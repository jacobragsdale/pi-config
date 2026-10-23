# Set up pi-config for a team

This guide moves pi-config from its public GitHub repo into a team's private Azure DevOps repo, adds the team's private settings, and checks the result against real GitHub Copilot. Then it covers rolling it out to the team.

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

The `DISABLED` push URL makes an accidental `git push github` fail, so the team's private settings can't reach the public repo.

To bring in later changes from GitHub:

```bash
git pull github main
git push origin main
```

Teammates clone from Azure DevOps, so their update checks follow it.

## 2. Add the team's private settings

Create `team.json` at the repo root, and commit it to the private copy only:

```json
{ "promptShareDir": "/mnt/team-share/pi-prompts" }
```

```bash
git add -f team.json
git commit -m "Add team settings"
git push origin main
```

The public repo's `.gitignore` lists `team.json`, which is why it needs `-f`.

## 3. Create the shared folder for prompt submissions

On the NFS share, create the folder, let the team write to it, and add the marker file pi looks for:

```bash
mkdir -p /mnt/team-share/pi-prompts
chmod 2775 /mnt/team-share/pi-prompts
touch /mnt/team-share/pi-prompts/.pi-prompt-share
```

`chmod 2775` keeps the folder's group on the month folders pi creates inside it. Anyone who mounts the share at a different path sets `PI_PROMPT_SHARE_DIR` to their path.

## 4. Install and sign in

```bash
~/pi-config/install.sh
```

Start pi, run `/login`, and choose GitHub Copilot.

## 5. Run the smoke test

```bash
node ~/pi-config/scripts/smoke-copilot.mjs --sol
```

It checks the install, the update check's access to Azure DevOps, the shared folder, and one real request each to Claude Haiku 5.5 with xhigh thinking and to GPT-6.1 Sol with high thinking. Together these cost a cent or two. A failed check prints what to fix.

Things only this step can confirm:

- pi signs in to the team's Copilot plan and can use GPT-6.1 Sol.
- `git fetch` reaches Azure DevOps without asking for credentials. If it can't, update checks stay silent; update with `git pull` and `install.sh` instead.
- pi's cost for each request matches GitHub's published prices for the tokens Copilot reports.

## 6. Roll it out

Each teammate:

1. Clones the Azure DevOps repo to `~/pi-config` and runs `~/pi-config/install.sh`.
2. Runs `/login` in pi and chooses GitHub Copilot.
3. Runs `node ~/pi-config/scripts/smoke-copilot.mjs` (well under a cent).

## 7. Watch the first week

- **Costs:** compare a few days of `/budget` totals with the team's Copilot usage report. Pi's costs are estimates from its price list, so a steady gap means a price in `agent/models.json` or `data/copilot-prices.json` needs fixing.
- **Compaction:** Claude Haiku 5.5 compacts at about 84K tokens to stay under its 100K price threshold, and GPT-6.1 Sol at about 239K to stay under 272K. Watch whether long tasks lose track after a compaction.
- **pi upgrades:** after each one, run `npm run check-prices` in the repo to catch price or model changes.
