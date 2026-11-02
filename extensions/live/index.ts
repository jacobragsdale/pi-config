/**
 * /live: stream this pi session to colleagues through a pi-live relay. Guests
 * join with the ssh command /live shows above the editor until someone joins,
 * follow the conversation as it happens, and can suggest prompts. Suggestions
 * wait above the editor until you accept one (alt+s), which runs it, or reject
 * it (alt+x); nothing a guest types reaches the agent unless you accept it.
 * Both are drawn between two rules, which the look turns into a card.
 *
 * Run /live again to end the stream; quitting pi ends it too. The stream
 * follows you across /new, /resume, /fork and /tree.
 *
 * The relay's address comes from PI_LIVE_URL, or from url in
 * ~/.pi/agent/live.json. PI_LIVE=0 turns the extension off.
 */
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { DynamicBorder, VERSION, copyToClipboard, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { parseJson } from "../../src/json.ts";
import { printable, printableLine } from "../../src/printable.ts";
import { PROTOCOL_VERSION, RelayMessageSchema } from "../../src/protocol.ts";
import type { HostMessage, RelayMessage, SuggestionStatus } from "../../src/protocol.ts";
import { scrub, scrubPartial } from "../../src/scrub.ts";
import { footerMeta, gitBranch } from "./footer.ts";
import { catchUp, inParts, wholeBranch } from "./transcript.ts";
import type { Change } from "./transcript.ts";

const ConfigSchema = Type.Object({ url: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });

const KEY = "live";
const ACCEPT_KEY = "alt+s";
const REJECT_KEY = "alt+x";
/** Streaming text and tool output are sent at most this often. */
const THROTTLE_MS = 100;
/** Catches entries no event announces, such as ! commands. */
const SYNC_MS = 500;
const READY_TIMEOUT_MS = 10_000;
const SHOWN_SUGGESTIONS = 3;
/** The footer names this many guests, then counts the rest. */
const SHOWN_GUESTS = 3;

interface Suggestion {
  readonly id: string;
  readonly from: string;
  readonly text: string;
}

/** One live stream. It lives on globalThis because /new, /resume, /fork and /reload load a fresh copy of this extension. */
interface Live {
  readonly socket: WebSocket;
  readonly join: string;
  /** Whether the join command went to the host's clipboard. */
  copied: boolean;
  guests: readonly string[];
  readonly suggestions: Suggestion[];
  /** Ids of the branch entries guests have, in order. */
  sent: string[];
}

declare global {
  var piLiveStream: Live | undefined;
}

type Ready = Extract<RelayMessage, { type: "ready" }>;

function relayUrl(): string | undefined {
  const fromEnv = process.env["PI_LIVE_URL"];
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  const path = join(getAgentDir(), "live.json");
  return existsSync(path) ? parseJson(ConfigSchema, readFileSync(path, "utf8"), path).url : undefined;
}

function hostName(): string {
  const name = process.env["PI_LIVE_NAME"] ?? userInfo().username;
  const trimmed = name.slice(0, 64);
  return trimmed === "" ? "host" : trimmed;
}

function parseRelayMessage(data: unknown): RelayMessage | undefined {
  if (typeof data !== "string") {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(data);
    return Check(RelayMessageSchema, value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const oneLine = (text: string): string => truncateToWidth(printableLine(text), 160, "…");

/** A guest's name as the relay sent it, on one printable line. */
function guestName(name: string): string {
  const line = printableLine(name);
  return line === "" ? "guest" : line;
}

/** Who has joined, for the footer: every name up to SHOWN_GUESTS, else two and a count. */
export function guestNames(names: readonly string[]): string {
  if (names.length === 0) {
    return "nobody joined yet";
  }
  return names.length <= SHOWN_GUESTS ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${String(names.length - 2)}`;
}

/** What waits above the editor: the suggestions, else the join command until someone joins. */
export function cardLines(stream: Pick<Live, "join" | "copied" | "guests" | "suggestions">, theme: Theme): string[] | undefined {
  const [first] = stream.suggestions;
  if (first !== undefined) {
    const shown = stream.suggestions.slice(0, SHOWN_SUGGESTIONS);
    const width = Math.max(...shown.map((s) => s.from.length));
    const lines = shown.map((s, i) => `${theme.fg(i === 0 ? "accent" : "muted", s.from.padEnd(width))}  ${oneLine(s.text)}`);
    const more = stream.suggestions.length - shown.length;
    const hint = `${ACCEPT_KEY} accepts ${first.from}'s and runs it · ${REJECT_KEY} rejects it${more > 0 ? ` · ${String(more)} more waiting` : ""}`;
    return [...lines, theme.fg("dim", hint)];
  }
  if (stream.guests.length === 0) {
    return [`Live. Send this to whoever should join${stream.copied ? " (copied)" : ""}:`, `  ${theme.fg("mdCode", stream.join)}`, theme.fg("dim", "/live link shows it again · /live ends the stream")];
  }
  return undefined;
}

/** `lines` between two rules, as pi draws its own blocks, and a blank line under them; the look draws the rules as a card. */
function ruled(lines: readonly string[], theme: Theme): Container {
  const block = new Container();
  const rule = (): DynamicBorder => new DynamicBorder((text) => theme.fg("borderMuted", text));
  block.addChild(rule());
  for (const line of lines) {
    block.addChild(new Text(line, 1, 0));
  }
  block.addChild(rule());
  block.addChild(new Spacer(1));
  return block;
}

/** Open a socket to the relay and wait for it to hand out the join command. */
function connect(url: string): Promise<{ socket: WebSocket; ready: Ready }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const fail = (message: string): void => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(message));
    };
    const timer = setTimeout(() => {
      fail(`The relay at ${url} didn't answer within ${String(READY_TIMEOUT_MS / 1000)} seconds.`);
    }, READY_TIMEOUT_MS);
    socket.onopen = (): void => {
      const hello: HostMessage = { type: "hello", protocol: PROTOCOL_VERSION, piVersion: VERSION, host: hostName() };
      socket.send(JSON.stringify(hello));
    };
    socket.onmessage = (event): void => {
      const message = parseRelayMessage(event.data);
      if (message?.type === "ready") {
        clearTimeout(timer);
        resolve({ socket, ready: message });
      } else if (message?.type === "error") {
        fail(`The relay refused the stream: ${message.message}`);
      }
    };
    socket.onclose = (): void => {
      fail(`Couldn't reach the relay at ${url}.`);
    };
  });
}

