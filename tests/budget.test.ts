import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { PiRpc, isRecord, makeAgentDir, repo, requestCount, scriptedProvider } from "./pi-rpc.ts";

const budgetExtension = join(repo, "extensions/budget/index.ts");
const HOUR = 3_600_000;

interface SeedSpend {
  readonly usd: number;
  readonly hoursAgo: number;
}

/** Write earlier spend into the agent directory's ledger. */
function seed(agentDir: string, spends: readonly SeedSpend[]): void {
  const dir = join(agentDir, "spend");
  mkdirSync(dir, { recursive: true });
  for (const { usd, hoursAgo } of spends) {
    const t = Date.now() - hoursAgo * HOUR;
    const line = JSON.stringify({ t, usd, model: "seed/model", kind: "reply", session: "seed" });
    writeFileSync(join(dir, `${new Date(t).toISOString().slice(0, 7)}.jsonl`), `${line}\n`, { flag: "a" });
  }
}

function ledgerLines(agentDir: string): unknown[] {
  const dir = join(agentDir, "spend");
  return readdirSync(dir).flatMap((file) =>
    readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line): unknown => JSON.parse(line))
  );
}

const running: PiRpc[] = [];

function start(agentDir: string, env: Readonly<Record<string, string>> = {}, args?: readonly string[]): { pi: PiRpc; log: string } {
  const log = join(agentDir, "requests.log");
  const pi = new PiRpc({ agentDir, extensions: [budgetExtension, scriptedProvider], env: { SCRIPTED_LOG: log, ...env }, ...(args === undefined ? {} : { args }) });
  running.push(pi);
  return { pi, log };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((pi) => pi.close()));
});

await test("logs each reply's cost and shows spend in the footer", async () => {
  const agentDir = makeAgentDir();
  const { pi } = start(agentDir, { SCRIPTED_COST: "2.5" });
  await pi.prompt("hello");
  assert.deepEqual(
    ledgerLines(agentDir).map((line) => (isRecord(line) ? { ...line, t: 0, session: "" } : line)),
    [{ t: 0, usd: 2.5, model: "scripted/model", kind: "reply", session: "" }]
  );
  assert.equal(pi.lastStatus("budget"), "day $2.50/$40.00 · week $2.50/$100.00");
});

await test("warns once spend passes 80% of a limit", async () => {
  const agentDir = makeAgentDir();
  seed(agentDir, [{ usd: 31, hoursAgo: 1 }]);
  const { pi } = start(agentDir, { SCRIPTED_COST: "2" });
  await pi.prompt("hello");
  assert.deepEqual(pi.notices(), ["Budget: $33.00 of your $40.00 day limit spent in the last 1 day(s)."]);
});

await test("holds a prompt over the limit and sends nothing when declined", async () => {
  const agentDir = makeAgentDir();
  seed(agentDir, [{ usd: 40, hoursAgo: 1 }]);
  const { pi, log } = start(agentDir);
  assert.equal(await pi.prompt("hello"), "handled");
  assert.deepEqual(pi.confirmTitles(), ["Over your day budget"]);
  assert.equal(requestCount(log), 0);
  assert.ok(pi.records.some((r) => r["method"] === "set_editor_text" && r["text"] === "hello"));
});

await test("continues when confirmed and asks again one step later", async () => {
  const agentDir = makeAgentDir();
  seed(agentDir, [{ usd: 40, hoursAgo: 1 }]);
  const { pi, log } = start(agentDir, { SCRIPTED_COST: "5" });
  pi.confirmAnswers = [true];
  await pi.prompt("first");
  await pi.prompt("second");
  assert.equal(requestCount(log), 2);
  assert.deepEqual(pi.confirmTitles(), ["Over your day budget"]);
  // $50 spent; the step is 25% of $40, so the next ask was due at $50.
  assert.equal(await pi.prompt("third"), "handled");
  assert.deepEqual(pi.confirmTitles(), ["Over your day budget", "Over your day budget"]);
  assert.equal(requestCount(log), 2);
});

