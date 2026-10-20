# pi-config

Team settings and extensions for the [pi](https://pi.dev) coding agent, tuned for GitHub Copilot's per-token billing.

## What it sets up

- **Copilot defaults:** GPT-6.1 Sol with high thinking, and context windows capped at each model's price threshold so long sessions don't drift onto long-context rates. See [docs/models.md](docs/models.md).
- **Update checks:** once a day, pi checks this clone for new commits and tells you to run `/pi-config-update`.

## Install

You need `git`, Node.js, and pi signed in to GitHub Copilot (`/login` in pi).

```bash
git clone <this repo's URL> ~/pi-config
~/pi-config/install.sh
```

Then restart pi, or run `/reload` in a session that is already open.

`install.sh` installs into `~/.pi/agent`, or into `$PI_CODING_AGENT_DIR` if that is set. It makes these changes:

| File | What happens |
|---|---|
| `settings.json` | The team keys from `agent/settings.json` are merged in. Your other keys are kept. |
| `models.json` | The team keys from `agent/models.json` are merged in. Your other keys are kept. |
| `SYSTEM.md` | Linked to `agent/SYSTEM.md` when the repo has one. If you already have your own `SYSTEM.md`, it is left alone. |
| pi packages | This clone is added as a package, so pi loads its extensions from the clone in place. |

Before changing a JSON file, it saves a copy next to it as `<file>.bak-<time>`. Running it again is safe.

## Update

When pi says pi-config has updates, run `/pi-config-update` in pi. It shows the new commits, and after you confirm it pulls them, re-runs `install.sh` and reloads pi. It refuses to run if your clone has local changes.

To update by hand instead: `git -C ~/pi-config pull`, then `~/pi-config/install.sh`.

To turn off the daily check, set `PI_CONFIG_UPDATE_CHECK=0`.

## Your own settings

The team keys win each time `install.sh` runs, so change a team setting for a single session (`/model`, the thinking level) rather than in `settings.json`. Keys the team doesn't set are yours to change.

## Change it

| To change | Edit |
|---|---|
| Team defaults | `agent/settings.json` |
| Model context caps or price fixes | `agent/models.json`, then run `npm run check-prices` |
| Copilot prices | `data/copilot-prices.json` (copied from GitHub's pricing page) |
| Extensions | `extensions/<name>/index.ts` |

This repo is public: don't commit company names, internal URLs, hostnames or paths. Put machine- or company-specific values in `team.local.json`, which git ignores.
