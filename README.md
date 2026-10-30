# pi-config

Team settings, extensions and skills for the [pi](https://pi.dev) coding agent, tuned for GitHub Copilot's per-token billing.

## What it sets up

- **Copilot defaults:** Claude Haiku 5.5 with xhigh thinking, Ctrl+P to switch to GPT-6.1 Sol with high thinking, and context windows capped at each model's price threshold so long sessions don't drift onto long-context rates. See [docs/models.md](docs/models.md).
- **Spending limits:** soft limits of $500 a calendar month and $40 a day, with your spend and the month's pace shown in pi's footer. See [Spending limits](#spending-limits).
- **System prompt:** a short prompt that replaces pi's default, with rules for reaching work systems through agent-cli. See [System prompt](#system-prompt).
- **Team skills:** `/skill:dev-start`, `/skill:dev-finish` and five more carry an Azure DevOps work item from start to merge through agent-cli. See [Team skills](#team-skills).
- **Prompt sharing:** `/submit-prompt` lets you volunteer a session's prompts for team review. See [Sharing prompts](#sharing-prompts).
- **Live sessions:** `/live` streams your session to colleagues, who join with one `ssh` command and can suggest prompts that you choose whether to send. It needs a relay, which this repo also holds. See [docs/live/README.md](docs/live/README.md).
- **No accidental uploads:** pi's built-in `/share` no longer falls back to a GitHub gist.
- **Update checks:** once a day, pi checks this clone for new commits and tells you to run `/pi-config-update`.

## Install

Setting this up for a team, with a private Azure DevOps copy and a shared folder? Follow [docs/work-setup.md](docs/work-setup.md).

You need `git`, Node.js, uv (or Python 3.11 or later), and pi signed in to GitHub Copilot (`/login` in pi). The team skills also need agent-cli.

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
| pi packages     | This clone is added as a package, so pi loads its extensions and team skills from the clone in place.          |

Before changing a JSON file, it saves a copy next to it as `<file>.bak-<time>`. Running it again is safe.

## Update

When pi says pi-config has updates, run `/pi-config-update` in pi. It shows the new commits, and after you confirm it pulls them, re-runs `install.sh` and reloads pi. It refuses to run if your clone has local changes.

To update by hand instead: `git -C ~/pi-config pull`, then `~/pi-config/install.sh`.

To turn off the daily check, set `PI_CONFIG_UPDATE_CHECK=0`.

## System prompt

`agent/SYSTEM.md` replaces pi's default system prompt with these working rules: read before editing, verify with the project's own checks, make the smallest change, never commit unless asked, run Python through uv. Pi still adds the tool list, skills, the repo's `AGENTS.md` and the working directory after it.

It also tells pi to use [agent-cli](https://github.com/jacobragsdale/agent-cli) for Azure DevOps, Azure, Kubernetes, databases and other work systems when it helps, and otherwise whatever tool does the job, such as az, kubectl, curl or git, without stopping to ask. Pi runs agent-cli writes with `--dry-run` first, and never adds `--yes` (destructive changes) or `--reveal` (secrets) unless you asked for that exact action.

The prompt is read from the cache on every request after the first, so its length costs little: 1,000 tokens of it cost about $0.0001 per request on GPT-6.1 Sol, and a tenth of that on Claude Haiku 5.5.

To add your own instructions, write them in `~/.pi/agent/APPEND_SYSTEM.md`; pi adds that file after the team prompt, and `install.sh` never touches it. If you already had a `SYSTEM.md`, `install.sh` keeps yours instead of the team's.

## Spending limits

Pi's footer shows what you have spent in each window against its limit, for example `day $3.10/$40.00 · month $212.00/$500.00 · pace $455.00`.

- "month" is the calendar month in local time, starting fresh on the 1st. It is the main limit.
- "pace" is what the month will cost if you carry on as you have so far: the month's spend divided by today's date, times the days in the month.
- "day" is the last 24 hours, not the calendar day. It catches a single runaway session.

What happens at a limit:

- At 80% of a limit, pi warns you once.
- Once you reach a limit, pi asks before sending your next prompt, or before the next request of a task that is already running. **Continue anyway** lets you spend another 25% of the limit ($125 of the monthly $500) before it asks again. Declining keeps your prompt in the editor, or stops the running task.
- In `pi -p`, which has nobody to ask, pi stops instead and prints why.
- `/budget` shows your spend per window and where this month's spend went. See [Where the month went](#where-the-month-went).

The limits are soft: they rely on your confirmation, and a single request can take you a little past a limit, because a request's cost is only known once it finishes. The costs are pi's estimates from its price list; your Copilot bill is the final word.

Spend is logged in `~/.pi/agent/spend/`, one file per month, shared by every pi session on the machine. Each machine keeps its own log.

To change your limits, create `~/.pi/agent/budget.json` with only the values you want to change. A window is either rolling, with `hours`, or the calendar month, with `"calendar": "month"`. This raises the monthly limit to $600 and adds a rolling week with no limit, shown in the footer only:

```json
{ "windows": { "month": { "usd": 600 }, "week": { "hours": 168, "usd": null } } }
```

The other settings are `warnAt` (default `0.8`) and `continueStep` (default `0.25`). If `budget.json` is invalid, pi shows an error and the limits are off until you fix it.

### Where the month went

`/budget` breaks this month's spend down from the sessions saved in `~/.pi/agent/sessions/`, which record each request's tokens. Each line answers a question about what is worth cutting next:

| Line                                | What it counts                                                                                   | What it tells you                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| new input                           | Prompt tokens not read from the cache, mostly tool results                                       | Whether tool output is worth trimming                |
| cache reads                         | Prompt tokens read from the cache                                                                | How much long conversations cost to carry            |
| output                              | Replies, thinking included, with thinking's share of output tokens where the provider reports it | Whether a lower thinking level would pay             |
| by model                            | Spend per model; compaction summaries show as `summaries`                                        | How much of the month runs on the cheap model        |
| cache misses                        | Uncached prompt of requests that missed the previous request's cache                             | What expired caches and model switches cost          |
| over a long-context price threshold | Requests whose prompt passed the model's long-context price threshold                            | Whether the context caps in `agent/models.json` hold |
| compaction                          | Summaries pi wrote when a session compacted                                                      | What compaction costs                                |
| top sessions                        | The 10 most expensive sessions, with their folder and first prompt                               | Which kinds of task cost the most                    |

The first line compares the breakdown's total with the spend log's. Sessions saved elsewhere, such as with `--session-dir` or `--no-session`, are in the spend log but not the breakdown.

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

Read the files straight from the shared folder.

### What pi itself can upload

- `/share` uploads a session and returns a link. pi-config sets `sessionShareDestination` to `radius`, so `/share` fails unless you have signed in to pi.dev's Radius service with `/login radius`. Without this setting it would fall back to a private GitHub gist.
- `/bug` sends a bug report, optionally with your transcript, to pi's developers after asking you. At work, choose **Export as Zip** instead of **Upload Report**.

## Team skills

Seven skills carry an Azure DevOps work item from start to merge, reaching Azure DevOps and other services through [agent-cli](https://github.com/jacobragsdale/agent-cli). Each runs only when you type its command, which in pi is `/skill:dev-<name>`. They need agent-cli signed in to your Azure DevOps organization (`agent-cli doctor` passes), and your repositories cloned under `~/dev/`.

A ticket's path is `/skill:dev-create-ticket` when the work has no ticket yet, `/skill:dev-start`, the work itself, `/skill:dev-finish`, and a teammate's `/skill:dev-review`. `/skill:dev-sprint` shows where your sprint, or the team's, stands. Each skill makes only the writes listed here without asking. No skill closes or deletes a work item, approves, or merges.

| Skill                              | What it does                                                                                                                                                                          | Writes without asking                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/skill:dev-context`               | Writes or refreshes a repository's `AGENTS.md` and `docs/app-context.md`, confirming each operational fact read-only. Run it once in each repository first.                           | The two files, in the working tree                                                                                                                  |
| `/skill:dev-create-ticket <what>`  | Turns something that needs doing into a PBI or Bug with concrete criteria, a dev task, and a QA task, in the backlog or the current sprint.                                           | Nothing until you approve the draft, then the three items                                                                                           |
| `/skill:dev-start [id]`            | Claims the task, keeps it in the current sprint, makes the PBI's acceptance criteria concrete, creates the branch, and agrees a plan. With no id, it offers the next unassigned task. | Assigns and starts the task, moves it into the sprint, writes the criteria and the estimate, creates the QA task and the branch, and posts the plan |
| `/skill:dev-finish`                | Runs `check`, maps each criterion to a test, has a fresh agent review the diff, opens the pull request, suggests reviewers, and writes the QA steps.                                  | Pushes the branch, opens the pull request linked to the task, sets Remaining Work to 0, writes the QA task, and comments on the task                |
| `/skill:dev-review [pr]`           | Reviews a teammate's pull request against its criteria and the review checklist, and drafts comments. With no id, it lists the reviews you owe.                                       | Nothing. It posts only the drafts you pick.                                                                                                         |
| `/skill:dev-sprint [team \| name]` | Shows your sprint, the team's, or a teammate's by stage, then offers fixes for your own tickets and fills in your time.                                                               | Nothing. It makes only the fixes you pick.                                                                                                          |
| `/skill:dev-feedback`              | Turns a skill's misstep in the current session into a pull request to this repository, with a fixture.                                                                                | A branch and a pull request here                                                                                                                    |

These are the v1 skills. The v2 and v3 skills in the [skill map](docs/skills/design.md#skill-map) follow once v1 has been proven at work.

### Prepare a repository

- Run `/skill:dev-context` in the repository, so the other skills can read its commands, its systems, and how to verify a change.
- Adopt the team's lint baseline once, by following [How to adopt the lint baseline](templates/lint/README.md).

### See your sprint from a terminal

`/skill:dev-sprint` runs a script you can also run yourself, with no agent and no tokens. In a terminal it prints colored tables:

```bash
alias sprint='uv run ~/pi-config/skills/dev-sprint/scripts/sprint.py'
sprint view            # your sprint
sprint view --team     # the team's
sprint time            # your hours since Monday of last week
```

### Measure the effect

Take the baseline before the skills reach the team, then run the same command every week:

```bash
uv run ~/pi-config/scripts/metrics.py --log ~/team-metrics.jsonl
```

It prints cycle time, pull request review turnaround, active items with no comment in three days, and stale items, and appends the same numbers to the log as one JSON line. The team and area default to `shared/assets/team.toml`. `--help` lists the filters for area, team, iteration, and repository.

### Change a skill

Follow the rules in [AGENTS.md](AGENTS.md); [docs/skills/design.md](docs/skills/design.md) gives the reasons. A skill's scripts, references and assets live once under `shared/`, and its folders link there. Every fix to a skill's behavior adds a note under `fixtures/<skill>/`. From inside a pi session, `/skill:dev-feedback` does all of this for you.

## Your own settings

The team keys win each time `install.sh` runs, so change a team setting for a single session (`/model`, the thinking level) rather than in `settings.json`. Keys the team doesn't set are yours to change.

## Change it

| To change                             | Edit                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------- |
| Team defaults                         | `agent/settings.json`                                                       |
| Model context caps or price fixes     | `agent/models.json`, then run `npm run check-prices`                        |
| Copilot prices                        | `data/copilot-prices.json` (copied from GitHub's pricing page)              |
| Team spending limits                  | `extensions/budget/defaults.json`                                           |
| Team system prompt                    | `agent/SYSTEM.md`                                                           |
| Extensions                            | `extensions/<name>/index.ts`                                                |
| The pi-live relay                     | `relay/`, then rebuild its image: see `docs/live/deploy.md`                 |
| Team skills                           | `skills/dev-<name>/SKILL.md`, and their scripts and references in `shared/` |
| The team's roster, tags and time logs | `shared/assets/team.toml`, in the team's private copy only                  |

This repo is public: don't commit company names, internal URLs, hostnames or paths. Company-specific values go in `team.json`, which only the team's private copy commits, and in `shared/assets/team.toml`, which holds placeholders here.

## Check an install

```bash
node ~/pi-config/scripts/smoke-copilot.mjs
```

It checks the install and makes one tiny request to GitHub Copilot's Claude Haiku 5.5, well under a cent. Add `--sol` to also try GPT-6.1 Sol, the model Ctrl+P switches to.

## Develop

```bash
npm ci
npm run check
```

`npm run check` runs the typecheck, ESLint, Prettier, the tests, and `scripts/validate.py`, which checks the skills against the rules in [AGENTS.md](AGENTS.md).

The tests run real pi processes in RPC mode against a scripted test provider (`tests/fixtures/scripted-provider.ts`), in throwaway agent directories. The pi-live tests also start relays on free local ports and connect guests to them over SSH. Nothing leaves the machine, and nothing costs anything.
