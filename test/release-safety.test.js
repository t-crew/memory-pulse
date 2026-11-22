// Two ways a release or a test run could damage something, both found by the independent review of 2026-11-21 and reproduced here first:
//   T-1  the suite wrote into whatever ledger the shell's MEMORY_PULSE_LEDGER named (5 rows and a quarantine folder in a decoy). The
//        test script and the release gate now run the suite through scripts/test.mjs, which clears those variables.
//   A-6  release.sh could not leave a pre-release version (the bump pattern did not match "1.0.0-rc.1", so "release.sh 1.0.0" re-tagged
//        the candidate), never compared its argument with the version it was about to tag, and moved the major tag onto a pre-release.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const ESTATE = ["MEMORY_PULSE_LEDGER", "MP_LEDGER", "MEMORY_PULSE_PROJECT", "MEMORY_PULSE_BOARD", "MEMORY_PULSE_KEY"];

test("T-1: scripts/test.mjs runs test files with the shell's ledger, project, board and key variables cleared", () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-test-env-"));
  const probe = join(dir, "probe.test.js");
  writeFileSync(probe, `import { test } from "node:test"; import assert from "node:assert/strict";\ntest("no estate variable reaches a test", () => { for (const k of ${JSON.stringify(ESTATE)}) assert.equal(process.env[k], undefined, k); });\n`);
  const decoy = Object.fromEntries(ESTATE.map((k) => [k, join(dir, "decoy", k)]));
  // a test runner started from inside a test file reports to its parent unless this variable is gone; the probe must run on its own
  const outer = { ...process.env }; delete outer.NODE_TEST_CONTEXT;
  const direct = spawnSync(process.execPath, ["--test", probe], { encoding: "utf8", env: { ...outer, ...decoy } });
  assert.notEqual(direct.status, 0, "the probe must fail when the variables are set, or it proves nothing");
  const through = spawnSync(process.execPath, [join(ROOT, "scripts", "test.mjs"), probe], { encoding: "utf8", env: { ...outer, ...decoy } });
  assert.equal(through.status, 0, through.stdout + through.stderr);
});

test("T-1: npm test and the release gate both go through scripts/test.mjs", () => {
  assert.equal(JSON.parse(read("package.json")).scripts.test, "node scripts/test.mjs");
  const sh = read("scripts/release.sh").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.match(sh, /node scripts\/test\.mjs > "\$LOG"/);
  assert.doesNotMatch(sh, /node --test test\/\*\.test\.js/);
});

// The version block of release.sh, cut out unchanged and run on copies of the manifests and docs.
function bump(arg, prep) {
  const sh = read("scripts/release.sh");
  const from = sh.indexOf('if [ "${1:-}" != "" ]; then'), to = sh.indexOf('echo "1/4 test gate"');
  assert.ok(from > 0 && to > from, "the version block is where this test expects it");
  const dir = mkdtempSync(join(tmpdir(), "mp-release-bump-"));
  for (const f of ["package.json", "server.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "mcpb/manifest.json", "README.md", "docs/GUIDE.md", "docs/INSTALL.md"]) { mkdirSync(dirname(join(dir, f)), { recursive: true }); copyFileSync(join(ROOT, f), join(dir, f)); }
  prep?.(dir);
  const run = (a) => spawnSync("bash", ["-c", `set -euo pipefail\n${sh.slice(from, to)}`, "release.sh", a], { cwd: dir, encoding: "utf8" });
  return { dir, run, first: run(arg), version: () => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version };
}

// release.sh is run on the maintainer's Mac and edits files with BSD sed (sed -i ''); these two run its version block, so they run there only.
const MAC = { skip: process.platform === "darwin" ? false : "scripts/release.sh uses BSD sed" };
test("A-6: a pre-release version can be set and then left: 1.0.0-rc.1, then 1.0.0, in every manifest and in the docs' pins", MAC, () => {
  const b = bump("1.0.0-rc.1");
  assert.equal(b.first.status, 0, b.first.stdout + b.first.stderr);
  assert.equal(b.version(), "1.0.0-rc.1");
  const next = b.run("1.0.0");
  assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.equal(b.version(), "1.0.0");
  for (const f of ["server.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "mcpb/manifest.json"]) assert.match(readFileSync(join(b.dir, f), "utf8"), /"version": "1\.0\.0"/, f);
  for (const f of ["README.md", "docs/GUIDE.md", "docs/INSTALL.md"]) assert.doesNotMatch(readFileSync(join(b.dir, f), "utf8"), /memory-pulse@[0-9.]+-rc/, `${f} still pins a release candidate`);
});

test("A-6: the release stops when the version it would tag is not the version it was asked for", MAC, () => {
  const b = bump("2.0.0", (dir) => { const p = join(dir, "package.json"); writeFileSync(p, readFileSync(p, "utf8").replace(/"version": "[^"]+"/, '"version": "not-a-version"')); });
  assert.notEqual(b.first.status, 0, "a manifest the bump cannot rewrite must stop the release");
  assert.match(b.first.stdout + b.first.stderr, /asked for 2\.0\.0/);
});

test("A-6: the major tag is not moved for a pre-release", () => {
  const sh = read("scripts/release.sh").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const guard = sh.search(/case "\$VERSION" in\s*\n?\s*\*-\*\)/), move = sh.search(/git tag -f "v\$MAJOR"/);
  assert.ok(guard > 0 && move > guard && move - guard < 500, "the v$MAJOR move sits behind a pre-release test");
});

test("the release waits for the pull request's checks before it merges, and stops when one fails", () => {
  const sh = read("scripts/release.sh").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const create = sh.indexOf("gh pr create"), watch = sh.search(/gh pr checks "\$BR" --watch/), merge = sh.indexOf("gh pr merge");
  assert.ok(create > 0 && watch > create && merge > watch, "create, then wait for the checks, then merge");
  assert.match(sh.slice(watch, merge), /exit 1/, "a failed check stops the release before the merge");
});

test("the release gate runs the IP gate in strict mode", () => {
  assert.match(read("scripts/release.sh"), /ip-gate\.mjs" --publish --strict/);
});
