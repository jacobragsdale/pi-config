import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { afterEach, beforeEach, test } from "node:test";
import ssh2 from "ssh2";
import { newHostKey } from "../relay/relay.ts";
import { FakeHost, Guest, assistant, eventually, meta, startRelay, user } from "./live.ts";
import type { TestRelay } from "./live.ts";

let relay: TestRelay;
const open: { close(): void }[] = [];

beforeEach(async () => {
  relay = await startRelay();
});

afterEach(async () => {
  for (const peer of open.splice(0)) {
    peer.close();
  }
  await relay.relay.close();
});

async function host(name = "jacob"): Promise<{ host: FakeHost; token: string; join: string }> {
  const fake = new FakeHost(relay.http);
  open.push(fake);
  const ready = await fake.hello(name);
  return { host: fake, token: ready.token, join: ready.join };
}

async function guest(token: string, name = "alice"): Promise<Guest> {
  const joined = await Guest.connect(relay.ssh, token);
  open.push(joined);
  await joined.sees("Type your name below");
  joined.type(`${name}\r`);
  await joined.sees("Suggest a prompt to");
  return joined;
}

await test("every new host key is one ssh2 can read", () => {
  // ssh2's own generator makes an unreadable key about once in 256 draws.
  for (let i = 0; i < 2000; i += 1) {
    assert.ok(!(ssh2.utils.parseKey(newHostKey()) instanceof Error));
  }
});

await test("a host gets a join command with an unguessable token", async () => {
  const { token, join } = await host();
  assert.match(token, /^[a-z2-7]{24}$/);
  assert.equal(join, `ssh -p ${String(relay.ssh)} ${token}@127.0.0.1`);
});

await test("a guest sees the transcript, the streamed reply, and who is hosting", async () => {
  const { host: fake, token } = await host();
  fake.send(
    meta({
      gitBranch: "main",
      model: { provider: "github-copilot", id: "claude-haiku-5.5", reasoning: true },
      showProvider: true,
      thinking: "xhigh",
      usage: { input: 2800, output: 40, cacheRead: 97_000, cacheWrite: 75, cost: 0.0123, cacheHitRate: 97.3 },
      context: { percent: 12.5, contextWindow: 84_000 }
    })
  );
  fake.send({ type: "reset", entries: [{ id: "a", messages: [user("Fix the login bug")] }] });
  const alice = await guest(token);
  await alice.sees("│ Fix the login bug");
  await alice.sees(/~\/dev\/shop · main +● live · jacob · 1 joined · ↑2\.8k ↓40 R97k W75 CH97\.3% · \$0\.012/);
  await alice.sees(/╰─ claude-haiku-5\.5 · xhigh ─+ 13% of 84k ─╯/);
  await alice.sees("Suggest a prompt to jacob · Enter sends · ctrl+c leaves");

  fake.send({ type: "tail", message: assistant([{ type: "text", text: "Looking at the session code" }], 5, "pending") });
  await alice.sees("Looking at the session code");
  fake.send({ type: "append", entries: [{ id: "b", messages: [assistant([{ type: "text", text: "Found it: the cookie expires early." }], 5)] }] });
  fake.send({ type: "tail", message: null });
  await alice.sees("Found it: the cookie expires early.");
});

await test("the host learns who joined, and a guest sees what became of their suggestion", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const alice = await guest(token);
  await fake.waitFor((m) => m.type === "guests" && m.names.join() === "alice", "guests [alice]");

  alice.type("run the migration tests\r");
  const suggestion = await fake.waitFor((m) => m.type === "suggestion", "suggestion");
  assert.equal(suggestion.type, "suggestion");
  assert.equal(suggestion.from, "alice");
  assert.equal(suggestion.text, "run the migration tests");
  await alice.sees(/╭─+ your suggestions ─╮/);
  await alice.sees(/│ ○ queued +run the migration tests · next up +│/);

  fake.send({ type: "suggestion_status", id: suggestion.id, status: "used" });
  await alice.sees(/│ ✓ accepted +run the migration tests +│/);

  alice.type("drop the old table\r");
  const second = await fake.waitFor((m) => m.type === "suggestion" && m.text === "drop the old table", "second suggestion");
  assert.equal(second.type, "suggestion");
  await alice.sees(/○ queued +drop the old table · next up/);
  fake.send({ type: "suggestion_status", id: second.id, status: "dismissed" });
  await alice.sees(/│ ✗ rejected +drop the old table +│/);
  assert.ok(!alice.screen.includes("✓ accepted"), `the card kept an older answer:\n${alice.screen}`);
});

