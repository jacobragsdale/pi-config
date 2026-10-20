---
name: agent-cli
description: Reach work systems (Azure DevOps, Azure, Kubernetes, databases, Airflow, Datadog, Confluence and more) through agent-cli instead of az, kubectl, sqlcmd or curl. Use when a task needs data from or changes to one of those systems.
---

# agent-cli

First check it is installed with `command -v agent-cli`. If it isn't, tell the user and stop; don't fall back to az, kubectl, sqlcmd or curl without asking.

- Run `agent-cli` to see the domains that are set up, then `agent-cli search "<task>"` to find the command.
- Output is JSON; narrow it with `--fields`.
- When one call's result feeds the next, chain the calls in one bash command or a short script instead of one call per turn. In scripts pass `--raw`, because output over 12 KB is otherwise cut to a shorter list that only stderr reports.
- Run writes with `--dry-run` first and show the user what would change.
