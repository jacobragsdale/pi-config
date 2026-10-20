/**
 * Checks the pi-config clone for new commits once a day and offers
 * /pi-config-update, which pulls, re-runs install.sh and reloads pi.
 *
 * The check runs in the background at startup, never prompts for git
 * credentials, and stays quiet when the remote can't be reached.
 * Set PI_CONFIG_UPDATE_CHECK=0 to turn it off.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { run } from "../../src/exec.ts";
import { parseJson } from "../../src/json.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

// Never let git ask for credentials: it would hang or draw over the TUI.
const quietEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

function git(args: readonly string[], timeout = 20_000): Promise<string> {
  return run("git", ["-C", repo, ...args], { env: quietEnv, timeout });
}

const StateSchema = Type.Object({ checkedAt: Type.Number() }, { additionalProperties: false });

const statePath = (): string => join(getAgentDir(), "pi-config-update.json");

function lastCheckedAt(): number {
  try {
    return parseJson(StateSchema, readFileSync(statePath(), "utf8"), statePath()).checkedAt;
  } catch {
    return 0;
  }
}

/** Commits on the upstream branch that HEAD doesn't have yet. */
async function pendingCommits(): Promise<string[]> {
  const log = await git(["log", "--oneline", "HEAD..@{upstream}"]);
  return log === "" ? [] : log.split("\n");
}

async function checkForUpdates(ctx: ExtensionContext): Promise<void> {
  if (Date.now() - lastCheckedAt() > CHECK_EVERY_MS) {
    await git(["fetch", "--quiet"]);
    writeFileSync(statePath(), JSON.stringify({ checkedAt: Date.now() }));
  }
  const pending = await pendingCommits();
  if (pending.length > 0) {
    ctx.ui.notify(`pi-config has ${String(pending.length)} update(s). Run /pi-config-update to install.`, "info");
  }
}

export default function piConfigUpdate(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" || !ctx.hasUI || process.env["PI_CONFIG_UPDATE_CHECK"] === "0") {
      return;
    }
    // Not awaited: startup must not wait on the network. Offline, no upstream,
    // or not a git clone all mean "check again next startup".
    checkForUpdates(ctx).catch(() => undefined);
  });

  pi.registerCommand("pi-config-update", {
    description: "Pull the latest team pi-config, reinstall it and reload",
    handler: async (_args, ctx) => {
      try {
        if ((await git(["status", "--porcelain"])) !== "") {
          ctx.ui.notify(`${repo} has local changes. Commit or stash them, then try again.`, "error");
          return;
        }
        await git(["fetch", "--quiet"], 60_000);
        const pending = await pendingCommits();
        if (pending.length === 0) {
          ctx.ui.notify("pi-config is up to date.", "info");
          return;
        }
        if (!(await ctx.ui.confirm("Update pi-config?", pending.join("\n")))) {
          return;
        }
        await git(["merge", "--ff-only", "@{upstream}"]);
        await run("bash", [join(repo, "install.sh")], { env: { ...quietEnv, PI_CODING_AGENT_DIR: getAgentDir() }, timeout: 120_000 });
        ctx.ui.notify(`pi-config updated (${String(pending.length)} commit(s)). Reloading.`, "info");
        await ctx.reload();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`pi-config update failed: ${message}`, "error");
      }
    }
  });
}
