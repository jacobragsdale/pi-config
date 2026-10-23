/**
 * Where a month's spend went, from the token counts in saved session files.
 * Each part answers one question about what is worth cutting next: the cost
 * components (thinking level, tool output), spend by model (the cheap-model
 * default), cache misses (session habits), long-context requests and
 * compactions (the context caps), and the most expensive sessions.
 */
import { basename } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { dollars } from "../../src/dollars.ts";
import type { SavedSession } from "../../src/sessions.ts";
import { entryUsage } from "../../src/usage.ts";

/** A miss reads at most this share of the previous request's prompt from the cache, as in cache-expiry. */
const MISS_SHARE = 0.5;
/** Below this, a miss can't be told apart from the part other sessions keep warm. */
const MIN_MISS_TOKENS = 8192;
const TOP_SESSIONS = 10;

interface Counter {
  usd: number;
  count: number;
}

export type Tally = Readonly<Counter>;

export interface SessionCost {
  readonly usd: number;
  readonly t: number;
  readonly cwd: string;
  readonly title: string;
}

export interface Breakdown {
  readonly sessions: number;
  readonly total: number;
  /** Uncached prompt: input and cache writes, mostly tool results. */
  readonly newInput: number;
  readonly cacheRead: number;
  /** Output, thinking included. */
  readonly output: number;
  /** Thinking and output tokens of the replies whose provider reports thinking separately. */
  readonly reasoning: { readonly tokens: number; readonly outputTokens: number };
  readonly byModel: ReadonlyMap<string, number>;
  readonly misses: Tally;
  readonly longContext: Tally;
  readonly compaction: Tally;
  readonly top: readonly SessionCost[];
}

/** A model's long-context price threshold in prompt tokens, or undefined when it has none. */
export type Threshold = (provider: string, model: string) => number | undefined;

interface Request {
  readonly provider: string;
  readonly model: string;
  readonly prompt: number;
}

const promptTokens = (usage: Usage): number => usage.input + usage.cacheRead + usage.cacheWrite;

function request(entry: SessionEntry): Request | undefined {
  if (entry.type !== "message" || entry.message.role !== "assistant") {
    return undefined;
  }
  const prompt = promptTokens(entry.message.usage);
  return prompt > 0 ? { provider: entry.message.provider, model: entry.message.model, prompt } : undefined;
}

function userText(entry: SessionEntry): string {
  if (entry.type !== "message" || entry.message.role !== "user") {
    return "";
  }
  const content = entry.message.content;
  const text = typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ");
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** Where the spend in `sessions` since `from` went. */
export function breakdown(sessions: readonly SavedSession[], from: number, threshold: Threshold): Breakdown {
  const sum = { total: 0, newInput: 0, cacheRead: 0, output: 0 };
  const reasoning = { tokens: 0, outputTokens: 0 };
  const byModel = new Map<string, number>();
  const misses: Counter = { usd: 0, count: 0 };
  const longContext: Counter = { usd: 0, count: 0 };
  const compaction: Counter = { usd: 0, count: 0 };
  const costs: SessionCost[] = [];

  function addUsage(usage: Usage, model: string, kind: string): void {
    const usd = usage.cost.total;
    sum.total += usd;
    sum.newInput += usage.cost.input + usage.cost.cacheWrite;
    sum.cacheRead += usage.cost.cacheRead;
    sum.output += usage.cost.output;
    if (usage.reasoning !== undefined) {
      reasoning.tokens += usage.reasoning;
      reasoning.outputTokens += usage.output;
    }
    byModel.set(model, (byModel.get(model) ?? 0) + usd);
    if (kind === "compaction") {
      compaction.usd += usd;
      compaction.count += 1;
    }
  }

  function addRequest(req: Request, usage: Usage, previousPrompt: number): void {
    if (previousPrompt >= MIN_MISS_TOKENS && usage.cacheRead < MISS_SHARE * previousPrompt) {
      misses.usd += usage.cost.input + usage.cost.cacheWrite;
      misses.count += 1;
    }
    const above = threshold(req.provider, req.model);
    if (above !== undefined && req.prompt > above) {
      longContext.usd += usage.cost.total;
      longContext.count += 1;
    }
  }

  function addSession(session: SavedSession): void {
    let usd = 0;
    let first: number | undefined;
    let title = "";
    let previousPrompt = 0;
    for (const entry of session.entries) {
      title = title === "" ? userText(entry) : title;
      if (entry.type === "compaction" || entry.type === "branch_summary") {
        // The next request starts from a new prompt, so it can't hit the old one's cache.
        previousPrompt = 0;
      }
      const found = entryUsage(entry);
      if (found === undefined) {
        continue;
      }
      const req = request(entry);
      const t = Date.parse(entry.timestamp);
      if (t >= from) {
        addUsage(found.usage, found.model, found.kind);
        if (req !== undefined) {
          addRequest(req, found.usage, previousPrompt);
        }
        usd += found.usage.cost.total;
        first ??= t;
      }
      previousPrompt = req?.prompt ?? previousPrompt;
    }
    if (first !== undefined && usd > 0) {
      costs.push({ usd, t: first, cwd: session.cwd, title });
    }
  }

  for (const session of sessions) {
    addSession(session);
  }
  const top = costs.sort((x, y) => y.usd - x.usd).slice(0, TOP_SESSIONS);
  return { sessions: costs.length, ...sum, reasoning, byModel, misses, longContext, compaction, top };
}

const percent = (part: number, whole: number): string => `${String(Math.round((part / whole) * 100))}%`;
const tally = (t: Tally, noun: string): string => `${dollars(t.usd)} in ${String(t.count)} ${noun}(s)`;
const day = (t: number): string => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The breakdown as report lines, against `logged`, the spend log's total for the same period. */
export function formatBreakdown(b: Breakdown, logged: number): string[] {
  if (b.total === 0) {
    return ["No spend in saved sessions this month."];
  }
  const share = (usd: number): string => `${dollars(usd)} (${percent(usd, b.total)})`;
  const thinking = b.reasoning.outputTokens > 0 ? `, thinking ${percent(b.reasoning.tokens, b.reasoning.outputTokens)} of output tokens` : "";
  const models = [...b.byModel].sort((x, y) => y[1] - x[1]);
  return [
    `This month in ${String(b.sessions)} saved session(s): ${dollars(b.total)} of the ${dollars(logged)} in your spend log.`,
    `  new input ${share(b.newInput)} · cache reads ${share(b.cacheRead)} · output ${share(b.output)}${thinking}`,
    "  by model:",
    ...models.map(([model, usd]) => `    ${model} ${dollars(usd)}`),
    `  cache misses (expiry, or a model or thinking change): ${tally(b.misses, "request")}`,
    `  over a long-context price threshold: ${tally(b.longContext, "request")}`,
    `  compaction: ${tally(b.compaction, "compaction")}`,
    "  top sessions:",
    ...b.top.map((s) => `    ${dollars(s.usd)}  ${day(s.t)}  ${basename(s.cwd)}  ${s.title}`)
  ];
}
