// The pull-request check runs the installed rule packs file by file. The ledger check runs under one path ("pull-request"), so a
// pack rule scoped to **/*.py never fired there: a block the guard gives in the editor was missing on the pull request.
// Added 2026-11-21 (red first).
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// A repository with the python-stdlib pack installed (or none) and a branch that adds `files`.
function repo(files, { pack = true, block = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mp-action-packs-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, ".memory-pulse", "packs"), { recursive: true });
  writeFileSync(join(dir, ".memory-pulse", "events.jsonl"), JSON.stringify({ t: 1, cause: "project-started", effect: "ledger-opened", note: "first row" }) + "\n");
  if (pack) copyFileSync(join(ROOT, "packs", "python-stdlib.jsonl"), join(dir, ".memory-pulse", "packs", "python-stdlib.jsonl"));
  // a pack never blocks by default (review of 0.19.0): the project commits the choice that turns blocking on, as pack add --block writes it
  if (pack && block) writeFileSync(join(dir, ".memory-pulse", "packs", "overrides.jsonl"), JSON.stringify({ rule: "python-stdlib/*", severity: "block" }) + "\n");
  writeFileSync(join(dir, "README.md"), "# project\n");
  git("add", "-A"); git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-q", "-b", "change");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  git("add", "-A"); git("commit", "-q", "-m", "change");
  return dir;
}
function run(dir) {
  const summary = join(dir, "summary.md"); writeFileSync(summary, "");
  const env = { ...process.env, GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: summary, MEMORY_PULSE_LEDGER: join(dir, ".memory-pulse", "events.jsonl"), GITHUB_TOKEN: "", GITHUB_REPOSITORY: "", MP_ACTION_LINT: "false", MEMORY_PULSE_KEY: "" };
  try { const out = execFileSync(process.execPath, [join(ROOT, "action", "run.mjs")], { cwd: dir, encoding: "utf8", env }); return { code: 0, out, summary: readFileSync(summary, "utf8") }; }
  catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr), summary: readFileSync(summary, "utf8") }; }
}

const REMOVED = "import unittest\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEquals(1, 1)\n";
const DEPRECATED = "from datetime import datetime\nnow = datetime.utcnow()\n";

test("a pull request that adds a line a pack rule blocks fails the check, and the summary names the rule, the file and the line", () => {
  const asInstalled = run(repo({ "test_a.py": REMOVED }));
  assert.equal(asInstalled.code, 0, "as installed, the rule is a warning and the check passes"); assert.match(asInstalled.summary, /python-stdlib\/unittest-aliases/);
  const r = run(repo({ "test_a.py": REMOVED }, { block: true }));
  assert.equal(r.code, 2, r.out);
  assert.match(r.summary, /memory-pulse blocked this change/);
  assert.match(r.summary, /python-stdlib\/unittest-aliases/);
  assert.match(r.summary, /test_a\.py:4/);
});

test("a pack warning does not fail the check; it is listed in the summary", () => {
  const r = run(repo({ "clock.py": DEPRECATED }));
  assert.equal(r.code, 0, r.out);
  assert.match(r.summary, /Rule packs/);
  assert.match(r.summary, /python-stdlib\/datetime-utcnow/);
  assert.match(r.summary, /clock\.py:2/);
});

test("a rule scoped to Python files does not fire on the same text in a Markdown file", () => {
  const r = run(repo({ "notes.md": "We used to call self.assertEquals(1, 1) here.\n" }));
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.summary, /unittest-aliases/);
});

test("with no pack installed the summary has no rule-pack section and the verdict is the ledger's", () => {
  const r = run(repo({ "test_a.py": REMOVED }, { pack: false }));
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.summary, /Rule packs/);
});
