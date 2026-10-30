# Set up pi-config for a team

This guide moves pi-config from its public GitHub repo into a team's private Azure DevOps repo, adds the team's private settings, connects the team skills to the internal agent-cli, and checks the result against real GitHub Copilot and Azure DevOps. Then it covers rolling it out to the team.

Every piece that has to change at work is marked `PORT:` in the source. `npm run validate-skills` lists the markers that remain, and you are done porting when it lists none.

Before you start, you need the internal agent-cli installed and signed in, so that `agent-cli doctor` passes, and uv or Python 3.11 or later in WSL.

## 1. Host a private copy

Clone the public repo on a work machine, then make the team's Azure DevOps repo the main remote:

```bash
git clone https://github.com/jacobragsdale/pi-config ~/pi-config
cd ~/pi-config
git remote rename origin github
git remote set-url --push github DISABLED
git remote add origin <your Azure DevOps repo URL>
git push -u origin main
```

The `DISABLED` push URL makes an accidental `git push github` fail, so the team's private settings, and the fixtures and feedback pull requests the team skills produce, can't reach the public repo.

To bring in later changes from GitHub:

```bash
git pull github main
git push origin main
```

Teammates clone from Azure DevOps, so their update checks follow it.

List the company and system names the repo must never hold, one per line, in `~/.config/pi-config/banned-words.txt`. `npm run validate-skills` then fails on any of them outside the two team settings files.

## 2. Add the team's private settings

The team's values live in two files, both committed to the private copy only.

### team.json

Create `team.json` at the repo root:

```json
{ "promptShareDir": "/mnt/team-share/pi-prompts" }
```

The public repo's `.gitignore` lists `team.json`, so add it with `git add -f team.json`.

### shared/assets/team.toml

The team skills' settings. Fill each value, then delete its `PORT:` marker.

**Team and area.** Set `team` to the Azure DevOps team's name, and check that this prints the current sprint:

```bash
agent-cli ado sprint get @current --team '<team>' --fields name,start,finish,people
```

Sprints, `@current`, and capacity all come through Azure DevOps' team-settings API. If that API is unavailable in the organization, the internal agent-cli needs a fallback that reads the sprint dates from the project's iterations, and the capacity figures drop out of the views. Set `area` to the team's area path, as `agent-cli ado workitem get <a team ticket> --fields area` prints it.

**People.** Add a `[[people]]` table for each member, with the display name and the sign-in address that `--assignee` takes. The assignee on one of their tickets shows the address.

**Tags.** Find the exact names the team uses:

```bash
agent-cli ado workitem list --iteration @current --team '<team>' --limit 200 --fields id,type,tags
```

Set `blocked`, `ready_for_qa`, and `ready_for_deployment` to those names, and `on` to `task` or `pbi`, whichever carries them. Keep `ready_for_qa_when = "merged"` if the team tags Ready for QA once the pull request merges. Any other value turns the offer off, until a skill can see the deploy to QA.

**Time logs.** Fill in the internal agent-cli's time-log commands, as the arguments after `agent-cli`, with `{person}`, `{since}`, `{until}`, `{task}`, `{date}`, `{hours}`, and `{entry}` where the values go. `list` must print a JSON list of entries, and `fields` names the keys holding each entry's id, task, date, and hours. Set `block_hours` to the smallest entry the tracker takes, and `time_off_task` to the ticket all time off goes to. Then check both directions without writing anything:

```bash
uv run skills/dev-sprint/scripts/sprint.py time
uv run skills/dev-sprint/scripts/post.py --skill dev-sprint --dry-run timelog <task> --date <day> --hours 1
```

Log one real hour on a test task and read `agent-cli ado history get <task>`. Note whether the tracker changed Completed Work or Remaining Work by itself, and add the answer to [docs/skills/design.md](skills/design.md) under Time.

`sprint.py` works out who you are from the assignee on your own work items, then from `agent-cli doctor`. If neither works, set `TEAM_SKILLS_ME` to your sign-in address.

## 3. Create the shared folder for prompt submissions

On the NFS share, create the folder, let the team write to it, and add the marker file pi looks for:

```bash
mkdir -p /mnt/team-share/pi-prompts
chmod 2775 /mnt/team-share/pi-prompts
touch /mnt/team-share/pi-prompts/.pi-prompt-share
```

`chmod 2775` keeps the folder's group on the month folders pi creates inside it. Anyone who mounts the share at a different path sets `PI_PROMPT_SHARE_DIR` to their path.

## 4. Check Azure DevOps and agent-cli for the team skills

**agent-cli's commands.** The skills and their scripts call the commands below. Run each one with `--help` on the internal agent-cli and compare its flags and its `Returns:` line with what the skills use. Where one differs, change the script under `shared/scripts/` or the skill's `SKILL.md`.