/** Runs the latest call at most once per THROTTLE_MS. */
class Throttle {
  #timer: NodeJS.Timeout | undefined;
  #last = 0;

  public run(fn: () => void): void {
    clearTimeout(this.#timer);
    const wait = THROTTLE_MS - (Date.now() - this.#last);
    if (wait <= 0) {
      this.#last = Date.now();
      fn();
      return;
    }
    this.#timer = setTimeout(() => {
      this.#last = Date.now();
      fn();
    }, wait);
  }

  public cancel(): void {
    clearTimeout(this.#timer);
  }
}

export default function live(pi: ExtensionAPI): void {
  if (process.env["PI_LIVE"] === "0") {
    return;
  }
  /**
   * The latest context this copy of the extension saw; undefined until its
   * session starts. pi makes it stale once the session shuts down, so code
   * that runs later, from a timer, a promise or the socket, checks `attached`
   * before touching it.
   */
  let ctx: ExtensionContext | undefined;
  let attached = false;
  /** Whether this copy's session is still running: false once /new, /resume, /fork or /reload replaces it. */
  let active = true;
  /** Whether /live is waiting for the relay to answer. */
  let connecting = false;
  let branch: string | undefined;
  let syncTimer: NodeJS.Timeout | undefined;
  /** Whether /compact is running: pi refuses prompts until it's done, where it queues them while the agent works or retries. */
  let compacting = false;
  const tail = new Throttle();
  const tools = new Map<string, Throttle>();

  const current = (): Live | undefined => globalThis.piLiveStream;

  function send(message: HostMessage): void {
    const socket = current()?.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function sendChange(change: Change): void {
    for (const part of inParts(change)) {
      send(part);
    }
  }

  function sync(): void {
    const stream = current();
    if (stream === undefined || ctx === undefined || !attached) {
      return;
    }
    const branch = ctx.sessionManager.getBranch();
    const change = catchUp(stream.sent, branch);
    stream.sent = branch.map((entry) => entry.id);
    if (change !== undefined) {
      sendChange(change);
    }
  }

  function sendMeta(): void {
    if (ctx !== undefined && attached && current() !== undefined) {
      send({ type: "meta", ...footerMeta(ctx, pi.getThinkingLevel(), branch) });
    }
  }

  /** Look up the git branch, which the agent may have changed, then resend the footer. */
  function refreshBranch(): void {
    if (ctx === undefined) {
      return;
    }
    gitBranch(ctx.cwd).then(
      (found) => {
        branch = found;
        sendMeta();
      },
      () => undefined
    );
  }

  function showState(): void {
    const stream = current();
    if (ctx === undefined || !attached || stream === undefined) {
      return;
    }
    const { theme } = ctx.ui;
    ctx.ui.setStatus(KEY, `${theme.fg("success", "● live")} · ${guestNames(stream.guests)}`);
    const lines = cardLines(stream, theme);
    if (lines === undefined) {
      ctx.ui.setWidget(KEY, undefined);
    } else if (ctx.mode === "tui") {
      ctx.ui.setWidget(KEY, (_tui, current) => ruled(lines, current));
    } else {
      ctx.ui.setWidget(KEY, lines);
    }
  }

  function clearState(): void {
    ctx?.ui.setStatus(KEY, undefined);
    ctx?.ui.setWidget(KEY, undefined);
  }

  function onRelayMessage(socket: WebSocket, data: unknown): void {
    const stream = current();
    const message = parseRelayMessage(data);
    if (stream?.socket !== socket) {
      return;
    }
    switch (message?.type) {
      // Names and suggestions are what guests typed: draw none of the escape sequences they might hold.
      case "guests":
        stream.guests = message.names.map(guestName);
        break;
      case "suggestion": {
        const text = printable(message.text).trim();
        if (text === "") {
          send({ type: "suggestion_status", id: message.id, status: "dismissed" });
        } else {
          stream.suggestions.push({ id: message.id, from: guestName(message.from), text });
        }
        break;
      }
      case "error":
        if (attached) {
          ctx?.ui.notify(`pi-live relay: ${message.message}`, "error");
        }
        break;
      case "ready":
      case undefined:
        break;
    }
    showState();
  }

  function onRelayClosed(stream: Live): void {
    if (current() !== stream) {
      return;
    }
    globalThis.piLiveStream = undefined;
    if (!attached) {
      return;
    }
    detach();
    clearState();
    ctx?.ui.notify("The live stream dropped: the relay closed the connection. Run /live to start a new one.", "warning");
  }

  /** Bind the stream to this copy of the extension and bring guests up to date. */
  function attach(): void {
    const stream = current();
    if (stream === undefined) {
      return;
    }
    attached = true;
    stream.socket.onmessage = (event): void => {
      onRelayMessage(stream.socket, event.data);
    };
    stream.socket.onclose = (): void => {
      onRelayClosed(stream);
    };
    clearInterval(syncTimer);
    syncTimer = setInterval(sync, SYNC_MS);
    sendMeta();
    refreshBranch();
    send({ type: "activity", working: !(ctx?.isIdle() ?? true) });
    // This may be another session than guests have (/new, /resume, /fork), so replace their transcript.
    const branch = ctx?.sessionManager.getBranch() ?? [];
    stream.sent = branch.map((entry) => entry.id);
    sendChange(wholeBranch(branch));
    showState();
  }

  function detach(): void {
    attached = false;
    clearInterval(syncTimer);
    tail.cancel();
    for (const throttle of tools.values()) {
      throttle.cancel();
    }
    tools.clear();
  }

  function end(notify: boolean): void {
    const stream = current();
    if (stream === undefined) {
      return;
    }
    globalThis.piLiveStream = undefined;
    detach();
    stream.socket.close(1000, "host ended the stream");
    clearState();
    if (notify) {
      ctx?.ui.notify("Stream ended. Its link no longer works.", "info");
    }
  }

  async function copyJoin(join: string): Promise<string> {
    // Over SSH, pi copies by writing an escape sequence to stdout, which only the TUI can do safely.
    if (ctx?.mode !== "tui") {
      return "";
    }
    try {
      await copyToClipboard(join);
      return " (copied)";
    } catch {
      return "";
    }
  }

  async function start(): Promise<void> {
    const url = relayUrl();
    if (url === undefined) {
      ctx?.ui.notify('No relay is set up. Set PI_LIVE_URL, or put {"url": "wss://<relay>/host"} in ~/.pi/agent/live.json.', "error");
      return;
    }
    connecting = true;
    const { socket, ready } = await connect(url).finally(() => {
      connecting = false;
    });
    if (!active) {
      // The session was replaced while the relay answered.
      socket.close(1000, "host left before the stream started");
      return;
    }
    const stream: Live = { socket, join: ready.join, copied: false, guests: [], suggestions: [], sent: [] };
    globalThis.piLiveStream = stream;
    attach();
    stream.copied = (await copyJoin(ready.join)) !== "";
    showState();
    if (attached && ready.piVersion !== VERSION) {
      ctx?.ui.notify(`The relay draws with pi ${ready.piVersion} and you run ${VERSION}, so guests may see small differences.`, "warning");
    }
  }

  /** Answer the first waiting suggestion. An accepted one runs now, or after the current turn when the agent is working. */
  function answer(accept: boolean, context: ExtensionContext): void {
    const stream = current();
    const next = stream?.suggestions[0];
    if (stream === undefined || next === undefined) {
      context.ui.notify("No suggestions are waiting.", "info");
      return;
    }
    if (accept && compacting && !context.isIdle()) {
      context.ui.notify(`pi is compacting. Accept ${next.from}'s suggestion once it's done.`, "warning");
      return;
    }
    stream.suggestions.shift();
    const status: SuggestionStatus = accept ? "used" : "dismissed";
    send({ type: "suggestion_status", id: next.id, status });
    showState();
    if (accept) {
      // It goes to the model as written: pi runs no / commands or skills from an extension's prompt.
      // A follow-up runs now when pi is idle, and after the current turn when it isn't, even when the
      // turn is one an accept a moment ago started and isIdle() doesn't show yet.
      pi.sendUserMessage(next.text, { deliverAs: "followUp" });
    }
  }

  pi.registerCommand("live", {
    description: "Stream this session to colleagues over ssh; run it again to end the stream",
    getArgumentCompletions: (prefix) => ["link", "accept", "reject"].filter((word) => word.startsWith(prefix)).map((word) => ({ value: word, label: word })),
    handler: async (args, context) => {
      ctx = context;
      if (!context.hasUI) {
        context.ui.notify("/live needs the interactive UI.", "error");
        return;
      }
      const stream = current();
      switch (args.trim()) {
        case "":
          if (connecting) {
            context.ui.notify("Still waiting for the relay to answer.", "info");
          } else if (stream === undefined) {
            await start().catch((err: unknown) => {
              context.ui.notify(err instanceof Error ? err.message : String(err), "error");
            });
          } else {
            end(true);
          }
          return;
        case "link":
          context.ui.notify(stream === undefined ? "Not live. Run /live to start a stream." : `Guests join with:\n  ${stream.join}${await copyJoin(stream.join)}`, "info");
          return;
        case "accept":
          answer(true, context);
          return;
        case "reject":
          answer(false, context);
          return;
        default:
          context.ui.notify("Usage: /live (start or end), /live link, /live accept, /live reject", "warning");
      }
    }
  });

  pi.registerShortcut(ACCEPT_KEY, {
    description: "Accept the first live-stream suggestion and run it",
    handler: (context) => {
      ctx = context;
      answer(true, context);
    }
  });
  pi.registerShortcut(REJECT_KEY, {
    description: "Reject the first live-stream suggestion",
    handler: (context) => {
      ctx = context;
      answer(false, context);
    }
  });

  pi.on("session_start", (_event, context) => {
    ctx = context;
    attach();
  });

  pi.on("session_shutdown", (event, context) => {
    ctx = context;
    active = false;
    if (event.reason === "quit") {
      end(false);
    } else {
      detach();
    }
  });

  pi.on("message_start", (event, context) => {
    ctx = context;
    if (event.message.role === "assistant") {
      sync();
      send({ type: "tail", message: scrubPartial(event.message) });
    }
  });

  pi.on("message_update", (event, context) => {
    ctx = context;
    if (event.message.role === "assistant") {
      const { message } = event;
      tail.run(() => {
        send({ type: "tail", message: scrubPartial(message) });
      });
    }
  });

  pi.on("message_end", (event, context) => {
    ctx = context;
    const isAssistant = event.message.role === "assistant";
    if (isAssistant) {
      tail.cancel();
    }
    // Pi saves the message after its handlers return, so look at the branch on the next tick.
    setTimeout(() => {
      sync();
      if (isAssistant) {
        send({ type: "tail", message: null });
        sendMeta();
      }
    }, 0);
  });

  pi.on("tool_execution_start", (event, context) => {
    ctx = context;
    if (event.parentToolCallId === undefined) {
      sync();
      send({ type: "tool", phase: "start", id: event.toolCallId });
    }
  });

  pi.on("tool_execution_update", (event, context) => {
    ctx = context;
    if (event.parentToolCallId !== undefined) {
      return;
    }
    const throttle = tools.get(event.toolCallId) ?? new Throttle();
    tools.set(event.toolCallId, throttle);
    const result: unknown = event.partialResult;
    throttle.run(() => {
      send({ type: "tool", phase: "update", id: event.toolCallId, result: scrubPartial(result) });
    });
  });

  pi.on("tool_execution_end", (event, context) => {
    ctx = context;
    if (event.parentToolCallId !== undefined) {
      return;
    }
    tools.get(event.toolCallId)?.cancel();
    tools.delete(event.toolCallId);
    const result: unknown = event.result;
    send({ type: "tool", phase: "end", id: event.toolCallId, result: scrub(result), isError: event.isError, ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }) });
  });

  pi.on("model_select", (_event, context) => {
    ctx = context;
    sendMeta();
  });
  pi.on("thinking_level_select", (_event, context) => {
    ctx = context;
    sendMeta();
  });
  pi.on("session_tree", (_event, context) => {
    ctx = context;
    sync();
  });
  pi.on("session_before_compact", (event) => {
    compacting = event.reason === "manual";
  });
  pi.on("session_compact", (_event, context) => {
    ctx = context;
    compacting = false;
    sync();
    sendMeta();
  });
  pi.on("session_compact_failed", () => {
    compacting = false;
  });
  pi.on("session_info_changed", (_event, context) => {
    ctx = context;
    sendMeta();
  });
  pi.on("agent_start", (_event, context) => {
    ctx = context;
    send({ type: "activity", working: true });
  });
  pi.on("agent_settled", (_event, context) => {
    ctx = context;
    sync();
    send({ type: "tail", message: null });
    send({ type: "activity", working: false });
    refreshBranch();
  });
}
