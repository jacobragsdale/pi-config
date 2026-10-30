/**
 * pi's editor in a rounded frame. The top border keeps pi's working status
 * and scroll markers; the bottom border carries labels, such as the model and
 * context use, unless it is showing how many lines are hidden below.
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { renderFakeCursor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

/** Columns the frame adds on each side: the border and one space. */
const FRAME = 2;
/** Below this width the editor is drawn as pi draws it. */
const MIN_WIDTH = 20;

export interface BorderLabels {
  /** Styled text for the bottom border's left and right ends. */
  readonly left: string;
  readonly right: string;
  /** Dim text shown while the editor is empty. */
  readonly placeholder: string;
}

/** A border of `width` columns with `left` and `right` set into it. When both don't fit, `right` goes, then `left` is shortened. */
export function labelledBorder(left: string, right: string, width: number, line: (text: string) => string): string {
  const spaced = (label: string): string => (label === "" ? "" : ` ${label} `);
  const gap = (l: string, r: string): number => width - 2 - visibleWidth(l) - visibleWidth(r);
  let l = spaced(left);
  let r = spaced(right);
  if (gap(l, r) < 1) {
    r = "";
  }
  if (gap(l, r) < 1) {
    // Room for the label between "─ " and " ──", or no label at all.
    const room = width - 5;
    l = room >= 4 ? spaced(truncateToWidth(left, room, "…")) : "";
  }
  if (gap(l, r) < 1) {
    return line("─".repeat(Math.max(0, width)));
  }
  return line("─") + l + line("─".repeat(gap(l, r))) + r + line("─");
}

export class FramedEditor extends CustomEditor {
  readonly #labels: () => BorderLabels;
  #bottom: string | undefined;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, labels: () => BorderLabels) {
    super(tui, theme, keybindings, { paddingX: FRAME, embedWorkingStatus: true });
    this.#labels = labels;
  }

  // pi sets the editorPaddingX setting through these; the frame comes on top of it.
  public override getPaddingX(): number {
    return Math.max(0, super.getPaddingX() - FRAME);
  }

  public override setPaddingX(padding: number): void {
    super.setPaddingX(padding + FRAME);
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    if (width < MIN_WIDTH) {
      return super.renderTopBorder(width, hiddenLineCount);
    }
    return this.borderColor("╭") + super.renderTopBorder(width - 2, hiddenLineCount) + this.borderColor("╮");
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    if (width < MIN_WIDTH) {
      return super.renderBottomBorder(width, hiddenLineCount);
    }
    let middle = super.renderBottomBorder(width - 2, hiddenLineCount);
    if (hiddenLineCount === 0) {
      const labels = this.#labels();
      middle = labelledBorder(labels.left, labels.right, width - 2, this.borderColor);
    }
    this.#bottom = this.borderColor("╰") + middle + this.borderColor("╯");
    return this.#bottom;
  }

  public override render(width: number): string[] {
    const lines = super.render(width);
    const drawn = this.#bottom;
    this.#bottom = undefined;
    const bottom = drawn === undefined ? -1 : lines.indexOf(drawn);
    if (bottom < 1) {
      return lines;
    }
    const side = this.borderColor("│");
    for (let i = 1; i < bottom; i += 1) {
      const line = i === 1 && this.getText() === "" ? this.#withPlaceholder(lines[i] ?? "") : (lines[i] ?? "");
      // Each line starts and ends with the padding's plain spaces: the outer ones become the frame.
      lines[i] = side + line.slice(1, -1) + side;
    }
    return lines;
  }

  /** An empty line is the cursor and then padding spaces; write the placeholder into those spaces. */
  #withPlaceholder(line: string): string {
    const cursor = renderFakeCursor(" ");
    const end = line.indexOf(cursor) + cursor.length;
    if (end < cursor.length) {
      return line;
    }
    const spaces = line.length - end;
    const shown = truncateToWidth(this.#labels().placeholder, Math.max(0, spaces - super.getPaddingX()), "…");
    return line.slice(0, end) + shown + " ".repeat(spaces - visibleWidth(shown));
  }
}
