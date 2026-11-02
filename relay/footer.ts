/**
 * A guest's footer and editor labels, drawn the way the host's look draws its
 * own from the facts the host sends. The footer is one line: directory, branch
 * and session name on the left; whose stream it is and how many have joined,
 * then the session's token use and cost, on the right. The editor's bottom
 * border shows the model, thinking level and context use, as the host's does.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { compactTokens, contextLabel } from "../extensions/look/editor.ts";
import { statusLines } from "../extensions/look/footer.ts";
import { dollars } from "../src/dollars.ts";
import type { Meta } from "../src/protocol.ts";
import { piTheme } from "./look.ts";

const LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const thinkingLevel = (level: string): ThinkingLevel => LEVELS.find((known) => known === level) ?? "off";

/** Token use as pi's own footer shows it: ↑2.8k ↓40 R97k W75 CH97.3%. */
export function tokenUse(usage: Meta["usage"]): string {
  const counts: [string, number][] = [
    ["↑", usage.input],
    ["↓", usage.output],
    ["R", usage.cacheRead],
    ["W", usage.cacheWrite]
  ];
  const parts = counts.filter(([, count]) => count > 0).map(([label, count]) => `${label}${compactTokens(count)}`);
  if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && usage.cacheHitRate !== undefined) {
    parts.push(`CH${usage.cacheHitRate.toFixed(1)}%`);
  }
  return parts.join(" ");
}

/** The model and thinking level, as the host's editor border shows them. */
export function modelLabel(meta: Meta): string {
  const { model } = meta;
  if (model === undefined) {
    return "no model";
  }
  const level = thinkingLevel(meta.thinking);
  return model.reasoning ? `${model.id} · ${level === "off" ? "thinking off" : level}` : model.id;
}

/** The editor's bottom border: the model on the left, context use on the right. */
export function editorLabels(theme: Theme, meta: Meta): { readonly left: string; readonly right: string } {
  return { left: theme.fg("muted", modelLabel(meta)), right: contextLabel(theme, meta.context?.percent ?? null, meta.context?.contextWindow ?? 0) };
}

export interface FooterState {
  readonly meta: Meta;
  readonly host: string;
  readonly joined: number;
}

/** The footer's two sides, before they are fitted to a width. */
export function footerSides(theme: Theme, { meta, host, joined }: FooterState): { readonly left: string; readonly right: string } {
  const where = [meta.cwdLabel, meta.gitBranch, meta.sessionName].filter((part) => part !== undefined && part !== "");
  const tokens = tokenUse(meta.usage);
  const live = `${theme.fg("success", "● live")}${theme.fg("muted", ` · ${host} · ${String(joined)} joined`)}`;
  // Whose stream it is comes first, so a narrow footer cuts the token counts instead.
  const right = [live, ...(tokens === "" ? [] : [theme.fg("muted", tokens)]), ...(meta.usage.cost > 0 ? [theme.fg("muted", dollars(meta.usage.cost))] : [])];
  return { left: theme.fg("dim", where.join(" · ")), right: right.join(theme.fg("dim", " · ")) };
}

export class GuestFooter implements Component {
  readonly #state: () => FooterState;

  constructor(state: () => FooterState) {
    this.#state = state;
  }

  public invalidate(): void {
    // Rendered from the stream's state on every frame.
  }

  public render(width: number): string[] {
    const theme = piTheme();
    const { left, right } = footerSides(theme, this.#state());
    return statusLines(left, right, width, theme.fg("dim", "…"));
  }
}
