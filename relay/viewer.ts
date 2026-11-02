/**
 * One guest's view of a stream: a full-screen pi on the guest's SSH channel.
 * The layout is pi's own fullscreen layout, a scrolling transcript above a
 * fixed dock with the editor and the footer, drawn with pi's components in the
 * host's look: tools as cards, the editor in a frame whose top border shows
 * the working status, and above it a card of the guest's own suggestions:
 * queued, accepted or rejected. The transcript logic follows pi's interactive mode: entries render as pi renders
 * a resumed session, and the streamed assistant message and running tools
 * update in place like a live run.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  getMarkdownTheme,
  getSelectListTheme,
  parseSkillBlock
} from "@earendil-works/pi-coding-agent";
import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Loader, ScrollView, Spacer, TuiAltScreen, VStack, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { formatDuration, frame, toolCards } from "../extensions/look/card.ts";
import { FramedEditor } from "../extensions/look/editor.ts";
import type { BorderLabels } from "../extensions/look/editor.ts";
import { printable, printableLine } from "../src/printable.ts";
import type { SuggestionStatus } from "../src/protocol.ts";
import { GuestFooter, editorLabels, thinkingLevel } from "./footer.ts";
import { keybindings, piTheme } from "./look.ts";
import { MAX_SUGGESTION_LENGTH, MAX_WAITING_PER_GUEST } from "./stream.ts";
import type { Guest, ShownEntry, Stream, ToolState } from "./stream.ts";
import { SuggestionCard } from "./suggestions.ts";
import { ChannelTerminal } from "./terminal.ts";
import type { Channel } from "./terminal.ts";

/** Copy to the guest's own clipboard: OSC 52 asks their terminal to do it. */
const osc52 = (text: string): string => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;

/** A guest's SSH channel: a terminal, plus the calls that end the session. */
export interface GuestChannel extends Channel {
  exit(code: number): unknown;
  end(): unknown;
}

interface Expandable {
  setExpanded(expanded: boolean): void;
}

/** Draws a placeholder instead of letting one bad message break the guest's screen. */
class Guarded implements Component {
  readonly #inner: Component;

  constructor(inner: Component) {
    this.#inner = inner;
  }

  public render(width: number): string[] {
    try {
      return this.#inner.render(width);
    } catch {
      return [piTheme().fg("dim", " (pi-live couldn't draw this part)")];
    }
  }

  public invalidate(): void {
    this.#inner.invalidate();
  }
}

