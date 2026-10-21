/**
 * Measuring how long a model's prompt cache lasts from the requests pi has
 * already made. Two consecutive requests in a session give one observation:
 * the gap between their starts, and whether the second read the first one's
 * prompt from the cache.
 */
import { readFileSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Check } from "typebox/value";
import { parseJson } from "../../src/json.ts";
import { MonthlyLog } from "../../src/monthly-log.ts";

const MINUTE = 60_000;
/** Shorter gaps say nothing about expiry, and expiries at them have other causes, such as Copilot routing a request elsewhere. */
export const MIN_GAP_MS = MINUTE;
/** Older observations are ignored, so a change in a provider's behavior shows through. */
export const MAX_AGE_MS = 30 * 24 * 60 * MINUTE;
/** A hit reads nearly the whole previous prompt; a cache that was refreshed reads all of it. */
const HIT_SHARE = 0.9;
/** An expiry reads at most this share: what other sessions keep warm, such as the system prompt and tools. */
const MISS_SHARE = 0.5;
const MIN_HIT_TOKENS = 1024;
/** Below this, the part other sessions keep warm can be most of the prompt, so an expiry can't be told apart. */
const MIN_MISS_TOKENS = 8192;
/** Grace past a published lifetime before the cache counts as cold, for request and clock timing. */
const COLD_GRACE_MS = MINUTE;

const ObservationSchema = Type.Object({ t: Type.Number(), model: Type.String(), gapMs: Type.Number(), hit: Type.Boolean() }, { additionalProperties: false });

/** One measured gap for a model, keyed `provider/model`, and whether the cache survived it. */
export type Observation = Readonly<Static<typeof ObservationSchema>>;

export class ObservationLog extends MonthlyLog<Observation> {
  constructor(dir: string) {
    super(dir, (value): value is Observation => Check(ObservationSchema, value));
  }
}

/** One model request: when it started, its prompt size and how much of it the cache served. */
export interface Request {
  readonly t: number;
  readonly provider: string;
  readonly model: string;
  readonly prompt: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export const modelKey = (request: Pick<Request, "provider" | "model">): string => `${request.provider}/${request.model}`;

// Only the fields read here. Session files can come from older pi versions, so they are checked.
const UsageSchema = Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number() });
const AssistantSchema = Type.Object({ role: Type.Literal("assistant"), provider: Type.String(), model: Type.String(), timestamp: Type.Number(), usage: UsageSchema });

/** How an entry affects the prompt cache of the requests after it. */
type Step =
  | { readonly kind: "request"; readonly request: Request }
  /** Leaves the cached prefix as it was: user messages, tool results, labels. */
  | { readonly kind: "pass" }
  /** A request that sent no prompt, such as one aborted before it reached the provider. Its effect on the cache is unknown. */
  | { readonly kind: "unknown" }
  /** The next request can't reuse the cache: a different model or thinking level, or edited history. */
  | { readonly kind: "changed" }
  /** The next request starts from a new prompt: a compaction or branch summary. */
  | { readonly kind: "restart" };

function requestStep(t: number, provider: string, model: string, usage: Static<typeof UsageSchema>): Step {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return prompt > 0 ? { kind: "request", request: { t, provider, model, prompt, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite } } : { kind: "unknown" };
}

function step(entry: SessionEntry): Step {
  switch (entry.type) {
    case "message": {
      const message: unknown = entry.message;
      return Check(AssistantSchema, message) ? requestStep(message.timestamp, message.provider, message.model, message.usage) : { kind: "pass" };
    }
    case "usage": {
      // Pi's cache warmer re-sends the last request, which refreshes the cache like a real one.
      const usage: unknown = entry.usage;
      return entry.kind === "cache_warm" && Check(UsageSchema, usage) ? requestStep(Date.parse(entry.timestamp), entry.provider, entry.model, usage) : { kind: "pass" };
    }
    case "model_change":
    case "thinking_level_change":
    case "context_edit":
      return { kind: "changed" };
    case "compaction":
    case "branch_summary":
      return { kind: "restart" };
    case "custom":
    case "custom_message":
    case "label":
    case "session_info":
      return { kind: "pass" };
  }
}

