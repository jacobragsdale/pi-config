#!/usr/bin/env node
// Deep-merge a team JSON file into a pi config file: objects merge key by key,
// and the team value wins for every key the team file sets. Keys the person
// set that the team file doesn't mention are kept. Backs up the target first.
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";

const [teamPath, targetPath] = process.argv.slice(2);
if (!teamPath || !targetPath) {
  console.error("usage: merge-json.mjs <team.json> <target.json>");
  process.exit(2);
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function merge(base, team) {
  if (!isObject(base) || !isObject(team)) return team;
  const out = { ...base };
  for (const [key, value] of Object.entries(team)) out[key] = merge(base[key], value);
  return out;
}

const team = JSON.parse(readFileSync(teamPath, "utf8"));
const target = existsSync(targetPath) ? realpathSync(targetPath) : targetPath;
const before = existsSync(target) ? readFileSync(target, "utf8") : null;
const current = before === null ? null : JSON.parse(before);
const merged = `${JSON.stringify(merge(current ?? {}, team), null, 2)}\n`;

// Compare parsed values: pi writes these files in its own formatting.
if (before !== null && merged === `${JSON.stringify(current, null, 2)}\n`) {
  console.log(`  unchanged ${targetPath}`);
} else {
  if (before !== null) {
    const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(target, backup);
    console.log(`  backup    ${backup}`);
  }
  writeFileSync(`${target}.tmp`, merged);
  renameSync(`${target}.tmp`, target);
  console.log(`  merged    ${targetPath}`);
}
