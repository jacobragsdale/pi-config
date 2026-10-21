import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, test } from "node:test";
import { PiRpc, isRecord, makeAgentDir, repo, scriptedProvider } from "./pi-rpc.ts";
import type { RpcRecord } from "./pi-rpc.ts";

const compactionExtension = join(repo, "extensions/cheap-compaction/index.ts");

const running: PiRpc[] = [];

interface Setup {
  /** The session's model id on the scripted provider. */
  readonly sessionModel?: string;
  /** compaction.json in the agent directory (default: the cheap scripted model); null writes none. */
  readonly personal?: object | null;
  readonly reserveTokens?: number;
  readonly env?: Readonly<Record<string, string>>;
}

function start(setup: Setup = {}): { pi: PiRpc; log: string } {
  const agentDir = makeAgentDir();
  // Manual compaction only. keepRecentTokens: 1 cuts inside the last turn, so pi summarizes the history and that turn's start: two requests.
  const compaction = { enabled: false, keepRecentTokens: 1, ...(setup.reserveTokens === undefined ? {} : { reserveTokens: setup.reserveTokens }) };
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: setup.sessionModel ?? "model", compaction }));
  if (setup.personal !== null) {
    writeFileSync(join(agentDir, "compaction.json"), JSON.stringify(setup.personal ?? { model: "scripted/cheap" }));
  }
  const log = join(agentDir, "requests.log");
  const pi = new PiRpc({ agentDir, extensions: [compactionExtension, scriptedProvider], env: { SCRIPTED_LOG: log, ...setup.env } });
  running.push(pi);
  return { pi, log };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((pi) => pi.close()));
});

/** Model ids of the requests the scripted provider received, in order. */
function requestModels(log: string): string[] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split(" ")[1] ?? "");
}

/** The models the compaction's summary requests went to, after the two prompts. */
const compactionModels = (log: string): string[] => [...new Set(requestModels(log).slice(2))];

async function compactNow(pi: PiRpc): Promise<RpcRecord> {
  const from = pi.records.length;
  pi.send({ id: "compact", type: "compact" });
  return pi.waitFor((r) => r["type"] === "response" && r["id"] === "compact", from);
}

const succeeded = (response: RpcRecord): boolean => response["success"] === true;

async function converse(pi: PiRpc): Promise<void> {
  await pi.prompt("first");
  await pi.prompt("second");
}

await test("writes the summary with the cheap model", async () => {
  const { pi, log } = start();
  await converse(pi);
  assert.ok(succeeded(await compactNow(pi)));
  assert.deepEqual(compactionModels(log), ["cheap"]);
  assert.ok(pi.notices().includes("Compacted with scripted/cheap for $2.00."));
});

await test("records the cheap call's usage on the compaction", async () => {
  const { pi, log } = start();
  await converse(pi);
  const response = await compactNow(pi);
  const calls = requestModels(log).slice(2).length;
  const data = response["data"];
  assert.ok(isRecord(data));
  const usage = data["usage"];
  assert.ok(isRecord(usage) && isRecord(usage["cost"]));
  // Each scripted reply costs $1.
  assert.equal(usage["cost"]["total"], calls);
});

await test("compacts with the session's model when the cheap one isn't available", async () => {
  const { pi, log } = start({ personal: { model: "scripted/missing" } });
  await converse(pi);
  assert.ok(succeeded(await compactNow(pi)));
  assert.deepEqual(compactionModels(log), ["model"]);
  assert.ok(pi.notices().includes("Compacting with the session's model: scripted/missing isn't available."));
});

await test("compacts with the session's model when the summary wouldn't fit the cheap one", async () => {
  // pi asks for a summary of up to 80% of reserveTokens: 120K here, over the cheap model's 100K window.
  const { pi, log } = start({ reserveTokens: 150_000 });
  await converse(pi);
  await compactNow(pi);
  assert.deepEqual(compactionModels(log), ["model"]);
  assert.ok(pi.notices().includes("Compacting with the session's model: this compaction is too large for scripted/cheap."));
});

await test("stays out of the way when the session's model is no more expensive", async () => {
  const { pi, log } = start({ sessionModel: "cheap", personal: { model: "scripted/model" } });
  await converse(pi);
  assert.ok(succeeded(await compactNow(pi)));
  assert.deepEqual(requestModels(log).slice(0, 2), ["cheap", "cheap"]);
  assert.deepEqual(compactionModels(log), ["cheap"]);
  assert.deepEqual(pi.notices(), []);
});

await test("is off for the team until a person sets a model", async () => {
  const { pi, log } = start({ personal: null });
  await converse(pi);
  assert.ok(succeeded(await compactNow(pi)));
  assert.deepEqual(compactionModels(log), ["model"]);
  assert.deepEqual(pi.notices(), []);
});

await test("is off with PI_CHEAP_COMPACTION=0", async () => {
  const { pi, log } = start({ env: { PI_CHEAP_COMPACTION: "0" } });
  await converse(pi);
  await compactNow(pi);
  assert.deepEqual(compactionModels(log), ["model"]);
});

await test("cancels instead of falling back when the compaction is aborted", async () => {
  const { pi, log } = start({ env: { SCRIPTED_DELAY_MS: "1500" } });
  await converse(pi);
  const from = pi.records.length;
  pi.send({ id: "compact", type: "compact" });
  await sleep(300);
  pi.send({ id: "abort", type: "abort" });
  const response = await pi.waitFor((r) => r["type"] === "response" && r["id"] === "compact", from);
  assert.equal(succeeded(response), false);
  // Neither the cheap summary nor a fallback to the session's model reached the provider.
  assert.deepEqual(requestModels(log), ["model", "model"]);
  assert.deepEqual(
    pi.notices(from).filter((notice) => notice.includes("failed")),
    []
  );
});

await test("turns itself off with an error when compaction.json is invalid", async () => {
  const { pi, log } = start({ personal: { model: "no-slash" } });
  await converse(pi);
  await compactNow(pi);
  assert.deepEqual(compactionModels(log), ["model"]);
  assert.ok(pi.notices().some((notice) => notice.startsWith("Cheap compaction is off until this is fixed:")));
});
