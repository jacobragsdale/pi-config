import { existsSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import type { Static } from "typebox";
import { parseJson } from "../../src/json.ts";

const ThinkingSchema = Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")]);

/** `provider/model`, or null for pi's own compaction on the session's model. */
const ModelSchema = Type.Union([Type.String({ pattern: "^[^/]+/.+$" }), Type.Null()]);

const ConfigSchema = Type.Object({ model: ModelSchema, thinkingLevel: ThinkingSchema }, { additionalProperties: false });
const PersonalSchema = Type.Object({ model: Type.Optional(ModelSchema), thinkingLevel: Type.Optional(ThinkingSchema) }, { additionalProperties: false });

/** The model that writes compaction summaries and its thinking level. */
export type CompactionConfig = Static<typeof ConfigSchema>;

/** The team config, with any keys a person's file sets in its place. */
export function loadConfig(teamPath: string, personalPath: string): CompactionConfig {
  const team = parseJson(ConfigSchema, readFileSync(teamPath, "utf8"), teamPath);
  if (!existsSync(personalPath)) {
    return team;
  }
  const personal = parseJson(PersonalSchema, readFileSync(personalPath, "utf8"), personalPath);
  return { model: personal.model === undefined ? team.model : personal.model, thinkingLevel: personal.thinkingLevel ?? team.thinkingLevel };
}

/** Split `provider/model` at the first slash; model ids may contain more. */
export function splitModel(key: string): { readonly provider: string; readonly id: string } {
  const slash = key.indexOf("/");
  return { provider: key.slice(0, slash), id: key.slice(slash + 1) };
}