| Command                                                                         | What the skills use                                                                                                                                                        |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ado workitem get`                                                              | `--comments`; `iteration`, `tags`, `parent`, `children`, `pull_requests`, `branches`, `comments`, `acceptance_criteria`                                                    |
| `ado workitem list`                                                             | `--iteration`, `--area`, `--team`, `--assignee @me`, `--state`, `--type`, `--text`, `--since`; `id`, `type`, `title`, `state`, `assignee`, `iteration`, `tags`, `priority` |
| `ado workitem update`                                                           | `--state`, `--assignee`, `--iteration`, `--tags`, `--field`, `--if-rev`, `--description-file`, `--acceptance-criteria-file`, `--dry-run`                                   |
| `ado workitem create`                                                           | `--type`, `--title`, `--parent`, `--area`, `--iteration`, `--description-file`, `--acceptance-criteria-file`, `--field`                                                    |
| `ado workitem comment`, `ado workitem link`                                     | `--text-file`; `--repo`, `--branch`                                                                                                                                        |
| `ado workitem-type get`, `list`                                                 | `states` with `name` and `category`; `fields` with `ref`                                                                                                                   |
| `ado history get`                                                               | `states` with `state`, `since`, `until`; `changes` with `rev`, `date`, and `fields` of `field`, `old`, `new`                                                               |
| `ado tree get`                                                                  | children with `remaining_work`                                                                                                                                             |
| `ado sprint get`, `ado sprint list`                                             | `path`, `name`, `start`, `finish`, `timeframe`, `working_days_left`, `totals`, `people`, `team_days_off`                                                                   |
| `ado backlog list`                                                              | `id`, `rank`                                                                                                                                                               |
| `ado activity list`                                                             | `--person`, `--since`; `at`, `kind`, `action`, `id`, `title`                                                                                                               |
| `ado pr list`                                                                   | `--reviewer`, `--vote none`, `--author`, `--draft`; `id`, `title`, `author`, `created`                                                                                     |
| `ado pr get`                                                                    | `status`, `is_draft`, `created`, `reviewers` with `vote`, `open_threads`, `work_items`, `source`                                                                           |
| `ado pr create`, `update`, `comment`, `link`, `ado thread list`, `ado diff get` | as `post.py` and `/skill:dev-review` call them                                                                                                                             |
| `doctor`                                                                        | the Azure DevOps check's "signed in as" detail                                                                                                                             |

**The work item types.**

```bash
agent-cli ado workitem-type get Task --fields fields
agent-cli ado workitem-type get '<backlog item type>' --fields fields
```

- The Task type has Remaining Work. `post.py` also writes Original Estimate where the type has it.
- The Task type's Activity field allows Testing, which QA tasks carry. If it has no Activity field, the skills leave it out.
- The backlog item type has Acceptance Criteria, and one of Story Points, Effort, or Size, which `sprint.py` reads as points.

**Reviewer mentions.** `/skill:dev-finish` asks reviewers in a pull request comment that mentions them, because agent-cli cannot add a reviewer yet. Post a test comment with `@<Display Name>` on a draft pull request and check that the person is notified. If the internal agent-cli can add a reviewer, change step 6 of `/skill:dev-finish` to use it.

**Branch policies.** The policies can be enabled on every repository: a linked work item on every pull request, and the linked items completed on merge.

## 5. Validate and push

```bash
npm ci
npm run check
```

Fix what it reports until it passes and `validate-skills` lists no `PORT:` markers. Commit both settings files and your fixes to the private copy, and push it with `git push origin main`.

## 6. Install and sign in

```bash
~/pi-config/install.sh
```

Start pi, run `/login`, and choose GitHub Copilot.

## 7. Run the smoke test

```bash
node ~/pi-config/scripts/smoke-copilot.mjs --sol
```

It checks the install, the update check's access to Azure DevOps, the shared folder, and one real request each to Claude Haiku 5.5 with xhigh thinking and to GPT-6.1 Sol with high thinking. Together these cost a cent or two. A failed check prints what to fix.

Things only this step can confirm:

- pi signs in to the team's Copilot plan and can use GPT-6.1 Sol.
- `git fetch` reaches Azure DevOps without asking for credentials. If it can't, update checks stay silent; update with `git pull` and `install.sh` instead.
- pi's cost for each request matches GitHub's published prices for the tokens Copilot reports.

## 8. Roll it out

Take the team skills' metrics baseline before the team gets them:

```bash
uv run ~/pi-config/scripts/metrics.py --log ~/team-metrics.jsonl
```

Then use each skill on three real tickets yourself, and fix what each run exposes with `/skill:dev-feedback`. The skills go to the team together once all seven have had their runs.

Each teammate:

1. Clones the Azure DevOps repo to `~/pi-config` and runs `~/pi-config/install.sh`.
2. Runs `/login` in pi and chooses GitHub Copilot.
3. Runs `node ~/pi-config/scripts/smoke-copilot.mjs` (well under a cent).
4. Runs `/skill:dev-context` once in each repository they work in, if it has no `AGENTS.md` yet.

## 9. Watch the first week

- **Costs:** compare a few days of `/budget` totals with the team's Copilot usage report. Pi's costs are estimates from its price list, so a steady gap means a price in `agent/models.json` or `data/copilot-prices.json` needs fixing.
- **Compaction:** Claude Haiku 5.5 compacts at about 84K tokens to stay under its 100K price threshold, and GPT-6.1 Sol at about 239K to stay under 272K. Watch whether long tasks lose track after a compaction.
- **The skills' numbers:** run the metrics command each week, as under [Measure the effect](../README.md#measure-the-effect). A skill that moves none of them is cut.
- **pi upgrades:** after each one, run `npm run check-prices` in the repo to catch price or model changes.
