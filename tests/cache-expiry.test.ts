import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { PiRpc, makeAgentDir, repo, scriptedProvider } from "./pi-rpc.ts";

const cacheExtension = join(repo, "extensions/cache-expiry/index.ts");
const MINUTE = 60_000;

const running: PiRpc[] = [];

function start(agentDir: string, env: Readonly<Record<string, string>> = {}): PiRpc {
  const pi = new PiRpc({ agentDir, extensions: [cacheExtension, scriptedProvider], env });
  running.push(pi);
  return pi;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((pi) => pi.close()));
});

function observationLines(agentDir: string): string[] {
  const dir = join(agentDir, "cache-observations");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) =>
      readFileSync(join(dir, file), "utf8")
        .split("\n")
        .filter((line) => line !== "")
    );
}

/** Save a session on disk in which scripted/model's cache survived 10 minutes and expired after 20. */
function seedSession(agentDir: string): void {
  const t0 = Date.now() - 2 * 60 * MINUTE;
  const iso = new Date(t0).toISOString();
  const reply = (id: string, parentId: string, minute: number, cacheRead: number, cacheWrite: number): object => ({
    type: "message",
    id,
    parentId,
    timestamp: iso,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "scripted",
      provider: "scripted",
      model: "model",
      usage: { input: 10, output: 100, cacheRead, cacheWrite, totalTokens: 10 + cacheRead + cacheWrite + 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: t0 + minute * MINUTE
    }
  });
  const user = (id: string, parentId: string | null): object => ({ type: "message", id, parentId, timestamp: iso, message: { role: "user", content: "hi", timestamp: t0 } });
  const lines = [
    { type: "session", version: 3, id: "seed", timestamp: iso, cwd: "/tmp" },
    user("u1", null),
    reply("a1", "u1", 0, 0, 20_000),
    user("u2", "a1"),
    reply("a2", "u2", 10, 20_000, 500),
    user("u3", "a2"),
    reply("a3", "u3", 30, 0, 20_600)
  ];
  const dir = join(agentDir, "sessions", "--tmp--");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "seed.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

await test("shows the cache as warm in the footer after a reply", async () => {
  const pi = start(makeAgentDir());
  await pi.prompt("hello");
  // scripted/model has no published lifetime, so it starts from 5 minutes; under 5 are left.
  assert.equal(pi.lastStatus("cache"), "cache warm · ~4m left");
});

await test("learns a model's lifetime from the sessions already on disk, once", async () => {
  const agentDir = makeAgentDir();
  seedSession(agentDir);
  const first = start(agentDir);
  await first.prompt("hello");
  assert.equal(first.lastStatus("cache"), "cache warm · ~9m left");
  const from = first.records.length;
  await first.prompt("/cache");
  assert.match(first.notices(from).at(-1) ?? "", /^scripted\/model: warm up to 10m, cold after 20m · 2 measurements · starting value 5m \(no published lifetime\)$/m);
  await first.close();
  assert.equal(observationLines(agentDir).length, 2);

  const second = start(agentDir);
  await second.prompt("again");
  assert.equal(observationLines(agentDir).length, 2);
});

await test("logs a measurement for each gap between requests in a session", async () => {
  const agentDir = makeAgentDir();
  const pi = start(agentDir, { SCRIPTED_TOKENS: JSON.stringify({ input: 10, cacheRead: 20_000 }), SCRIPTED_STEP_MS: String(15 * MINUTE) });
  await pi.prompt("first");
  await pi.prompt("second");
  const from = pi.records.length;
  await pi.prompt("/cache");
  assert.match(pi.notices(from).at(-1) ?? "", /^scripted\/model: warm up to 15m, no expiry measured yet · 1 measurement · /m);
  assert.equal(observationLines(agentDir).length, 1);
});