await test("stops a run that crosses the limit between requests", async () => {
  const agentDir = makeAgentDir();
  seed(agentDir, [{ usd: 38, hoursAgo: 1 }]);
  const { pi, log } = start(agentDir, { SCRIPTED_COST: "1", SCRIPTED_TOOL_TURNS: "5" });
  await pi.prompt("do a long task");
  assert.equal(requestCount(log), 2);
  assert.deepEqual(pi.confirmTitles(), ["Over your day budget"]);
  assert.ok(pi.notices().includes("Stopped: over budget. /budget shows your spend."));
});

await test("counts a rolling window: spend from 25 hours ago is in the week, not the day", async () => {
  const agentDir = makeAgentDir();
  seed(agentDir, [{ usd: 50, hoursAgo: 25 }]);
  const { pi, log } = start(agentDir);
  await pi.prompt("hello");
  assert.equal(requestCount(log), 1);
  assert.equal(pi.lastStatus("budget"), "day $1.00/$40.00 · week $51.00/$100.00");
});

await test("applies a personal budget.json over the team limits", async () => {
  const agentDir = makeAgentDir();
  writeFileSync(join(agentDir, "budget.json"), JSON.stringify({ windows: { day: { usd: 60 }, month: { hours: 720, usd: null } } }));
  seed(agentDir, [{ usd: 45, hoursAgo: 1 }]);
  const { pi, log } = start(agentDir);
  await pi.prompt("hello");
  assert.equal(requestCount(log), 1);
  assert.equal(pi.lastStatus("budget"), "day $46.00/$60.00 · week $46.00/$100.00 · month $46.00");
});

await test("turns limits off with an error when budget.json is invalid", async () => {
  const agentDir = makeAgentDir();
  writeFileSync(join(agentDir, "budget.json"), JSON.stringify({ windows: { day: { usd: "lots" } } }));
  seed(agentDir, [{ usd: 45, hoursAgo: 1 }]);
  const { pi, log } = start(agentDir);
  await pi.prompt("hello");
  assert.equal(requestCount(log), 1);
  assert.equal(pi.notices().filter((n) => n.startsWith("Budget limits are off until this is fixed:")).length, 1);
});

await test("shows spend by window and model with /budget", async () => {
  const agentDir = makeAgentDir();
  seed(agentDir, [{ usd: 3, hoursAgo: 30 }]);
  const { pi } = start(agentDir);
  await pi.prompt("hello");
  const from = pi.records.length;
  await pi.prompt("/budget");
  const report = pi.notices(from).at(-1) ?? "";
  assert.match(report, /^day: \$1\.00 in the last 1 day\(s\), limit \$40\.00$/m);
  assert.match(report, /^week: \$4\.00 in the last 7 day\(s\), limit \$100\.00$/m);
  assert.match(report, /^ {2}seed\/model \$3\.00$/m);
  assert.match(report, /^ {2}scripted\/model \$1\.00$/m);
});

await test("doesn't count a resumed session's earlier replies again", async () => {
  const agentDir = makeAgentDir();
  const sessions = ["--session-dir", join(agentDir, "sessions")];
  const first = start(agentDir, {}, sessions);
  await first.pi.prompt("hello");
  await first.pi.close();
  const second = start(agentDir, {}, [...sessions, "--continue"]);
  await second.pi.prompt("again");
  assert.equal(ledgerLines(agentDir).length, 2);
});

await test("stops without asking in print mode", () => {
  const agentDir = makeAgentDir();
  seed(agentDir, [{ usd: 40, hoursAgo: 1 }]);
  const log = join(agentDir, "requests.log");
  mkdirSync(join(agentDir, "work"), { recursive: true });
  const result = spawnSync("pi", ["-e", budgetExtension, "-e", scriptedProvider, "--no-session", "-p", "hello"], {
    cwd: join(agentDir, "work"),
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, SCRIPTED_LOG: log },
    input: "",
    encoding: "utf8",
    timeout: 30_000
  });
  assert.equal(requestCount(log), 0);
  assert.match(result.stderr, /pi budget: stopped, \$40\.00 of your \$40\.00 day limit spent in the last 1 day\(s\)/);
});
