import { existsSync, readFileSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Check } from "typebox/value";
import { parseJson, validate } from "../../src/json.ts";
import { MonthlyLog } from "../../src/monthly-log.ts";
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

/** Spend log shared by every pi process using the same agent directory, one line per billed call. */
export class Ledger extends MonthlyLog<Spend> {
  constructor(dir: string) {
    super(dir, (value): value is Spend => Check(SpendSchema, value));
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
