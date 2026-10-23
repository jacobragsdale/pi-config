import assert from "node:assert/strict";
import { test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { breakdown, formatBreakdown } from "../extensions/budget/breakdown.ts";
import type { SavedSession } from "../src/sessions.ts";

const MINUTE = 60_000;
const FROM = Date.UTC(2026, 9, 1);
const noThreshold = (): undefined => undefined;

interface Tokens {
  readonly input?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly output?: number;
  readonly reasoning?: number;
}

interface Costs {
  readonly input?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly output?: number;
}

function usage(tokens: Tokens, costs: Costs): Usage {
  const { input = 0, cacheRead = 0, cacheWrite = 0, output = 100 } = tokens;
  const cost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...costs };
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(tokens.reasoning === undefined ? {} : { reasoning: tokens.reasoning }),
    totalTokens: input + cacheRead + cacheWrite + output,
    cost: { ...cost, total: cost.input + cost.cacheRead + cost.cacheWrite + cost.output }
  };
}

type Part = (id: string) => SessionEntry;

const base = (id: string, minute: number): { id: string; parentId: null; timestamp: string } => ({ id, parentId: null, timestamp: new Date(FROM + minute * MINUTE).toISOString() });

const reply =
  (minute: number, tokens: Tokens, costs: Costs, model = "m"): Part =>
  (id) => ({
    ...base(id, minute),
    type: "message",
    message: { role: "assistant", content: [], api: "test", provider: "p", model, usage: usage(tokens, costs), stopReason: "stop", timestamp: FROM + minute * MINUTE }
  });

const user =
  (text: string): Part =>
  (id) => ({ ...base(id, 0), type: "message", message: { role: "user", content: text, timestamp: FROM } });

const compaction =
  (minute: number, costs: Costs): Part =>
  (id) => ({ ...base(id, minute), type: "compaction", summary: "s", firstKeptEntryId: "e0", tokensBefore: 0, usage: usage({ input: 1000 }, costs) });

const session = (cwd: string, ...parts: readonly Part[]): SavedSession => ({ cwd, entries: parts.map((part, index) => part(`e${String(index)}`)) });

await test("splits spend since the start into components and models", () => {
  const b = breakdown(
    [
      session(
        "/w/a",
        reply(-60, { input: 1000 }, { output: 5 }),
        reply(1, { input: 1000, output: 200, reasoning: 50 }, { input: 0.125, cacheRead: 0.25, cacheWrite: 0.5, output: 1 }),
        reply(2, { input: 1000, output: 100, reasoning: 10 }, { output: 0.375 }, "other")
      )
    ],
    FROM,
    noThreshold
  );
  assert.equal(b.total, 2.25);
  assert.equal(b.newInput, 0.625);
  assert.equal(b.cacheRead, 0.25);
  assert.equal(b.output, 1.375);
  assert.deepEqual(b.reasoning, { tokens: 60, outputTokens: 300 });
  assert.deepEqual(
    [...b.byModel],
    [
      ["p/m", 1.875],
      ["p/other", 0.375]
    ]
  );
});

await test("counts a request that misses the previous one's cache, but not the first after a compaction", () => {
  const b = breakdown(
    [
      session(
        "/w/a",
        reply(1, { cacheWrite: 10_000 }, { cacheWrite: 1 }),
        reply(2, { cacheRead: 10_000, input: 500 }, { cacheRead: 0.1, input: 0.05 }),
        reply(40, { cacheRead: 1000, cacheWrite: 10_000 }, { cacheRead: 0.01, cacheWrite: 1.2 }),
        compaction(41, { output: 0.3 }),
        reply(42, { cacheWrite: 9000 }, { cacheWrite: 0.9 })
      )
    ],
    FROM,
    noThreshold
  );
  assert.deepEqual(b.misses, { usd: 1.2, count: 1 });
  assert.deepEqual(b.compaction, { usd: 0.3, count: 1 });
});

await test("counts requests over their model's long-context threshold", () => {
  const b = breakdown(
    [session("/w/a", reply(1, { cacheRead: 120_000 }, { cacheRead: 2 }, "big"), reply(2, { cacheRead: 120_000 }, { cacheRead: 1 }), reply(3, { cacheRead: 90_000 }, { cacheRead: 1 }, "big"))],
    FROM,
    (_provider, model) => (model === "big" ? 100_000 : undefined)
  );
  assert.deepEqual(b.longContext, { usd: 2, count: 1 });
});

await test("ranks sessions by cost, titled by their first prompt", () => {
  const long = "x".repeat(80);
  const b = breakdown(
    [
      session("/w/cheap", user("small fix"), reply(1, {}, { output: 1 })),
      session("/w/dear", user(`fix\n  the  ${long}`), reply(5, {}, { output: 3 })),
      session("/w/old", reply(-5, {}, { output: 9 }))
    ],
    FROM,
    noThreshold
  );
  assert.equal(b.sessions, 2);
  assert.deepEqual(
    b.top.map((s) => [s.cwd, s.usd, s.title]),
    [
      ["/w/dear", 3, `fix the ${"x".repeat(51)}…`],
      ["/w/cheap", 1, "small fix"]
    ]
  );
});

await test("reports shares of the total against the spend log", () => {
  const b = breakdown([session("/w/repo", user("hello"), reply(1, { reasoning: 25 }, { input: 1, output: 3 }))], FROM, noThreshold);
  const lines = formatBreakdown(b, 5);
  assert.equal(lines[0], "This month in 1 saved session(s): $4.00 of the $5.00 in your spend log.");
  assert.equal(lines[1], "  new input $1.00 (25%) · cache reads $0.00 (0%) · output $3.00 (75%), thinking 25% of output tokens");
  assert.ok(lines.includes("    p/m $4.00"));
  assert.match(lines.at(-1) ?? "", /^ {4}\$4\.00 {2}.+ {2}repo {2}hello$/);
  assert.deepEqual(formatBreakdown(breakdown([], FROM, noThreshold), 0), ["No spend in saved sessions this month."]);
});
