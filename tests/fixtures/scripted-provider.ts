/**
 * Test-only provider "scripted/model". Each reply costs SCRIPTED_COST dollars
 * (default 1). The first SCRIPTED_TOOL_TURNS replies of a process call bash,
 * so one prompt makes several requests. Every request that gets past
 * before_provider_request is logged as a line in SCRIPTED_LOG.
 */
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;

function usage(usd: number): Usage {
  return { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { input: 0, output: usd, cacheRead: 0, cacheWrite: 0, total: usd } };
}

export default function scriptedProvider(pi: ExtensionAPI): void {
  let requests = 0;

  async function respond(model: Model<string>, options: SimpleStreamOptions | undefined, stream: AssistantMessageEventStream): Promise<void> {
    const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: usage(0), stopReason: "stop", timestamp: Date.now() };
    await options?.onPayload?.({ model: model.id }, model);
    if (options?.signal?.aborted === true) {
      const aborted: AssistantMessage = { ...message, stopReason: "aborted", errorMessage: "Request aborted" };
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
      return;
    }
    requests += 1;
    appendFileSync(env("SCRIPTED_LOG", "/dev/null"), `${String(requests)}\n`);
    stream.push({ type: "start", partial: message });
    const final: AssistantMessage =
      requests <= Number(env("SCRIPTED_TOOL_TURNS", "0"))
        ? { ...message, stopReason: "toolUse", content: [{ type: "toolCall", id: `call-${String(requests)}`, name: "bash", arguments: { command: "true" } }] }
        : { ...message, content: [{ type: "text", text: "ok" }] };
    final.usage = usage(Number(env("SCRIPTED_COST", "1")));
    stream.push({ type: "done", reason: final.stopReason === "toolUse" ? "toolUse" : "stop", message: final });
    stream.end(final);
  }

  pi.registerProvider("scripted", {
    baseUrl: "http://scripted.invalid",
    apiKey: "scripted",
    api: "scripted",
    models: [{ id: "model", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 }],
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
