# pi-config: the team's pi setup, with its settings, system prompt, extensions, team skills and the pi-live relay

## System

Sibling repositories, each cloned at `~/dev/<name>`:

- `agent-cli`: the tool the system prompt and every team skill reach work systems through.
- `skillbook`: personal skills. Team skills live here instead, in `skills/`.

This repository is public on GitHub. The team works in a private Azure DevOps copy that pulls from GitHub and can never push back; [docs/work-setup.md](docs/work-setup.md) sets it up. pi loads the clone in place as a package, so its extensions and skills update with `git pull`.

## Commands

- Setup: `npm ci`, and uv (or Python 3.11 or later) for the skills' scripts
- Check: `npm run check` (types, ESLint, Prettier, the tests, and `scripts/validate.py` for the skills)
- Test: `npm test`
- Run locally: `PI_CODING_AGENT_DIR=$(mktemp -d) ./install.sh`, then `pi`; the relay with `npm run relay`

## Verify

- Extensions: `npm test` drives real pi processes in RPC mode against `tests/fixtures/scripted-provider.ts`, in throwaway agent directories.
- At work: `node scripts/smoke-copilot.mjs` makes one tiny real request.
- Skills: three real runs at work, as under Rules.

## Rules

1. No company names, system names, hostnames, internal URLs, ticket content or data. The team's values go in `shared/assets/team.toml` (placeholders here, filled in only in the ADO copy) and `team.json` (ADO copy only). `validate.py` checks a banned-word list kept outside the repository.
2. An extension is one folder with one job, an environment variable that turns it off, and tests against the scripted provider.
3. Anything sold as a cost saving stays off by default until a measurement shows it pays.
4. No third-party pi packages: read them, then copy or adapt what is worth having.
5. Only team skills go in `skills/dev-<name>/`. Write each `description` for a person scanning the slash menu, in one sentence.
6. A skill's scripts, references and assets exist once, under `shared/`; its folders link there. Edit `shared/`.
7. A skill reads the current repository's `AGENTS.md` first, writes to Azure DevOps only through `post.py` and only the writes it declares up front, and treats production as read-only. Closing or deleting work items, editing someone else's, approving and merging always ask a person. No subagents, except `/dev-finish`'s single cold review.
8. Skill scripts are one file of stdlib-only Python with a PEP 723 header, and must run in WSL behind a corporate proxy. Output a person reads prints colored tables in a terminal and Markdown when piped; output only an agent reads is JSON.
9. Mark every piece that must change at work with `PORT:`, and add the step that fills it in to `docs/work-setup.md`.
10. Every fix to a skill's behavior adds a note under `fixtures/<skill>/` ([fixtures/README.md](fixtures/README.md)), and a skill reaches the team only after three real runs at work.

The reasons behind the skill rules are in [docs/skills/design.md](docs/skills/design.md).

## Gotchas

- The relay pins pi's version. When pi upgrades, bump `relay/package.json` and the root `devDependencies` together, then rebuild the relay image.
- Prettier skips `skills/`, `shared/`, `fixtures/`, `templates/` and `docs/skills/`. Their compact tables are on purpose: a skill's text is paid for on every run.
- ESLint skips `templates/`, the lint baselines this repository hands to other repositories.
- In pi a skill runs as `/skill:dev-<name>`, not `/dev-<name>`.
