#!/usr/bin/env bash
# One-command release for memory-pulse (client) + the engine worker.
#
#   scripts/release.sh            # release the version in package.json
#   scripts/release.sh 0.3.3      # bump every manifest to 0.3.3 first
#
# Steps, each gated on the previous one:
#   1. test gate  — the client suite must report `fail 0` (never gate on a filter pipeline); run through scripts/test.mjs,
#                   which clears the caller's MEMORY_PULSE_* variables so no test can write a real ledger
#   1b. IP gate   — ip-gate --publish over exactly the npm pack list; fails closed (added 2026-10-22)
#   2. version    — package.json, server.json, .claude-plugin, .codex-plugin carry the same version
#   3. tag + push — v<version>, `git push --follow-tags`; release.yml then publishes to npm AND the
#                   MCP registry with no tokens (OIDC trusted publishing — needs the npm Trusted
#                   Publisher registered once: package memory-pulse, workflow release.yml)
#   3b. major tag — v<major> (v0) is re-pointed at the release, because the Action is documented as @v0
#   4. worker     — `wrangler deploy` in the engine repo so the seal / provenance path is live;
#                   RELEASE_SKIP_WORKER=1 releases the client without deploying the engine
#
# Until the Trusted Publisher exists, step 3 falls back to a local `npm publish` (browser one-time
# authorisation). Proxy vars are stripped for wrangler and git (a SOCKS proxy crashes wrangler).
set -euo pipefail
CLIENT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE="${MEMORY_PULSE_ENGINE:-$HOME/future-research/memory-pulse}"
noproxy() { env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy "$@"; }
cd "$CLIENT"

# A version is digits.digits.digits, with an optional pre-release suffix. "v1.2.3" or any other string is refused here: it used to be
# written into every manifest (second review, 2026-11-22).
if [ "${1:-}" != "" ] && ! printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'; then echo "not a version: $1 (expected 1.2.3 or 1.2.3-rc.1)"; exit 1; fi
if [ "${1:-}" != "" ]; then
  for f in package.json server.json .claude-plugin/plugin.json .codex-plugin/plugin.json mcpb/manifest.json; do
    sed -i '' -E "s/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?\"/\"version\": \"$1\"/g" "$f"
  done
  # the docs pin the release a reader copies (test/manifests.test.js holds them to package.json)
  for f in README.md docs/GUIDE.md docs/INSTALL.md; do
    sed -i '' -E "s/memory-pulse@[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?/memory-pulse@$1/g" "$f"
    # and the desktop extension's file name (INSTALL.md named memory-pulse-0.8.0.mcpb through 0.16.0)
    sed -i '' -E "s/memory-pulse-[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?\.mcpb/memory-pulse-$1.mcpb/g" "$f"
  done
fi
VERSION=$(node -p "require('./package.json').version")
# The version about to be tagged is the one that was asked for. A manifest the bump did not rewrite used to pass every later
# step, because each manifest was equally stale (review 2026-11-21, A-6).
if [ "${1:-}" != "" ] && [ "$VERSION" != "$1" ]; then echo "asked for $1 but package.json reads $VERSION: the bump did not take; nothing was tagged or pushed"; exit 1; fi
echo "release: memory-pulse@$VERSION"

echo "1/4 test gate"
LOG="${TMPDIR:-/tmp}/mp-release-test.log"
node scripts/test.mjs > "$LOG" 2>&1 || true
grep -E "^ℹ fail 0$" "$LOG" > /dev/null || { echo "tests not green — see $LOG"; exit 1; }
grep -E "^ℹ (tests|pass|fail)" "$LOG" | tr '\n' ' '; echo