/** Classify the gap between two consecutive requests, or undefined when it doesn't show whether the cache lasted. */
export function classify(previous: Request, current: Request): Observation | undefined {
  const gapMs = current.t - previous.t;
  if (gapMs < MIN_GAP_MS || modelKey(previous) !== modelKey(current)) {
    return undefined;
  }
  const expected = Math.min(previous.prompt, current.prompt);
  const base = { t: current.t, model: modelKey(current), gapMs };
  if (expected >= MIN_HIT_TOKENS && current.cacheRead >= HIT_SHARE * expected) {
    return { ...base, hit: true };
  }
  // A provider that never reports cache use may not cache at all, so reading nothing proves nothing.
  const reportsCaching = previous.cacheRead + previous.cacheWrite + current.cacheWrite > 0;
  if (expected >= MIN_MISS_TOKENS && current.cacheRead <= MISS_SHARE * expected && reportsCaching) {
    return { ...base, hit: false };
  }
  // A partial read: the start of the prompt changed, which says nothing about expiry.
  return undefined;
}

function previousRequest(entry: SessionEntry, byId: ReadonlyMap<string, SessionEntry>): Request | undefined {
  let parent = entry.parentId === null ? undefined : byId.get(entry.parentId);
  while (parent !== undefined) {
    const found = step(parent);
    if (found.kind === "request") {
      return found.request;
    }
    if (found.kind !== "pass") {
      return undefined;
    }
    parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
  }
  return undefined;
}

/** Observations for the requests among `entries` that `include` accepts, each paired with the request before it on its branch. */
export function observe(entries: readonly SessionEntry[], include: (entry: SessionEntry) => boolean = () => true): Observation[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const result: Observation[] = [];
  for (const entry of entries) {
    const current = include(entry) ? step(entry) : undefined;
    if (current?.kind !== "request") {
      continue;
    }
    const previous = previousRequest(entry, byId);
    const observation = previous === undefined ? undefined : classify(previous, current.request);
    if (observation !== undefined) {
      result.push(observation);
    }
  }
  return result;
}

/** The last request on a branch, and whether something since then stops the next request from reusing its cache. */
export interface LastRequest {
  readonly request: Request;
  readonly changed: boolean;
}

/** Undefined when the branch has no request, or the next request starts from a new prompt. */
export function lastRequest(branch: readonly SessionEntry[]): LastRequest | undefined {
  let changed = false;
  for (const entry of branch.toReversed()) {
    const found = step(entry);
    switch (found.kind) {
      case "request":
        return { request: found.request, changed };
      case "restart":
        return undefined;
      case "changed":
        changed = true;
        break;
      case "pass":
      case "unknown":
        break;
    }
  }
  return undefined;
}

/** How long a cache stays warm, and from when it is known to be cold (undefined: no expiry known). */
export interface Lifetime {
  readonly warmMs: number;
  readonly coldMs: number | undefined;
}

export interface Estimate extends Lifetime {
  readonly measurements: number;
}

/**
 * A model's cache lifetime from its observations and a starting lifetime.
 *
 * Picks the gap that splits the observations with the fewest disagreeing:
 * hits should fall below it and expiries above. The starting lifetime counts
 * as one hit at its warm time and one expiry at its cold time, so it holds
 * until measurements outvote it. Ties go to the longer split, so one hit past
 * the estimate raises it, since a cache can't be read once it has expired,
 * while lowering it takes two expiries, since an expiry can have other causes.
 */
