/**
 * A pi-tui Terminal on top of one guest's SSH channel, so each guest gets
 * their own TUI at their own terminal size. It skips the keyboard protocol
 * negotiation ProcessTerminal does: the viewer only needs plain keys.
 */
import { StringDecoder } from "node:string_decoder";
import { StdinBuffer } from "@earendil-works/pi-tui";
import type { Terminal } from "@earendil-works/pi-tui";

/**
 * Guests are drawn at least this wide. pi's editor wraps forever, and the
 * stack overflow ends the relay, when a character is wider than the space
 * it has, as a CJK character is in an editor a few columns wide. A guest's
 * terminal can claim any width, so narrower ones are drawn at this width and
 * their terminal crops the lines.
 */
const MIN_COLUMNS = 20;

/** The parts of an ssh2 ServerChannel the terminal uses. */
export interface Channel {
  write(data: string): unknown;
  on(event: "data", listener: (data: Buffer) => void): unknown;
}

export class ChannelTerminal implements Terminal {
  readonly #channel: Channel;
  #columns: number;
  #rows: number;
  #closed = false;
  #onResize: (() => void) | undefined;
  #buffer: StdinBuffer | undefined;
  public readonly kittyProtocolActive = false;

  constructor(channel: Channel, columns: number, rows: number) {
    this.#channel = channel;
    this.#columns = columns;
    this.#rows = rows;
  }

  public start(onInput: (data: string) => void, onResize: () => void): void {
    this.#onResize = onResize;
    const buffer = new StdinBuffer();
    // StdinBuffer also delivers keys from a timer, where nothing would catch an
    // error: a key the guest's screen can't handle is dropped instead of
    // stopping the relay.
    const input = (data: string): void => {
      try {
        onInput(data);
      } catch {
        // Dropped.
      }
    };
    buffer.on("data", input);
    buffer.on("paste", (content) => {
      input(`\x1b[200~${content}\x1b[201~`);
    });
    this.#buffer = buffer;
    // Decoded as pi decodes its own stdin, so a character split between two packets arrives whole.
    const decoder = new StringDecoder("utf8");
    this.#channel.on("data", (data) => {
      const text = decoder.write(data);
      // Keys that arrive after the guest left, such as the rest of a paste, go nowhere.
      if (this.#buffer === buffer && text !== "") {
        buffer.process(text);
      }
    });
    this.write("\x1b[?2004h"); // Bracketed paste, so a pasted prompt arrives as one edit.
  }

  public stop(): void {
    this.write("\x1b[?2004l");
    this.#buffer?.destroy();
    this.#buffer = undefined;
  }

  public drainInput(): Promise<void> {
    return Promise.resolve();
  }

  public resize(columns: number, rows: number): void {
    this.#columns = columns;
    this.#rows = rows;
    this.#onResize?.();
  }

  /** Stop writing: the guest has gone. */
  public close(): void {
    this.#closed = true;
  }

  public write(data: string): void {
    if (!this.#closed) {
      this.#channel.write(data);
    }
  }

  public get columns(): number {
    return Math.max(MIN_COLUMNS, this.#columns);
  }

  public get rows(): number {
    return this.#rows;
  }

  public moveBy(lines: number): void {
    if (lines > 0) {
      this.write(`\x1b[${String(lines)}B`);
    } else if (lines < 0) {
      this.write(`\x1b[${String(-lines)}A`);
    }
  }

  public hideCursor(): void {
    this.write("\x1b[?25l");
  }

  public showCursor(): void {
    this.write("\x1b[?25h");
  }

  public clearLine(): void {
    this.write("\x1b[K");
  }

  public clearFromCursor(): void {
    this.write("\x1b[J");
  }

  public clearScreen(): void {
    this.write("\x1b[2J\x1b[H");
  }

  public setTitle(title: string): void {
    this.write(`\x1b]0;${title}\x07`);
  }

  public setProgress(): void {
    // Guests' terminals show no progress indicator.
  }

  public setProgramStatus(): void {
    // Not reported to guests.
  }
}
