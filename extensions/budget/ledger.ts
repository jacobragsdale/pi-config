import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Check } from "typebox/value";
import { parseJson, validate } from "../../src/json.ts";
import { entryCost } from "../../src/usage.ts";

const WindowSchema = Type.Object({ hours: Type.Number({ exclusiveMinimum: 0 }), usd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]) }, { additionalProperties: false });

const ConfigSchema = Type.Object(
  { windows: Type.Record(Type.String(), WindowSchema), warnAt: Type.Number({ exclusiveMinimum: 0, maximum: 1 }), continueStep: Type.Number({ exclusiveMinimum: 0 }) },
  { additionalProperties: false }
);

/** A person's budget.json: any subset of the team config, merged window by window. */
const PersonalSchema = Type.Object(
  {
    windows: Type.Optional(
      Type.Record(Type.String(), Type.Object({ hours: Type.Optional(WindowSchema.properties.hours), usd: Type.Optional(WindowSchema.properties.usd) }, { additionalProperties: false }))
    ),
    warnAt: Type.Optional(ConfigSchema.properties.warnAt),
    continueStep: Type.Optional(ConfigSchema.properties.continueStep)
  },
  { additionalProperties: false }
);

export type BudgetConfig = Static<typeof ConfigSchema>;

export function loadConfig(teamPath: string, personalPath: string): BudgetConfig {
  const team = parseJson(ConfigSchema, readFileSync(teamPath, "utf8"), teamPath);
  if (!existsSync(personalPath)) {
    return team;
  }
  const personal = parseJson(PersonalSchema, readFileSync(personalPath, "utf8"), personalPath);
  const windows: Record<string, unknown> = { ...team.windows };
  for (const [name, window] of Object.entries(personal.windows ?? {})) {
    windows[name] = { ...team.windows[name], ...window };
  }
  return validate(ConfigSchema, { windows, warnAt: personal.warnAt ?? team.warnAt, continueStep: personal.continueStep ?? team.continueStep }, personalPath);
}

const SpendSchema = Type.Object({ t: Type.Number(), usd: Type.Number(), model: Type.String(), kind: Type.String(), session: Type.String() }, { additionalProperties: false });

/** One billed model call: when it was recorded, its cost and where it came from. */
export type Spend = Readonly<Static<typeof SpendSchema>>;

/** The cost of a session entry as a ledger line, or undefined when it cost nothing. */
export function entrySpend(entry: SessionEntry, session: string, now: number): Spend | undefined {
  const cost = entryCost(entry);
  return cost === undefined ? undefined : { t: now, ...cost, session };
}

const monthKey = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

/**
 * Spend log shared by every pi process using the same agent directory, one
 * JSON line per billed call in a file per UTC month.
 */
export class Ledger {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  public append(spends: readonly Spend[]): void {
    if (spends.length === 0) {
      return;
    }
    mkdirSync(this.#dir, { recursive: true });
    const byMonth = new Map<string, string[]>();
    for (const item of spends) {
      const key = monthKey(item.t);
      byMonth.set(key, [...(byMonth.get(key) ?? []), JSON.stringify(item)]);
    }
    // One append per file: O_APPEND keeps lines from concurrent processes whole.
    for (const [key, lines] of byMonth) {
      appendFileSync(join(this.#dir, `${key}.jsonl`), `${lines.join("\n")}\n`);
    }
  }

  /** Spend recorded at or after `from`. Unreadable lines are skipped. */
  public since(from: number, now: number): Spend[] {
    const result: Spend[] = [];
    const start = new Date(from);
    for (let month = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1); month <= now;) {
      const file = join(this.#dir, `${monthKey(month)}.jsonl`);
      if (existsSync(file)) {
        for (const line of readFileSync(file, "utf8").split("\n")) {
          const item = parseLine(line);
          if (item !== undefined && item.t >= from) {
            result.push(item);
          }
        }
      }
      const date = new Date(month);
      month = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    }
    return result;
  }
}

function parseLine(line: string): Spend | undefined {
  if (line.trim() === "") {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(line);
    return Check(SpendSchema, value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface WindowStatus {
  readonly name: string;
  readonly hours: number;
  readonly limit: number | null;
  readonly spent: number;
}

export function windowStatuses(config: BudgetConfig, spends: readonly Spend[], now: number): WindowStatus[] {
  return Object.entries(config.windows).map(([name, window]) => {
    const from = now - window.hours * 3_600_000;
    const spent = spends.filter((item) => item.t >= from).reduce((sum, item) => sum + item.usd, 0);
    return { name, hours: window.hours, limit: window.usd, spent };
  });
}

export function longestWindowHours(config: BudgetConfig): number {
  return Math.max(0, ...Object.values(config.windows).map((window) => window.hours));
}
