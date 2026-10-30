import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { BashExecutionComponent, DynamicBorder, SkillInvocationMessageComponent, UserMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, colorToRgb, parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
// pi exports no theme loader; this is the one /settings uses.
import { loadThemeFromPath, setThemeInstance } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { ToolCard, cardRenderers, formatDuration, toolCards } from "../extensions/look/card.ts";
import { labelledBorder } from "../extensions/look/editor.ts";
import { statusLines } from "../extensions/look/footer.ts";
import { compactTokens, contextLabel } from "../extensions/look/index.ts";
import { frameMarkdown, framedCode } from "../extensions/look/markdown.ts";
import { frameMessages, framedBash, framedNotice, framedPrompt, timeBash } from "../extensions/look/messages.ts";
import { framePanels, framedPanel } from "../extensions/look/panels.ts";
import { PiRpc, isRecord, makeAgentDir, repo, scriptedProvider } from "./pi-rpc.ts";

const plain = (line: string): string => stripTerminalSequences(line);
const themePath = (name: string): string => join(repo, "themes", `${name}.json`);
const dark = loadThemeFromPath(themePath("shadcn-dark"), "truecolor");
// pi's own renderers, key hints and message blocks draw with the global theme.
setThemeInstance(dark);

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

// --- Themes ---

const schema = record(JSON.parse(readFileSync(join(repo, "node_modules/@earendil-works/pi-coding-agent/schemas/theme.schema.json"), "utf8")));
const colorSchema = record(record(schema["properties"])["colors"]);
const requiredColors = new Set(Array.isArray(colorSchema["required"]) ? colorSchema["required"].map(String) : []);
const knownColors = new Set(Object.keys(record(colorSchema["properties"])));
const isLiteral = (value: unknown): boolean => typeof value === "number" || (typeof value === "string" && /^(?:#|oklch\(|okhsl\(|$)/.test(value));

/** WCAG contrast ratio of two colors. */
function contrast(a: string, b: string): number {
  const luminance = (value: string): number => {
    const { r, g, b: blue } = colorToRgb(parseColor(value));
    const channel = (c: number): number => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(blue);
  };
  const [light, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

for (const name of ["shadcn-dark", "shadcn-light"]) {
  await test(`${name} sets every color pi's schema asks for, and nothing else`, () => {
    const file = record(JSON.parse(readFileSync(themePath(name), "utf8")));
    assert.equal(file["name"], name);
    const colors = Object.keys(record(file["colors"]));
    assert.deepEqual(
      [...requiredColors].filter((token) => !colors.includes(token)),
      []
    );
    assert.deepEqual(
      colors.filter((token) => !knownColors.has(token)),
      []
    );
  });

  await test(`${name} names only variables it defines`, () => {
    const file = record(JSON.parse(readFileSync(themePath(name), "utf8")));
    const vars = record(file["vars"]);
    const values = [...Object.values(vars), ...Object.values(record(file["colors"])), ...Object.values(record(file["export"]))];
    assert.deepEqual(
      values.filter((value) => !isLiteral(value) && !(typeof value === "string" && value in vars)),
      []
    );
  });

  await test(`${name} loads in pi, and its text and muted text are readable on its background`, () => {
    const loaded = loadThemeFromPath(themePath(name), "truecolor");
    assert.equal(loaded.appearance, name.endsWith("dark") ? "dark" : "light");
    const vars = record(record(JSON.parse(readFileSync(themePath(name), "utf8")))["vars"]);
    const background = String(vars["background"]);
    assert.ok(contrast(String(vars["text"]), background) >= 7);
    assert.ok(contrast(String(vars["mutedForeground"]), background) >= 4.5);
  });
}

await test("the team settings pick the shadcn themes, light and dark", () => {
  const settings = record(JSON.parse(readFileSync(join(repo, "agent/settings.json"), "utf8")));
  assert.equal(settings["theme"], "shadcn-light/shadcn-dark");
});

// --- Tool cards ---

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderContext = Parameters<RenderCall>[2];

function context(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    args: {},
    toolCallId: "call-1",
    invalidate: () => undefined,
    lastComponent: undefined,
    state: {},
    cwd: "/work",
    executionStarted: false,
    argsComplete: true,
    isPartial: true,
    expanded: false,
    showImages: false,
    isError: false,
    durationMs: undefined,
    outputPad: 1,
    ...overrides
  };
}

const ok = { content: [{ type: "text" as const, text: "done" }], details: undefined };

/** Fake renderers that record the context they were given. */
function recording(): { renderers: ToolRenderers; seen: RenderContext[] } {
  const seen: RenderContext[] = [];
  const renderers: ToolRenderers = {
    renderCall: (_args, _theme, ctx) => {
      seen.push(ctx);
      return new Text("$ npm test", 0, 0);
    },
    renderResult: (_result, _options, _theme, ctx) => {
      seen.push(ctx);
      return new Text("\n12 passed", 0, 0);
    }
  };
  return { renderers, seen };
}

function draw(component: Component, width: number): string[] {
  const lines = component.render(width);
  for (const line of lines) {
    assert.equal(visibleWidth(line), width, `"${plain(line)}" is not ${String(width)} columns`);
  }
  return lines.map(plain);
}

const running: PiRpc[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((pi) => pi.close()));
});

await test("a tool row becomes a card that waits, runs and finishes, with the tool's own call and result inside", () => {
  const { renderers } = recording();
  const card = cardRenderers("bash", renderers);
  const state = {};
  const call = (ctx: RenderContext): Component => card.renderCall?.({}, dark, ctx) ?? new Text("", 0, 0);

  const drawn = call(context({ state }));
  assert.ok(drawn instanceof ToolCard);
  assert.match(draw(drawn, 60)[0] ?? "", /^ ╭─+ ○ pending ─╮ $/);

  call(context({ state, executionStarted: true }));
  assert.match(draw(drawn, 60)[0] ?? "", / ● running ─╮/);

  const done = context({ state, executionStarted: true, isPartial: false, durationMs: 1234 });
  call(done);
  const result = card.renderResult?.(ok, { expanded: false, isPartial: false }, dark, done);
  assert.deepEqual(result?.render(60), []);
  assert.deepEqual(draw(drawn, 60), [` ╭${"─".repeat(47)} ✓ 1.2s ─╮ `, ` │ $ npm test${" ".repeat(45)}│ `, ` │${" ".repeat(56)}│ `, ` │ 12 passed${" ".repeat(46)}│ `, ` ╰${"─".repeat(56)}╯ `]);
});

await test("a failed tool's card says so in its badge", () => {
  const { renderers } = recording();
  const card = cardRenderers("bash", renderers);
  const state = {};
  const drawn = card.renderCall?.({}, dark, context({ state }));
  card.renderCall?.({}, dark, context({ state, executionStarted: true, isPartial: false, isError: true, durationMs: 40 }));
  assert.match(plain(drawn?.render(50)[0] ?? ""), / ✗ 40ms ─╮/);
});

await test("the wrapped renderers get their own state and components back, no padding, and no clock for shell tools", () => {
  const { renderers, seen } = recording();
  const card = cardRenderers("bash", renderers);
  const state = {};
  card.renderCall?.({}, dark, context({ state }));
  card.renderCall?.({}, dark, context({ state, executionStarted: true, isPartial: false, durationMs: 5 }));
  const [first, second] = seen;
  assert.notEqual(first?.state, state);
  assert.equal(first?.state, second?.state);
  assert.equal(first?.lastComponent, undefined);
  assert.ok(second?.lastComponent instanceof Text);
  assert.equal(second.outputPad, 0);
  assert.equal(second.executionStarted, false);
  assert.equal(second.durationMs, undefined);
});

await test("a row that starts already running, as in pi's HTML export, gets the tool's plain components", () => {
  const { renderers } = recording();
  const card = cardRenderers("bash", renderers);
  const state = {};
  const call = card.renderCall?.({}, dark, context({ state, executionStarted: true }));
  assert.ok(call instanceof Text);
  const result = card.renderResult?.(ok, { expanded: false, isPartial: false }, dark, context({ state, executionStarted: true, isPartial: false }));
  assert.deepEqual(
    result?.render(40).map((line) => plain(line).trim()),
    ["", "12 passed"]
  );
});

await test("a narrow card leaves out its frame", () => {
  const { renderers } = recording();
  const drawn = cardRenderers("bash", renderers).renderCall?.({}, dark, context());
  assert.ok(!(drawn?.render(14) ?? []).some((line) => line.includes("╭")));
});

await test("tools that draw their own frame keep it, except pi's edit; tools without renderers get a name and their output", () => {
  const own: ToolRenderers = { renderShell: "self", renderCall: () => new Text("mine", 0, 0) };
  assert.equal(
    toolCards("custom", () => own),
    own
  );
  assert.notEqual(
    toolCards("edit", () => own),
    own
  );
  const bare = toolCards("lookup", () => undefined);
  const state = {};
  const drawn = bare?.renderCall?.({ id: 7 }, dark, context({ state })) ?? new Text("", 0, 0);
  assert.match(draw(drawn, 50)[1] ?? "", /│ lookup \{"id":7\} +│/);
  const many = { content: [{ type: "text" as const, text: Array.from({ length: 14 }, (_, i) => `line ${String(i)}`).join("\n") }], details: undefined };
  bare?.renderResult?.(many, { expanded: false, isPartial: false }, dark, context({ state, isPartial: false }));
  assert.ok(draw(drawn, 50).some((line) => line.includes("... (4 more lines,")));
});

await test("durations read as milliseconds, then seconds, then minutes", () => {
  assert.deepEqual([840, 4200, 90_000, 7_380_000].map(formatDuration), ["840ms", "4.2s", "1m 30s", "2h 3m"]);
});

// --- Messages ---

const hasBackground = (line: string): boolean => line.includes("\x1b[48;");

await test("a prompt you send sits in a frame, without pi's fill, and keeps its marks for terminals that jump between prompts", () => {
  const lines = framedPrompt(new UserMessageComponent("tell me about **this** repo"), 40, dark);
  assert.deepEqual(lines.map(plain), [` ╭${"─".repeat(36)}╮ `, ` │ tell me about this repo${" ".repeat(12)}│ `, ` ╰${"─".repeat(36)}╯ `]);
  assert.ok(!lines.some(hasBackground));
  assert.ok(lines[0]?.startsWith("\x1b]133;A\x07") === true);
  assert.ok(lines.at(-1)?.startsWith("\x1b]133;B\x07\x1b]133;C\x07") === true);
});

await test("pi's skill block sits in a frame like a tool card's, without its fill", () => {
  const skill = new SkillInvocationMessageComponent({ name: "dev-start", location: "", content: "", userMessage: undefined });
  const lines = framedNotice(skill, 50, dark);
  const [top, label, bottom, ...rest] = lines.map(plain);
  assert.deepEqual([top, bottom, rest], [` ╭${"─".repeat(46)}╮ `, ` ╰${"─".repeat(46)}╯ `, []]);
  assert.match(label ?? "", /^ │ \[skill\] dev-start \(.*to expand\) +│ $/);
  assert.ok(!lines.some(hasBackground));
});

await test("framed messages last until undone, and then pi draws them its own way again", () => {
  const own = Object.getOwnPropertyDescriptor(UserMessageComponent.prototype, "render");
  const update = Object.getOwnPropertyDescriptor(BashExecutionComponent.prototype, "updateDisplay");
  const message = new UserMessageComponent("hello");
  const skill = new SkillInvocationMessageComponent({ name: "dev-start", location: "", content: "", userMessage: undefined });
  const undo = frameMessages(() => dark);
  try {
    assert.match(plain(message.render(30)[0] ?? ""), /╭/);
    assert.match(plain(skill.render(50)[0] ?? ""), /╭/);
  } finally {
    undo();
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(UserMessageComponent.prototype, "render"), own);
  assert.ok(!Object.hasOwn(SkillInvocationMessageComponent.prototype, "render"));
  assert.ok(!Object.hasOwn(BashExecutionComponent.prototype, "render"));
  assert.deepEqual(Object.getOwnPropertyDescriptor(BashExecutionComponent.prototype, "updateDisplay"), update);
  assert.ok(message.render(30).some(hasBackground));
  assert.ok(skill.render(50).some(hasBackground));
});

/** A stand-in for pi's BashExecutionComponent: its output container, status and padding. */
function bashLike(status: string, output: string): Container {
  const content = new Container();
  content.addChild(new Text(`$ ls\n\n${output}`, 1, 0));
  return Object.assign(new Container(), { contentContainer: content, status, outputPad: 1 });
}

await test("a ! command is a card whose badge says how it went and how long it took", async () => {
  const quick = bashLike("running", "a.ts");
  timeBash(quick);
  await Promise.resolve();
  Object.assign(quick, { status: "complete" });
  timeBash(quick);
  const lines = framedBash(quick, 40, dark).map(plain);
  assert.equal(lines[0], "");
  assert.match(lines[1] ?? "", /^ ╭─+ ✓ \d+ms ─╮ $/);
  assert.deepEqual(lines.slice(2), [` │ $ ls${" ".repeat(31)}│ `, ` │${" ".repeat(36)}│ `, ` │ a.ts${" ".repeat(31)}│ `, ` ╰${"─".repeat(36)}╯ `]);

  // pi builds a command loaded from the session and completes it at once, so its run time is unknown.
  const loaded = bashLike("running", "");
  timeBash(loaded);
  Object.assign(loaded, { status: "error" });
  timeBash(loaded);
  assert.match(plain(framedBash(loaded, 40, dark)[1] ?? ""), / ✗ failed ─╮ $/);
});

// --- Markdown ---

await test("Markdown tables get rounded corners, and code blocks a frame with their language, until undone", () => {
  const text = "| a | b |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```";
  const undo = frameMarkdown(() => dark);
  let lines: string[];
  try {
    lines = new Markdown(text, 0, 0, getMarkdownTheme()).render(30).map((line) => plain(line).trimEnd());
  } finally {
    undo();
  }
  assert.deepEqual(lines, ["╭───┬───╮", "│ a │ b │", "├───┼───┤", "│ 1 │ 2 │", "╰───┴───╯", "", `╭${"─".repeat(23)} ts ─╮`, `│ const x = 1;${" ".repeat(15)}│`, `╰${"─".repeat(28)}╯`]);
  const plainMarkdown = new Markdown(text, 0, 0, getMarkdownTheme()).render(30).map((line) => plain(line).trimEnd());
  assert.ok(plainMarkdown.includes("┌───┬───┐"));
  assert.ok(plainMarkdown.includes("```ts"));
});

await test("a long line of code wraps inside its frame", () => {
  const indent = "  ";
  const lines = framedCode(["```", `${indent}${"x".repeat(30)}`, "```"], "", 20, indent, dark).map(plain);
  assert.deepEqual(lines, [`╭${"─".repeat(18)}╮`, `│ ${"x".repeat(16)} │`, `│ ${"x".repeat(14)}   │`, `╰${"─".repeat(18)}╯`]);
});

// --- Panels ---

const rule = (width: number): string => dark.fg("border", "─".repeat(width));

await test("a selector's rules become its frame and dividers, with blank lines outside them left out", () => {
  const panel = framedPanel(["", rule(20), "Title", rule(20), "item", "", rule(20)], 24, (text) => text);
  assert.deepEqual(panel.lines.map(plain), [`╭${"─".repeat(22)}╮`, `│ Title${" ".repeat(16)}│`, `├${"─".repeat(22)}┤`, `│ item${" ".repeat(17)}│`, `│${" ".repeat(22)}│`, `╰${"─".repeat(22)}╯`]);
  assert.equal(panel.offset, 1);
  assert.equal(framedPanel(["plain"], 24, (text) => text).offset, -1);
});

await test("what replaces the editor is framed and still gets its clicks, and the chat's ruled blocks are framed, until undone", () => {
  const editor = new Text("editor", 0, 0);
  const holder = new Container();
  holder.addChild(editor);
  const chat = new Container();
  const document = new Container();
  document.addChild(new Container());
  document.addChild(chat);
  for (const child of [new Text("a", 0, 0), new DynamicBorder(), new Text("b", 1, 0), new DynamicBorder()]) {
    chat.addChild(child);
  }
  const clicks: TuiMouseEvent[] = [];
  const selector: Component = {
    render: (width) => [rule(width), "pick", rule(width)],
    invalidate: () => undefined,
    handleMouse: (event) => {
      clicks.push(event);
      return { handled: true };
    }
  };
  const undo = framePanels({ children: [document, holder] }, editor, () => dark);
  try {
    assert.deepEqual(holder.render(24).map(plain), [`editor${" ".repeat(18)}`]);
    holder.clear();
    holder.addChild(selector);
    assert.deepEqual(holder.render(24).map(plain), [`╭${"─".repeat(22)}╮`, `│ pick${" ".repeat(17)}│`, `╰${"─".repeat(22)}╯`]);
    holder.handleMouse({ type: "click", button: "left", x: 5, y: 1, screenX: 5, screenY: 30, width: 24, height: 3, shift: false, alt: false, ctrl: false });
    assert.deepEqual(
      clicks.map(({ x, y, width }) => ({ x, y, width })),
      [{ x: 3, y: 1, width: 20 }]
    );
    assert.deepEqual(chat.render(24).map(plain), [`a${" ".repeat(23)}`, `╭${"─".repeat(22)}╮`, `│ b${" ".repeat(20)}│`, `╰${"─".repeat(22)}╯`]);
  } finally {
    undo();
  }
  assert.deepEqual(holder.render(24).map(plain), ["─".repeat(24), "pick", "─".repeat(24)]);
  assert.ok(chat.render(24).map(plain).includes("─".repeat(24)));
});

// --- Editor and footer ---

await test("the editor's bottom border fits its width, and the right label gives way first", () => {
  const line = (text: string): string => text;
  assert.equal(labelledBorder("model · high", "12% of 128k", 40, line), "─ model · high ─────────── 12% of 128k ─");
  assert.equal(labelledBorder("model · high", "12% of 128k", 22, line), "─ model · high ───────");
  assert.equal(plain(labelledBorder("claude-haiku-5.5 · xhigh", "12% of 128k", 16, line)), "─ claude-hai… ──");
  assert.equal(labelledBorder("model", "ctx", 6, line), "──────");
});

await test("the status bar keeps both sides on one line when they fit, and moves the right side down when not", () => {
  assert.deepEqual(statusLines("~/dev/app · main", "$0.04", 30, "…"), [`~/dev/app · main${" ".repeat(9)}$0.04`]);
  assert.deepEqual(statusLines("~/dev/app · main", "month $3.20/$500", 30, "…"), ["~/dev/app · main", "month $3.20/$500"]);
  assert.deepEqual(statusLines("~/dev/app", "", 30, "…"), ["~/dev/app"]);
});

await test("context use reads as a share of the window, colored past 70% and 90%", () => {
  assert.deepEqual([940, 2800, 128_000, 1_000_000].map(compactTokens), ["940", "2.8k", "128k", "1.0M"]);
  assert.equal(plain(contextLabel(dark, 12.4, 128_000)), "12% of 128k");
  assert.equal(plain(contextLabel(dark, null, 128_000)), "? of 128k");
  assert.equal(contextLabel(dark, 95, 128_000), dark.fg("error", "95% of 128k"));
  assert.equal(contextLabel(dark, 80, 128_000), dark.fg("warning", "80% of 128k"));
});

// --- In pi ---

/** The tools pi's HTML export drew with their renderers, from the session data the page embeds. */
function renderedTools(html: string): Record<string, unknown> {
  const data = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html)?.[1] ?? "";
  const parsed: unknown = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  return record(record(parsed)["renderedTools"]);
}

await test("in pi, a tool runs with the look loaded, and the HTML export shows it without a card", async () => {
  const agentDir = makeAgentDir();
  const extensions = [join(repo, "extensions/look/index.ts"), join(repo, "tests/fixtures/lookup-tool.ts"), scriptedProvider];
  const pi = new PiRpc({ agentDir, extensions, env: { SCRIPTED_TOOL_TURNS: "1", SCRIPTED_TOOL: "lookup" }, args: [] });
  running.push(pi);
  await pi.prompt("look it up");
  const from = pi.records.length;
  const outputPath = join(agentDir, "session.html");
  pi.send({ id: "export", type: "export_html", outputPath });
  const response = await pi.waitFor((r) => r["type"] === "response" && r["id"] === "export", from);
  assert.equal(response["success"], true, JSON.stringify(response));
  const tool = record(renderedTools(readFileSync(outputPath, "utf8"))["call-1"]);
  assert.match(String(tool["callHtml"]), /lookup/);
  assert.match(String(tool["resultHtmlExpanded"]), /found 3 matches/);
  assert.ok(!JSON.stringify(tool).includes("╭"));
});
