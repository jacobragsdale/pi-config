import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Session files under `dir`, at any depth. */
export function sessionFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => join(dir, file));
  } catch {
    return [];
  }
}

/** A saved session's working directory and entries. */
export interface SavedSession {
  readonly cwd: string;
  readonly entries: SessionEntry[];
}

/** Read a session file. One that can't be read has no entries. */
export function readSession(file: string): SavedSession {
  try {
    const entries = parseSessionEntries(readFileSync(file, "utf8"));
    migrateSessionEntries(entries);
    const header = entries.find((entry) => entry.type === "session");
    return { cwd: header?.cwd ?? "", entries: entries.filter((entry) => entry.type !== "session") };
  } catch {
    return { cwd: "", entries: [] };
  }
}
