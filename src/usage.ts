import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

/** What one session entry cost, and which model or category it is billed to. */
export interface EntryCost {
  readonly usd: number;
  readonly model: string;
  readonly kind: string;
}

function cost(usage: Usage, model: string, kind: string): EntryCost | undefined {
  const usd = usage.cost.total;
  return usd > 0 ? { usd, model, kind } : undefined;
}

function messageCost(entry: SessionMessageEntry): EntryCost | undefined {
  const message = entry.message;
  if (message.role === "assistant") {
    return cost(message.usage, `${message.provider}/${message.responseModel ?? message.model}`, "reply");
  }
  if (message.role === "toolResult" && message.usage !== undefined) {
    return cost(message.usage, "tools", "tool");
  }
  return undefined;
}

/** The cost of a session entry, counted the way pi's /session totals count it. */
export function entryCost(entry: SessionEntry): EntryCost | undefined {
  switch (entry.type) {
    case "usage":
      return cost(entry.usage, `${entry.provider}/${entry.model}`, entry.kind);
    case "compaction":
    case "branch_summary":
      return entry.usage === undefined ? undefined : cost(entry.usage, "summaries", entry.type);
    case "message":
      return messageCost(entry);
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
