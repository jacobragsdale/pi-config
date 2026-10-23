import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger, loadConfig, monthPace, windowStart, windowStatuses } from "../extensions/budget/ledger.ts";
import type { BudgetConfig } from "../extensions/budget/ledger.ts";

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

const config: BudgetConfig = { windows: { day: { hours: 24, usd: 40 }, month: { calendar: "month", usd: 500 } }, warnAt: 0.8, continueStep: 0.25 };

await test("starts a calendar month at local midnight on the 1st", () => {
  assert.equal(windowStart({ calendar: "month", usd: null }, new Date(2026, 9, 22, 15).getTime()), new Date(2026, 9, 1).getTime());
});

await test("counts the day as the last 24 hours and the month from the 1st", () => {
  const now = new Date(2026, 9, 2, 10).getTime();
  const spends = [spend(new Date(2026, 8, 30, 23).getTime(), 7), spend(new Date(2026, 9, 1, 9).getTime(), 50), spend(new Date(2026, 9, 2, 9).getTime(), 1)];
  assert.deepEqual(
    windowStatuses(config, spends, now).map((w) => [w.name, w.spent, w.pace]),
    [
      ["day", 1, undefined],
      ["month", 51, 790.5]
    ]
  );
});

await test("projects a month's pace from its days so far, today included", () => {
  assert.equal(monthPace(100, new Date(2026, 9, 10, 8).getTime()), 310);
  assert.equal(monthPace(70, new Date(2027, 1, 14, 23).getTime()), 140);
});

await test("merges a personal limit into a calendar window, and rejects hours on one", () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-"));
  const team = join(dir, "team.json");
  const personal = join(dir, "budget.json");
  writeFileSync(team, JSON.stringify(config));
  writeFileSync(personal, JSON.stringify({ windows: { month: { usd: 600 } } }));
  assert.deepEqual(loadConfig(team, personal).windows["month"], { calendar: "month", usd: 600 });
  writeFileSync(personal, JSON.stringify({ windows: { month: { hours: 720 } } }));
  assert.throws(() => loadConfig(team, personal), /budget\.json/);
});
