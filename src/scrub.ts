/**
 * Prepares pi's messages before they leave the host's machine: masks likely
 * secrets in every string, drops provider signatures guests have no use for,
 * and replaces images with a placeholder so screenshots never reach the relay.
 */
import { redact, redactPartial } from "./redact.ts";

/** Opaque provider blobs: large, meaningless to guests, and not worth scanning. */
const DROPPED_KEYS = new Set(["textSignature", "thinkingSignature", "thoughtSignature", "signature"]);

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

type Mask = (text: string) => string;

const whole: Mask = (text) => redact(text).text;

/** The fields of a message or tool result whose text is what the model or the tool writes, as it writes it. */
const WRITTEN = new Set(["text", "thinking", "arguments"]);

/** Masks strings with `mask`, except under the WRITTEN fields, where it uses `written`. */
function scrubWith(value: unknown, mask: Mask, written: Mask): unknown {
  if (typeof value === "string") {
    return mask(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubWith(item, mask, written));
  }
  if (!isObject(value)) {
    return value;
  }
  if (value["type"] === "image") {
    return { type: "text", text: "[image not shared]" };
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!DROPPED_KEYS.has(key)) {
      copy[key] = scrubWith(item, WRITTEN.has(key) ? written : mask, written);
    }
  }
  return copy;
}

export function scrub(value: unknown): unknown {
  return scrubWith(value, whole, whole);
}

/** scrub for a message or tool output still being written, whose text may end partway through a secret. */
export function scrubPartial(value: unknown): unknown {
  return scrubWith(value, whole, redactPartial);
}