/** The renderers of pi's built-in tools, so guests see reads, edits and commands as the host does. */
function builtInTools(cwd: string): ReadonlyMap<string, ToolRenderers> {
  // defineTool widens each tool's argument types, so its renderers fit the card's.
  const definitions = [
    defineTool(createReadToolDefinition(cwd)),
    defineTool(createBashToolDefinition(cwd)),
    defineTool(createEditToolDefinition(cwd)),
    defineTool(createWriteToolDefinition(cwd)),
    defineTool(createGrepToolDefinition(cwd)),
    defineTool(createFindToolDefinition(cwd)),
    defineTool(createLsToolDefinition(cwd))
  ];
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

/** The width of the welcome card's column of keys. */
const KEY_COLUMN = 11;
/** A guest's name is cut to this many columns. */
const NAME_WIDTH = 32;

/** The card at the top of a guest's transcript: whose session this is, and the keys. Until they join, it asks for their name. */
class Welcome implements Component {
  public joined = false;
  readonly #host: string;

  constructor(host: string) {
    this.#host = host;
  }

  public render(width: number): string[] {
    const theme = piTheme();
    const host = this.#host;
    const intro = this.joined
      ? [theme.bold(`You've joined ${host}'s pi session.`)]
      : [theme.bold(`You're joining ${host}'s pi session.`), theme.fg("accent", `Type your name below and press Enter, so ${host} knows who joined.`)];
    const keys: [string, string][] = [
      ["Enter", this.joined ? `suggests a prompt to ${host}, who can run it or reject it` : "joins, with the name you typed"],
      ["PgUp PgDn", "scroll, as does the mouse wheel"],
      ["ctrl+o", "expands or collapses tool output"],
      ["ctrl+c", "leaves"]
    ];
    const wrap = (text: string, room: number): string[] => wrapTextWithAnsi(text, Math.max(1, room));
    // Each key's description wraps under itself, beside the key column.
    const key = ([name, what]: [string, string], room: number): string[] =>
      wrap(theme.fg("muted", what), room - KEY_COLUMN).map((part, i) => (i === 0 ? theme.fg("text", name.padEnd(KEY_COLUMN)) : " ".repeat(KEY_COLUMN)) + part);
    const draw = (inner: number): string[] => [...intro.flatMap((line) => wrap(line, inner - 2)), "", ...keys.flatMap((entry) => key(entry, inner - 2))].map((line) => ` ${line}`);
    return ["", ...frame(Math.min(width, 84), 1, (text) => theme.fg("borderMuted", text), draw, theme.fg("muted", "pi-live"))];
  }

  public invalidate(): void {
    // Drawn from the theme on every frame.
  }
}

/** pi's working spinner, for the editor's top border, as pi's own status indicator draws it there. */
class WorkingStatus extends Loader {
  public readonly kind = "working";

  public renderInBorder(width: number): string {
    const line = super.render(width + 2)[1] ?? "";
    return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
  }

  public renderSpinnerInBorder(width: number): string {
    return truncateToWidth(this.getRenderedIndicator(), width, "");
  }

  public dispose(): void {
    this.stop();
  }
}

function userText(message: AgentMessage): string {
  if (message.role !== "user") {
    return "";
  }
  return typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

const failure = (message: AssistantMessage): string => (message.stopReason === "aborted" ? "Operation aborted" : (message.errorMessage ?? "Error"));

export interface ViewerOptions {
  readonly channel: GuestChannel;
  readonly columns: number;
  readonly rows: number;
  readonly stream: Stream;
  /** Used for the name of a guest who doesn't type one. */
  readonly number: number;
}

export class Viewer implements Guest {
  public name = "";
  readonly #stream: Stream;
  readonly #channel: GuestChannel;
  readonly #terminal: ChannelTerminal;
  readonly #tui: TuiAltScreen;
  readonly #chat = new Container();
  readonly #welcome: Welcome;
  readonly #suggestions: SuggestionCard;
  readonly #editor: FramedEditor;
  readonly #wrappers = new Map<Component, Component>();
  readonly #pending = new Map<string, ToolExecutionComponent>();
  /** How long each finished tool ran on the host, until its result entry arrives. */
  readonly #durations = new Map<string, number>();
  readonly #expandables = new Set<Expandable>();
  readonly #number: number;
  #loader: WorkingStatus | undefined;
  #tools: ReadonlyMap<string, ToolRenderers> = new Map();
  #toolsCwd: string | undefined;
  #tail: { readonly timestamp: number; readonly component: AssistantMessageComponent; readonly tools: Map<string, ToolExecutionComponent> } | undefined;
  #expanded = false;
  /** When the guest gave their name and joined. */
  #joinedAt: number | undefined;
  #closed = false;

  constructor(options: ViewerOptions) {
    this.#stream = options.stream;
    this.#channel = options.channel;
    this.#number = options.number;
    this.#terminal = new ChannelTerminal(options.channel, options.columns, options.rows);
    const theme = piTheme();
    const searchMatch = (text: string): string => theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
    this.#tui = new TuiAltScreen(this.#terminal, false, undefined, {
      wheelScrollLines: "auto",
      searchMatchStyle: (text) => theme.underline(searchMatch(text)),
      searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(searchMatch(text))),
      searchNavigationButtonStyle: (text, hovered) => (hovered ? theme.underline(text) : text),
      scrollToEndIndicator: () => theme.bg("selectedBg", theme.fg("text", " ↓ Jump to latest message · ctrl+end ")),
      copySelection: (text) => {
        this.#terminal.write(osc52(text));
        return Promise.resolve(true);
      }
    });
    const editorTheme = { borderColor: theme.getThinkingBorderColor(thinkingLevel(this.#stream.meta.thinking)), selectList: getSelectListTheme() };
    this.#editor = new FramedEditor(this.#tui, editorTheme, keybindings, () => this.#labels());
    this.#editor.onSubmit = (text): void => {
      this.#submit(text);
    };
    this.#welcome = new Welcome(this.#stream.host);
    this.#suggestions = new SuggestionCard(this.#stream.host, (id) => this.#stream.ahead(id));
    const gap = new Spacer(1);
    const footer = new GuestFooter(() => ({ meta: this.#stream.meta, host: this.#stream.host, joined: this.#stream.guests.length }));
    const transcript = new ScrollView(this.#chat, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
    const dock = new VStack([
      { component: gap, shrink: 1, minSize: 0 },
      { component: this.#suggestions, shrink: 1, minSize: 0 },
      { component: this.#editor, shrink: 1, minSize: 3 },
      { component: footer, shrink: 1, minSize: 0 }
    ]);
    for (const component of [this.#chat, gap, this.#suggestions, this.#editor, footer]) {
      this.#tui.addChild(component);
    }
    this.#tui.setLayoutRoot(
      new VStack([
        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 }
      ])
    );
    this.#tui.setFocus(this.#editor);
    this.#tui.addInputListener((data) => this.#onKey(data));
    this.#chat.addChild(this.#welcome);
    this.#tui.start();
  }

  get #joined(): boolean {
    return this.#joinedAt !== undefined;
  }

  #labels(): BorderLabels {
    const theme = piTheme();
    const placeholder = this.#joined ? `Suggest a prompt to ${this.#stream.host} · Enter sends · ctrl+c leaves` : "Type your name, then Enter to join";
    return { ...editorLabels(theme, this.#stream.meta), placeholder: theme.fg("dim", placeholder) };
  }

  #submit(text: string): void {
    if (this.#closed) {
      return;
    }
    if (this.#joined) {
      this.#suggest(text);
      return;
    }
    const name = truncateToWidth(printableLine(text), NAME_WIDTH, "");
    this.name = name === "" ? `guest-${String(this.#number)}` : name;
    this.#joinedAt = Date.now();
    this.#welcome.joined = true;
    this.#suggestions.joinedAs(this.name);
    this.#stream.join(this);
    this.reset();
    this.activity();
  }

  #onKey(data: string): { consume: boolean } | undefined {
    if (this.#closed) {
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c") || (matchesKey(data, "ctrl+d") && this.#editor.getText() === "")) {
      this.#close("You left the stream.");
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o") && this.#joined) {
      this.#expanded = !this.#expanded;
      for (const component of this.#expandables) {
        component.setExpanded(this.#expanded);
      }
      this.#tui.requestRender();
      return { consume: true };
    }
    return undefined;
  }

  #suggest(value: string): void {
    const text = printable(value).trim();
    if (text === "") {
      return;
    }
    // Either way, what they typed stays in their editor for later.
    if (text.length > MAX_SUGGESTION_LENGTH) {
      this.#editor.setText(value);
      this.#suggestions.refuse(`That's ${text.length.toLocaleString("en-US")} characters; a suggestion can be at most ${MAX_SUGGESTION_LENGTH.toLocaleString("en-US")}.`);
    } else {
      const id = this.#stream.suggest(this, text);
      if (id === undefined) {
        this.#editor.setText(value);
        this.#suggestions.refuse(`${String(MAX_WAITING_PER_GUEST)} queued · send more once ${this.#stream.host} answers one`);
      } else {
        this.#suggestions.add(id, text);
      }
    }
    this.#tui.requestRender();
  }

  public suggestionStatus(id: string, status: SuggestionStatus): void {
    this.#suggestions.answer(id, status);
    this.#tui.requestRender();
  }

  public queue(): void {
    this.#tui.requestRender();
  }

  public resize(columns: number, rows: number): void {
    this.#terminal.resize(columns, rows);
  }

  // Dock

  public activity(): void {
    if (!this.#joined) {
      return;
    }
    if (this.#stream.working && this.#loader === undefined) {
      const theme = piTheme();
      this.#loader = new WorkingStatus(
        this.#tui,
        (text) => theme.fg("accent", text),
        (text) => theme.fg("muted", text),
        "Working"
      );
      this.#loader.start();
      this.#editor.setWorkingStatusIndicator(this.#loader);
    } else if (!this.#stream.working && this.#loader !== undefined) {
      this.#stopLoader();
    }
    this.#tui.requestRender();
  }

  #stopLoader(): void {
    this.#loader?.dispose();
    this.#loader = undefined;
    this.#editor.setWorkingStatusIndicator(undefined);
  }

  public footer(): void {
    this.#editor.borderColor = piTheme().getThinkingBorderColor(thinkingLevel(this.#stream.meta.thinking));
    this.#tui.requestRender();
  }

  // Transcript

  public reset(): void {
    if (!this.#joined) {
      return;
    }
    this.#settleTools();
    this.#chat.clear();
    this.#wrappers.clear();
    this.#pending.clear();
    this.#durations.clear();
    this.#expandables.clear();
    this.#tail = undefined;
    this.#chat.addChild(this.#welcome);
    for (const entry of this.#stream.entries) {
      this.#addMessages(entry.messages);
    }
    for (const id of this.#stream.tools.keys()) {
      this.tool(id);
    }
    this.tail();
    this.footer();
  }

  public append(entries: readonly ShownEntry[]): void {
    if (!this.#joined) {
      return;
    }
    for (const entry of entries) {
      this.#addMessages(entry.messages);
    }
    this.#tui.requestRender();
  }

  public tail(): void {
    if (!this.#joined) {
      return;
    }
    const message = this.#stream.tail;
    if (this.#tail !== undefined && this.#tail.timestamp !== message?.timestamp) {
      this.#dropTail();
    }
    if (message === undefined) {
      this.#tui.requestRender();
      return;
    }
    if (this.#tail === undefined) {
      const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
      this.#add(component);
      this.#tail = { timestamp: message.timestamp, component, tools: new Map() };
    }
    const tail = this.#tail;
    tail.component.updateContent(message, true);
    for (const part of message.content) {
      if (part.type !== "toolCall") {
        continue;
      }
      const existing = tail.tools.get(part.id);
      if (existing === undefined) {
        const component = this.#newTool(part.name, part.id, part.arguments);
        tail.tools.set(part.id, component);
        this.#pending.set(part.id, component);
      } else {
        existing.updateArgs(part.arguments);
      }
    }
    this.#tui.requestRender();
  }

  public tool(id: string): void {
    const state = this.#stream.tools.get(id);
    const component = this.#pending.get(id);
    if (!this.#joined || state === undefined || component === undefined) {
      return;
    }
    applyTool(component, state);
    if (state.end?.durationMs !== undefined) {
      this.#durations.set(id, state.end.durationMs);
    }
    this.#tui.requestRender();
  }

  #addMessages(messages: readonly AgentMessage[]): void {
    for (const message of messages) {
      this.#addMessage(message);
    }
  }

  #addMessage(message: AgentMessage): void {
    const markdown = getMarkdownTheme();
    switch (message.role) {
      case "assistant":
        this.#addAssistant(message);
        break;
      case "toolResult": {
        const durationMs = this.#durations.get(message.toolCallId);
        this.#pending.get(message.toolCallId)?.updateResult(durationMs === undefined ? message : { ...message, durationMs });
        this.#pending.delete(message.toolCallId);
        this.#durations.delete(message.toolCallId);
        break;
      }
      case "user":
        this.#addUser(userText(message));
        break;
      case "bashExecution": {
        const component = new BashExecutionComponent(message.command, this.#tui, message.excludeFromContext);
        if (message.output !== "") {
          component.appendOutput(message.output);
        }
        component.setComplete(message.exitCode ?? undefined, message.cancelled, undefined, message.fullOutputPath);
        this.#addExpandable(component);
        break;
      }
      case "custom":
        if (message.display) {
          this.#addExpandable(new CustomMessageComponent(message, undefined, markdown));
        }
        break;
      case "compactionSummary":
        this.#add(new Spacer(1));
        this.#addExpandable(new CompactionSummaryMessageComponent(message, markdown));
        break;
      case "branchSummary":
        this.#add(new Spacer(1));
        this.#addExpandable(new BranchSummaryMessageComponent(message, markdown));
        break;
      case "system":
        break;
    }
  }

  #addUser(text: string): void {
    if (text === "") {
      return;
    }
    const markdown = getMarkdownTheme();
    this.#add(new Spacer(1));
    const skill = parseSkillBlock(text);
    if (skill === null) {
      this.#add(new UserMessageComponent(text, markdown));
      return;
    }
    this.#addExpandable(new SkillInvocationMessageComponent(skill, markdown));
    if (skill.userMessage !== undefined) {
      this.#add(new Spacer(1));
      this.#add(new UserMessageComponent(skill.userMessage, markdown));
    }
  }

  /** A finished assistant message: the streamed one, finalized in place, or a new one. */
  #addAssistant(message: AssistantMessage): void {
    const streamed = this.#tail?.timestamp === message.timestamp ? this.#tail : undefined;
    if (this.#tail !== undefined && streamed === undefined) {
      this.#dropTail();
    }
    this.#tail = undefined;
    if (streamed === undefined) {
      this.#add(new AssistantMessageComponent(message, false, getMarkdownTheme()));
    } else {
      streamed.component.updateContent(message, false);
    }
    const failed = message.stopReason === "aborted" || message.stopReason === "error";
    for (const part of message.content) {
      if (part.type !== "toolCall") {
        continue;
      }
      const component = streamed?.tools.get(part.id) ?? this.#newTool(part.name, part.id, part.arguments);
      if (failed) {
        component.updateResult({ content: [{ type: "text", text: failure(message) }], isError: true });
        this.#pending.delete(part.id);
      } else {
        component.setArgsComplete();
        this.#pending.set(part.id, component);
      }
    }
  }

  #dropTail(): void {
    if (this.#tail === undefined) {
      return;
    }
    this.#remove(this.#tail.component);
    for (const [id, component] of this.#tail.tools) {
      settle(component);
      this.#remove(component);
      this.#pending.delete(id);
    }
    this.#tail = undefined;
  }

  /** Stop the clocks of tools still waiting for a result, before their cards are dropped. */
  #settleTools(): void {
    for (const component of this.#pending.values()) {
      settle(component);
    }
  }

  #newTool(name: string, id: string, args: unknown): ToolExecutionComponent {
    const cwd = this.#stream.meta.cwd;
    if (this.#toolsCwd !== cwd) {
      this.#tools = builtInTools(cwd);
      this.#toolsCwd = cwd;
    }
    const renderers = toolCards(name, () => this.#tools.get(name));
    const component = new ToolExecutionComponent(name, id, args, { showImages: false }, renderers, this.#tui, cwd);
    this.#addExpandable(component);
    return component;
  }

  #add(component: Component): void {
    const wrapper = new Guarded(component);
    this.#wrappers.set(component, wrapper);
    this.#chat.addChild(wrapper);
  }

  #addExpandable(component: Component & Expandable): void {
    component.setExpanded(this.#expanded);
    this.#expandables.add(component);
    this.#add(component);
  }

  #remove(component: Component): void {
    const wrapper = this.#wrappers.get(component);
    if (wrapper !== undefined) {
      this.#chat.removeChild(wrapper);
    }
    this.#wrappers.delete(component);
  }

  // Ending

  /** The host left or the relay is stopping. */
  public end(reason: string): void {
    this.#close(reason);
  }

  /** The guest's connection closed. */
  public dispose(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#stopLoader();
    this.#settleTools();
    this.#terminal.close();
    this.#tui.stop({ preserveScreen: true });
    this.#stream.leave(this);
  }

  /** Leave the full-screen view, so the guest's terminal shows what it did before they joined, then say why. */
  #close(reason: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#stopLoader();
    this.#settleTools();
    this.#stream.leave(this);
    this.#tui.stop({ preserveScreen: true });
    const stayed = this.#joinedAt === undefined ? "" : piTheme().fg("dim", ` You were in it for ${formatDuration(Date.now() - this.#joinedAt)}.`);
    this.#terminal.write(`${reason}${stayed}\r\n`);
    this.#terminal.close();
    this.#channel.exit(0);
    this.#channel.end();
  }
}

/**
 * Give a tool that will never get its result here a final one. A running
 * tool's card keeps a clock ticking until its result arrives, and the clock
 * would keep the whole view alive after the guest left.
 */
function settle(component: ToolExecutionComponent): void {
  component.updateResult({ content: [], isError: false }, false);
}

function applyTool(component: ToolExecutionComponent, state: ToolState): void {
  if (state.started) {
    component.markExecutionStarted();
  }
  if (state.progress !== undefined) {
    const isError = state.end?.isError ?? false;
    component.updateResult({ ...state.progress, isError, ...(state.end?.durationMs === undefined ? {} : { durationMs: state.end.durationMs }) }, state.end === undefined);
  }
}
