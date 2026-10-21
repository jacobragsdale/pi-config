import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { classify, estimate, footer, lastRequest, loadRules, observe, startingLifetime } from "../extensions/cache-expiry/observations.ts";
import type { Observation, Request } from "../extensions/cache-expiry/observations.ts";
import { repo } from "./pi-rpc.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 20, 12);

interface Base {
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
}
type Part = (base: Base) => SessionEntry;

/** Link parts into one branch, each entry the child of the one before. */
function branch(...parts: readonly Part[]): SessionEntry[] {
  return parts.map((part, index) => part({ id: `e${String(index)}`, parentId: index === 0 ? null : `e${String(index - 1)}`, timestamp: new Date(T0).toISOString() }));
}

interface Tokens {
  readonly input?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

const reply =
  (minute: number, tokens: Tokens, model = "m"): Part =>
  (base) => {
    const { input = 0, cacheRead = 0, cacheWrite = 0 } = tokens;
    return {
      ...base,
      type: "message",
      message: {
        role: "assistant",
        content: [],
        api: "test",
        provider: "p",
        model,
        usage: { input, output: 100, cacheRead, cacheWrite, totalTokens: input + cacheRead + cacheWrite + 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: T0 + minute * MINUTE
      }
    };
  };
const user: Part = (base) => ({ ...base, type: "message", message: { role: "user", content: "next", timestamp: T0 } });
const compaction: Part = (base) => ({ ...base, type: "compaction", summary: "s", firstKeptEntryId: "e0", tokensBefore: 0 });
const modelChange: Part = (base) => ({ ...base, type: "model_change", provider: "p", modelId: "other" });

const request = (minute: number, tokens: Required<Tokens>): Request => ({
  t: T0 + minute * MINUTE,
  provider: "p",
  model: "m",
  prompt: tokens.input + tokens.cacheRead + tokens.cacheWrite,
  output: 100,
  ...tokens
});
const seen = (minutes: number, hit: boolean): Observation => ({ t: T0, model: "p/m", gapMs: minutes * MINUTE, hit });

await test("classifies a full cache read after a gap as a hit, and a read of nothing as an expiry", () => {
  const first = request(0, { input: 0, cacheRead: 0, cacheWrite: 20_000 });
  assert.deepEqual(classify(first, request(10, { input: 10, cacheRead: 20_000, cacheWrite: 500 })), { t: T0 + 10 * MINUTE, model: "p/m", gapMs: 10 * MINUTE, hit: true });
  assert.equal(classify(first, request(20, { input: 10, cacheRead: 0, cacheWrite: 20_500 }))?.hit, false);
});

await test("counts a read of only what other sessions keep warm as an expiry", () => {
  const first = request(0, { input: 0, cacheRead: 2800, cacheWrite: 20_000 });
  assert.equal(classify(first, request(20, { input: 10, cacheRead: 2800, cacheWrite: 18_000 }))?.hit, false);
});

await test("ignores pairs that don't show whether the cache lasted", () => {
  const first = request(0, { input: 0, cacheRead: 0, cacheWrite: 20_000 });
  // Too short a gap to say anything.
  assert.equal(classify(first, request(0.5, { input: 10, cacheRead: 0, cacheWrite: 20_000 })), undefined);
  // A partial read: the start of the prompt changed.
  assert.equal(classify(first, request(10, { input: 10, cacheRead: 14_000, cacheWrite: 6000 })), undefined);
  // Too small for an expiry to stand out from a shared system prompt.
  assert.equal(classify(request(0, { input: 0, cacheRead: 0, cacheWrite: 4000 }), request(10, { input: 4000, cacheRead: 0, cacheWrite: 0 })), undefined);
  // A provider that never reported cache use.
  assert.equal(classify(request(0, { input: 20_000, cacheRead: 0, cacheWrite: 0 }), request(10, { input: 20_000, cacheRead: 0, cacheWrite: 0 })), undefined);
});

await test("pairs each request with the one before it on its branch, across user messages", () => {
  const entries = branch(reply(0, { cacheWrite: 20_000 }), user, reply(10, { cacheRead: 20_000, cacheWrite: 500 }), user, reply(40, { cacheWrite: 21_000 }));
  assert.deepEqual(
    observe(entries).map((item) => [item.gapMs / MINUTE, item.hit]),
    [
      [10, true],
      [30, false]
    ]
  );
});

await test("doesn't measure across a compaction or model change", () => {
  assert.deepEqual(observe(branch(reply(0, { cacheWrite: 20_000 }), compaction, reply(10, { cacheWrite: 9000 }))), []);
  assert.deepEqual(observe(branch(reply(0, { cacheWrite: 20_000 }), modelChange, reply(10, { cacheWrite: 21_000 }))), []);
});

await test("doesn't measure across a request that sent no prompt", () => {
  assert.deepEqual(observe(branch(reply(0, { cacheWrite: 20_000 }), user, reply(5, {}), user, reply(10, { cacheRead: 20_000 }))), []);
});

await test("measures only the entries asked for", () => {
  const entries = branch(reply(0, { cacheWrite: 20_000 }), user, reply(10, { cacheRead: 20_000 }), user, reply(20, { cacheRead: 20_000 }));
  assert.deepEqual(
    observe(entries, (entry) => entry.id === "e4").map((item) => item.t),
    [T0 + 20 * MINUTE]
  );
});

await test("finds the last request, notes a model change after it, and stops at a compaction", () => {
  assert.equal(lastRequest(branch(reply(0, { cacheWrite: 20_000 }), user))?.changed, false);
  assert.equal(lastRequest(branch(reply(0, { cacheWrite: 20_000 }), modelChange, user))?.changed, true);
  assert.equal(lastRequest(branch(reply(0, { cacheWrite: 20_000 }), compaction)), undefined);
  assert.equal(lastRequest(branch(user)), undefined);
});

await test("keeps the starting lifetime until measurements outvote it", () => {
  const start = { warmMs: 30 * MINUTE, coldMs: undefined };
  assert.deepEqual(estimate([], start), { warmMs: 30 * MINUTE, coldMs: undefined, measurements: 0 });
  // One odd expiry inside the published lifetime doesn't move it.
  assert.deepEqual(estimate([seen(2, true), seen(12, false)], start), { warmMs: 30 * MINUTE, coldMs: undefined, measurements: 2 });
  // Two do.
  assert.deepEqual(estimate([seen(2, true), seen(12, false), seen(15, false)], start), { warmMs: 2 * MINUTE, coldMs: 12 * MINUTE, measurements: 3 });
});

await test("raises the lifetime past the starting value on one longer hit", () => {
  const start = { warmMs: 5 * MINUTE, coldMs: 6 * MINUTE };
  // As when PI_CACHE_RETENTION=long gives Claude an hour instead of the published 5 minutes.
  assert.deepEqual(estimate([seen(20, true)], start), { warmMs: 20 * MINUTE, coldMs: undefined, measurements: 1 });
  assert.deepEqual(estimate([seen(20, true), seen(45, true), seen(70, false)], start), { warmMs: 45 * MINUTE, coldMs: 70 * MINUTE, measurements: 3 });
});

await test("narrows the range between a measured hit and expiry", () => {
  const start = { warmMs: 5 * MINUTE, coldMs: undefined };
  assert.deepEqual(estimate([seen(3, true), seen(10, true), seen(20, false), seen(600, false)], start), { warmMs: 10 * MINUTE, coldMs: 20 * MINUTE, measurements: 4 });
});

await test("shows warm, may be cold, and cold by time since the last request", () => {
  const lifetime = { warmMs: 30 * MINUTE, coldMs: 60 * MINUTE };
  assert.equal(footer(lifetime, 12 * MINUTE, false, "$0.90"), "cache warm · ~18m left");
  assert.equal(footer(lifetime, 40 * MINUTE, false, "$0.90"), "cache may be cold · if expired ≈ $0.90");
  assert.equal(footer(lifetime, 60 * MINUTE, false, "$0.90"), "cache cold · resend ≈ $0.90");
  assert.equal(footer({ warmMs: 30 * MINUTE, coldMs: undefined }, 600 * MINUTE, false, "$0.90"), "cache may be cold · if expired ≈ $0.90");
});

await test("shows the cache as cold right after a model change", () => {
  assert.equal(footer({ warmMs: 30 * MINUTE, coldMs: undefined }, MINUTE, true, "$0.40"), "cache cold · resend ≈ $0.40");
});

await test("starts from pi's catalog, then the team's published lifetimes", () => {
  const rules = loadRules(join(repo, "extensions/cache-expiry/defaults.json"));
  const minutes = (id: string, catalog?: number): [number, number | undefined] => {
    const start = startingLifetime(rules, id, catalog);
    return [start.warmMs / MINUTE, start.coldMs === undefined ? undefined : start.coldMs / MINUTE];
  };
  assert.deepEqual(minutes("claude-opus-5-5", 3600), [60, 61]);
  assert.deepEqual(minutes("claude-sonnet-5.5"), [5, 6]);
  assert.deepEqual(minutes("gpt-6.1-sol"), [30, undefined]);
  assert.deepEqual(minutes("gpt-5.6-luna"), [30, undefined]);
  assert.deepEqual(minutes("gpt-5.5"), [5, 60]);
  assert.deepEqual(minutes("gpt-5.3-codex"), [5, 60]);
  assert.deepEqual(minutes("grok-4.7"), [5, undefined]);
});
