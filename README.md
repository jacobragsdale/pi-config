# pi-config

Team settings and extensions for the [pi](https://pi.dev) coding agent, tuned for GitHub Copilot's per-token billing.

## What it sets up

- **Copilot defaults:** GPT-6.1 Sol with high thinking, and context windows capped at each model's price threshold so long sessions don't drift onto long-context rates. See [docs/models.md](docs/models.md).
- **Spending limits:** soft limits of $40 a day and $100 a week, with your spend shown in pi's footer. See [Spending limits](#spending-limits).
- **Prompt sharing:** `/submit-prompt` lets you volunteer a session's prompts for team review. See [Sharing prompts](#sharing-prompts).
- **No accidental uploads:** pi's built-in `/share` no longer falls back to a GitHub gist.
- **Update checks:** once a day, pi checks this clone for new commits and tells you to run `/pi-config-update`.

## Install

You need `git`, Node.js, and pi signed in to GitHub Copilot (`/login` in pi).

```bash
git clone <this repo's URL> ~/pi-config
~/pi-config/install.sh
```

Then restart pi, or run `/reload` in a session that is already open.

`install.sh` installs into `~/.pi/agent`, or into `$PI_CODING_AGENT_DIR` if that is set. It makes these changes:

| File            | What happens                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `settings.json` | The team keys from `agent/settings.json` are merged in. Your other keys are kept.                              |
| `models.json`   | The team keys from `agent/models.json` are merged in. Your other keys are kept.                                |
| `SYSTEM.md`     | Linked to `agent/SYSTEM.md` when the repo has one. If you already have your own `SYSTEM.md`, it is left alone. |
| pi packages     | This clone is added as a package, so pi loads its extensions from the clone in place.                          |

Before changing a JSON file, it saves a copy next to it as `<file>.bak-<time>`. Running it again is safe.

## Update

When pi says pi-config has updates, run `/pi-config-update` in pi. It shows the new commits, and after you confirm it pulls them, re-runs `install.sh` and reloads pi. It refuses to run if your clone has local changes.

To update by hand instead: `git -C ~/pi-config pull`, then `~/pi-config/install.sh`.

To turn off the daily check, set `PI_CONFIG_UPDATE_CHECK=0`.

## Spending limits

Pi's footer shows what you have spent in each window against its limit, for example `day $3.10/$40.00 · week $12.40/$100.00`. The windows are rolling: "day" is the last 24 hours, not the calendar day.

- At 80% of a limit, pi warns you once.
- Once you reach a limit, pi asks before sending your next prompt, or before the next request of a task that is already running. **Continue anyway** lets you spend another 25% of the limit ($10 of the daily $40) before it asks again. Declining keeps your prompt in the editor, or stops the running task.
- In `pi -p`, which has nobody to ask, pi stops instead and prints why.
- `/budget` shows your spend per window and your most expensive models.

The limits are soft: they rely on your confirmation, and a single request can take you a little past a limit, because a request's cost is only known once it finishes. The costs are pi's estimates from its price list; your Copilot bill is the final word.

Spend is logged in `~/.pi/agent/spend/`, one file per month, shared by every pi session on the machine. Each machine keeps its own log.

To change your limits, create `~/.pi/agent/budget.json` with only the values you want to change. This raises the daily limit to $60 and adds a 30-day window with no limit, shown in the footer only:

```json
{ "windows": { "day": { "usd": 60 }, "month": { "hours": 720, "usd": null } } }
```

The other settings are `warnAt` (default `0.8`) and `continueStep` (default `0.25`). If `budget.json` is invalid, pi shows an error and the limits are off until you fix it.

## Sharing prompts

Run `/submit-prompt` in a session whose prompts you'd like the team to see, whether they worked well or not. Nothing is shared unless you run it.

1. Choose what to submit: just your prompts, or the whole conversation, which adds pi's replies and the first 600 characters of each tool call and result.
2. Say how it went, and optionally what you were trying to do.
3. Review the submission in the editor. Tokens, keys and passwords that look like secrets are already masked, but the masking can miss things: delete anything you don't want to share.
4. Confirm, and it is saved to the team's shared folder.

Each submission is one markdown file, named `<YYYY-MM>/<time>-<your name>-<random>.md`. Its header records the model, thinking level, cost, prompt and tool-call counts, and your outcome rating.

If the shared folder isn't mounted, the file is saved in `~/.pi/agent/prompt-submissions/` instead, and pi tells you to copy it over later.

### Set up the shared folder

The repo is public, so the folder's path isn't in it. In the team's private copy, add `team.json` at the repo root and commit it there with `git add -f team.json` (the public repo ignores it):

```json
{ "promptShareDir": "/mnt/team-share/pi-prompts" }
```

`PI_PROMPT_SHARE_DIR` overrides it for one person. Create an empty file named `.pi-prompt-share` in the folder. Pi only writes to a folder that contains it, so a mount point whose NFS share isn't mounted is never mistaken for the share.

### Reviewing submissions

Read the files straight from the shared folder. When a prompt is worth reusing, turn it into a pi prompt template in this repo's `prompts/` folder and open a pull request; everyone gets it with their next update.

### What pi itself can upload

- `/share` uploads a session and returns a link. pi-config sets `sessionShareDestination` to `radius`, so `/share` fails unless you have signed in to pi.dev's Radius service with `/login radius`. Without this setting it would fall back to a private GitHub gist.
- `/bug` sends a bug report, optionally with your transcript, to pi's developers after asking you. At work, choose **Export as Zip** instead of **Upload Report**.

## Your own settings

The team keys win each time `install.sh` runs, so change a team setting for a single session (`/model`, the thinking level) rather than in `settings.json`. Keys the team doesn't set are yours to change.

## Change it

| To change                         | Edit                                                           |
| --------------------------------- | -------------------------------------------------------------- |
| Team defaults                     | `agent/settings.json`                                          |
| Model context caps or price fixes | `agent/models.json`, then run `npm run check-prices`           |
| Copilot prices                    | `data/copilot-prices.json` (copied from GitHub's pricing page) |
| Team spending limits              | `extensions/budget/defaults.json`                              |
| Extensions                        | `extensions/<name>/index.ts`                                   |

This repo is public: don't commit company names, internal URLs, hostnames or paths. Company-specific values go in `team.json`, which only the team's private copy commits.

## Develop

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
```

The tests run real pi processes in RPC mode against a scripted test provider (`tests/fixtures/scripted-provider.ts`), in throwaway agent directories. They make no network calls and cost nothing.
