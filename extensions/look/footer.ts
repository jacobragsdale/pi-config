/**
 * A one-line status bar in place of pi's footer: the directory, branch and
 * session name on the left; the session's cost and the other extensions'
 * statuses (budget, live) on the right. The model, thinking level and context
 * use are in the editor's bottom border instead. When both sides don't fit
 * on one line, the right side moves to a second.
 */
import { homedir } from "node:os";
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { dollars } from "../../src/dollars.ts";
import { cwdLabel, usageTotals } from "../live/footer.ts";

/** One status text on a single line, as pi's footer shows it. */
const oneLine = (text: string): string =>
  text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();

/** Text in the muted color, keeping colors set inside it: muted resumes after each one ends. */
function mutedAround(theme: Theme, text: string): string {
  const muted = theme.getFgAnsi("muted");
  return `${muted}${text.replaceAll("\x1b[39m", `\x1b[39m${muted}`)}\x1b[39m`;
}

/** Left and right on one line of `width`, or on two when they don't fit together. */
export function statusLines(left: string, right: string, width: number, ellipsis: string): string[] {
  const gap = 2;
  if (right === "") {
    return [truncateToWidth(left, width, ellipsis)];
  }
  const room = width - visibleWidth(left) - visibleWidth(right);
  if (room >= gap) {
    return [left + " ".repeat(room) + right];
  }
  return [truncateToWidth(left, width, ellipsis), truncateToWidth(right, width, ellipsis)];
}

export class StatusBar implements Component {
  readonly #theme: Theme;
  readonly #data: ReadonlyFooterDataProvider;
  readonly #ctx: ExtensionContext;
  readonly #unsubscribe: () => void;
  #cost: { key: string; usd: number } | undefined;

  constructor(tui: TUI, theme: Theme, data: ReadonlyFooterDataProvider, ctx: ExtensionContext) {
    this.#theme = theme;
    this.#data = data;
    this.#ctx = ctx;
    this.#unsubscribe = data.onBranchChange(() => {
      tui.requestRender();
    });
  }

  /** The session's cost. The footer draws every frame, and each new entry moves the leaf, so it is summed once per leaf. */
  #sessionCost(): number {
    const session = this.#ctx.sessionManager;
    const key = `${session.getSessionId()}:${session.getLeafId() ?? ""}`;
    if (this.#cost?.key !== key) {
      this.#cost = { key, usd: usageTotals(session.getEntries()).cost };
    }
    return this.#cost.usd;
  }

  public render(width: number): string[] {
    const t = this.#theme;
    const session = this.#ctx.sessionManager;
    const where = [cwdLabel(session.getCwd(), homedir()), this.#data.getGitBranch(), session.getSessionName()].filter((part) => part !== null && part !== undefined && part !== "");
    const left = t.fg("dim", where.join(" · "));
    const cost = this.#sessionCost();
    const statuses = [...this.#data.getExtensionStatuses().entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => mutedAround(t, oneLine(text)));
    const right = [...(cost > 0 ? [t.fg("muted", dollars(cost))] : []), ...statuses].join(t.fg("dim", " · "));
    return statusLines(left, right, width, t.fg("dim", "…"));
  }

  public invalidate(): void {
    this.#cost = undefined;
  }

  public dispose(): void {
    this.#unsubscribe();
  }
}