await test("a guest sees how many suggestions wait ahead of theirs, and moves up as the host answers", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const alice = await guest(token);
  alice.type("first\r");
  const first = await fake.waitFor((m) => m.type === "suggestion" && m.text === "first", "alice's suggestion");
  const bob = await guest(token, "bob");
  bob.type("second\r");
  await fake.waitFor((m) => m.type === "suggestion" && m.text === "second", "bob's suggestion");
  await bob.sees(/○ queued +second · 1 ahead/);
  alice.close();
  await fake.waitFor((m) => m.type === "guests" && m.names.join() === "bob", "alice gone");
  // The host still has alice's suggestion, so bob's is still second.
  await bob.sees(/○ queued +second · 1 ahead/);
  assert.equal(first.type, "suggestion");
  fake.send({ type: "suggestion_status", id: first.id, status: "dismissed" });
  await bob.sees(/○ queued +second · next up/);
});

await test("a guest can have only three suggestions waiting", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const alice = await guest(token);
  for (const text of ["one", "two", "three", "four"]) {
    alice.type(`${text}\r`);
  }
  await alice.sees("3 queued · send more once jacob answers one");
  assert.match(alice.screen, /│ four/);
  await eventually(
    () => (fake.received.filter((m) => m.type === "suggestion").length === 3 ? true : undefined),
    () => "three suggestions"
  );
});

await test("a guest is asked for their name first, then told whom they joined as and what Enter now does", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const joining = await Guest.connect(relay.ssh, token);
  open.push(joining);
  await joining.sees("Enter      joins, with the name you typed");
  assert.ok(!joining.screen.includes("suggests a prompt"), joining.screen);
  joining.type("hello!\r");
  await joining.sees("✓ Joined as hello! · type a prompt below and press Enter to suggest it to jacob");
  await joining.sees("Enter      suggests a prompt to jacob, who can run it or reject it");
  joining.type("run the tests\r");
  await joining.sees(/○ queued +run the tests · next up/);
  assert.ok(!joining.screen.includes("Joined as"), joining.screen);
});

await test("a pasted name becomes one line, and neither names nor suggestions carry control characters", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const pasted = await Guest.connect(relay.ssh, token);
  open.push(pasted);
  await pasted.sees("Type your name below");
  // \u009b is CSI as one character, which some terminals act on.
  pasted.type("\x1b[200~ali\nce\u009b2J\x1b[201~\r");
  const guests = await fake.waitFor((m) => m.type === "guests" && m.names.length === 1, "one guest");
  assert.deepEqual(guests.type === "guests" ? guests.names : [], ["ali ce2J"]);
  pasted.type("\x1b[200~line one\nline\u009d52;c;aGk=\u009c two\x1b[201~\r");
  const suggestion = await fake.waitFor((m) => m.type === "suggestion", "suggestion");
  assert.equal(suggestion.type === "suggestion" ? suggestion.text : "", "line one\nline52;c;aGk= two");
});

await test("keys that arrive after a guest leaves neither rejoin them nor suggest anything", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const quick = await Guest.connect(relay.ssh, token);
  open.push(quick);
  await quick.sees("Type your name below");
  quick.type("\x03bob\r");
  await quick.waitForEnd();
  const alice = await guest(token);
  await fake.waitFor((m) => m.type === "guests" && m.names.join() === "alice", "alice alone");
  alice.type("\x03do it\r");
  await alice.waitForEnd();
  await fake.waitFor((m) => m.type === "guests" && m.names.length === 0, "nobody");
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 200);
  });
  assert.ok(!fake.received.some((m) => (m.type === "guests" && m.names.includes("bob")) || m.type === "suggestion"), JSON.stringify(fake.received));
});

await test("a guest still typing their name sees how many have joined", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const naming = await Guest.connect(relay.ssh, token);
  open.push(naming);
  await naming.sees("· 0 joined");
  await guest(token);
  await naming.sees("· 1 joined");
});

await test("a suggestion longer than the limit stays in the guest's editor, with the reason", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const alice = await guest(token);
  alice.type(`\x1b[200~${"y".repeat(4500)}\x1b[201~\r`);
  await alice.sees("That's 4,500 characters; a suggestion can be at most 4,000.");
  assert.match(alice.screen, /│ y{20}/);
  assert.ok(!fake.received.some((m) => m.type === "suggestion"));
});

