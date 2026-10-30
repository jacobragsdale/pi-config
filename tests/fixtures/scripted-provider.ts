/**
 * Test-only provider with the model "scripted/model". Each reply costs
 * SCRIPTED_COST dollars (default 1). The
 * first SCRIPTED_TOOL_TURNS replies of a process call bash (or the tool named
 * by SCRIPTED_TOOL, with no arguments), so one prompt makes several requests. Every request that gets past
 * before_provider_request is logged in SCRIPTED_LOG as a line with its number
 * and model id. SCRIPTED_DELAY_MS holds each reply back, so a test can abort it.
 * Each reply uses 1000 input and 100 output tokens. SCRIPTED_STREAM_MS
 * streams the final reply as several text deltas
 * that many milliseconds apart, marked "pending" as real providers mark a
 * message still streaming.
 */
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;

function usage(usd: number): Usage {
  return { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { input: 0, output: usd, cacheRead: 0, cacheWrite: 0, total: usd } };
}

/** The streamed reply, in the pieces it arrives in. */
export const STREAMED_PIECES = ["Streaming ", "this reply ", "in pieces, ", "like a real provider ", "does."];

async function streamText(message: AssistantMessage, stream: AssistantMessageEventStream, delayMs: number): Promise<void> {
  const text = { type: "text" as const, text: "" };
  const partial: AssistantMessage = { ...message, stopReason: "pending", content: [text] };
  stream.push({ type: "text_start", contentIndex: 0, partial });
  for (const piece of STREAMED_PIECES) {
    await sleep(delayMs);
    text.text += piece;
    stream.push({ type: "text_delta", contentIndex: 0, delta: piece, partial });
  }
  stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial });
}

export default function scriptedProvider(pi: ExtensionAPI): void {
  let requests = 0;

  async function respond(model: Model<string>, options: SimpleStreamOptions | undefined, stream: AssistantMessageEventStream): Promise<void> {
    const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: usage(0), stopReason: "stop", timestamp: Date.now() };
    await options?.onPayload?.({ model: model.id }, model);
    const delay = Number(env("SCRIPTED_DELAY_MS", "0"));
    if (delay > 0) {
      // An abort ends the wait early; the check below reports it.
      await sleep(delay, undefined, options?.signal === undefined ? {} : { signal: options.signal }).catch(() => undefined);
    }
    if (options?.signal?.aborted === true) {
      const aborted: AssistantMessage = { ...message, stopReason: "aborted", errorMessage: "Request aborted" };
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
      return;
    }
    requests += 1;
    appendFileSync(env("SCRIPTED_LOG", "/dev/null"), `${String(requests)} ${model.id}\n`);
    stream.push({ type: "start", partial: message });
    const streamMs = Number(env("SCRIPTED_STREAM_MS", "0"));
    if (streamMs > 0 && requests > Number(env("SCRIPTED_TOOL_TURNS", "0"))) {
      await streamText(message, stream, streamMs);
    }
    const tool = env("SCRIPTED_TOOL", "bash");
    const final: AssistantMessage =
      requests <= Number(env("SCRIPTED_TOOL_TURNS", "0"))
        ? { ...message, stopReason: "toolUse", content: [{ type: "toolCall", id: `call-${String(requests)}`, name: tool, arguments: tool === "bash" ? { command: "true" } : {} }] }
        : { ...message, content: [{ type: "text", text: streamMs > 0 ? STREAMED_PIECES.join("") : "ok" }] };
    final.usage = usage(Number(env("SCRIPTED_COST", "1")));
    stream.push({ type: "done", reason: final.stopReason === "toolUse" ? "toolUse" : "stop", message: final });
    stream.end(final);
  }

  pi.registerProvider("scripted", {
    baseUrl: "http://scripted.invalid",
    apiKey: "scripted",
    api: "scripted",
    models: [{ id: "model", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 }],
    streamSimple: (model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      respond(model, options, stream).catch((err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const failed: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: usage(0),
          stopReason: "error",
          errorMessage,
          timestamp: Date.now()
        };
        stream.push({ type: "error", reason: "error", error: failed });
        stream.end(failed);
      });
      return stream;
    }
  });
}
