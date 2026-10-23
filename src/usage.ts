import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

/** The usage one session entry records, and which model or category it is billed to. */
export interface EntryUsage {
  readonly usage: Usage;
  readonly model: string;
  readonly kind: string;
}

/** What one session entry cost, and which model or category it is billed to. */
export interface EntryCost {
  readonly usd: number;
  readonly model: string;
  readonly kind: string;
}

function messageUsage(entry: SessionMessageEntry): EntryUsage | undefined {
  const message = entry.message;
  if (message.role === "assistant") {
    return { usage: message.usage, model: `${message.provider}/${message.responseModel ?? message.model}`, kind: "reply" };
  }
  if (message.role === "toolResult" && message.usage !== undefined) {
    return { usage: message.usage, model: "tools", kind: "tool" };
  }
  return undefined;
}

/** The usage a session entry records, counted the way pi's /session totals count it. */
export function entryUsage(entry: SessionEntry): EntryUsage | undefined {
  switch (entry.type) {
    case "usage":
      return { usage: entry.usage, model: `${entry.provider}/${entry.model}`, kind: entry.kind };
    case "compaction":
    case "branch_summary":
      return entry.usage === undefined ? undefined : { usage: entry.usage, model: "summaries", kind: entry.type };
    case "message":
      return messageUsage(entry);
    case "thinking_level_change":
    case "model_change":
    case "custom":
    case "custom_message":
    case "context_edit":
    case "label":
    case "session_info":
      return undefined;
  }
}

/** The cost of a session entry, or undefined when it cost nothing. */
export function entryCost(entry: SessionEntry): EntryCost | undefined {
  const found = entryUsage(entry);
  if (found === undefined || found.usage.cost.total <= 0) {
    return undefined;
  }
  return { usd: found.usage.cost.total, model: found.model, kind: found.kind };
}
