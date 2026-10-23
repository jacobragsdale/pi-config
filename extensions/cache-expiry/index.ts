/**
 * Shows in pi's footer whether the prompt cache is likely still warm, and
 * what re-sending the conversation costs if it has expired.
 *
 * Every pair of consecutive requests is a measurement of the model's cache
 * lifetime (see observations.ts). Measurements go in a log shared by all pi
 * processes on the machine, and each model's lifetime is estimated from the
 * last 30 days of them, starting from the published lifetimes in
 * defaults.json. The first time it runs, it fills the log from the sessions
 * already on disk. It never sends a request of its own.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { calculateCost } from "@earendil-works/pi-ai";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { dollars } from "../../src/dollars.ts";
import { readSession, sessionFiles } from "../../src/sessions.ts";
import { MAX_AGE_MS, ObservationLog, duration, estimate, footer, lastRequest, loadRules, modelKey, observe, startingLifetime } from "./observations.ts";
import type { Estimate, LastRequest, Observation, StartingLifetime } from "./observations.ts";

const rules = loadRules(join(dirname(fileURLToPath(import.meta.url)), "defaults.json"));
const TICK_MS = 30_000;

const observationDir = (): string => join(getAgentDir(), "cache-observations");

/** What re-sending `tokens` of prompt costs without the cache: at the cache-write rate where the model charges one, else the input rate. */
function resendUsd(model: Model<Api>, tokens: number): number {
  const asWrite = model.cost.cacheWrite > 0;
  const usage: Usage = {
    input: asWrite ? 0 : tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: asWrite ? tokens : 0,
    totalTokens: tokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
  return calculateCost(model, usage).total;
}

/** Claim the one-time backfill for this agent directory. False when another process already has. */
function claimBackfill(now: number): boolean {
  mkdirSync(observationDir(), { recursive: true });
  try {
    writeFileSync(join(observationDir(), "backfilled"), `${new Date(now).toISOString()}\n`, { flag: "wx" });
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

/** Observations from the sessions saved on disk, except `skip`, the session open now. */
function savedObservations(skip: string | undefined): Observation[] {
  const current = skip === undefined ? undefined : resolve(skip);
  return sessionFiles(join(getAgentDir(), "sessions"))
    .filter((file) => resolve(file) !== current)
    .flatMap((file) => observe(readSession(file).entries));
}

interface Shown {
  readonly last: LastRequest;
  readonly lifetime: Estimate;
  readonly resend: string | undefined;
}

export default function cacheExpiry(pi: ExtensionAPI): void {
  /** Session entries already measured, keyed by session, so each is logged once. */
  const counted = new Set<string>();
  let latest: ExtensionContext | undefined;
  let shown: Shown | undefined;
  let timer: NodeJS.Timeout | undefined;

  const log = (): ObservationLog => new ObservationLog(observationDir());
  const entryKey = (ctx: ExtensionContext, entry: SessionEntry): string => `${ctx.sessionManager.getSessionId()}:${entry.id}`;

  function findModel(ctx: ExtensionContext, provider: string, id: string): Model<Api> | undefined {
    return ctx.model?.provider === provider && ctx.model.id === id ? ctx.model : ctx.modelRegistry.find(provider, id);
  }

  function start(ctx: ExtensionContext, key: string): StartingLifetime {
    const slash = key.indexOf("/");
    const provider = key.slice(0, slash);
    const id = key.slice(slash + 1);
    const tiers = findModel(ctx, provider, id)?.promptCache;
    return startingLifetime(rules, id, process.env["PI_CACHE_RETENTION"] === "long" ? tiers?.long : tiers?.short);
  }

  function observationsByModel(ctx: ExtensionContext, now: number): Map<string, Observation[]> {
    const byModel = new Map<string, Observation[]>();
    for (const item of log().since(now - MAX_AGE_MS, now)) {
      byModel.set(item.model, [...(byModel.get(item.model) ?? []), item]);
    }
    if (ctx.model !== undefined && !byModel.has(modelKey({ provider: ctx.model.provider, model: ctx.model.id }))) {
      byModel.set(modelKey({ provider: ctx.model.provider, model: ctx.model.id }), []);
    }
    return byModel;
  }

  /** Log measurements from session entries added since the last call. */
  function recordNew(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getEntries();
    const fresh = new Set(entries.filter((entry) => !counted.has(entryKey(ctx, entry))));
    for (const entry of fresh) {
      counted.add(entryKey(ctx, entry));
    }
    log().append(observe(entries, (entry) => fresh.has(entry)));
  }

  function render(): void {
    if (latest === undefined) {
      return;
    }
    latest.ui.setStatus("cache", shown === undefined ? undefined : footer(shown.lifetime, Date.now() - shown.last.request.t, shown.last.changed, shown.resend));
  }

  function update(ctx: ExtensionContext): void {
    latest = ctx;
    recordNew(ctx);
    const found = lastRequest(ctx.sessionManager.getBranch());
    if (found === undefined) {
      shown = undefined;
      render();
      return;
    }
    const { request } = found;
    const current = ctx.model;
    const switched = current !== undefined && (current.provider !== request.provider || current.id !== request.model);
    const last = switched ? { ...found, changed: true } : found;
    const key = modelKey(request);
    const now = Date.now();
    const observations = log()
      .since(now - MAX_AGE_MS, now)
      .filter((item) => item.model === key);
    // After a switch the next request goes to the new model, at its prices.
    const priced = switched ? findModel(ctx, current.provider, current.id) : findModel(ctx, request.provider, request.model);
    shown = { last, lifetime: estimate(observations, start(ctx, key)), resend: priced === undefined ? undefined : dollars(resendUsd(priced, request.prompt + request.output)) };
    render();
  }

  pi.on("session_start", (_event, ctx) => {
    const now = Date.now();
    if (claimBackfill(now)) {
      const entries = ctx.sessionManager.getEntries();
      const backfill = [...savedObservations(ctx.sessionManager.getSessionFile()), ...observe(entries)];
      log().append(backfill.filter((item) => item.t >= now - MAX_AGE_MS));
    }
    // Entries already in a resumed or forked session were measured when they were made, or just now.
    for (const entry of ctx.sessionManager.getEntries()) {
      counted.add(entryKey(ctx, entry));
    }
    if (ctx.hasUI && timer === undefined) {
      timer = setInterval(render, TICK_MS);
      timer.unref();
    }
    update(ctx);
  });

  const refresh = (_event: unknown, ctx: ExtensionContext): void => {
    update(ctx);
  };
  pi.on("turn_end", refresh);
  pi.on("agent_settled", refresh);
  pi.on("model_select", refresh);
  pi.on("thinking_level_select", refresh);
  pi.on("session_compact", refresh);
  pi.on("session_tree", refresh);
  pi.on("session_shutdown", (_event, ctx) => {
    recordNew(ctx);
    clearInterval(timer);
    timer = undefined;
    latest = undefined;
  });

  pi.registerCommand("cache", {
    description: "Show how long each model's prompt cache is estimated to last",
    handler: (_args, ctx) => {
      const now = Date.now();
      const current = ctx.model === undefined ? undefined : modelKey({ provider: ctx.model.provider, model: ctx.model.id });
      const byModel = [...observationsByModel(ctx, now)].sort(([a], [b]) => (a === current ? -1 : b === current ? 1 : a.localeCompare(b)));
      const lines = byModel.map(([key, observations]) => {
        const first = start(ctx, key);
        const result = estimate(observations, first);
        const cold = result.coldMs === undefined ? "no expiry measured yet" : `cold after ${duration(result.coldMs)}`;
        const count = `${String(result.measurements)} measurement${result.measurements === 1 ? "" : "s"}`;
        return `${key}: warm up to ${duration(result.warmMs)}, ${cold} · ${count} · starting value ${duration(first.warmMs)} (${first.source})`;
      });
      lines.push(`Measurements from the last 30 days: ${observationDir()}`);
      ctx.ui.notify(lines.join("\n"), "info");
      return Promise.resolve();
    }
  });
}
