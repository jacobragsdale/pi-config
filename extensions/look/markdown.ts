/**
 * Markdown tables and code blocks drawn like the cards. A table gets rounded
 * corners and the cards' border color in place of pi's bright square grid; a
 * code block sits in a frame with its language in the top border, in place
 * of its fences. pi-tui draws both in Markdown's private renderTable and
 * renderToken, so this wraps those while a session runs.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { frame } from "./card.ts";
import { callMethod, isStringArray, restoreAll, swapProperty } from "./swap.ts";

const CORNERS: Readonly<Record<string, readonly [string, string]>> = { "┌": ["╭", "╮"], "└": ["╰", "╯"], "├": ["├", "┤"] };

/** pi-tui's table lines with rounded corners, and every border character in `edge`'s color. */
export function roundTable(lines: string[], edge: (text: string) => string): string[] {
  if (!(lines[0] ?? "").startsWith("┌")) {
    // Too narrow for a table: pi-tui printed the Markdown source instead.
    return lines;
  }
  return lines.map((line) => {
    const corners = CORNERS[line.slice(0, 1)];
    if (corners !== undefined) {
      return edge(corners[0] + line.slice(1, -1) + corners[1]);
    }
    if (line.startsWith("│ ") && line.endsWith(" │")) {
      return edge("│") + line.slice(1, -1).replaceAll(" │ ", ` ${edge("│")} `) + edge("│");
    }
    return line;
  });
}

/** pi-tui's code block lines, fences and all, as a frame with `lang` in its top border. */
export function framedCode(lines: string[], lang: string, width: number, indent: string, theme: Theme): string[] {
  const spaced = lines.at(-1) === "";
  const code = lines.slice(1, spaced ? -2 : -1).map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line));
  const draw = (inner: number): string[] =>
    code.flatMap((line) => {
      const wrapped = wrapTextWithAnsi(line, Math.max(1, inner - 2));
      return (wrapped.length === 0 ? [""] : wrapped).map((part) => ` ${part}`);
    });
  const edge = (text: string): string => theme.fg("borderMuted", text);
  return [...frame(width, 0, edge, draw, lang === "" ? "" : theme.fg("muted", lang)), ...(spaced ? [""] : [])];
}

function codeToken(token: unknown): { lang: string } | undefined {
  if (typeof token !== "object" || token === null || Reflect.get(token, "type") !== "code") {
    return undefined;
  }
  const lang: unknown = Reflect.get(token, "lang");
  return { lang: typeof lang === "string" ? lang : "" };
}

/** The indent pi-tui puts before each line of code: the Markdown theme's codeBlockIndent, two spaces by default. */
function codeIndent(markdown: object): string {
  const markdownTheme: unknown = Reflect.get(markdown, "theme");
  const indent: unknown = typeof markdownTheme === "object" && markdownTheme !== null ? Reflect.get(markdownTheme, "codeBlockIndent") : undefined;
  return typeof indent === "string" ? indent : "  ";
}

/** Draw Markdown tables and code blocks like cards, until the returned function puts pi-tui's drawing back. */
export function frameMarkdown(theme: () => Theme): () => void {
  const prototype = Markdown.prototype;
  const renderTable: unknown = Reflect.get(prototype, "renderTable");
  const renderToken: unknown = Reflect.get(prototype, "renderToken");
  const restores = [
    swapProperty(prototype, "renderTable", function (this: Markdown, ...args: unknown[]): unknown {
      const lines = callMethod(renderTable, this, args);
      return isStringArray(lines) ? roundTable(lines, (text) => theme().fg("borderMuted", text)) : lines;
    }),
    swapProperty(prototype, "renderToken", function (this: Markdown, ...args: unknown[]): unknown {
      const lines = callMethod(renderToken, this, args);
      const [token, width] = args;
      const code = codeToken(token);
      if (code === undefined || !isStringArray(lines) || typeof width !== "number" || lines.length < 2) {
        return lines;
      }
      return framedCode(lines, code.lang, width, codeIndent(this), theme());
    })
  ];
  return () => {
    restoreAll(restores);
  };
}