export function estimate(observations: readonly Observation[], start: Lifetime): Estimate {
  const points = [...observations, { gapMs: start.warmMs, hit: true }, ...(start.coldMs === undefined ? [] : [{ gapMs: start.coldMs, hit: false }])].sort((a, b) => a.gapMs - b.gapMs);
  let missesBelow = 0;
  let hitsAbove = points.filter((point) => point.hit).length;
  let best = { disagreeing: hitsAbove, split: 0 };
  for (const [index, point] of points.entries()) {
    if (point.hit) {
      hitsAbove -= 1;
    } else {
      missesBelow += 1;
    }
    // Only split between different gaps: observations at the same gap go on the same side.
    if (points[index + 1]?.gapMs !== point.gapMs && missesBelow + hitsAbove <= best.disagreeing) {
      best = { disagreeing: missesBelow + hitsAbove, split: index + 1 };
    }
  }
  const below = points.slice(0, best.split).filter((point) => point.hit);
  const coldMs = points.slice(best.split).find((point) => !point.hit)?.gapMs;
  return { warmMs: Math.max(0, ...below.map((point) => point.gapMs)), coldMs, measurements: observations.length };
}

const RuleSchema = Type.Object(
  { models: Type.String(), warmMinutes: Type.Number({ exclusiveMinimum: 0 }), coldMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), source: Type.String() },
  { additionalProperties: false }
);
const DefaultsSchema = Type.Object({ lifetimes: Type.Array(RuleSchema) }, { additionalProperties: false });

/** A published cache lifetime for the models whose id matches the `models` regular expression. */
export type LifetimeRule = Static<typeof RuleSchema>;

export function loadRules(path: string): LifetimeRule[] {
  const rules = parseJson(DefaultsSchema, readFileSync(path, "utf8"), path).lifetimes;
  for (const rule of rules) {
    if (rule.coldMinutes !== undefined && rule.coldMinutes <= rule.warmMinutes) {
      throw new Error(`${path}: coldMinutes must be more than warmMinutes for "${rule.models}"`);
    }
  }
  return rules;
}

export interface StartingLifetime extends Lifetime {
  readonly source: string;
}

/** The cache lifetime to assume before measurements: pi's catalog when it has one for the model, then the first matching rule. */
export function startingLifetime(rules: readonly LifetimeRule[], modelId: string, catalogSeconds: number | undefined): StartingLifetime {
  if (catalogSeconds !== undefined) {
    return { warmMs: catalogSeconds * 1000, coldMs: catalogSeconds * 1000 + COLD_GRACE_MS, source: "pi's model catalog" };
  }
  const rule = rules.find((candidate) => new RegExp(candidate.models, "u").test(modelId));
  if (rule === undefined) {
    return { warmMs: 5 * MINUTE, coldMs: undefined, source: "no published lifetime" };
  }
  return { warmMs: rule.warmMinutes * MINUTE, coldMs: rule.coldMinutes === undefined ? undefined : rule.coldMinutes * MINUTE, source: rule.source };
}

/** Whole minutes, rounded down so a lifetime is never overstated, as `45m` or `2h 5m`; `<1m` below a minute. */
export function duration(ms: number): string {
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `${String(minutes)}m`;
  }
  const rest = minutes % 60;
  return `${String(Math.floor(minutes / 60))}h${rest === 0 ? "" : ` ${String(rest)}m`}`;
}

/** Footer text `elapsedMs` after the last request. `resend` is what re-sending the conversation uncached costs, when known. */
export function footer(lifetime: Lifetime, elapsedMs: number, changed: boolean, resend: string | undefined): string {
  if (!changed && elapsedMs < lifetime.warmMs) {
    return `cache warm · ~${duration(lifetime.warmMs - elapsedMs)} left`;
  }
  if (changed || (lifetime.coldMs !== undefined && elapsedMs >= lifetime.coldMs)) {
    return resend === undefined ? "cache cold" : `cache cold · resend ≈ ${resend}`;
  }
  return resend === undefined ? "cache may be cold" : `cache may be cold · if expired ≈ ${resend}`;
}
