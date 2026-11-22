// The pull-request check, file by file. Findings of the independent review of 2026-11-21 (A-1 to A-4), each reproduced here first:
//   A-1  a pull request that only records a correction, or declares a rule, failed its own check: the ledger's and the rules' own
//        lines were checked as if they were the change. Each file is now checked under its own path, and the rule folder is not content.
//   A-2  a pull request could switch enforcement off in the same change that broke it (a superseding row, an override, a pack rule
//        turned off) and the check said "verified" or "no evidence". A pull request that changes the rules is judged by the base
//        branch's rules as well as its own, and the comment says so.
//   A-3  when the diff could not be read, nothing was checked and the job passed. It now fails and says the change could not be read.
//   A-4  the runner fetched the base with --depth=1 and left a full clone shallow.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), "mp-action-perfile-home-"));
const clean = (extra = {}) => { const e = { ...process.env, HOME, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x", GIT_CONFIG_GLOBAL: join(HOME, "gitconfig"), ...extra }; for (const k of ["MEMORY_PULSE_KEY", "MP_LEDGER", "MEMORY_PULSE_PROJECT", "MEMORY_PULSE_BOARD", "MEMORY_PULSE_LEDGER"]) if (!(k in extra)) delete e[k]; return e; };

// A repository whose main holds `base` (a function that prepares it) and whose branch `change` holds what `change` adds.
function repo(base, change) {
  const dir = mkdtempSync(join(tmpdir(), "mp-action-perfile-"));
  const led = join(dir, ".memory-pulse", "events.jsonl");
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: clean() });
  const cli = (...a) => execFileSync(process.execPath, [join(ROOT, "server.mjs"), ...a], { cwd: dir, encoding: "utf8", env: clean({ MEMORY_PULSE_LEDGER: led }), stdio: ["ignore", "pipe", "pipe"] });
  const write = (name, body) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), body); };
  const ctx = { dir, led, git, cli, write };
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, ".memory-pulse"));
  write("README.md", "# project\n");
  cli("remember", "project-started", "ledger-opened", "--note", "first row");
  base?.(ctx);
  git("add", "-A"); git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-q", "-b", "change");
  change(ctx);
  git("add", "-A"); git("commit", "-q", "-m", "change");
  return ctx;
}
function run(ctx, env = {}) {
  const summary = join(ctx.dir, "summary.md"); writeFileSync(summary, "");
  const e = clean({ GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: summary, MEMORY_PULSE_LEDGER: ctx.led, GITHUB_TOKEN: "", GITHUB_REPOSITORY: "", MP_ACTION_LINT: "false", ...env });
  try { const out = execFileSync(process.execPath, [join(ROOT, "action", "run.mjs")], { cwd: ctx.dir, encoding: "utf8", env: e, stdio: ["ignore", "pipe", "pipe"] }); return { code: 0, out, summary: readFileSync(summary, "utf8") }; }
  catch (x) { return { code: x.status, out: String(x.stdout) + String(x.stderr), summary: readFileSync(summary, "utf8") }; }
}
const price = (c) => c.cli("remember", "pricing-shipped", "price-corrected", "--kind", "correction", "--withdrawn", "$49", "--replacement", "$29");

test("A-1: a pull request that only records a prohibition does not fail its own check", () => {
  const c = repo(null, (x) => x.cli("remember", "we-use-pnpm", "npm-install-banned", "--kind", "correction", "--withdrawn", "npm install"));
  const r = run(c);
  assert.equal(r.code, 0, r.out + r.summary);
  assert.doesNotMatch(r.summary, /blocked this change/);
});

test("A-1: a pull request that only declares a rule does not trip that rule", () => {
  const c = repo(null, (x) => x.write(".memory-pulse/invariants.jsonl", JSON.stringify({ id: "no-legacy-auth", statement: "legacyAuth( is gone; use session()", patterns: ["legacyAuth("], severity: "block" }) + "\n"));
  const r = run(c);
  assert.equal(r.code, 0, r.out + r.summary);
  assert.doesNotMatch(r.summary, /blocked this change/);
});

test("each file is checked under its own path: an override for docs/history/ lets the old value stand there and nowhere else", () => {
  const base = (x) => { price(x); x.cli("guard", "allow", "$49", "--path", "docs/history/", "the old price list is history"); };
  const inside = run(repo(base, (x) => x.write("docs/history/prices.md", "In 2025 the plan was $49 a month.\n")));
  assert.equal(inside.code, 0, inside.out + inside.summary);
  const outside = run(repo(base, (x) => x.write("src/pricing.md", "The plan is $49 a month.\n")));
  assert.equal(outside.code, 2, outside.out + outside.summary);
  assert.match(outside.summary, /src\/pricing\.md/);
});

test("A-2: a pull request that writes a withdrawn value back and supersedes the correction in the same change is blocked under the base branch's rules, and the comment says the rules changed", () => {
  const change = (x) => { x.write("pricing.md", "Pro is $49 a month.\n"); x.cli("remember", "pricing-reviewed", "price-49-stands", "--kind", "correction", "--supersedes", "2", "--note", "back to the old price"); };
  const c = repo(price, change);
  const r = run(c);
  assert.equal(r.code, 2, r.out + r.summary);
  assert.match(r.summary, /changes the rules it is checked by/);
  assert.match(r.summary, /\.memory-pulse\/events\.jsonl/);
  assert.match(r.summary, /rules on `main`/);
  // a team that wants rule changes and content in one step says so, and the comment still names the change
  const head = run(c, { MP_ACTION_RULES: "head" });
  assert.equal(head.code, 0, head.out + head.summary);
  assert.match(head.summary, /changes the rules it is checked by/);
  assert.match(head.summary, /its own rules only/);
});

test("A-2: adding a correction without loosening anything is judged the same under both sets of rules", () => {
  const c = repo(price, (x) => { x.write("notes.md", "Pro is $29 a month.\n"); x.cli("remember", "region-chosen", "region-moved", "--kind", "correction", "--withdrawn", "us-east-1", "--replacement", "eu-west-2"); });
  const r = run(c);
  assert.equal(r.code, 0, r.out + r.summary);
  assert.match(r.summary, /changes the rules it is checked by/);
});

test("A-3: when the base branch is not in the checkout the check fails and says the change could not be read", () => {
  const c = repo(price, (x) => x.write("pricing.md", "Pro is $49 a month.\n"));
  const r = run(c, { GITHUB_BASE_REF: "no-such-branch" });
  assert.equal(r.code, 1, r.out + r.summary);
  assert.match(r.summary, /could not read this change/);
  assert.match(r.summary, /Nothing was checked/);
  assert.doesNotMatch(r.summary, /no evidence/);
});

test("A-4: the runner leaves a full clone full", () => {
  const origin = mkdtempSync(join(tmpdir(), "mp-action-origin-"));
  const c = repo(price, (x) => x.write("notes.md", "Pro is $29 a month.\n"));
  execFileSync("git", ["clone", "-q", "--bare", c.dir, origin], { env: clean() });
  c.git("remote", "add", "origin", origin); c.git("fetch", "-q", "origin");
  const before = c.git("rev-list", "--count", "origin/main").trim();
  const r = run(c);
  assert.equal(r.code, 0, r.out + r.summary);
  assert.equal(c.git("rev-parse", "--is-shallow-repository").trim(), "false");
  assert.equal(c.git("rev-list", "--count", "origin/main").trim(), before);
});