await test("escape sequences a host sends never reach guests' terminals", async () => {
  const { host: fake, token } = await host();
  fake.send(meta({ gitBranch: "main\n\x1b[2J", sessionName: "a\x1b]0;owned\x07b" }));
  fake.send({ type: "reset", entries: [{ id: "a", messages: [user("before\x1b[2J\x1b[Hafter \x1b]52;c;aGk=\x07end")] }] });
  const alice = await guest(token);
  await alice.sees("│ beforeafter end");
  const lines = alice.screen.trimEnd().split("\n");
  assert.match(lines.at(-1) ?? "", /~\/dev\/shop · main · ab +● live · jacob · 1 joined/);
});

/** Send `request` to the relay's HTTP port as raw bytes, and resolve with everything it answers. */
function rawHttp(request: string): Promise<string> {
  return new Promise((resolve) => {
    let reply = "";
    const socket = createConnection(relay.http, "127.0.0.1", () => {
      socket.write(request);
    });
    socket.on("data", (data: Buffer) => {
      reply += data.toString("utf8");
    });
    socket.on("close", () => {
      resolve(reply);
    });
    socket.on("error", () => {
      resolve(reply);
    });
  });
}

await test("a request whose URL can't be read is refused, and the relay keeps running", async () => {
  assert.match(await rawHttp("GET http://%zz/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), /^HTTP\/1\.1 404/);
  await rawHttp("GET http://%zz/host HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
  const { join } = await host();
  assert.match(join, /^ssh -p \d+ [a-z2-7]{24}@127\.0\.0\.1$/);
});

await test("a tool call shows its command, its live output, and its result", async () => {
  const { host: fake, token } = await host();
  fake.send(meta({ cwd: "/repo", cwdLabel: "/repo" }));
  fake.send({ type: "reset", entries: [] });
  const alice = await guest(token);
  fake.send({ type: "append", entries: [{ id: "a", messages: [assistant([{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } }], 3, "toolUse")] }] });
  await alice.sees("$ npm test");
  fake.send({ type: "tool", phase: "start", id: "call-1" });
  fake.send({ type: "tool", phase: "update", id: "call-1", result: { content: [{ type: "text", text: "running 12 tests" }] } });
  await alice.sees("running 12 tests");
  fake.send({ type: "tool", phase: "end", id: "call-1", result: { content: [{ type: "text", text: "12 passed" }] }, isError: false, durationMs: 1200 });
  fake.send({
    type: "append",
    entries: [{ id: "b", messages: [{ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "12 passed" }], isError: false, timestamp: 4 }] }]
  });
  await alice.sees("12 passed");
  await alice.sees(/╭─+ ✓ 1\.2s ─╮/);

  const lines = Array.from({ length: 30 }, (_, i) => `line ${String(i)}`).join("\n");
  fake.send({ type: "append", entries: [{ id: "c", messages: [assistant([{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "seq 30" } }], 5, "toolUse")] }] });
  fake.send({
    type: "append",
    entries: [{ id: "d", messages: [{ role: "toolResult", toolCallId: "call-2", toolName: "bash", content: [{ type: "text", text: lines }], isError: false, timestamp: 6 }] }]
  });
  await alice.sees("ctrl+o to expand");
  alice.type("\x0f"); // ctrl+o
  await alice.sees("line 0");
});

await test("a guest who joins mid-run catches up on the streamed reply", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [{ id: "a", messages: [user("Explain the cache")] }] });
  fake.send({ type: "tail", message: assistant([{ type: "text", text: "The cache keeps rendered pages" }], 7, "pending") });
  const bob = await guest(token, "bob");
  await bob.sees("Explain the cache");
  await bob.sees("The cache keeps rendered pages");
});

await test("messages the relay can't draw are dropped, and the stream carries on", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const alice = await guest(token);
  fake.send({ type: "append", entries: [{ id: "x", messages: [{ role: "assistant", content: "not an array" }, { role: "nonsense" }] }] });
  fake.send({ type: "nonsense" });
  fake.send({ type: "append", entries: [{ id: "y", messages: [user("still streaming")] }] });
  await alice.sees("still streaming");
  assert.ok(relay.logs.some((line) => line.startsWith("ignored a malformed message")));
});

