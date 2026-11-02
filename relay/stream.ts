/**
 * One host's live stream on the relay: what guests are shown, held in memory
 * only while the host is connected, the guests who have joined it, and the
 * suggestions waiting on the host, in the host's order.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { clip, printableDeep, printableLine } from "../src/printable.ts";
import type { Entry, HostMessage, Meta, RelayMessage, SuggestionStatus } from "../src/protocol.ts";
import { isAgentMessage, isAssistantMessage, isToolProgress } from "./messages.ts";
import type { ToolProgress } from "./messages.ts";

/** A guest can have this many suggestions waiting on the host at once. */
export const MAX_WAITING_PER_GUEST = 3;
export const MAX_SUGGESTION_LENGTH = 4000;

export interface ShownEntry {
  readonly id: string;
  readonly messages: readonly AgentMessage[];
}

export interface ToolState {
  started: boolean;
  progress?: ToolProgress;
  end?: { readonly isError: boolean; readonly durationMs?: number };
}

/** What the stream needs from each guest's viewer. */
export interface Guest {
  readonly name: string;
  reset(): void;
  append(entries: readonly ShownEntry[]): void;
  tail(): void;
  tool(id: string): void;
  footer(): void;
  activity(): void;
  /** The host answered one of this guest's suggestions. */
  suggestionStatus(id: string, status: SuggestionStatus): void;
  /** The host answered a suggestion, so those behind it moved up. */
  queue(): void;
  end(reason: string): void;
}

type StreamUpdate = Exclude<HostMessage, { type: "hello" }>;

/** The footer's facts with every string on one printable line, since the footer and the editor's border draw them as they are. */
function printableMeta(meta: Extract<HostMessage, { type: "meta" }>): Meta {
  const { gitBranch, sessionName, model } = meta;
  return {
    ...meta,
    cwd: printableLine(meta.cwd),
    cwdLabel: printableLine(meta.cwdLabel),
    thinking: printableLine(meta.thinking),
    ...(gitBranch === undefined ? {} : { gitBranch: printableLine(gitBranch) }),
    ...(sessionName === undefined ? {} : { sessionName: printableLine(sessionName) }),
    ...(model === undefined ? {} : { model: { ...model, provider: printableLine(model.provider), id: printableLine(model.id) } })
  };
}

const resultIds = (entries: readonly ShownEntry[]): string[] => entries.flatMap((entry) => entry.messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])));

export class Stream {
  public readonly token: string;
  public readonly host: string;
  public meta: Meta = { cwd: "", cwdLabel: "", showProvider: false, thinking: "off", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, autoCompact: true };
  /** Whether the host's agent is working. */
  public working = false;
  public entries: ShownEntry[] = [];
  /** The assistant message being streamed, until its entry arrives. */
  public tail: AssistantMessage | undefined;
  /** Tools that started but whose result entry hasn't arrived yet. */
  public readonly tools = new Map<string, ToolState>();
  readonly #guests = new Set<Guest>();
  /** Guests still typing their name: the host doesn't see them yet, but they hear when the stream ends. */
  readonly #arriving = new Set<Guest>();
  /** Suggestions the host hasn't answered, in the order the host has them, and who sent each; undefined once they've left. */
  readonly #waiting = new Map<string, Guest | undefined>();
  readonly #send: (message: RelayMessage) => void;
  readonly #log: (line: string) => void;
  #nextSuggestion = 0;
  #ended = false;
  /** What this stream has already logged about, so a broken host doesn't flood the log. */
  readonly #warned = new Set<string>();

  constructor(token: string, host: string, send: (message: RelayMessage) => void, log: (line: string) => void) {
    this.token = token;
    this.host = host;
    this.#send = send;
    this.#log = log;
  }

