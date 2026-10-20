/**
 * Checks the pi-config clone for new commits once a day and offers
 * /pi-config-update, which pulls, re-runs install.sh and reloads pi.
 *
 * The check runs in the background at startup, never prompts for git
 * credentials, and stays quiet when the remote can't be reached.
 * Set PI_CONFIG_UPDATE_CHECK=0 to turn it off.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);
const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

// Never let git ask for credentials: it would hang or draw over the TUI.
const quietEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

async function git(args: string[], timeout = 20_000): Promise<string> {
	const { stdout } = await run("git", ["-C", repo, ...args], { env: quietEnv, timeout });
	return stdout.trim();
}

interface State {
	checkedAt: number;
}

const statePath = () => join(getAgentDir(), "pi-config-update.json");

function readState(): State {
	try {
		return JSON.parse(readFileSync(statePath(), "utf8"));
	} catch {
		return { checkedAt: 0 };
	}
}

/** Commits on the upstream branch that HEAD doesn't have yet. */
async function pendingCommits(): Promise<string[]> {
	const log = await git(["log", "--oneline", "HEAD..@{upstream}"]);
	return log ? log.split("\n") : [];
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" || !ctx.hasUI || process.env.PI_CONFIG_UPDATE_CHECK === "0") return;
		const due = Date.now() - readState().checkedAt > CHECK_EVERY_MS;
		// Not awaited: startup must not wait on the network.
		void (async () => {
			try {
				if (due) {
					await git(["fetch", "--quiet"]);
					writeFileSync(statePath(), JSON.stringify({ checkedAt: Date.now() } satisfies State));
				}
				const pending = await pendingCommits();
				if (pending.length > 0) {
					ctx.ui.notify(`pi-config has ${pending.length} update(s). Run /pi-config-update to install.`, "info");
				}
			} catch {
				// Offline, no upstream, or not a git clone: check again next startup.
			}
		})();
	});

	pi.registerCommand("pi-config-update", {
		description: "Pull the latest team pi-config, reinstall it and reload",
		handler: async (_args, ctx) => {
			try {
				if (await git(["status", "--porcelain"])) {
					ctx.ui.notify(`${repo} has local changes. Commit or stash them, then try again.`, "error");
					return;
				}
				await git(["fetch", "--quiet"], 60_000);
				const pending = await pendingCommits();
				if (pending.length === 0) {
					ctx.ui.notify("pi-config is up to date.", "info");
					return;
				}
				if (!(await ctx.ui.confirm("Update pi-config?", pending.join("\n")))) return;
				await git(["merge", "--ff-only", "@{upstream}"]);
				await run("bash", [join(repo, "install.sh")], {
					env: { ...quietEnv, PI_CODING_AGENT_DIR: getAgentDir() },
					timeout: 120_000,
				});
				ctx.ui.notify(`pi-config updated (${pending.length} commit(s)). Reloading.`, "info");
				await ctx.reload();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`pi-config update failed: ${message}`, "error");
			}
		},
	});
}
