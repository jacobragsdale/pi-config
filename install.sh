#!/usr/bin/env bash
# Install the team pi config into $PI_CODING_AGENT_DIR (default ~/.pi/agent).
# Safe to re-run after every git pull.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
agent=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}

for tool in node pi git; do
  command -v "$tool" >/dev/null || { echo "install.sh: $tool is not on PATH" >&2; exit 1; }
done

mkdir -p "$agent"
echo "Installing pi-config into $agent"

# JSON settings are merged, not linked: pi writes settings.json itself.
node "$repo/lib/merge-json.mjs" "$repo/agent/settings.json" "$agent/settings.json"
node "$repo/lib/merge-json.mjs" "$repo/agent/models.json" "$agent/models.json"

# SYSTEM.md is linked, so a git pull updates it. A personal SYSTEM.md is kept.
if [[ -f $repo/agent/SYSTEM.md ]]; then
  if [[ -L $agent/SYSTEM.md && $(readlink "$agent/SYSTEM.md") == "$repo/agent/SYSTEM.md" ]]; then
    echo "  unchanged $agent/SYSTEM.md"
  elif [[ -e $agent/SYSTEM.md ]]; then
    echo "  kept      $agent/SYSTEM.md (yours; remove it to use the team prompt)"
  else
    ln -s "$repo/agent/SYSTEM.md" "$agent/SYSTEM.md"
    echo "  linked    $agent/SYSTEM.md"
  fi
fi

# Load extensions from this clone in place.
PI_CODING_AGENT_DIR=$agent pi install "$repo"
echo "Done. Restart pi, or run /reload in a running session."