echo "1b/4 IP gate over exactly the npm pack file list (fails closed; a missing gate is a failure)"
IPGATE="$HOME/.config/opencode/tools/ip-gate.mjs"
[ -f "$IPGATE" ] || { echo "ip-gate not found at $IPGATE"; exit 1; }
noproxy node "$HOME/.config/opencode/tools/ip-gate.mjs" --publish --strict >"${TMPDIR:-/tmp}/mp-release-ipgate.log" 2>&1 || { grep -E "Files scanned|GATE" "${TMPDIR:-/tmp}/mp-release-ipgate.log"; echo "IP gate failed: see the log; nothing was pushed"; exit 1; }
grep -E "Files scanned|GATE" "${TMPDIR:-/tmp}/mp-release-ipgate.log"

echo "2/4 version consistency"
for f in server.json .claude-plugin/plugin.json .codex-plugin/plugin.json mcpb/manifest.json; do
  grep -q "\"version\": \"$VERSION\"" "$f" || { echo "$f is not at $VERSION"; exit 1; }
done
if ! git diff --quiet || ! git diff --cached --quiet; then
  git add package.json server.json .claude-plugin/plugin.json .codex-plugin/plugin.json mcpb/manifest.json README.md docs/GUIDE.md docs/INSTALL.md
  git -c user.name="Travis Crew" -c user.email="travisaaroncrew@gmail.com" commit -q -m "release $VERSION" || true
fi

echo "3/4 pull request → merge → tag (main is protected: changes land through a PR; the tag triggers release.yml)"
BR="release/$VERSION"
git branch -f "$BR" HEAD > /dev/null
noproxy git push -f -u origin "$BR" > /dev/null
if ! noproxy gh pr view "$BR" > /dev/null 2>&1; then
  noproxy gh pr create --base main --head "$BR" --title "release $VERSION" --body "Automated release $VERSION via scripts/release.sh (tests green, manifests consistent)." > /dev/null
fi
# The pull request's checks (the suite on Linux and macOS, and Memory CI) finish before anything is merged. A release used to
# merge at once, so a failure on Linux first showed at tag time, after the tag was public.
echo "   waiting for the pull request's checks"
sleep 20
noproxy gh pr checks "$BR" --watch --interval 20 || { echo "a pull-request check failed or none ran: nothing was merged or tagged. See: gh pr checks $BR"; exit 1; }
noproxy gh pr merge "$BR" --merge --delete-branch > /dev/null
noproxy git fetch -q origin && git merge -q --ff-only origin/main || { echo "local main did not fast-forward to origin/main — resolve before tagging"; exit 1; }
git tag -f "v$VERSION" -m "memory-pulse $VERSION" > /dev/null
noproxy git push -f origin "v$VERSION"
# The docs tell teams to write `uses: t-crew/memory-pulse@v0`. Until 2026-11-21 nothing moved that tag, and it served 0.2.2
# for eleven weeks. The major tag follows every release.
MAJOR="${VERSION%%.*}"
case "$VERSION" in
  *-*) echo "   pre-release $VERSION: v$MAJOR stays where it is" ;;
  *) git tag -f "v$MAJOR" -m "memory-pulse $VERSION" > /dev/null
     noproxy git push -f origin "v$MAJOR" ;;
esac
if [ "${MP_LOCAL_PUBLISH:-}" = "1" ] && ! noproxy npm view "memory-pulse@$VERSION" version > /dev/null 2>&1; then
  echo "   local npm publish (approve npm's browser prompt once)"
  noproxy npm publish --access public
fi

if [ "${RELEASE_SKIP_WORKER:-}" = "1" ]; then
  echo "4/4 worker deploy skipped (RELEASE_SKIP_WORKER=1): the engine was not deployed"
  echo "released memory-pulse@$VERSION — tags v$VERSION and v$MAJOR pushed, worker not deployed"
else
  echo "4/4 worker deploy"
  ( cd "$ENGINE" && noproxy npx wrangler deploy 2>&1 | grep -E "Deployed|Current Version|error" )
  echo "released memory-pulse@$VERSION — tags v$VERSION and v$MAJOR pushed, worker deployed"
fi
