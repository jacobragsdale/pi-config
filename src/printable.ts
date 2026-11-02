/**
 * Text from the other end of a stream, reduced to what a terminal shows
 * rather than acts on: escape sequences and control characters are removed.
 * Guests' names and suggestions pass through it before the host's pi draws
 * them, and everything a host sends passes through it before guests see it.
 */

/** Escape sequences: CSI, OSC and the other string commands, then the two-byte ones. */
// eslint-disable-next-line no-control-regex -- escape sequences are what this removes
const SEQUENCES = /\x1b(?:\[[0-?]*[ -/]*[@-~]?|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -~])/g;
/** C0 controls but tab and newline, DEL, and the C1 controls some terminals act on in UTF-8 too. */
// eslint-disable-next-line no-control-regex -- control characters are what this removes
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** `text` without escape sequences or control characters; tabs and newlines stay. */
export function printable(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(SEQUENCES, "").replace(CONTROLS, "");
}

/** `text` as one printable line: every run of whitespace becomes a space. */
export function printableLine(text: string): string {
  return printable(text).replace(/\s+/g, " ").trim();
}

/** Every string in `value`, made printable. */
export function printableDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return printable(value);
  }
  if (Array.isArray(value)) {
    return value.map(printableDeep);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, printableDeep(item)]));
}

/** The first `max` UTF-16 units of `text`, or one fewer rather than half of a surrogate pair. */
export function clip(text: string, max: number): string {
  const cut = text.slice(0, max);
  return cut.length === text.length || !/[\ud800-\udbff]$/.test(cut) ? cut : cut.slice(0, -1);
}
