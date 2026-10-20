/**
 * /submit-prompt: volunteer this session's prompts, or the whole conversation,
 * for team review. Secrets are masked, the person reviews and edits the text,
 * and nothing is written until they confirm.
 *
 * Submissions go to the shared folder named by PI_PROMPT_SHARE_DIR or by
 * promptShareDir in the clone's team.json. The folder must contain a file
 * named .pi-prompt-share, so an unmounted NFS mount point is never mistaken
 * for the share. When the share can't be used, the file is saved locally.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { run } from "../../src/exec.ts";
import { parseJson } from "../../src/json.ts";
import { buildSubmission } from "./format.ts";
import type { Outcome, Scope } from "./format.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SHARE_MARKER = ".pi-prompt-share";

const TeamSchema = Type.Object({ promptShareDir: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });

const SCOPES: Readonly<Record<string, Scope>> = { "Just my prompts": "prompts", "The whole conversation (replies and trimmed tool output too)": "conversation" };
const OUTCOMES: Readonly<Record<string, Outcome>> = { "It worked well": "worked", "It partly worked": "partly", "It didn't work": "did-not-work" };

type Destination = { readonly kind: "share"; readonly dir: string } | { readonly kind: "local"; readonly dir: string; readonly reason: string };

function destination(): Destination {
  const local = join(getAgentDir(), "prompt-submissions");
  let dir = process.env["PI_PROMPT_SHARE_DIR"];
  if (dir === undefined || dir === "") {
    const teamPath = join(repo, "team.json");
    dir = existsSync(teamPath) ? parseJson(TeamSchema, readFileSync(teamPath, "utf8"), teamPath).promptShareDir : undefined;
  }
  if (dir === undefined) {
    return { kind: "local", dir: local, reason: "No shared folder is set up (promptShareDir in team.json)." };
  }
  if (!existsSync(join(dir, SHARE_MARKER))) {
    return { kind: "local", dir: local, reason: `The shared folder ${dir} isn't available (no ${SHARE_MARKER} file; is it mounted?).` };
  }
  return { kind: "share", dir };
}

/** Write the file under <dir>/<YYYY-MM>/ with a unique name, via rename so readers never see half a file. */
function writeSubmission(dir: string, markdown: string, author: string, now: Date): string {
  const folder = join(dir, now.toISOString().slice(0, 7));
  mkdirSync(folder, { recursive: true });
  const cleaned = author
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const slug = cleaned === "" ? "anonymous" : cleaned;
  const name = `${now.toISOString().replace(/[:.]/g, "-")}-${slug}-${randomBytes(3).toString("hex")}.md`;
  const temp = join(folder, `.${name}.tmp`);
  writeFileSync(temp, markdown, { flag: "wx" });
  renameSync(temp, join(folder, name));
  return join(folder, name);
}

async function gitOutput(args: readonly string[], cwd: string): Promise<string> {
  try {
    return await run("git", args, { cwd, timeout: 5_000 });
  } catch {
    return "";
  }
}

async function choose<T>(ctx: ExtensionCommandContext, title: string, options: Readonly<Record<string, T>>): Promise<T | undefined> {
  const label = await ctx.ui.select(title, Object.keys(options));
  return label === undefined ? undefined : options[label];
}

async function submit(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const branch = ctx.sessionManager.getBranch();
  if (!branch.some((entry) => entry.type === "message" && entry.message.role === "user")) {
    ctx.ui.notify("Nothing to submit yet: this session has no prompts.", "warning");
    return;
  }
  const scope = await choose(ctx, "What do you want to submit?", SCOPES);
  const outcome = scope === undefined ? undefined : await choose(ctx, "How did it go?", OUTCOMES);
  const note = outcome === undefined ? undefined : await ctx.ui.input("What were you trying to do? (optional)", "One or two sentences for the reviewers");
  if (scope === undefined || outcome === undefined || note === undefined) {
    return;
  }
  const gitName = await gitOutput(["config", "user.name"], ctx.cwd);
  const author = gitName === "" ? userInfo().username : gitName;
  const now = new Date();
  const draft = buildSubmission(branch, {
    submitted: now,
    author,
    model: ctx.model === undefined ? "unknown" : `${ctx.model.provider}/${ctx.model.id}`,
    thinking: pi.getThinkingLevel(),
    piConfig: await gitOutput(["rev-parse", "--short", "HEAD"], repo),
    outcome,
    scope,
    note: note.trim()
  });
  const masked = draft.redactions === 0 ? "" : ` ${String(draft.redactions)} likely secret(s) were masked.`;
  const reviewed = await ctx.ui.editor(`Review your submission. Remove anything you don't want to share.${masked}`, draft.markdown);
  if (reviewed === undefined || reviewed.trim() === "") {
    ctx.ui.notify("Submission cancelled.", "info");
    return;
  }
  const target = destination();
  const where = target.kind === "share" ? target.dir : `${target.dir} on this machine. ${target.reason}`;
  if (!(await ctx.ui.confirm("Submit this for team review?", `It will be saved to ${where}`))) {
    ctx.ui.notify("Submission cancelled.", "info");
    return;
  }
  const path = writeSubmission(target.dir, reviewed, author, now);
  if (target.kind === "share") {
    ctx.ui.notify(`Submitted for review: ${path}`, "info");
  } else {
    ctx.ui.notify(`Saved locally: ${path}\n${target.reason} Copy the file to the shared folder when you can.`, "warning");
  }
}

export default function submitPrompt(pi: ExtensionAPI): void {
  pi.registerCommand("submit-prompt", {
    description: "Volunteer this session's prompts for team review",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/submit-prompt needs the interactive UI.", "error");
        return;
      }
      try {
        await submit(pi, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Submission failed: ${message}`, "error");
      }
    }
  });
}
