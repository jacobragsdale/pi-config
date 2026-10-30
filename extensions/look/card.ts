/**
 * Tool calls drawn as cards: a rounded frame with a status badge in its top
 * border, and the tool's own call and result inside. The card wraps whichever
 * renderers pi or another extension would use, so every tool keeps its
 * content (diffs, previews, click to expand) and only the frame changes.
 */
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, Theme, ToolRendererResolver, ToolRenderers, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Box, Text, mixColors, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type RenderContext = Parameters<RenderCall>[2];

export type CardStatus = "waiting" | "running" | "done" | "failed";

/** Below this width the card leaves out its frame. */
const MIN_FRAME_WIDTH = 16;
/** Lines of a result without its own renderer shown before "to expand". */
const PREVIEW_LINES = 10;
/** pi's shell renderers print their own "Took 4.2s" line; the badge shows it instead. */
const TIMED_TOOLS = new Set(["bash", "powershell"]);

/** 840ms, 4.2s, 1m 30s, 2h 3m. */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${String(Math.round(ms))}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)}m ${String(Math.floor(seconds % 60))}s`;
  }
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

/** A running clock: whole seconds, then as formatDuration. */
const formatElapsed = (ms: number): string => (ms < 60_000 ? `${String(Math.floor(ms / 1000))}s` : formatDuration(ms));

const isBlank = (line: string): boolean => stripTerminalSequences(line).trim() === "";

/** Drop blank lines from both ends, so every tool's content sits flush in its card. */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start] ?? "")) {
    start += 1;
  }
  while (end > start && isBlank(lines[end - 1] ?? "")) {
    end -= 1;
  }
  return lines.slice(start, end);
}

/**
 * Lines that `draw` makes for a given width, inside a rounded frame inset up
 * to `pad` columns from each side, with `badge` at the right of the top
 * border. Too narrow for a frame, the lines come back unframed at full width.
 */
export function frame(width: number, pad: number, edge: (text: string) => string, draw: (inner: number) => string[], badge = ""): string[] {
  const inset = Math.max(0, Math.min(pad, Math.floor((width - MIN_FRAME_WIDTH) / 2)));
  const outer = width - inset * 2;
  if (outer < MIN_FRAME_WIDTH) {
    return trimBlankEdges(draw(width));
  }
  const inner = outer - 2;
  const indent = " ".repeat(inset);
  const body = trimBlankEdges(draw(inner)).map((line) => indent + edge("│") + truncateToWidth(line, inner, "", true) + edge("│") + indent);
  const label = badge === "" ? "" : ` ${badge} `;
  const labelWidth = visibleWidth(label);
  const top = label !== "" && labelWidth + 2 <= inner ? edge("─".repeat(inner - labelWidth - 1)) + label + edge("─") : edge("─".repeat(inner));
  return [indent + edge("╭") + top + edge("╮") + indent, ...body, indent + edge(`╰${"─".repeat(inner)}╯`) + indent];
}

/** `○ pending`, `● running 4s`, `✓ 1.2s` or a red `✗ 1.2s`, for the top border of a card. */
export function statusBadge(t: Theme, status: CardStatus, elapsedMs: number | undefined): string {
  const time = elapsedMs === undefined ? undefined : formatDuration(elapsedMs);
  switch (status) {
    case "waiting":
      return t.fg("dim", "○ pending");
    case "running":
      return `${t.fg("warning", "●")} ${t.fg("muted", elapsedMs === undefined || elapsedMs < 1000 ? "running" : `running ${formatElapsed(elapsedMs)}`)}`;
    case "done":
      return `${t.fg("success", "✓")} ${t.fg("muted", time ?? "done")}`;
    case "failed":
      return t.fg("error", `✗ ${time ?? "failed"}`);
  }
}

/** A card's frame color: borderMuted, or for a failed card the error color half faded into it. */
export function cardEdge(t: Theme, failed: boolean): (text: string) => string {
  const color = failed ? mixColors(t.colors.error, t.colors.borderMuted, 0.5) : "borderMuted";
  return (text) => t.style(text, { fg: color });
}

export class ToolCard implements Component {
  /** The wrapped renderers' components, passed back to them as lastComponent. */
  public call: Component | undefined;
  public result: Component | undefined;
  /** Row state for the wrapped renderers, apart from pi's row state that holds this card. */
  public readonly innerState: Record<string, unknown> = {};
  /** Whether this row is drawn as a card, decided on its first call render. */
  public framed: boolean | undefined;
  public status: CardStatus = "waiting";
  /** Run time once finished, or time so far while running. */
  public elapsedMs: number | undefined;
  #pad = 1;
  #theme: Theme;
  #startedAt: number | undefined;
  #endedAt: number | undefined;
  #ticker: ReturnType<typeof setInterval> | undefined;
  readonly #body = new Box(1, 0);

  constructor(theme: Theme) {
    this.#theme = theme;
  }

  /** Take the row's latest theme, padding and progress, and keep a running card's clock ticking. */
  public update(theme: Theme, context: RenderContext): void {
    this.#theme = theme;
    this.#pad = context.outputPad;
    if (context.executionStarted) {
      this.#startedAt ??= Date.now();
    }
    if (!context.isPartial || context.isError) {
      this.#endedAt ??= Date.now();
      clearInterval(this.#ticker);
      this.#ticker = undefined;
      this.status = context.isError ? "failed" : "done";
      this.elapsedMs = context.durationMs ?? (this.#startedAt === undefined ? undefined : this.#endedAt - this.#startedAt);
      return;
    }
    if (this.#startedAt === undefined) {
      this.status = "waiting";
      this.elapsedMs = undefined;
      return;
    }
    this.status = "running";
    this.elapsedMs = Date.now() - this.#startedAt;
    if (this.#ticker === undefined) {
      this.#ticker = setInterval(context.invalidate, 1000);
      this.#ticker.unref();
    }
  }

  public badge(): string {
    return statusBadge(this.#theme, this.status, this.elapsedMs);
  }

  public render(width: number): string[] {
    this.#body.clear();
    for (const child of [this.call, this.result]) {
      if (child !== undefined) {
        this.#body.addChild(child);
      }
    }
    return frame(width, this.#pad, cardEdge(this.#theme, this.status === "failed"), (inner) => this.#body.render(inner), this.badge());
  }

  public invalidate(): void {
    this.call?.invalidate();
    this.result?.invalidate();
    this.#body.invalidate();
  }
}

/** pi's edit draws its call on a tool background, which would be a box inside the card's frame. */
function withoutBackground(component: Component): Component {
  if (component instanceof Box) {
    component.setBgFn(undefined);
  }
  return component;
}

/** Takes the result's place in the tool row: the card draws it. */
const nothing: Component = { render: () => [], invalidate: () => undefined };

/** Each tool row's card, by the row state pi gives its renderers. */
const cards = new WeakMap<object, ToolCard>();

function cardFor(context: RenderContext, theme: Theme): ToolCard {
  const state: unknown = context.state;
  const key = typeof state === "object" && state !== null ? state : undefined;
  const found = key === undefined ? undefined : cards.get(key);
  if (found !== undefined) {
    return found;
  }
  const card = new ToolCard(theme);
  if (key !== undefined) {
    cards.set(key, card);
  }
  return card;
}

function compactArgs(args: unknown): string {
  const text = args === undefined ? "" : JSON.stringify(args);
  return text === "{}" ? "" : text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

/** For a tool without its own call renderer: its name and arguments. */
function fallbackCall(toolName: string): RenderCall {
  return (args, theme) => {
    const shown = compactArgs(args);
    return new Text(theme.fg("toolTitle", theme.bold(toolName)) + (shown === "" ? "" : ` ${theme.fg("muted", shown)}`), 0, 0);
  };
}

/** For a tool without its own result renderer: its text output, cut to PREVIEW_LINES until expanded. */
function fallbackResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme): Component {
  const output = result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
  if (output === "") {
    return nothing;
  }
  const lines = output.split("\n");
  const shown = options.expanded ? lines : lines.slice(0, PREVIEW_LINES);
  let text = `\n${shown.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
  if (shown.length < lines.length) {
    text += `\n${theme.fg("muted", `... (${String(lines.length - shown.length)} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
  }
  return new Text(text, 0, 0);
}

/**
 * Renderers that draw a tool's call as a card around `base`'s call and result.
 *
 * pi's terminal creates a row's first call component before the tool starts,
 * then draws the call and the result together. Its HTML export instead asks
 * for a call and a result one at a time, starting with a call already under
 * way; a row that starts that way gets `base`'s plain components.
 */
export function cardRenderers(toolName: string, base: ToolRenderers | undefined): ToolRenderers {
  const renderCall = base?.renderCall ?? fallbackCall(toolName);
  const renderResult: RenderResult = base?.renderResult ?? fallbackResult;
  const timed = TIMED_TOOLS.has(toolName);
  const inner = (context: RenderContext, card: ToolCard, last: Component | undefined): RenderContext => ({
    ...context,
    state: card.innerState,
    lastComponent: last,
    ...(card.framed === true ? { outputPad: 0 } : {}),
    ...(card.framed === true && timed ? { executionStarted: false, durationMs: undefined } : {})
  });
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      const card = cardFor(context, theme);
      card.framed ??= !context.executionStarted;
      card.call = renderCall(args, theme, inner(context, card, card.call));
      if (!card.framed) {
        return card.call;
      }
      withoutBackground(card.call);
      card.update(theme, context);
      return card;
    },
    renderResult(result, options, theme, context) {
      const card = cardFor(context, theme);
      card.result = renderResult(result, options, theme, inner(context, card, card.result));
      if (card.framed !== true) {
        return card.result;
      }
      // Edit's result renderer redraws its call component, background and all.
      if (card.call !== undefined) {
        withoutBackground(card.call);
      }
      return nothing;
    }
  };
}

/** Draw every tool as a card, except tools that already draw their own frame, other than pi's edit. */
export const toolCards: ToolRendererResolver = (toolName, next) => {
  const base = next();
  if (base?.renderShell === "self" && toolName !== "edit") {
    return base;
  }
  return cardRenderers(toolName, base);
};
