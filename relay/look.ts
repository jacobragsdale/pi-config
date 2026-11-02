/**
 * The host's look, for guests: the team's shadcn-dark theme, pi's key
 * bindings so the key hints pi's components print name their keys, and the
 * look extension's frames for prompts, summaries, `!` commands, tables and
 * code. pi keeps one theme per process, so every guest of a relay gets the same.
 */
import { fileURLToPath } from "node:url";
import { Theme, initTheme } from "@earendil-works/pi-coding-agent";
import { setKeybindings } from "@earendil-works/pi-tui";
// pi exports neither its key bindings nor its theme loader; these are the ones its interactive mode uses.
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { loadThemeFromPath, setThemeInstance } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { frameMarkdown } from "../extensions/look/markdown.ts";
import { frameMessages } from "../extensions/look/messages.ts";

/** Where pi keeps its theme; pi's components read it from here too. */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const THEME = fileURLToPath(new URL("../themes/shadcn-dark.json", import.meta.url));

/** pi's default key bindings, for the guests' editors and pi's key hints. */
export const keybindings = new KeybindingsManager();

let set = false;

/** Set up the theme, key bindings and frames, once per process; the frames stay for its life. */
export function useHostLook(log: (line: string) => void): void {
  if (set) {
    return;
  }
  set = true;
  try {
    setThemeInstance(loadThemeFromPath(THEME, "truecolor"));
  } catch (err) {
    log(`guests get pi's dark theme: can't load ${THEME} (${err instanceof Error ? err.message : String(err)})`);
    initTheme("dark", false);
  }
  setKeybindings(keybindings);
  frameMessages(piTheme);
  frameMarkdown(piTheme);
}

export function piTheme(): Theme {
  const value: unknown = Reflect.get(globalThis, THEME_KEY);
  if (!(value instanceof Theme)) {
    throw new Error("pi's theme isn't set up: call useHostLook() first");
  }
  return value;
}
