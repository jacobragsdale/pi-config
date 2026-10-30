/**
 * What pi puts in the editor's place, such as /model, /resume, /tree,
 * /settings, /login and extensions' dialogs, drawn in a rounded frame like
 * the editor's; and the blocks pi writes into the chat between two rules,
 * such as /hotkeys, /changelog and update notices, framed instead. pi builds
 * both from plain containers, so this wraps the editor's container and the
 * chat's render while a session runs.
 */
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Editor, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { callMethod, restoreAll, swapProperty } from "./swap.ts";

/** Below this width panels and chat blocks are drawn as pi draws them. */
const MIN_WIDTH = 20;
/** Columns a panel's frame takes on each side: the border and one space. */
const SIDE = 2;

/** Whether `line` is a rule pi-tui's DynamicBorder drew across `width` columns. */
const isRule = (line: string, width: number): boolean => line.includes("──") && stripTerminalSequences(line) === "─".repeat(width);

/** Whether `line` is a border across `width` columns, perhaps with a label in it, such as an editor's "↑ 9 more". */
function isBorder(line: string, width: number): boolean {
  const plain = stripTerminalSequences(line);
  return plain.startsWith("─") && plain.endsWith("─") && visibleWidth(line) === width;
}

/** `text` in the color `rule` was drawn in. */
const inColorOf = (rule: string, text: string): string => rule.slice(0, rule.indexOf("─")) + text + rule.slice(rule.lastIndexOf("─") + 1);

const line = (left: string, width: number, right: string): string => left + "─".repeat(Math.max(0, width - 2)) + right;

export interface FramedPanel {
  readonly lines: string[];
  /** What to add to a row of the framed lines to find the panel's own line there. */
  readonly offset: number;
}

const isBlank = (text: string): boolean => stripTerminalSequences(text).trim() === "";

/**
 * A panel drawn `SIDE` columns narrower on each side than `width`, in a frame.
 * Its first and last rules, with any blank lines outside them, become the
 * frame's top and bottom, in the rules' own color; borders in between, such
 * as a dialog's editor's, reach out to the frame as dividers.
 */
export function framedPanel(lines: string[], width: number, fallback: (text: string) => string): FramedPanel {
  const inner = width - SIDE * 2;
  const rule = lines.find((text) => isRule(text, inner));
  const edge = (text: string): string => (rule === undefined ? fallback(text) : inColorOf(rule, text));
  const first = lines.findIndex((text) => !isBlank(text));
  const last = lines.findLastIndex((text) => !isBlank(text));
  const hasTop = first >= 0 && isRule(lines[first] ?? "", inner);
  const hasBottom = last > first && isRule(lines[last] ?? "", inner);
  const start = hasTop ? first + 1 : 0;
  const body = lines.slice(start, hasBottom ? last : lines.length);
  const framed = body.map((text) => (isBorder(text, inner) ? edge("├─") + text + edge("─┤") : `${edge("│")} ${truncateToWidth(text, inner, "", true)} ${edge("│")}`));
  return { lines: [edge(line("╭", width, "╮")), ...framed, edge(line("╰", width, "╯"))], offset: start - 1 };
}

/**
 * A container's children drawn as pi-tui's Container draws them, except that
 * each run of children between two DynamicBorders is drawn a column narrower
 * on each side, in a frame of the borders' color.
 */
export function renderFramingRuns(container: Container, width: number): string[] {
  const lines: string[] = [];
  const layout: { component: Component; height: number }[] = [];
  const add = (component: Component, drawn: string[]): void => {
    layout.push({ component, height: drawn.length });
    lines.push(...drawn);
  };
  const { children } = container;
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child === undefined) {
      continue;
    }
    const close = child instanceof DynamicBorder ? children.findIndex((other, j) => j > i && other instanceof DynamicBorder) : -1;
    const closer = children[close];
    if (closer === undefined) {
      add(child, child.render(width));
      continue;
    }
    const rule = child.render(width)[0] ?? "";
    const edge = (text: string): string => inColorOf(rule, text);
    add(child, [edge(line("╭", width, "╮"))]);
    for (const inside of children.slice(i + 1, close)) {
      add(
        inside,
        inside.render(width - 2).map((text) => edge("│") + truncateToWidth(text, width - 2, "", true) + edge("│"))
      );
    }
    add(closer, [edge(line("╰", width, "╯"))]);
    i = close;
  }
  // Container.handleMouse finds the child under a click from this layout.
  Reflect.set(container, "mouseLayout", { width, children: layout });
  return lines;
}

/** Frame what pi shows in place of `editor`, and the chat's ruled blocks, until the returned function puts pi's drawing back. */
export function framePanels(tui: Pick<TUI, "children">, editor: Component, theme: () => Theme): () => void {
  const restores: (() => void)[] = [];
  const holder = tui.children.find((child): child is Container => child instanceof Container && child.children.includes(editor));
  if (holder !== undefined) {
    const render: unknown = Reflect.get(holder, "render");
    const handleMouse: unknown = Reflect.get(holder, "handleMouse");
    // Where the framed panel's lines sit, for mouse events; undefined while it isn't framed.
    let placed: { offset: number; height: number } | undefined;
    restores.push(
      swapProperty(holder, "render", (width: number): unknown => {
        const [panel] = holder.children;
        placed = undefined;
        if (panel === undefined || panel === editor || panel instanceof Editor || holder.children.length > 1 || width < MIN_WIDTH) {
          return callMethod(render, holder, [width]);
        }
        const lines = panel.render(width - SIDE * 2);
        const framed = framedPanel(lines, width, (text) => theme().fg("border", text));
        placed = { offset: framed.offset, height: lines.length };
        return framed.lines;
      }),
      swapProperty(holder, "handleMouse", (event: TuiMouseEvent): unknown => {
        const moved = placed === undefined ? event : { ...event, x: event.x - SIDE, y: event.y + placed.offset, width: event.width - SIDE * 2, height: placed.height };
        return callMethod(handleMouse, holder, [moved]);
      })
    );
  }
  // pi's document holds the header, the loaded resources and, last, the chat.
  const [document] = tui.children;
  const chat = document instanceof Container && document !== holder ? document.children.at(-1) : undefined;
  if (chat instanceof Container) {
    const render: unknown = Reflect.get(chat, "render");
    restores.push(swapProperty(chat, "render", (width: number): unknown => (width < MIN_WIDTH ? callMethod(render, chat, [width]) : renderFramingRuns(chat, width))));
  }
  return () => {
    restoreAll(restores);
  };
}
