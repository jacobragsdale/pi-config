/**
 * A guest's own suggestions, in a card above their editor: each one queued,
 * with how many wait ahead of it on the host, accepted or rejected. The card
 * keeps every queued suggestion and the latest the host answered. Until the
 * guest suggests something, it is one line saying whom they joined as and
 * what Enter now does.
 */
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { frame } from "../extensions/look/card.ts";
import type { SuggestionStatus } from "../src/protocol.ts";
import { piTheme } from "./look.ts";

type Outcome = "queued" | "accepted" | "rejected";

interface Sent {
  readonly id: string;
  readonly text: string;
  outcome: Outcome;
}

const LABEL_WIDTH = visibleWidth("✓ accepted");

/** A suggestion's text on one line. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export class SuggestionCard implements Component {
  readonly #host: string;
  readonly #ahead: (id: string) => number | undefined;
  #sent: Sent[] = [];
  /** Why the guest's last Enter sent nothing, until they send something or the host answers. */
  #refusal: string | undefined;
  /** The guest's name, once they've joined. */
  #name: string | undefined;

  /** `ahead` says how many suggestions the host has before one, or undefined once it's answered. */
  constructor(host: string, ahead: (id: string) => number | undefined) {
    this.#host = host;
    this.#ahead = ahead;
  }

  /** The guest joined with this name: say so, since their Enter now sends suggestions. */
  public joinedAs(name: string): void {
    this.#name = name;
  }

  public add(id: string, text: string): void {
    this.#refusal = undefined;
    this.#sent.push({ id, text: oneLine(text), outcome: "queued" });
  }

  /** The guest's Enter sent nothing, for this reason; what they typed stays in their editor. */
  public refuse(reason: string): void {
    this.#refusal = reason;
  }

  public answer(id: string, status: SuggestionStatus): void {
    const sent = this.#sent.find((s) => s.id === id);
    if (sent === undefined) {
      return;
    }
    sent.outcome = status === "used" ? "accepted" : "rejected";
    this.#refusal = undefined;
    // Keep what's queued, and the latest answer, which is this one: the host answers in order.
    this.#sent = this.#sent.filter((s) => s.outcome === "queued" || s === sent);
  }

  public render(width: number): string[] {
    const theme = piTheme();
    if (this.#sent.length === 0 && this.#refusal === undefined) {
      if (this.#name === undefined) {
        return [];
      }
      const note = `${theme.fg("success", "✓")} ${theme.fg("muted", "Joined as ")}${theme.fg("text", this.#name)}${theme.fg("muted", ` · type a prompt below and press Enter to suggest it to ${this.#host}`)}`;
      return [...wrapTextWithAnsi(note, Math.max(1, width - 2)).map((line) => ` ${line}`), ""];
    }
    const label = (outcome: Outcome): string => {
      switch (outcome) {
        case "queued":
          return `${theme.fg("dim", "○")} ${theme.fg("muted", "queued")}`;
        case "accepted":
          return `${theme.fg("success", "✓")} ${theme.fg("muted", "accepted")}`;
        case "rejected":
          return `${theme.fg("error", "✗")} ${theme.fg("muted", "rejected")}`;
      }
    };
    const place = (sent: Sent): string => {
      if (sent.outcome !== "queued") {
        return "";
      }
      const ahead = this.#ahead(sent.id);
      return ahead === undefined ? "" : theme.fg("dim", ahead === 0 ? " · next up" : ` · ${String(ahead)} ahead`);
    };
    const draw = (inner: number): string[] => {
      const room = inner - 2;
      const lines = this.#sent.map((sent) => {
        const head = label(sent.outcome) + " ".repeat(LABEL_WIDTH + 2 - visibleWidth(label(sent.outcome)));
        const tail = place(sent);
        const text = truncateToWidth(sent.text, Math.max(1, room - LABEL_WIDTH - 2 - visibleWidth(tail)), "…");
        return ` ${truncateToWidth(head + theme.fg("text", text) + tail, room, "…")}`;
      });
      const refusal = this.#refusal === undefined ? [] : wrapTextWithAnsi(theme.fg("warning", this.#refusal), Math.max(1, room)).map((line) => ` ${line}`);
      return [...lines, ...refusal];
    };
    return [...frame(width, 0, (text) => theme.fg("borderMuted", text), draw, theme.fg("muted", "your suggestions")), ""];
  }

  public invalidate(): void {
    // Drawn from the theme on every frame.
  }
}
