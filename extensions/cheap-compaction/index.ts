/**
 * Writes compaction summaries with a cheap model instead of the session's.
 *
 * Compaction never reads the prompt cache: pi re-sends everything since the
 * last compaction at the full input price, on the session's model. This
 * extension hands the same work to pi's own `compact()` with a cheaper model,
 * so the prompts, cut point and summary format are pi's; only the model
 * changes. When the cheap model can't do it (missing, not signed in, too small
 * a context window, already no cheaper, or the call fails), pi compacts as usual.
 *
 * Off for the team (defaults.json sets no model): in an evaluation against
 * Sonnet 5.5, GPT-6 Luna's summaries lost details the session needed
 * (docs/compaction-eval.md). Turn it on with "model" in
 * <agent dir>/compaction.json. PI_CHEAP_COMPACTION=0 turns it off again.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { compact, estimateTokens, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CompactionResult, ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";
import { dollars } from "../../src/dollars.ts";
import { loadConfig, splitModel } from "./config.ts";
import type { CompactionConfig } from "./config.ts";

const teamConfigPath = join(dirname(fileURLToPath(import.meta.url)), "defaults.json");
const personalConfigPath = (): string => join(getAgentDir(), "compaction.json");

/** Tokens the summary request sends: the messages to summarize and the previous summary. */
function promptTokens(preparation: SessionBeforeCompactEvent["preparation"]): number {
  const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0) + Math.ceil((preparation.previousSummary?.length ?? 0) / 4);
}

/** Request headers without the ones the provider config deletes (null), as pi's own summaries send them. */
function sentHeaders(headers: Readonly<Record<string, string | null>> | undefined): Record<string, string> | undefined {
  if (headers === undefined) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
}

const sameModel = (a: Model<Api>, b: Model<Api>): boolean => a.provider === b.provider && a.id === b.id;

export default function cheapCompaction(pi: ExtensionAPI): void {
  function config(ctx: ExtensionContext): CompactionConfig | undefined {
    try {
      return loadConfig(teamConfigPath, personalConfigPath());
    } catch (err) {
      ctx.ui.notify(`Cheap compaction is off until this is fixed: ${err instanceof Error ? err.message : String(err)}`, "error");
      return undefined;
    }
  }

  /** The cheap model, or why pi should compact as usual. */
  function choose(event: SessionBeforeCompactEvent, ctx: ExtensionContext, cfg: CompactionConfig & { readonly model: string }): Model<Api> | string {
    const { provider, id } = splitModel(cfg.model);
    const cheap = ctx.modelRegistry.find(provider, id);
    if (cheap === undefined) {
      return `${cfg.model} isn't available`;
    }
    const current = ctx.model === undefined ? undefined : ctx.modelRegistry.find(ctx.model.provider, ctx.model.id);
    if (current !== undefined && (sameModel(current, cheap) || current.cost.input <= cheap.cost.input)) {
      return "";
    }
    // Room for the prompt plus the summary pi asks for, 80% of reserveTokens.
    if (promptTokens(event.preparation) + 0.8 * event.preparation.settings.reserveTokens > cheap.contextWindow) {
      return `this compaction is too large for ${cfg.model}`;
    }
    return cheap;
  }

  async function summarize(event: SessionBeforeCompactEvent, ctx: ExtensionContext, cfg: CompactionConfig & { readonly model: string }, cheap: Model<Api>): Promise<CompactionResult> {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(cheap);
    if (!auth.ok) {
      throw new Error(auth.error);
    }
    const model = auth.baseUrl === undefined ? cheap : { ...cheap, baseUrl: auth.baseUrl };
    const result = await compact(
      event.preparation,
      model,
      auth.apiKey,
      sentHeaders(auth.headers),
      event.customInstructions,
      event.signal,
      cfg.thinkingLevel,
      (requestModel, context, options) => ctx.modelRegistry.streamSimple(requestModel, context, options),
      auth.env
    );
    if (result.summary.trim() === "") {
      throw new Error(`${cfg.model} returned an empty summary`);
    }
    return result;
  }

  pi.on("session_before_compact", async (event, ctx): Promise<SessionBeforeCompactResult | undefined> => {
    const loaded = process.env["PI_CHEAP_COMPACTION"] === "0" ? undefined : config(ctx);
    if (loaded === undefined || loaded.model === null) {
      return undefined;
    }
    const cfg = { ...loaded, model: loaded.model };
    const cheap = choose(event, ctx, cfg);
    if (typeof cheap === "string") {
      if (cheap !== "") {
        ctx.ui.notify(`Compacting with the session's model: ${cheap}.`, "info");
      }
      return undefined;
    }
    try {
      const compaction = await summarize(event, ctx, cfg, cheap);
      const cost = compaction.usage === undefined ? "" : ` for ${dollars(compaction.usage.cost.total)}`;
      ctx.ui.notify(`Compacted with ${cfg.model}${cost}.`, "info");
      return { compaction };
    } catch (err) {
      // Falling back after an abort would start the expensive compaction the person just stopped.
      if (event.signal.aborted) {
        return { cancel: true };
      }
      ctx.ui.notify(`Compaction with ${cfg.model} failed (${err instanceof Error ? err.message : String(err)}); compacting with the session's model.`, "warning");
      return undefined;
    }
  });
}
