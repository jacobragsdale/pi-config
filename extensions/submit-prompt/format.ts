import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { redact } from "../../src/redact.ts";
import { entryCost } from "../../src/usage.ts";

export type Scope = "prompts" | "conversation";
export type Outcome = "worked" | "partly" | "did-not-work";

export interface SubmissionMeta {
  readonly submitted: Date;
  readonly author: string;
  readonly model: string;
  readonly thinking: string;
  readonly piConfig: string;
  readonly outcome: Outcome;
  readonly scope: Scope;
  readonly note: string;
}

export interface Draft {
  readonly markdown: string;
  readonly prompts: number;
  readonly redactions: number;
}

/** Longest tool argument or result kept in a conversation submission. */
const SNIPPET_CHARS = 600;

const truncate = (text: string): string => (text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS)}… (${String(text.length - SNIPPET_CHARS)} more characters)` : text);

const quote = (text: string): string =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

function textOf(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
}

function messages(branch: readonly SessionEntry[]): SessionEntry[] {
  return branch.filter((entry) => entry.type === "message");
}

function promptsBody(branch: readonly SessionEntry[]): string[] {
  const prompts = messages(branch).flatMap((entry) => (entry.type === "message" && entry.message.role === "user" ? [textOf(entry.message.content)] : []));
  return prompts.map((text, i) => `### Prompt ${String(i + 1)}\n\n${text}`);
}

function conversationBody(branch: readonly SessionEntry[]): string[] {
  const sections: string[] = [];
  for (const entry of messages(branch)) {
    if (entry.type !== "message") {
      continue;
    }
    const message = entry.message;
    if (message.role === "user") {
      sections.push(`### You\n\n${textOf(message.content)}`);
    } else if (message.role === "assistant") {
      const parts = message.content.flatMap((part) => {
        if (part.type === "text") {
          return [part.text];
        }
        return part.type === "toolCall" ? [`Tool \`${part.name}\`: \`${truncate(JSON.stringify(part.arguments))}\``] : [];
      });
      if (parts.length > 0) {
        sections.push(`### pi\n\n${parts.join("\n\n")}`);
      }
    } else if (message.role === "toolResult") {
      sections.push(`Result of \`${message.toolName}\`${message.isError ? " (error)" : ""}:\n\n${quote(truncate(textOf(message.content)))}`);
    }
  }
  return sections;
}

/** Front matter values are written as JSON strings and numbers, which are valid YAML. */
function frontMatter(fields: Readonly<Record<string, string | number>>): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join("\n")}\n---`;
}

/** Build a reviewable markdown submission from the current branch, with secrets masked. */
export function buildSubmission(branch: readonly SessionEntry[], meta: SubmissionMeta): Draft {
  const prompts = promptsBody(branch).length;
  const usd = branch.reduce((sum, entry) => sum + (entryCost(entry)?.usd ?? 0), 0);
  const toolCalls = messages(branch).reduce(
    (sum, entry) => sum + (entry.type === "message" && entry.message.role === "assistant" ? entry.message.content.filter((part) => part.type === "toolCall").length : 0),
    0
  );
  const body = [
    "## What I was trying to do",
    meta.note === "" ? "_No note._" : meta.note,
    meta.scope === "prompts" ? "## Prompts" : "## Conversation",
    ...(meta.scope === "prompts" ? promptsBody(branch) : conversationBody(branch))
  ].join("\n\n");
  const masked = redact(body);
  const header = frontMatter({
    submitted: meta.submitted.toISOString(),
    author: meta.author,
    outcome: meta.outcome,
    scope: meta.scope,
    model: meta.model,
    thinking: meta.thinking,
    prompts,
    tool_calls: toolCalls,
    cost_usd: Math.round(usd * 10_000) / 10_000,
    redactions: masked.count,
    pi_config: meta.piConfig
  });
  return { markdown: `${header}\n\n${masked.text}\n`, prompts, redactions: masked.count };
}
