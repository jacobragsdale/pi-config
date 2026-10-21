import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const monthKey = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

/**
 * Log shared by every pi process using the same agent directory, one JSON
 * line per item in a file per UTC month of the item's `t`.
 */
export class MonthlyLog<T extends { readonly t: number }> {
  readonly #dir: string;
  readonly #isItem: (value: unknown) => value is T;

  constructor(dir: string, isItem: (value: unknown) => value is T) {
    this.#dir = dir;
    this.#isItem = isItem;
  }

  public append(items: readonly T[]): void {
    if (items.length === 0) {
      return;
    }
    mkdirSync(this.#dir, { recursive: true });
    const byMonth = new Map<string, string[]>();
    for (const item of items) {
      const key = monthKey(item.t);
      byMonth.set(key, [...(byMonth.get(key) ?? []), JSON.stringify(item)]);
    }
    // One append per file: O_APPEND keeps lines from concurrent processes whole.
    for (const [key, lines] of byMonth) {
      appendFileSync(join(this.#dir, `${key}.jsonl`), `${lines.join("\n")}\n`);
    }
  }

  /** Items recorded at or after `from`. Unreadable lines are skipped. */
  public since(from: number, now: number): T[] {
    const result: T[] = [];
    const start = new Date(from);
    for (let month = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1); month <= now;) {
      const file = join(this.#dir, `${monthKey(month)}.jsonl`);
      if (existsSync(file)) {
        for (const line of readFileSync(file, "utf8").split("\n")) {
          const item = this.#parseLine(line);
          if (item !== undefined && item.t >= from) {
            result.push(item);
          }
        }
      }
      const date = new Date(month);
      month = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    }
    return result;
  }

  #parseLine(line: string): T | undefined {
    if (line.trim() === "") {
      return undefined;
    }
    try {
      const value: unknown = JSON.parse(line);
      return this.#isItem(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
}
