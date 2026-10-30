/**
 * The team's look, after shadcn/ui. Tool calls, `!` commands, the prompts you
 * send and pi's skill and summary blocks are cards in rounded frames; so are
 * Markdown tables and code blocks, selectors and dialogs, and pi's ruled chat
 * blocks. The editor's frame shows the model, thinking level and context use
 * in its bottom border, and the footer is one status line. The colors are the
 * shadcn-dark and shadcn-light themes in themes/; this extension changes only
 * shapes, so it works with any theme.
 *
 * PI_LOOK=0 turns it off.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { toolCards } from "./card.ts";
import { FramedEditor } from "./editor.ts";
import type { BorderLabels } from "./editor.ts";
import { StatusBar } from "./footer.ts";
import { frameMarkdown } from "./markdown.ts";
import { frameMessages } from "./messages.ts";
import { framePanels } from "./panels.ts";
import { restoreAll } from "./swap.ts";

/** Compact token counts, as pi's footer shows them: 940, 2.8k, 97k, 1.0M. */
export function compactTokens(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  if (count < 10_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  if (count < 1_000_000) {
    return `${String(Math.round(count / 1000))}k`;
  }
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** "12% of 128k", turning to the warning color above 70% and the error color above 90%, as pi's footer does. */
export function contextLabel(theme: Theme, percent: number | null, window: number): string {
  if (window <= 0) {
    return "";
  }
  if (percent === null) {
    return theme.fg("muted", `? of ${compactTokens(window)}`);
  }
  const text = `${String(Math.round(percent))}% of ${compactTokens(window)}`;
  return theme.fg(percent > 90 ? "error" : percent > 70 ? "warning" : "muted", text);
}

function labels(pi: ExtensionAPI, ctx: ExtensionContext): BorderLabels {
  const theme = ctx.ui.theme;
  const model = ctx.model;
  const level = pi.getThinkingLevel();
  const thinking = model?.reasoning === true ? ` · ${level === "off" ? "thinking off" : level}` : "";
  const usage = ctx.getContextUsage();
  return {
    left: theme.fg("muted", model === undefined ? "no model" : `${model.id}${thinking}`),
    right: contextLabel(theme, usage?.percent ?? null, usage?.contextWindow ?? model?.contextWindow ?? 0),
    placeholder: theme.fg("dim", "Ask anything, or type / for commands")
  };
}

export default function look(pi: ExtensionAPI): void {
  if (process.env["PI_LOOK"] === "0") {
    return;
  }
  // Puts pi's own drawing back, for what pi has no hook to draw.
  let restores: (() => void)[] = [];
  const unframe = (): void => {
    restoreAll(restores);
    restores = [];
  };
  pi.registerToolRenderer(toolCards);
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") {
      return;
    }
    unframe();
    const theme = (): Theme => ctx.ui.theme;
    let mounted: { tui: TUI; editor: FramedEditor } | undefined;
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      const editor = new FramedEditor(tui, editorTheme, keybindings, () => labels(pi, ctx));
      mounted = { tui, editor };
      return editor;
    });
    ctx.ui.setFooter((tui, footerTheme, data) => new StatusBar(tui, footerTheme, data, ctx));
    restores.push(frameMessages(theme), frameMarkdown(theme));
    if (mounted !== undefined) {
      restores.push(framePanels(mounted.tui, mounted.editor, theme));
    }
  });
  pi.on("session_shutdown", unframe);
}
