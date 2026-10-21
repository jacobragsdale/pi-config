/**
 * Soft spending limits over rolling time windows.
 *
 * Every billed model call is written to a spend log shared by all pi processes
 * on the machine. The footer shows spend against each limit, a warning appears
 * at `warnAt` of a limit, and once a limit is reached pi asks before sending
 * another prompt or request. "Continue anyway" allows `continueStep` of the
 * limit more before asking again. Without a UI (pi -p) the run stops instead.
 *
 * Team limits: defaults.json. Personal overrides: <agent dir>/budget.json.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dollars } from "../../src/dollars.ts";
import { Ledger, entrySpend, loadConfig, longestWindowHours, windowStatuses } from "./ledger.ts";
import type { BudgetConfig, Spend, WindowStatus } from "./ledger.ts";

const teamConfigPath = join(dirname(fileURLToPath(import.meta.url)), "defaults.json");
const personalConfigPath = (): string => join(getAgentDir(), "budget.json");

const span = (hours: number): string => (hours % 24 === 0 ? `${String(hours / 24)} day(s)` : `${String(hours)} hour(s)`);

export default function budget(pi: ExtensionAPI): void {
  /** Session entries already counted, so each call is logged once. */
  const counted = new Set<string>();
  /** Dollars above a window's limit that "continue anyway" has allowed in this process. */
  const allowance = new Map<string, number>();
  const warned = new Set<string>();
  let configError: string | undefined;

  const ledger = (): Ledger => new Ledger(join(getAgentDir(), "spend"));

  function config(ctx: ExtensionContext): BudgetConfig | undefined {
    try {
      const loaded = loadConfig(teamConfigPath, personalConfigPath());
      configError = undefined;
      return loaded;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== configError) {
        configError = message;
        ctx.ui.notify(`Budget limits are off until this is fixed: ${message}`, "error");
      }
      return undefined;
    }
  }

  /** Log the cost of session entries added since the last call. */
  function recordNewSpend(ctx: ExtensionContext): void {
    const now = Date.now();
    const session = ctx.sessionManager.getSessionId();
    const fresh: Spend[] = [];
    for (const entry of ctx.sessionManager.getEntries()) {
      if (counted.has(entry.id)) {
        continue;
      }
      counted.add(entry.id);
      const item = entrySpend(entry, session, now);
      if (item !== undefined) {
        fresh.push(item);
      }
    }
    ledger().append(fresh);
  }

  function statuses(cfg: BudgetConfig): WindowStatus[] {
    const now = Date.now();
    return windowStatuses(cfg, ledger().since(now - longestWindowHours(cfg) * 3_600_000, now), now);
  }

  function showStatus(ctx: ExtensionContext, current: readonly WindowStatus[]): void {
    const parts = current.map((w) => (w.limit === null ? `${w.name} ${dollars(w.spent)}` : `${w.name} ${dollars(w.spent)}/${dollars(w.limit)}`));
    ctx.ui.setStatus("budget", parts.join(" · "));
  }

  /** Record spend, refresh the footer and warn on crossing `warnAt`. Returns the windows over their limit. */
  function update(ctx: ExtensionContext): { cfg: BudgetConfig; over: WindowStatus[] } | undefined {
    recordNewSpend(ctx);
    const cfg = config(ctx);
    if (cfg === undefined) {
      return undefined;
    }
    const current = statuses(cfg);
    showStatus(ctx, current);
    const over: WindowStatus[] = [];
    for (const w of current) {
      if (w.limit === null) {
        continue;
      }
      if (w.spent >= w.limit + (allowance.get(w.name) ?? 0)) {
        over.push(w);
      } else if (w.spent >= w.limit * cfg.warnAt && !warned.has(w.name)) {
        warned.add(w.name);
        ctx.ui.notify(`Budget: ${dollars(w.spent)} of your ${dollars(w.limit)} ${w.name} limit spent in the last ${span(w.hours)}.`, "warning");
      }
    }
    return { cfg, over };
  }

  /** Whether spending may continue. Asks for each window over its limit. */
  async function mayContinue(ctx: ExtensionContext): Promise<boolean> {
    const state = update(ctx);
    if (state === undefined) {
      return true;
    }
    for (const w of state.over) {
      // `update` only reports windows that have a limit.
      const limit = w.limit ?? 0;
      const summary = `${dollars(w.spent)} of your ${dollars(limit)} ${w.name} limit spent in the last ${span(w.hours)}`;
      if (!ctx.hasUI) {
        console.error(`pi budget: stopped, ${summary}. Raise the limit in ${personalConfigPath()}.`);
        return false;
      }
      const nextAsk = w.spent + limit * state.cfg.continueStep;
      const confirmed = await ctx.ui.confirm(`Over your ${w.name} budget`, `${summary}.\n\nContinue anyway? You'll be asked again at ${dollars(nextAsk)}.`);
      if (!confirmed) {
        return false;
      }
      allowance.set(w.name, nextAsk - limit);
    }
    return true;
  }

  pi.on("session_start", (_event, ctx) => {
    // Entries already in a resumed or forked session were counted when they were made.
    for (const entry of ctx.sessionManager.getEntries()) {
      counted.add(entry.id);
    }
    update(ctx);
  });

  pi.on("input", async (event, ctx) => {
    const text = event.text.trimStart();
    if (text.startsWith("/") || text.startsWith("!")) {
      return { action: "continue" };
    }
    if (await mayContinue(ctx)) {
      return { action: "continue" };
    }
    if (ctx.hasUI) {
      ctx.ui.setEditorText(event.text);
      ctx.ui.notify("Prompt not sent: over budget. /budget shows your spend.", "warning");
    }
    return { action: "handled" };
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    if (!(await mayContinue(ctx))) {
      ctx.abort();
      ctx.ui.notify("Stopped: over budget. /budget shows your spend.", "warning");
    }
    return undefined;
  });

  const refresh = (_event: unknown, ctx: ExtensionContext): void => {
    update(ctx);
  };
  pi.on("turn_end", refresh);
  pi.on("agent_settled", refresh);
  pi.on("session_compact", refresh);
  pi.on("session_shutdown", (_event, ctx) => {
    recordNewSpend(ctx);
  });

  pi.registerCommand("budget", {
    description: "Show spend against your budget limits",
    handler: (_args, ctx) => {
      const state = update(ctx);
      if (state === undefined) {
        return Promise.resolve();
      }
      const now = Date.now();
      const lines = statuses(state.cfg).map((w) => {
        const limit = w.limit === null ? "no limit" : `limit ${dollars(w.limit)}`;
        const extra = allowance.get(w.name);
        return `${w.name}: ${dollars(w.spent)} in the last ${span(w.hours)}, ${limit}${extra === undefined ? "" : ` (+${dollars(extra)} allowed this session)`}`;
      });
      const hours = longestWindowHours(state.cfg);
      const byModel = new Map<string, number>();
      for (const item of ledger().since(now - hours * 3_600_000, now)) {
        byModel.set(item.model, (byModel.get(item.model) ?? 0) + item.usd);
      }
      const top = [...byModel].sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (top.length > 0) {
        lines.push(`Top models, last ${span(hours)}:`, ...top.map(([model, usd]) => `  ${model} ${dollars(usd)}`));
      }
      lines.push(`Limits: ${personalConfigPath()} (overrides the team defaults)`);
      ctx.ui.notify(lines.join("\n"), "info");
      return Promise.resolve();
    }
  });
}
