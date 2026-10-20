import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { PiRpc, makeAgentDir, repo, scriptedProvider } from "./pi-rpc.ts";

const submitExtension = join(repo, "extensions/submit-prompt/index.ts");
const secret = `ghp_${"Zx9Q".repeat(9)}`;

const running: PiRpc[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((pi) => pi.close()));
});

interface Setup {
  readonly pi: PiRpc;
  readonly agentDir: string;
  readonly share: string;
}

function start(options: { readonly marker?: boolean; readonly toolTurns?: number } = {}): Setup {
  const agentDir = makeAgentDir();
  const share = join(agentDir, "nfs-share");
  mkdirSync(share);
  if (options.marker ?? true) {
    writeFileSync(join(share, ".pi-prompt-share"), "");
  }
  const gitConfig = join(agentDir, "gitconfig");
  writeFileSync(gitConfig, "[user]\n\tname = Test Person\n");
  const pi = new PiRpc({
    agentDir,
    extensions: [submitExtension, scriptedProvider],
    env: { PI_PROMPT_SHARE_DIR: share, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", SCRIPTED_TOOL_TURNS: String(options.toolTurns ?? 0) }
  });
  running.push(pi);
  return { pi, agentDir, share };
}

/** Every markdown file under a directory's month folders. */
function submissions(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".md"))
    .map((path) => join(dir, path));
}

function answerAll(pi: PiRpc, scope: string, edit: (prefill: string) => string | undefined = (p) => p): void {
  pi.answers.select.push(scope, "It worked well");
  pi.answers.input.push("Testing the submit flow");
  pi.answers.editor.push(edit);
  pi.answers.confirm.push(true);
}

await test("submits the prompts to the shared folder with secrets masked", async () => {
  const { pi, share } = start();
  await pi.prompt(`Fix the login bug. The token is ${secret}`);
  await pi.prompt("Now add a test");
  answerAll(pi, "Just my prompts");
  await pi.prompt("/submit-prompt");

  const files = submissions(share);
  assert.equal(files.length, 1);
  const [file = ""] = files;
  assert.match(file, /\/\d{4}-\d{2}\/[0-9TZ-]+-test-person-[0-9a-f]{6}\.md$/);
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes(secret));
  assert.match(text, /^author: "Test Person"$/m);
  assert.match(text, /^outcome: "worked"$/m);
  assert.match(text, /^scope: "prompts"$/m);
  assert.match(text, /^model: "scripted\/model"$/m);
  assert.match(text, /^prompts: 2$/m);
  assert.match(text, /^redactions: 1$/m);
  assert.match(text, /^## What I was trying to do\n\nTesting the submit flow$/m);
  assert.match(text, /^### Prompt 1\n\nFix the login bug\. The token is \[REDACTED:github-token\]$/m);
  assert.match(text, /^### Prompt 2\n\nNow add a test$/m);
  assert.ok(!text.includes("### pi"));
  assert.deepEqual(
    readdirSync(share, { recursive: true, encoding: "utf8" }).filter((path) => path.endsWith(".tmp")),
    []
  );
  assert.ok(pi.notices().some((n) => n.startsWith("Submitted for review: ")));
});

await test("includes replies and trimmed tool output for the whole conversation", async () => {
  const { pi, share } = start({ toolTurns: 1 });
  await pi.prompt("Check the repo");
  answerAll(pi, "The whole conversation (replies and trimmed tool output too)");
  await pi.prompt("/submit-prompt");
  const text = readFileSync(submissions(share)[0] ?? "", "utf8");
  assert.match(text, /^scope: "conversation"$/m);
  assert.match(text, /^tool_calls: 1$/m);
  assert.match(text, /^### You\n\nCheck the repo$/m);
  assert.match(text, /^Tool `bash`: `\{"command":"true"\}`$/m);
  assert.match(text, /^Result of `bash`:$/m);
  assert.match(text, /^### pi\n\nok$/m);
});

await test("saves what the person edited in the review", async () => {
  const { pi, share } = start();
  await pi.prompt("Original wording");
  answerAll(pi, "Just my prompts", (p) => p.replace("Original wording", "Edited wording"));
  await pi.prompt("/submit-prompt");
  const text = readFileSync(submissions(share)[0] ?? "", "utf8");
  assert.ok(text.includes("Edited wording"));
  assert.ok(!text.includes("Original wording"));
});

await test("writes nothing when the review is cancelled", async () => {
  const { pi, share, agentDir } = start();
  await pi.prompt("hello");
  answerAll(pi, "Just my prompts", () => undefined);
  await pi.prompt("/submit-prompt");
  assert.deepEqual(submissions(share), []);
  assert.deepEqual(submissions(join(agentDir, "prompt-submissions")), []);
  assert.deepEqual(pi.confirmTitles(), []);
});

await test("saves locally when the share has no marker file, as an unmounted NFS mount point would", async () => {
  const { pi, share, agentDir } = start({ marker: false });
  await pi.prompt("hello");
  answerAll(pi, "Just my prompts");
  await pi.prompt("/submit-prompt");
  assert.deepEqual(submissions(share), []);
  assert.equal(submissions(join(agentDir, "prompt-submissions")).length, 1);
  assert.ok(pi.notices().some((n) => n.startsWith("Saved locally: ") && n.includes("isn't available")));
});

await test("says there is nothing to submit before the first prompt", async () => {
  const { pi } = start();
  await pi.prompt("/submit-prompt");
  assert.deepEqual(pi.notices(), ["Nothing to submit yet: this session has no prompts."]);
});
