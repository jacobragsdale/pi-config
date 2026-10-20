#!/usr/bin/env node
// Check a pi-config install against real GitHub Copilot. Run it after install.sh.
//
//   node scripts/smoke-copilot.mjs            # one tiny request to GPT-6 Luna, well under a cent
//   node scripts/smoke-copilot.mjs --default  # plus one to the team default (GPT-6.1 Sol, high thinking), a cent or two
//
// Exits 1 if any check fails.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const agent = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME ?? "", ".pi/agent");
const prices = JSON.parse(readFileSync(join(repo, "data/copilot-prices.json"), "utf8")).models;
let failures = 0;

const ok = (text) => console.log(`  ok    ${text}`);
const note = (text) => console.log(`  note  ${text}`);
const fail = (text) => {
  failures += 1;
  console.log(`  FAIL  ${text}`);
};
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined);
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", input: "", timeout: 180_000, ...options });

function checkInstall() {
  const settings = readJson(join(agent, "settings.json")) ?? {};
  const team = readJson(join(repo, "agent/settings.json"));
  const packages = (settings.packages ?? []).map((p) => (typeof p === "string" ? p : p.source));
  if (packages.some((p) => p.endsWith("pi-config"))) ok("pi-config is installed as a pi package");
  else fail("pi-config is not in settings.json packages; run install.sh");
  for (const key of ["defaultProvider", "defaultModel", "sessionShareDestination"]) {
    if (settings[key] === team[key]) ok(`${key} is ${JSON.stringify(team[key])}`);
    else fail(`${key} is ${JSON.stringify(settings[key])}, expected ${JSON.stringify(team[key])}; run install.sh`);
  }
  const list = run("pi", ["--list-models", "gpt-6.1-sol"]);
  if (/github-copilot\s+gpt-6\.1-sol\s+272K/.test(list.stdout)) ok("pi caps GPT-6.1 Sol at 272K, under the long-context price");
  else fail(`pi --list-models doesn't show github-copilot gpt-6.1-sol at 272K:\n${list.stdout}${list.stderr}`);
}

function checkUpdates() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  const fetch = run("git", ["-C", repo, "fetch", "--quiet"], { env, timeout: 30_000 });
  if (fetch.status === 0) ok("git can fetch pi-config without prompting, so update checks work");
  else fail(`git fetch failed without a prompt, so update checks won't work: ${fetch.stderr.trim()}`);
}

function checkPromptShare() {
  const dir = process.env.PI_PROMPT_SHARE_DIR || readJson(join(repo, "team.json"))?.promptShareDir;
  if (dir === undefined) fail("no shared folder for /submit-prompt: add promptShareDir to team.json");
  else if (!existsSync(join(dir, ".pi-prompt-share"))) fail(`${dir} has no .pi-prompt-share file; is it mounted?`);
  else ok(`/submit-prompt will save to ${dir}`);
}

function ledgerTotal() {
  const dir = join(agent, "spend");
  if (!existsSync(dir)) return { lines: 0, usd: 0 };
  const lines = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean));
  return { lines: lines.length, usd: lines.reduce((sum, line) => sum + JSON.parse(line).usd, 0) };
}

/** Price a usage record from data/copilot-prices.json, as GitHub publishes it. */
function githubPrice(modelId, usage) {
  const p = prices[modelId];
  if (p === undefined) return undefined;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const rates = p.longContext !== undefined && promptTokens > p.longContext.above ? p.longContext : p;
  return (usage.input * rates.input + usage.cacheRead * rates.cacheRead + usage.cacheWrite * rates.cacheWrite + usage.output * rates.output) / 1e6;
}

function liveRequest(model, thinking) {
  const label = `${model} (thinking ${thinking})`;
  const sessions = mkdtempSync(join(tmpdir(), "pi-smoke-"));
  const before = ledgerTotal();
  const result = run("pi", ["--model", `github-copilot/${model}`, "--thinking", thinking, "--session-dir", sessions, "-p", "Reply with exactly: ok"], {
    env: { ...process.env, PI_CONFIG_UPDATE_CHECK: "0" }
  });
  if (result.status !== 0 || !/\bok\b/i.test(result.stdout)) {
    fail(`${label}: request failed. Is pi signed in to Copilot (/login)?\n${result.stdout}${result.stderr}`);
    return;
  }
  ok(`${label}: Copilot answered`);
  const replies = readdirSync(sessions)
    .flatMap((f) => readFileSync(join(sessions, f), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line))
    .filter((e) => e.type === "message" && e.message.role === "assistant")
    .map((e) => e.message);
  const piCost = replies.reduce((sum, m) => sum + m.usage.cost.total, 0);
  const after = ledgerTotal();
  const logged = after.usd - before.usd;
  if (after.lines > before.lines && Math.abs(logged - piCost) < 1e-9) ok(`${label}: budget logged $${logged.toFixed(6)}, matching pi's session cost`);
  else fail(`${label}: budget logged $${logged.toFixed(6)} in ${after.lines - before.lines} line(s); pi's session cost is $${piCost.toFixed(6)}`);
  for (const m of replies) {
    const u = m.usage;
    const expected = githubPrice(model, u);
    const tokens = `input ${u.input}, cache read ${u.cacheRead}, cache write ${u.cacheWrite}, output ${u.output}${u.reasoning === undefined ? "" : ` (reasoning ${u.reasoning})`}`;
    note(`${label}: ${tokens}`);
    if (expected !== undefined && Math.abs(expected - u.cost.total) > 1e-9) fail(`${label}: pi priced it at $${u.cost.total.toFixed(6)}, GitHub's table gives $${expected.toFixed(6)}`);
    if (m.providerThinkingLevel !== undefined) note(`${label}: Copilot ran it at reasoning effort ${m.providerThinkingLevel}`);
  }
}

console.log(`pi-config smoke test for ${agent}`);
checkInstall();
checkUpdates();
checkPromptShare();
liveRequest("gpt-6-luna", "low");
if (process.argv.includes("--default")) liveRequest("gpt-6.1-sol", "high");
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
