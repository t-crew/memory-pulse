/**
 * The GitHub Action: pure functions on fixtures, then an end-to-end run
 * against a fixture repo (base branch + PR branch that reintroduces a
 * withdrawn value) with no GitHub API — the verdict must land through the
 * exit code and the step summary alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addedLines, conclusionFor, titleFor, renderComment, findSticky, MARKER } from "../action/run.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

test("addedLines keeps only what the change introduces", () => {
  const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old $49\n+new $29\n+still $49 here\n";
  assert.equal(addedLines(diff), "new $29\nstill $49 here");
  assert.equal(addedLines(""), "");
});

test("verdict → conclusion: blocked fails, verified succeeds, no_evidence is NEUTRAL (never green)", () => {
  assert.equal(conclusionFor("blocked"), "failure");
  assert.equal(conclusionFor("verified"), "success");
  assert.equal(conclusionFor("no_evidence"), "neutral");
  assert.equal(conclusionFor("anything-else"), "neutral");
});

test("titles state what was checked, not 'passed'", () => {
  assert.match(titleFor({ verdict: "verified", checked: { events: 12, corrections: 3 }, evidence: [{}, {}] }), /12 memories checked, 2 bear on this change, 3 correction\(s\) enforced/);
  assert.match(titleFor({ verdict: "no_evidence", checked: { events: 12 } }), /no evidence — 12 memories checked, none bear on this change \(not a pass\)/);
  assert.match(titleFor({ verdict: "blocked", corrections: [{}], invariants: [{ id: "x" }] }), /blocked — 1 withdrawn value\(s\) reintroduced, 1 invariant\(s\) hit/);
});

test("renderComment carries the marker, the citations, and the receipt; findSticky locates it", () => {
  const blocked = renderComment({ verdict: "blocked", corrections: [{ t: 3 }], reasons: ['"$49" was withdrawn at ledger t3: churn -> corrected — use $29', "1 recorded event(s) bear on this edit"] }, { receiptId: "check:abc123def456", sha: "0123456789abcdef" });
  assert.ok(blocked.startsWith(MARKER));
  assert.match(blocked, /withdrawn at ledger t3/);
  assert.ok(!blocked.includes("recorded event(s) bear"), "the verified-count line is not repeated on a block");
  assert.match(blocked, /guard allow/);
  assert.match(blocked, /receipt `check:abc123def456`/);
  assert.match(blocked, /commit `0123456789ab`/);
  const ne = renderComment({ verdict: "no_evidence", checked: { events: 4 } });
  assert.match(ne, /not as a pass/);
  assert.equal(findSticky([{ id: 1, body: "hello" }, { id: 2, body: blocked }]).id, 2);
  assert.equal(findSticky([{ id: 1, body: "hello" }]), null);
  assert.equal(findSticky(null), null);
});

test("e2e: a PR that reintroduces a withdrawn value fails the action with the citation in the step summary; a benign PR does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-action-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, ".memory-pulse"));
  writeFileSync(join(dir, ".memory-pulse", "events.jsonl"), [
    JSON.stringify({ t: 1, cause: "pricing-survey", effect: "wtp-measured", note: "$49" }),
    JSON.stringify({ t: 2, cause: "wtp-measured", effect: "price-corrected", kind: "correction", withdrawn: ["$49"], replacement: ["$29"] }),
  ].join("\n") + "\n");
  writeFileSync(join(dir, "pricing.md"), "# Pricing\n\nPro is $29/mo.\n");
  git("add", "-A"); git("commit", "-q", "-m", "base");
  // Simulate origin/main for the diff.
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-q", "-b", "pr");
  writeFileSync(join(dir, "pricing.md"), "# Pricing\n\nPro is $49/mo.\n");
  git("commit", "-q", "-am", "reintroduce");
  // The step summary lives OUTSIDE the repo: writing it inside made the next
  // commit sweep the previous verdict (with its slugs) into the diff.
  const summary = join(mkdtempSync(join(tmpdir(), "mp-summary-")), "summary.md");
  const run = () => { try { return { code: 0, out: execFileSync(process.execPath, [join(ROOT, "action", "run.mjs")], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: summary, MEMORY_PULSE_LEDGER: join(dir, ".memory-pulse", "events.jsonl"), GITHUB_TOKEN: "", GITHUB_REPOSITORY: "" } }) }; } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } };
  const blocked = run();
  assert.equal(blocked.code, 2, blocked.out);
  assert.match(blocked.out, /memory-pulse: blocked — 1 withdrawn value/);
  assert.match(readFileSync(summary, "utf8"), /withdrawn at ledger t2/);
  // Benign PR: a comparison that names the replacement.
  writeFileSync(join(dir, "pricing.md"), "# Pricing\n\nPro was $49/mo; it is $29/mo now.\n");
  git("commit", "-q", "-am", "comparison");
  writeFileSync(summary, "");
  const ok = run();
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /memory-pulse: verified/);
  // A PR the ledger knows nothing about: neutral, exit 0, and the summary says so.
  writeFileSync(join(dir, "other.md"), "unrelated prose\n");
  git("add", "-A"); git("commit", "-q", "-m", "unrelated");
  writeFileSync(join(dir, "pricing.md"), "# Pricing\n\nPro is $29/mo.\n"); git("commit", "-q", "-am", "revert pricing to base");
  writeFileSync(summary, "");
  const ne = run();
  assert.equal(ne.code, 0);
  assert.match(ne.out, /memory-pulse: no evidence/);
  assert.match(readFileSync(summary, "utf8"), /not as a pass/);
});

test("e2e lint: a governance file that still states a withdrawn value fails the action even when the diff is benign; the summary names the file; lint off leaves the verdict to the diff", () => {
  const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const dir = mkdtempSync(join(tmpdir(), "mp-action-lint-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, ".memory-pulse"), { recursive: true });
  writeFileSync(join(dir, ".memory-pulse", "events.jsonl"), JSON.stringify({ t: 1, cause: "pricing-shipped", effect: "price-corrected", kind: "correction", withdrawn: ["$49"], replacement: ["$29"] }) + "\n");
  writeFileSync(join(dir, "CLAUDE.md"), "Always quote the price as $49.\n");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git("add", "."); git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "README.md"), "hello\nnothing the ledger knows\n");
  git("commit", "-q", "-am", "benign");
  const summary = join(dir, "summary.md");
  const run = (lint) => { writeFileSync(summary, ""); try { return { code: 0, out: execFileSync(process.execPath, [join(ROOT, "action", "run.mjs")], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: summary, MEMORY_PULSE_LEDGER: join(dir, ".memory-pulse", "events.jsonl"), GITHUB_TOKEN: "", GITHUB_REPOSITORY: "", MP_ACTION_LINT: lint } }) }; } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } };
  const off = run("false");
  assert.equal(off.code, 0, "benign diff, lint off → not blocked");
  const on = run("true");
  assert.equal(on.code, 2, "lint on → the stale CLAUDE.md blocks the PR");
  const s = readFileSync(summary, "utf8");
  assert.match(s, /CLAUDE\.md/, "the summary names the governance file");
  assert.match(s, /"\$49" was withdrawn at ledger t1/, "and cites the ledger line");
  assert.match(on.out, /governance/i);
});
