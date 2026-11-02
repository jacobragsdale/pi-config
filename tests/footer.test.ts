import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { cwdLabel, usageTotals } from "../extensions/live/footer.ts";
import type { Meta } from "../src/protocol.ts";
import { GuestFooter, modelLabel, tokenUse } from "../relay/footer.ts";
import { useHostLook } from "../relay/look.ts";

useHostLook(() => undefined);

const at = "2026-10-27T12:00:00.000Z";

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number): Usage => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total }
});

function reply(id: string, spent: Usage): SessionEntry {
  const message: AssistantMessage = { role: "assistant", content: [], api: "test", provider: "test", model: "m", usage: spent, stopReason: "stop", timestamp: 1 };
  return { type: "message", id, parentId: null, timestamp: at, message };
}

await test("usage adds up every reply, and the cache hit rate is the latest reply's", () => {
  const entries = [reply("a", usage(1000, 100, 0, 500, 0.01)), reply("b", usage(200, 50, 1500, 0, 0.002))];
  assert.deepEqual(usageTotals(entries), { input: 1200, output: 150, cacheRead: 1500, cacheWrite: 500, cost: 0.012, cacheHitRate: (1500 / 1700) * 100 });
});

await test("usage outside replies counts too", () => {
  const warm: SessionEntry = { type: "usage", id: "w", parentId: null, timestamp: at, kind: "cache_warm", provider: "test", model: "m", usage: usage(0, 0, 900, 0, 0.001) };
  assert.equal(usageTotals([warm]).cacheRead, 900);
  assert.equal(usageTotals([warm]).cacheHitRate, undefined);
});

await test("the directory is shown with ~ for home, as pi shows it", () => {
  assert.equal(cwdLabel("/home/jacob", "/home/jacob"), "~");
  assert.equal(cwdLabel("/home/jacob/dev/shop", "/home/jacob"), "~/dev/shop");
  assert.equal(cwdLabel("/srv/shop", "/home/jacob"), "/srv/shop");
  assert.equal(cwdLabel("/home/jacobs-old", "/home/jacob"), "/home/jacobs-old");
});

const facts: Meta = {
  cwd: "/home/jacob/dev/shop",
  cwdLabel: "~/dev/shop",
  gitBranch: "main",
  model: { provider: "github-copilot", id: "claude-haiku-5.5", reasoning: true },
  showProvider: true,
  thinking: "xhigh",
  usage: { input: 2800, output: 40, cacheRead: 97_000, cacheWrite: 75, cost: 0.0123, cacheHitRate: 97.3 },
  context: { percent: 12.5, contextWindow: 84_000 },
  autoCompact: true
};

await test("token use is compact, as pi's footer shows it, and leaves out what is zero", () => {
  assert.equal(tokenUse(facts.usage), "↑2.8k ↓40 R97k W75 CH97.3%");
  assert.equal(tokenUse({ input: 940, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }), "↑940");
});

await test("the editor's border names the host's model and thinking level", () => {
  assert.equal(modelLabel(facts), "claude-haiku-5.5 · xhigh");
  assert.equal(modelLabel({ ...facts, thinking: "off" }), "claude-haiku-5.5 · thinking off");
  assert.equal(modelLabel({ ...facts, model: { provider: "p", id: "plain", reasoning: false } }), "plain");
  const noModel: Meta = { ...facts };
  delete noModel.model;
  assert.equal(modelLabel(noModel), "no model");
});

await test("a guest's footer is one line: where the host works, then whose stream it is and how many joined, token use and cost", () => {
  const footer = new GuestFooter(() => ({ meta: facts, host: "jacob", joined: 2 }));
  const lines = footer.render(120).map((line) => stripTerminalSequences(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /^~\/dev\/shop · main +● live · jacob · 2 joined · ↑2\.8k ↓40 R97k W75 CH97\.3% · \$0\.012$/);
  assert.deepEqual(
    footer.render(60).map((line) => stripTerminalSequences(line)),
    ["~/dev/shop · main", "● live · jacob · 2 joined · ↑2.8k ↓40 R97k W75 CH97.3% · $0…"]
  );
  const fresh = new GuestFooter(() => ({ meta: { ...facts, gitBranch: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }, host: "sam", joined: 1 }));
  assert.match(stripTerminalSequences(fresh.render(80)[0] ?? ""), /^~\/dev\/shop +● live · sam · 1 joined$/);
});
