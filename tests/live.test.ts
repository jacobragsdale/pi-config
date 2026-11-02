/**
 * End to end: a real pi in RPC mode with the extension and the scripted
 * provider, a relay in this process, and guests over real SSH connections.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { cardLines, guestNames } from "../extensions/live/index.ts";
import { piTheme } from "../relay/look.ts";
import { Guest, eventually, startRelay } from "./live.ts";
import type { TestRelay } from "./live.ts";
import { PiRpc, field, isRecord, makeAgentDir, repo, scriptedProvider } from "./pi-rpc.ts";
import type { RpcRecord } from "./pi-rpc.ts";

const extension = join(repo, "extensions/live/index.ts");
const secret = `ghp_${"Zx9Q".repeat(9)}`;

let relay: TestRelay;
const open: { close(): void }[] = [];
const running: PiRpc[] = [];

beforeEach(async () => {
  relay = await startRelay();
});

afterEach(async () => {
  for (const peer of open.splice(0)) {
    peer.close();
  }
  await Promise.all(running.splice(0).map((pi) => pi.close()));
  await relay.relay.close();
});

function startPi(env: Readonly<Record<string, string>> = {}, agentDir = makeAgentDir()): PiRpc {
  const pi = new PiRpc({ agentDir, extensions: [extension, scriptedProvider], env: { PI_LIVE_URL: `ws://127.0.0.1:${String(relay.http)}/host`, PI_LIVE_NAME: "tester", ...env } });
  running.push(pi);
  return pi;
}

const isUi = (method: string) => (record: RpcRecord) => record["type"] === "extension_ui_request" && record["method"] === method;

/** Start a stream and return the token from the join command pi shows above the editor. */
async function goLive(pi: PiRpc): Promise<string> {
  await pi.prompt("/live");
  const card = await eventually(
    () => lastWidget(pi)?.map(String).join("\n"),
    () => "no join card"
  );
  assert.ok(stripTerminalSequences(card).startsWith("Live. Send this to whoever should join:"), card);
  const token = /ssh -p \d+ ([a-z2-7]{24})@127\.0\.0\.1/.exec(stripTerminalSequences(card))?.[1];
  assert.ok(token !== undefined, `no join command in ${card}`);
  return token;
}

async function join_(pi: PiRpc, token: string, name: string): Promise<Guest> {
  const guest = await Guest.connect(relay.ssh, token);
  open.push(guest);
  await guest.sees("Type your name");
  guest.type(`${name}\r`);
  await eventually(
    () => (pi.lastStatus("live").includes(name) ? true : undefined),
    () => `status never named ${name}: ${pi.lastStatus("live")}`
  );
  return guest;
}

function lastWidget(pi: PiRpc): readonly unknown[] | undefined {
  const widget = pi.records.filter((r) => isUi("setWidget")(r) && r["widgetKey"] === "live").at(-1);
  const lines = widget?.["widgetLines"];
  return Array.isArray(lines) ? lines : undefined;
}

await test("/live streams the session to an ssh guest, and /live again ends it", async () => {
  const pi = startPi();
  const token = await goLive(pi);
  assert.match(pi.lastStatus("live"), /● live.* · nobody joined yet/);
  const bob = await join_(pi, token, "bob");
  await bob.sees("You've joined tester's pi session.");
  await eventually(
    () => (lastWidget(pi) === undefined ? true : undefined),
    () => `the join card stayed once bob joined: ${JSON.stringify(lastWidget(pi))}`
  );

  await pi.prompt("Fix the login bug");
  await bob.sees("Fix the login bug");
  await bob.sees("ok");

  const from = pi.records.length;
  await pi.prompt("/live");
  assert.ok(pi.notices(from).includes("Stream ended. Its link no longer works."));
  assert.equal(pi.lastStatus("live"), "");
  await bob.sees("tester ended the stream.");
  await bob.waitForEnd();
});

await test("a guest who joins later sees the conversation so far", async () => {
  const pi = startPi();
  const token = await goLive(pi);
  await pi.prompt("What does the cache do?");
  const carol = await join_(pi, token, "carol");
  await carol.sees("What does the cache do?");
  await carol.sees("ok");
});

/** Wait until the card above the host's editor shows `text` from `name`. */
async function waitsAbove(pi: PiRpc, name: string, text: string): Promise<void> {
  await eventually(
    () => (lastWidget(pi)?.some((line) => typeof line === "string" && line.includes(name) && line.includes(text)) === true ? true : undefined),
    () => `no suggestion card with ${text}: ${JSON.stringify(lastWidget(pi))}`
  );
}

const runs = (pi: PiRpc, from: number): number => pi.records.slice(from).filter((r) => r["type"] === "agent_start").length;

