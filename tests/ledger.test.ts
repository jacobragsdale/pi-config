import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../extensions/budget/ledger.ts";

const spend = (t: number, usd: number): { t: number; usd: number; model: string; kind: string; session: string } => ({ t, usd, model: "m", kind: "reply", session: "s" });

await test("reads a window that spans two monthly files", () => {
  const ledger = new Ledger(mkdtempSync(join(tmpdir(), "ledger-")));
  const lastOfMonth = Date.UTC(2026, 9, 31, 20);
  const firstOfNext = Date.UTC(2026, 10, 1, 4);
  ledger.append([spend(Date.UTC(2026, 9, 1), 100), spend(lastOfMonth, 2), spend(firstOfNext, 3)]);
  const now = Date.UTC(2026, 10, 1, 12);
  assert.deepEqual(
    ledger.since(now - 24 * 3_600_000, now).map((s) => s.usd),
    [2, 3]
  );
});

await test("splits one batch across month files", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  new Ledger(dir).append([spend(Date.UTC(2026, 9, 31), 1), spend(Date.UTC(2026, 10, 1), 1)]);
  assert.deepEqual(
    readdirSync(dir).sort((a, b) => a.localeCompare(b)),
    ["2026-10.jsonl", "2026-11.jsonl"]
  );
});
