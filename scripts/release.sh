#!/usr/bin/env bash
# One-command release for memory-pulse (client) + the engine worker.
#
#   scripts/release.sh            # release the version in package.json
#   scripts/release.sh 0.3.3      # bump every manifest to 0.3.3 first
#
# Steps, each gated on the previous one:
#   1. test gate  — the client suite must report `fail 0` (never gate on a filter pipeline)
#   2. version    — package.json, server.json, .claude-plugin, .codex-plugin carry the same version
#   3. tag + push — v<version>, `git push --follow-tags`; release.yml then publishes to npm AND the
#                   MCP registry with no tokens (OIDC trusted publishing — needs the npm Trusted
#                   Publisher registered once: package memory-pulse, workflow release.yml)
#   4. worker     — `wrangler deploy` in the engine repo so the seal / provenance path is live
#
# Until the Trusted Publisher exists, step 3 falls back to a local `npm publish` (browser one-time
# authorisation). Proxy vars are stripped for wrangler and git (a SOCKS proxy crashes wrangler).
set -euo pipefail
CLIENT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE="${MEMORY_PULSE_ENGINE:-$HOME/future-research/memory-pulse}"
noproxy() { env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy "$@"; }
cd "$CLIENT"

if [ "${1:-}" != "" ]; then
  for f in package.json server.json .claude-plugin/plugin.json .codex-plugin/plugin.json; do
    sed -i '' -E "s/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"$1\"/g" "$f"
  done
fi
VERSION=$(node -p "require('./package.json').version")
echo "release: memory-pulse@$VERSION"

echo "1/4 test gate"
LOG="${TMPDIR:-/tmp}/mp-release-test.log"
node --test test/*.test.js > "$LOG" 2>&1 || true
grep -E "^ℹ fail 0$" "$LOG" > /dev/null || { echo "tests not green — see $LOG"; exit 1; }
grep -E "^ℹ (tests|pass|fail)" "$LOG" | tr '\n' ' '; echo

echo "2/4 version consistency"
for f in server.json .claude-plugin/plugin.json .codex-plugin/plugin.json; do
  grep -q "\"version\": \"$VERSION\"" "$f" || { echo "$f is not at $VERSION"; exit 1; }
done
if ! git diff --quiet || ! git diff --cached --quiet; then
  git add package.json server.json .claude-plugin/plugin.json .codex-plugin/plugin.json
  git -c user.name="Travis Crew" -c user.email="travisaaroncrew@gmail.com" commit -q -m "release $VERSION" || true
fi

echo "3/4 pull request → merge → tag (main is protected: changes land through a PR; the tag triggers release.yml)"
BR="release/$VERSION"
git branch -f "$BR" HEAD > /dev/null
noproxy git push -f -u origin "$BR" > /dev/null
if ! noproxy gh pr view "$BR" > /dev/null 2>&1; then
  noproxy gh pr create --base main --head "$BR" --title "release $VERSION" --body "Automated release $VERSION via scripts/release.sh (tests green, manifests consistent)." > /dev/null
fi
noproxy gh pr merge "$BR" --merge --delete-branch > /dev/null
noproxy git fetch -q origin && git merge -q --ff-only origin/main || { echo "local main did not fast-forward to origin/main — resolve before tagging"; exit 1; }
git tag -f "v$VERSION" -m "memory-pulse $VERSION" > /dev/null
noproxy git push -f origin "v$VERSION"
if [ "${MP_LOCAL_PUBLISH:-}" = "1" ] && ! noproxy npm view "memory-pulse@$VERSION" version > /dev/null 2>&1; then
  echo "   local npm publish (approve npm's browser prompt once)"
  noproxy npm publish --access public
fi

echo "4/4 worker deploy"
( cd "$ENGINE" && noproxy npx wrangler deploy 2>&1 | grep -E "Deployed|Current Version|error" )

echo "released memory-pulse@$VERSION — tag pushed, worker deployed"
