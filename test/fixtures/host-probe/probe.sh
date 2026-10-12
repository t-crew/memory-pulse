#!/usr/bin/env bash
# Live host probe (0.7.0 Task 1). Usage: probe.sh claude|codex  — prints the model's answer; a few cents of API use.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; T="$(mktemp -d)"; cd "$T"
HOOK="node $HERE/hook.mjs"
PROMPT="Create a file named note.txt containing the word ok. After that, list verbatim every project codename you have been told in this session, one per line."
if [ "$1" = claude ]; then
  node -e 'const h=process.argv[1];const ev=(m)=>({...(m?{matcher:m}:{}),hooks:[{type:"command",command:h}]});process.stdout.write(JSON.stringify({hooks:{SessionStart:[ev()],UserPromptSubmit:[ev()],PreToolUse:[ev("Write|Edit")]}}))' "$HOOK" > settings.json
  claude -p "$PROMPT" --settings "$T/settings.json" --allowedTools Write --output-format text
else
  mkdir -p .codex && node -e 'const h=process.argv[1];const ev=(m)=>({...(m?{matcher:m}:{}),hooks:[{type:"command",command:h}]});process.stdout.write(JSON.stringify({hooks:{SessionStart:[ev()],UserPromptSubmit:[ev()],PreToolUse:[ev("apply_patch|Edit|Write")]}}))' "$HOOK" > .codex/hooks.json
  git init -q . && codex exec --dangerously-bypass-hook-trust --skip-git-repo-check -s workspace-write "$PROMPT"
fi
echo "--- note.txt: $(cat note.txt 2>/dev/null || echo missing)"