  public get guests(): readonly Guest[] {
    return [...this.#guests];
  }

  /** Everyone connected: the guests who joined and those still typing their name. */
  public get connected(): number {
    return this.#guests.size + this.#arriving.size;
  }

  public apply(update: StreamUpdate): void {
    switch (update.type) {
      case "meta":
        this.meta = printableMeta(update);
        this.#each((guest) => {
          guest.footer();
        });
        break;
      case "activity":
        this.working = update.working;
        this.#each((guest) => {
          guest.activity();
        });
        break;
      case "reset":
        this.entries = this.#shown(update.entries);
        this.#settleTools(this.entries);
        this.#each((guest) => {
          guest.reset();
        });
        break;
      case "append": {
        const added = this.#shown(update.entries);
        this.entries.push(...added);
        this.#settleTools(added);
        const tail = this.tail;
        if (tail !== undefined && added.some((entry) => entry.messages.some((m) => m.role === "assistant" && m.timestamp === tail.timestamp))) {
          this.tail = undefined;
        }
        this.#each((guest) => {
          guest.append(added);
        });
        break;
      }
      case "tail": {
        const message = printableDeep(update.message);
        this.tail = isAssistantMessage(message) ? message : undefined;
        if (this.tail === undefined && update.message !== null) {
          this.#warnOnce("tail", "dropped a streamed message the relay can't read, so guests see it only once it is finished");
        }
        this.#each((guest) => {
          guest.tail();
        });
        break;
      }
      case "tool":
        this.#tool(update);
        break;
      case "suggestion_status":
        this.#answered(update.id, update.status);
        break;
    }
  }

  /** The host answered a suggestion: tell whoever sent it, and let everyone's queued ones move up. */
  #answered(id: string, status: SuggestionStatus): void {
    const from = this.#waiting.get(id);
    if (!this.#waiting.delete(id)) {
      return;
    }
    if (from !== undefined && this.#guests.has(from)) {
      from.suggestionStatus(id, status);
    }
    this.#each((guest) => {
      guest.queue();
    });
  }

  #tool(update: Extract<StreamUpdate, { type: "tool" }>): void {
    const state = this.tools.get(update.id) ?? { started: false };
    this.tools.set(update.id, state);
    state.started = true;
    const result = printableDeep(update.result);
    if (isToolProgress(result)) {
      state.progress = result;
    }
    if (update.phase === "end") {
      state.end = { isError: update.isError ?? false, ...(update.durationMs === undefined ? {} : { durationMs: update.durationMs }) };
    }
    this.#each((guest) => {
      guest.tool(update.id);
    });
  }

  /** The messages of each entry the relay can draw; the rest are dropped, with one log line per stream. */
  #shown(entries: readonly Entry[]): ShownEntry[] {
    return entries.map((entry) => {
      const messages = entry.messages.map(printableDeep).filter(isAgentMessage);
      if (messages.length < entry.messages.length) {
        this.#warnOnce("entry", "dropped transcript messages the relay can't read");
      }
      return { id: entry.id, messages };
    });
  }

  #warnOnce(kind: string, what: string): void {
    if (!this.#warned.has(kind)) {
      this.#warned.add(kind);
      this.#log(`${this.host}'s stream: ${what} (logged once per stream)`);
    }
  }

  /** Forget the live state of tools whose results are now in the transcript. */
  #settleTools(entries: readonly ShownEntry[]): void {
    for (const id of resultIds(entries)) {
      this.tools.delete(id);
    }
  }

  /** A guest connected, and has yet to give their name. */
  public arrive(guest: Guest): void {
    this.#arriving.add(guest);
  }

  /** A guest gave their name: the host sees them now. */
  public join(guest: Guest): void {
    if (this.#ended || !this.#arriving.delete(guest)) {
      return;
    }
    this.#guests.add(guest);
    this.#presence();
  }

  public leave(guest: Guest): void {
    this.#arriving.delete(guest);
    if (!this.#guests.delete(guest)) {
      return;
    }
    // The host still has their suggestions, so they keep their places in line.
    for (const [id, from] of this.#waiting) {
      if (from === guest) {
        this.#waiting.set(id, undefined);
      }
    }
    this.#presence();
  }

  /** Send a guest's suggestion to the host. Returns its id, or undefined when the guest already has MAX_WAITING_PER_GUEST waiting. */
  public suggest(guest: Guest, text: string): string | undefined {
    const mine = [...this.#waiting.values()].filter((from) => from === guest).length;
    if (mine >= MAX_WAITING_PER_GUEST) {
      return undefined;
    }
    this.#nextSuggestion += 1;
    const id = String(this.#nextSuggestion);
    this.#waiting.set(id, guest);
    this.#send({ type: "suggestion", id, from: guest.name, text: clip(text, MAX_SUGGESTION_LENGTH) });
    return id;
  }

  /** How many suggestions the host has before this one, or undefined once the host has answered it. */
  public ahead(id: string): number | undefined {
    const index = [...this.#waiting.keys()].indexOf(id);
    return index === -1 ? undefined : index;
  }

  /** The host left: tell every guest, named or not, and let them go. */
  public end(reason: string): void {
    this.#ended = true;
    const everyone = [...this.#arriving, ...this.#guests];
    this.#arriving.clear();
    this.#guests.clear();
    this.#waiting.clear();
    for (const guest of everyone) {
      this.#try(guest, () => {
        guest.end(reason);
      });
    }
  }

  #presence(): void {
    if (this.#ended) {
      return;
    }
    this.#send({ type: "guests", names: this.guests.map((guest) => guest.name) });
    this.#each((guest) => {
      guest.footer();
    });
  }

  /** Every guest, named or still typing their name. One guest's drawing failing must not stop the others. */
  #each(fn: (guest: Guest) => void): void {
    for (const guest of [...this.#arriving, ...this.#guests]) {
      this.#try(guest, () => {
        fn(guest);
      });
    }
  }

  #try(guest: Guest, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.#log(`couldn't update ${guest.name === "" ? "a guest" : guest.name}'s view of ${this.host}'s stream: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