await test("when the host leaves, guests are told and disconnected", async () => {
  const { host: fake, token } = await host("sam");
  fake.send({ type: "reset", entries: [] });
  const alice = await guest(token);
  fake.close();
  await alice.sees(/sam ended the stream\. You were in it for \d/);
  await alice.waitForEnd();
  assert.ok(!/live|joined|╭/.test(alice.screen.replace(/sam ended the stream\. You were in it for [\d.ms ]+\./, "")), `the stream's screen was left behind:\n${alice.screen}`);
  const late = await Guest.connect(relay.ssh, token);
  open.push(late);
  await late.sees("This pi-live link has ended");
  await late.waitForEnd();
});

await test("a guest still typing their name hears when the host leaves", async () => {
  const { host: fake, token } = await host("sam");
  fake.send({ type: "reset", entries: [] });
  const naming = await Guest.connect(relay.ssh, token);
  open.push(naming);
  await naming.sees("Type your name below");
  fake.close();
  await naming.sees("sam ended the stream.");
  await naming.waitForEnd();
  assert.ok(!naming.screen.includes("You were in it"), naming.screen);
});

await test("a guest can leave with ctrl+c", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const alice = await guest(token);
  await fake.waitFor((m) => m.type === "guests" && m.names.length === 1, "one guest");
  alice.type("\x03");
  await alice.sees(/You left the stream\. You were in it for \d/);
  await alice.waitForEnd();
  await fake.waitFor((m) => m.type === "guests" && m.names.length === 0, "no guests");
});

await test("a host on another protocol version is refused", async () => {
  const fake = new FakeHost(relay.http);
  open.push(fake);
  await fake.open();
  fake.send({ type: "hello", protocol: 99, piVersion: "9.9.9", host: "future" });
  const refusal = await fake.waitFor((m) => m.type === "error", "error");
  assert.equal(refusal.type, "error");
  assert.match(refusal.message, /protocol 2 and your pi-live speaks 99/);
  await eventually(
    () => (fake.closed ? true : undefined),
    () => "socket closed"
  );
});

await test("an empty name becomes guest-N", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const joined = await Guest.connect(relay.ssh, token);
  open.push(joined);
  await joined.sees("Type your name below");
  await joined.sees("Type your name, then Enter");
  joined.type("\r");
  const guests = await fake.waitFor((m) => m.type === "guests" && m.names.length === 1, "one guest");
  assert.equal(guests.type, "guests");
  assert.match(guests.names[0] ?? "", /^guest-\d+$/);
});

await test("guests see pi's working indicator while the host's agent runs", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const alice = await guest(token);
  fake.send({ type: "activity", working: true });
  await alice.sees("Working");
  fake.send({ type: "activity", working: false });
  await eventually(
    () => (alice.screen.includes("Working") ? undefined : true),
    () => `the indicator stayed:\n${alice.screen}`
  );
});

await test("a guest scrolls the transcript with PgUp, the mouse wheel, and ctrl+end", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: Array.from({ length: 60 }, (_, i) => ({ id: `e${String(i)}`, messages: [user(`message number ${String(i)}`, i)] })) });
  const alice = await guest(token);
  await alice.sees("message number 59");
  assert.ok(!alice.screen.includes("message number 30"));
  alice.type("\x1b[5~\x1b[5~"); // PgUp twice
  await alice.sees(/message number [2-4]\d\b/);
  assert.ok(!alice.screen.includes("message number 59"));
  alice.type("\x1b[1;5F"); // ctrl+end
  await alice.sees("message number 59");
  alice.type("\x1b[<64;10;10M".repeat(10)); // mouse wheel up
  await eventually(
    () => (alice.screen.includes("message number 59") ? undefined : true),
    () => `the wheel didn't scroll:\n${alice.screen}`
  );
});

await test("a guest whose terminal claims to be a few columns wide can type wide characters without ending the relay", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  for (const cols of [1, 2, 3, 5]) {
    const narrow = await Guest.connect(relay.ssh, token, { cols, rows: 10 });
    open.push(narrow);
    narrow.type("名前");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    narrow.close();
  }
  // A stack overflow in a guest's drawing would have ended this process by now.
  const alice = await guest(token);
  alice.type("still here\r");
  await fake.waitFor((m) => m.type === "suggestion" && m.text === "still here", "suggestion");
});
