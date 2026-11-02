/**
 * Turns the host's session branch into the entries guests see, and works out
 * what to send so guests catch up with the branch.
 */
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Entry } from "../../src/protocol.ts";
import { scrub } from "../../src/scrub.ts";

/** The messages guests see for one entry: what pi itself shows, minus the system prompt and hidden custom messages. */
export function toEntry(entry: SessionEntry): Entry {
  const shown = sessionEntryToContextMessages(entry).filter((message) => message.role !== "system" && !(message.role === "custom" && !message.display));
  return { id: entry.id, messages: shown.map(scrub) };
}

export interface Change {
  readonly type: "append" | "reset";
  readonly entries: Entry[];
}

/** The whole branch, replacing whatever guests have. */
export function wholeBranch(branch: readonly SessionEntry[]): Change {
  return { type: "reset", entries: branch.map(toEntry).filter((entry) => entry.messages.length > 0) };
}

/** Entries in one message add up to at most this much JSON: well under the relay's 32 MiB limit. */
const PART_BYTES = 4 * 1024 * 1024;

/**
 * A change as the messages to send it in. A long session's branch can be
 * more than the relay takes in one message, so the entries are split: the
 * first part keeps the change's type, and the rest append to it.
 */
export function inParts(change: Change, maxBytes = PART_BYTES): Change[] {
  const parts: Change[] = [];
  let entries: Entry[] = [];
  let bytes = 0;
  const flush = (): void => {
    parts.push({ type: parts.length === 0 ? change.type : "append", entries });
    entries = [];
    bytes = 0;
  };
  for (const entry of change.entries) {
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (entries.length > 0 && bytes + size > maxBytes) {
      flush();
    }
    entries.push(entry);
    bytes += size;
  }
  flush();
  return parts;
}

/**
 * What to send, given the ids of the entries guests already have, in order.
 * New entries at the end are appended; any other difference (a /tree jump)
 * resends the whole branch. Returns undefined when nothing changed.
 */
export function catchUp(sent: readonly string[], branch: readonly SessionEntry[]): Change | undefined {
  const extends_ = sent.length <= branch.length && sent.every((id, index) => branch[index]?.id === id);
  if (!extends_) {
    return wholeBranch(branch);
  }
  const added = branch
    .slice(sent.length)
    .map(toEntry)
    .filter((entry) => entry.messages.length > 0);
  return added.length === 0 ? undefined : { type: "append", entries: added };
}