await test("a suggestion waits above the editor until the host accepts it, which runs it, or rejects it", async () => {
  const pi = startPi();
  const token = await goLive(pi);
  const bob = await join_(pi, token, "bob");

  bob.type("add a test for expiry\r");
  await waitsAbove(pi, "bob", "add a test for expiry");
  await bob.sees(/○ queued +add a test for expiry · next up/);
  let from = pi.records.length;
  await pi.prompt("/live accept");
  await pi.waitFor((r) => r["type"] === "agent_settled", from);
  assert.equal(lastWidget(pi), undefined);
  await bob.sees(/✓ accepted +add a test for expiry/);
  await bob.sees("│ add a test for expiry");

  bob.type("rewrite it in rust\r");
  await waitsAbove(pi, "bob", "rewrite it in rust");
  from = pi.records.length;
  await pi.prompt("/live reject");
  await bob.sees(/✗ rejected +rewrite it in rust/);
  assert.equal(runs(pi, from), 0);
  assert.ok(!bob.screen.includes("✓ accepted"), `the card kept an older answer:\n${bob.screen}`);
});

await test("a suggestion accepted while the agent works runs after the current turn", async () => {
  const pi = startPi({ SCRIPTED_STREAM_MS: "250" });
  const token = await goLive(pi);
  const bob = await join_(pi, token, "bob");
  bob.type("then add a test\r");
  await waitsAbove(pi, "bob", "then add a test");
  const done = pi.prompt("Tell me something");
  await bob.sees("Streaming this reply");
  await pi.prompt("/live accept");
  await done;
  await bob.sees("│ then add a test");
  const screen = bob.screen;
  assert.ok(screen.indexOf("like a real provider does.") < screen.indexOf("│ then add a test"), screen);
});

await test("a suggestion accepted while pi compacts stays first in line", async () => {
  const agentDir = makeAgentDir();
  // Keep almost nothing at compaction, so a short session has something to compact.
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "model", compaction: { keepRecentTokens: 1 } }));
  const pi = startPi({ SCRIPTED_DELAY_MS: "1500" }, agentDir);
  const token = await goLive(pi);
  const bob = await join_(pi, token, "bob");
  await pi.prompt("first prompt");
  await pi.prompt("second prompt");
  bob.type("summarize the change\r");
  await waitsAbove(pi, "bob", "summarize the change");
  const from = pi.records.length;
  pi.send({ id: "compact", type: "compact" });
  await pi.waitFor((r) => r["type"] === "compaction_start", from);
  await pi.prompt("/live accept");
  assert.ok(pi.notices(from).includes("pi is compacting. Accept bob's suggestion once it's done."), JSON.stringify(pi.notices(from)));
  await waitsAbove(pi, "bob", "summarize the change");
  assert.equal(runs(pi, from), 0);
  await pi.waitFor((r) => r["type"] === "response" && r["id"] === "compact", from);
  await pi.prompt("/live accept");
  await bob.sees("│ summarize the change");
});

await test("two suggestions accepted at once both run", async () => {
  const pi = startPi();
  const token = await goLive(pi);
  const bob = await join_(pi, token, "bob");
  bob.type("first idea\r");
  await waitsAbove(pi, "bob", "first idea");
  bob.type("second idea\r");
  await waitsAbove(pi, "bob", "second idea");
  const from = pi.records.length;
  // Two presses in one read: the second comes before the run the first started shows as busy.
  pi.send({ id: "accept-1", type: "prompt", message: "/live accept" });
  pi.send({ id: "accept-2", type: "prompt", message: "/live accept" });
  await bob.sees("│ first idea");
  await bob.sees("│ second idea");
  assert.ok(!pi.records.slice(from).some((r) => JSON.stringify(r).includes("already processing")), "pi refused the second suggestion");
});

await test("pi keeps running when the host starts a new session while the agent replies", async () => {
  const pi = startPi({ SCRIPTED_STREAM_MS: "250" });
  const token = await goLive(pi);
  const bob = await join_(pi, token, "bob");
  const from = pi.records.length;
  pi.send({ id: "reply", type: "prompt", message: "Tell me something" });
  await bob.sees("Streaming this reply");
  pi.send({ id: "new", type: "new_session" });
  await pi.waitFor((r) => r["type"] === "response" && r["id"] === "new", from);
  // A stale extension context would have ended pi by now, and this prompt would never be answered.
  await pi.prompt("after the switch");
  await bob.sees("after the switch");
  assert.ok(!pi.records.slice(from).some((r) => JSON.stringify(r).includes("stale")), "an extension used a stale context");
});

await test("guests see tool calls, and secrets are masked before they leave pi", async () => {
  const pi = startPi({ SCRIPTED_TOOL_TURNS: "1" });
  const token = await goLive(pi);
  const bob = await join_(pi, token, "bob");
  await pi.prompt(`Deploy with token ${secret}`);
  await bob.sees("$ true");
  await bob.sees("Deploy with token [REDACTED:github-token]");
  assert.ok(!bob.received.includes(secret));
});

