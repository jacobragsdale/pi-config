#!/usr/bin/env node
// Compare pi's Copilot catalog with GitHub's published prices, and print the
// per-task cost table used in docs/models.md.
//
//   node scripts/prices.mjs check   # exit 1 on a price mismatch or a missing context cap
//   node scripts/prices.mjs table   # markdown table for docs/models.md
//
// Set PI_AI_DIR to the @earendil-works/pi-ai package directory if pi isn't found on PATH.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const prices = readJson(join(repo, "data/copilot-prices.json"));
const overrides = readJson(join(repo, "agent/models.json")).providers["github-copilot"].modelOverrides;

// Token profiles, derived from measured pi tasks (2026-10-16): a small task is
// ~90K cached input, ~18K new input and ~4K output. An hour-long task is the
// same mix at 100x, which prices at about $9.40 on GPT-6.1 Sol, in line with
// the ~$10 those tasks cost in practice.
const SMALL = { cached: 90_000, fresh: 18_000, output: 4_000 };
const HOUR = { cached: 9_000_000, fresh: 1_800_000, output: 400_000 };
const FIELDS = ["input", "cacheRead", "cacheWrite", "output"];

function findPiAi() {
  if (process.env.PI_AI_DIR) return process.env.PI_AI_DIR;
  const candidates = [];
  try {
    const bin = realpathSync(execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim());
    // Managed install: <agent>/bin/pi with <agent>/install/current-version.
    const agent = dirname(dirname(bin));
    const versionFile = join(agent, "install/current-version");
    if (existsSync(versionFile)) {
      const version = readFileSync(versionFile, "utf8").trim();
      candidates.push(join(agent, "install/releases", version, "node_modules/@earendil-works/pi-ai"));
    }
    // npm install: .../node_modules/@earendil-works/pi-coding-agent/dist/cli.js
    const nodeModules = bin.slice(0, bin.lastIndexOf("/node_modules/") + "/node_modules".length);
    candidates.push(join(nodeModules, "@earendil-works/pi-ai"));
    candidates.push(join(nodeModules, "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai"));
  } catch {
    // pi not on PATH
  }
  const found = candidates.find((dir) => existsSync(join(dir, "package.json")));
  if (!found) throw new Error("can't find pi's @earendil-works/pi-ai package; set PI_AI_DIR");
  return found;
}

function loadCatalog() {
  const dir = findPiAi();
  const data = readJson(join(dir, "dist/providers/data/github-copilot.json"));
  const version = readJson(join(dir, "package.json")).version;
  const models = new Map();
  for (const list of Object.values(data)) {
    for (const model of Array.isArray(list) ? list : Object.values(list)) {
      models.set(model.id, { ...model, ...overrides[model.id] });
    }
  }
  return { version, models };
}

const dollars = (n) => (n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

// Price a token profile. New input is billed as a cache write when the model
// charges for cache writes, and as plain input otherwise.
function taskCost(rates, profile) {
  const fresh = rates.cacheWrite > 0 ? rates.cacheWrite : rates.input;
  return (profile.cached * rates.cacheRead + profile.fresh * fresh + profile.output * rates.output) / 1e6;
}

function check() {
  const { version, models } = loadCatalog();
  const problems = [];
  const notes = [];
  for (const [id, github] of Object.entries(prices.models)) {
    const pi = models.get(id);
    if (!pi) {
      notes.push(`${id}: on GitHub's page but not in pi's catalog`);
      continue;
    }
    for (const field of FIELDS) {
      if (pi.cost[field] !== github[field]) {
        problems.push(`${id}: ${field} pi=${pi.cost[field]} github=${github[field]}`);
      }
    }
    const tier = pi.cost.tiers?.[0];
    const long = github.longContext;
    if (long && !tier) problems.push(`${id}: GitHub has a long-context tier above ${long.above}; pi has none`);
    if (tier && !long) problems.push(`${id}: pi has a tier above ${tier.inputTokensAbove}; GitHub has none`);
    if (tier && long) {
      if (tier.inputTokensAbove !== long.above) {
        problems.push(`${id}: tier threshold pi=${tier.inputTokensAbove} github=${long.above}`);
      }
      for (const field of FIELDS) {
        if (tier[field] !== long[field]) problems.push(`${id}: long-context ${field} pi=${tier[field]} github=${long[field]}`);
      }
    }
    if (long && pi.contextWindow > long.above) {
      problems.push(`${id}: contextWindow ${pi.contextWindow} is above the ${long.above} price threshold; cap it in agent/models.json`);
    }
  }
  for (const id of models.keys()) {
    if (!prices.models[id]) notes.push(`${id}: in pi's catalog but not on GitHub's page (retired?)`);
  }
  console.log(`pi-ai ${version} vs GitHub prices checked ${prices.checked}`);
  for (const note of notes) console.log(`  note     ${note}`);
  for (const problem of problems) console.log(`  PROBLEM  ${problem}`);
  if (problems.length === 0) console.log("  prices match and every tiered model is capped");
  process.exitCode = problems.length === 0 ? 0 : 1;
}

function table() {
  const rows = Object.entries(prices.models)
    .map(([id, p]) => ({ id, p, small: taskCost(p, SMALL), hour: taskCost(p, HOUR) }))
    .sort((a, b) => a.small - b.small);
  console.log("| Model | Small task | Hour-long task | Hour-long, above the threshold | Threshold |");
  console.log("|---|---:|---:|---:|---:|");
  for (const { id, p, small, hour } of rows) {
    const long = p.longContext;
    const above = long ? dollars(taskCost(long, HOUR)) : "—";
    const threshold = long ? `${long.above / 1000}K` : "—";
    console.log(`| \`${id}\` | ${dollars(small)} | ${dollars(hour)} | ${above} | ${threshold} |`);
  }
}

const command = process.argv[2];
if (command === "check") check();
else if (command === "table") table();
else {
  console.error("usage: prices.mjs check|table");
  process.exitCode = 2;
}
