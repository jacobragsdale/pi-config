/**
 * The prompts you send, pi's skill, compaction and branch summary blocks, and
 * the output of `!` commands, drawn in rounded frames like the tool cards
 * instead of on pi's full-width fills and rules. pi has no hook for drawing
 * these, so this swaps their classes' render while a session runs and puts
 * pi's back when the session shuts down.
 */
import { BashExecutionComponent, BranchSummaryMessageComponent, CompactionSummaryMessageComponent, SkillInvocationMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Theme, ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Container } from "@earendil-works/pi-tui";
import { cardEdge, frame, statusBadge } from "./card.ts";
import { callMethod, restoreAll, swapProperty } from "./swap.ts";

/** pi marks each prompt for terminals that jump between them (OSC 133): where it starts, and where its output starts. */
const PROMPT_START = "\x1b]133;A\x07";
const PROMPT_END = "\x1b]133;B\x07\x1b]133;C\x07";
const DEFAULT_BG = "\x1b[49m";

const padOf = (component: object, field: string): number => {
  const value: unknown = Reflect.get(component, field);
  return typeof value === "number" ? value : 1;
};

/** `draw`'s lines in a frame of the `edge` color, without the `fill` background the theme puts behind them. */
function unfilledFrame(theme: Theme, fill: ThemeBg, edge: ThemeColor, width: number, pad: number, draw: (inner: number) => string[]): string[] {
  const fillAnsi = theme.getBgAnsi(fill);
  const unfilled = (line: string): string => (fillAnsi === "" ? line : line.replaceAll(fillAnsi, "")).replaceAll(DEFAULT_BG, "");
  return frame(
    width,
    pad,
    (text) => theme.fg(edge, text),
    (inner) => draw(inner).map(unfilled)
  );
}

/** A prompt you sent, framed a step brighter than the tool cards, keeping pi's prompt marks. */
export function framedPrompt(message: Container, width: number, theme: Theme): string[] {
  const draw = (inner: number): string[] => Container.prototype.render.call(message, inner);
  const lines = unfilledFrame(theme, "userMessageBg", "border", width, padOf(message, "outputPad"), draw);
  const last = lines.length - 1;
  if (last >= 0) {
    lines[0] = PROMPT_START + (lines[0] ?? "");
    lines[last] = PROMPT_END + (lines[last] ?? "");
  }
  return lines;
}

/** A skill, compaction or branch summary block, framed like the tool cards. */
export function framedNotice(notice: Box, width: number, theme: Theme): string[] {
  const draw = (inner: number): string[] => Box.prototype.render.call(notice, inner);
  return unfilledFrame(theme, "customMessageBg", "borderMuted", width, padOf(notice, "paddingX"), draw);
}

interface BashTimes {
  start: number | undefined;
  end: number | undefined;
  /** Whether the tick that created the component is over. */
  settled: boolean;
}

/** When each `!` command started and ended. */
const bashTimes = new WeakMap<object, BashTimes>();

/** Note a `!` command's start, on pi's first update of it, and its end. */
export function timeBash(bash: object): void {
  let times = bashTimes.get(bash);
  if (times === undefined) {
    const fresh: BashTimes = { start: Date.now(), end: undefined, settled: false };
    queueMicrotask(() => {
      fresh.settled = true;
    });
    bashTimes.set(bash, fresh);
    times = fresh;
  }
  if (Reflect.get(bash, "status") === "running" || times.end !== undefined) {
    return;
  }
  // pi builds a command loaded from the session and completes it in the same tick; its run time is unknown.
  times.end = Date.now();
  if (!times.settled) {
    times.start = undefined;
  }
}

/** A `!` or `!!` command and its output, as a card with a status badge in place of pi's rules above and below. */
export function framedBash(bash: Container, width: number, theme: Theme): string[] {
  const content: unknown = Reflect.get(bash, "contentContainer");
  if (!(content instanceof Container)) {
    return Container.prototype.render.call(bash, width);
  }
  const state: unknown = Reflect.get(bash, "status");
  const running = state === "running";
  const times = bashTimes.get(bash);
  const elapsed = times?.start === undefined ? undefined : (times.end ?? Date.now()) - times.start;
  const failed = state === "error" || state === "cancelled";
  const badge = state === "cancelled" ? theme.fg("warning", "cancelled") : statusBadge(theme, running ? "running" : failed ? "failed" : "done", elapsed);
  return ["", ...frame(width, padOf(bash, "outputPad"), cardEdge(theme, failed), (inner) => content.render(inner), badge)];
}

/** Draw prompts, pi's summary blocks and `!` commands in frames, until the returned function puts pi's drawing back. */
export function frameMessages(theme: () => Theme): () => void {
  const updateDisplay: unknown = Reflect.get(BashExecutionComponent.prototype, "updateDisplay");
  const restores = [
    swapProperty(BashExecutionComponent.prototype, "updateDisplay", function (this: BashExecutionComponent, ...args: unknown[]): unknown {
      timeBash(this);
      return callMethod(updateDisplay, this, args);
    }),
    swapProperty(UserMessageComponent.prototype, "render", function (this: UserMessageComponent, width: number): string[] {
      return framedPrompt(this, width, theme());
    }),
    swapProperty(BashExecutionComponent.prototype, "render", function (this: BashExecutionComponent, width: number): string[] {
      return framedBash(this, width, theme());
    }),
    ...[SkillInvocationMessageComponent, CompactionSummaryMessageComponent, BranchSummaryMessageComponent].map((notice) =>
      swapProperty(notice.prototype, "render", function (this: Box, width: number): string[] {
        return framedNotice(this, width, theme());
      })
    )
  ];
  return () => {
    restoreAll(restores);
  };
}