await test("guests see a reply stream in as the model writes it", async () => {
  const pi = startPi({ SCRIPTED_STREAM_MS: "250" });
  const token = await goLive(pi);
  const bob = await join_(pi, token, "bob");
  const from = pi.records.length;
  const done = pi.prompt("Tell me something");
  await bob.sees("Streaming this reply");
  assert.ok(!bob.screen.includes("does."), "the guest saw the reply only once it was finished");
  assert.ok(!pi.records.slice(from).some((r) => r["type"] === "agent_settled"), "the reply finished before the guest saw any of it");
  await done;
  await bob.sees("Streaming this reply in pieces, like a real provider does.");
});

await test("guests see the host's ! commands and their output", async () => {
  const pi = startPi();
  const token = await goLive(pi);
  const bob = await join_(pi, token, "bob");
  pi.send({ id: "bash", type: "bash", command: "echo build-is-green" });
  await pi.waitFor((r) => r["type"] === "response" && r["id"] === "bash");
  await bob.sees("$ echo build-is-green");
  await bob.sees(/build-is-green[\s\S]*build-is-green/);
});

await test("the stream follows the host into a new session", async () => {
  const pi = startPi();
  const token = await goLive(pi);
  const bob = await join_(pi, token, "bob");
  await pi.prompt("first session");
  await bob.sees("first session");
  pi.send({ id: "new", type: "new_session" });
  await pi.waitFor((r) => r["type"] === "response" && r["id"] === "new");
  await eventually(
    () => (bob.screen.includes("first session") ? undefined : true),
    () => `bob still sees the old session:\n${bob.screen}`
  );
  await pi.prompt("second session");
  await bob.sees("second session");
  assert.ok(!bob.screen.includes("first session"), bob.screen);
  assert.match(pi.lastStatus("live"), /bob/);
});

await test("the footer names up to three guests, then two and a count", () => {
  assert.equal(guestNames([]), "nobody joined yet");
  assert.equal(guestNames(["alice", "bob", "carol"]), "alice, bob, carol");
  assert.equal(guestNames(["alice", "bob", "carol", "dave", "erin"]), "alice, bob +3");
});

await test("the card above the editor shows the join command until someone joins, and suggestions once any wait", () => {
  const theme = piTheme();
  const plain = (lines: string[] | undefined): string[] | undefined => lines?.map((line) => stripTerminalSequences(line));
  const stream = { join: "ssh -p 2222 abc@relay", copied: true, guests: [] as string[], suggestions: [] as { id: string; from: string; text: string }[] };
  assert.deepEqual(plain(cardLines(stream, theme)), ["Live. Send this to whoever should join (copied):", "  ssh -p 2222 abc@relay", "/live link shows it again · /live ends the stream"]);
  stream.guests = ["alice"];
  assert.equal(cardLines(stream, theme), undefined);
  stream.suggestions = ["one", "two", "three", "four", "five"].map((text, i) => ({ id: String(i), from: i % 2 === 0 ? "alice" : "bob", text }));
  assert.deepEqual(plain(cardLines(stream, theme)), ["alice  one", "bob    two", "alice  three", "alt+s accepts alice's and runs it · alt+x rejects it · 2 more waiting"]);
});

await test("/live says how to set up a relay when none is configured", async () => {
  const pi = startPi({ PI_LIVE_URL: "" });
  const from = pi.records.length;
  await pi.prompt("/live");
  assert.ok(pi.notices(from).some((text) => text.startsWith("No relay is set up.")));
});

await test("/live reports a relay it can't reach", async () => {
  const pi = startPi({ PI_LIVE_URL: "ws://127.0.0.1:9/host" });
  const from = pi.records.length;
  await pi.prompt("/live");
  assert.ok(pi.notices(from).some((text) => text.startsWith("Couldn't reach the relay at ws://127.0.0.1:9/host")));
  assert.equal(pi.lastStatus("live"), "");
});

async function commandNames(pi: PiRpc): Promise<string[]> {
  pi.send({ id: "commands", type: "get_commands" });
  const response = await pi.waitFor((r) => r["type"] === "response" && r["id"] === "commands");
  const data = response["data"];
  const commands: unknown[] = isRecord(data) && Array.isArray(data["commands"]) ? data["commands"] : [];
  return commands.flatMap((c) => (isRecord(c) ? [field(c, "name")] : []));
}

await test("PI_LIVE=0 turns the extension off", async () => {
  assert.ok((await commandNames(startPi())).includes("live"));
  assert.ok(!(await commandNames(startPi({ PI_LIVE: "0" }))).includes("live"));
});
