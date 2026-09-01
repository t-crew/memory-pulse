#!/usr/bin/env node
/**
 * memory-pulse GitHub Action runner — the PR status check.
 *
 * Runs `memory-pulse check --ci` over the ADDED lines of a pull request and
 * turns the verdict into a check conclusion and one sticky PR comment:
 *
 *   blocked      → failure   (each hit cites the ledger line that retired the value)
 *   verified     → success   ("N memories checked, M corrections enforced")
 *   no_evidence  → neutral   never green: a badge on an empty evidence set is a lie
 *
 * Pure functions are exported and tested on fixtures; the GitHub API calls
 * are best-effort (a missing token degrades to the job's exit code and the
 * step summary — the verdict still lands, just with less decoration).
 *
 * Env (set by the composite action): GITHUB_TOKEN, GITHUB_REPOSITORY,
 * GITHUB_SHA, GITHUB_BASE_REF, GITHUB_EVENT_PATH, GITHUB_STEP_SUMMARY,
 * MP_ACTION_BASE (override the base ref), MP_ACTION_CLI (override the CLI).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const MARKER = "<!-- memory-pulse-check -->";

/** Added lines of a unified diff, as one text (what the change INTRODUCES). */
export function addedLines(diff) {
  return String(diff ?? "").split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");
}

/** Check-run conclusion for a verdict. no_evidence is NEUTRAL, never success. */
export function conclusionFor(verdict) {
  return verdict === "blocked" ? "failure" : verdict === "verified" ? "success" : "neutral";
}

/** Title line for the check-run / summary. States what was checked, not "passed". */
export function titleFor(result) {
  const c = result.checked ?? {};
  if (result.verdict === "blocked") return `memory-pulse: blocked — ${result.corrections?.length ?? 0} withdrawn value(s) reintroduced${result.invariants?.length ? `, ${result.invariants.length} invariant(s) hit` : ""}`;
  if (result.verdict === "verified") return `memory-pulse: verified — ${c.events ?? 0} memories checked, ${result.evidence?.length ?? 0} bear on this change, ${c.corrections ?? "?"} correction(s) enforced`;
  return `memory-pulse: no evidence — ${c.events ?? 0} memories checked, none bear on this change (not a pass)`;
}

/** The sticky comment body. Idempotent by MARKER; re-rendered, never appended. */
export function renderComment(result, { receiptId = null, sha = null } = {}) {
  const lines = [MARKER, `### ${titleFor(result)}`, ""];
  if (result.verdict === "blocked") {
    lines.push("This change writes back a value the ledger retired, or trips a declared invariant. The verdict cites the line that binds:");
    for (const r of result.reasons ?? []) if (!/^\d+ recorded event/.test(r)) lines.push(`- ${r}`);
    lines.push("", "Use the corrected value (a comparison naming both old and new goes through), record a new correction if the old one is wrong, or record an override with `memory-pulse guard allow \"<term>\" --path <prefix> \"<reason>\"` if this is a false block — overrides are counted.");
  } else if (result.verdict === "verified") {
    lines.push("Recorded events bear on this change and none is contradicted:");
    for (const e of (result.evidence ?? []).slice(0, 8)) lines.push(`- t${e.t} \`${e.cause}\` → \`${e.effect}\`${e.kind === "correction" ? " (correction)" : ""}`);
  } else {
    lines.push("The ledger has nothing recorded that bears on this change. That is reported as **no evidence**, not as a pass — nothing here is green on an empty evidence set.", "", "If this change carries a finding worth keeping, record it: `memory-pulse remember` (or the `remember` MCP tool).");
  }
  const foot = [];
  if (sha) foot.push(`commit \`${String(sha).slice(0, 12)}\``);
  if (receiptId) foot.push(`receipt \`${receiptId}\` (verify keyless at /v1/verify)`);
  if (result.lint) {
    const L = result.lint;
    lines.push("", `**Governance files** (lint): ${L.summary.files} checked — ${L.summary.blocked} blocked, ${L.summary.verified} verified, ${L.summary.noEvidence} no evidence`);
    for (const row of L.rows) if (row.verdict === "blocked") { lines.push(`- \`${row.file}\` — BLOCKED`); for (const reason of row.reasons) lines.push(`  - ${reason}`); }
    if (L.ledger?.unenforceableCorrections) lines.push(`- ${L.ledger.unenforceableCorrections} correction(s) carry no withdrawn terms and cannot be enforced`);
  }
  if (foot.length) lines.push("", `<sub>${foot.join(" · ")}</sub>`);
  return lines.join("\n");
}

/** Find the comment to update, by MARKER. */
export const findSticky = (comments) => (comments ?? []).find((c) => typeof c.body === "string" && c.body.includes(MARKER)) ?? null;

async function gh(path, { method = "GET", body } = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  const res = await fetch(`https://api.github.com${path}`, {
    method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28", "user-agent": "memory-pulse-action" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) { console.error(`github ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`); return null; }
  try { return JSON.parse(text); } catch { return null; }
}

export async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const base = process.env.MP_ACTION_BASE || process.env.GITHUB_BASE_REF || "";
  const cli = process.env.MP_ACTION_CLI || join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

  // Added lines of the PR (base...HEAD); on a push event with no base, the last commit.
  let diff = "";
  try {
    if (base) { try { execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", base], { stdio: "ignore" }); } catch { /* shallow checkout without the base is handled below */ }
      diff = execFileSync("git", ["diff", `origin/${base}...HEAD`, "--unified=0"], { encoding: "utf8" }); }
    else diff = execFileSync("git", ["diff", "HEAD~1", "--unified=0"], { encoding: "utf8" });
  } catch (err) { console.error(`could not compute the diff (${err.message}); checking the working tree instead`); diff = execFileSync("git", ["diff", "--unified=0"], { encoding: "utf8" }); }
  const text = addedLines(diff);

  let result;
  try {
    const out = execFileSync(process.execPath, [cli, "check", "--ci", "--json", "--kind", "edit", "--path", "pull-request"], { input: text, encoding: "utf8", env: { ...process.env } });
    result = JSON.parse(out);
  } catch (e) {
    // check exits non-zero on blocked / no_evidence; the JSON is still on stdout.
    try { result = JSON.parse(String(e.stdout)); } catch { console.error(String(e.stderr || e.message)); process.exit(1); }
  }
  // Lint: the governance files a session will load, checked the same way.
  // A rule that still states a retired value is loaded into every session
  // with full confidence — that is worse than a stale line in the diff.
  let lint = null;
  if (String(process.env.MP_ACTION_LINT ?? "true") !== "false") {
    try { lint = JSON.parse(execFileSync(process.execPath, [cli, "lint", "--json"], { encoding: "utf8", env: { ...process.env } })); }
    catch (e) { try { lint = JSON.parse(String(e.stdout)); } catch { console.error(`lint failed: ${String(e.stderr || e.message).slice(0, 200)}`); } }
    if (lint?.summary?.blocked) {
      result.verdict = "blocked";
      for (const row of lint.rows.filter((x) => x.verdict === "blocked")) for (const reason of row.reasons) result.reasons = [...(result.reasons ?? []), `governance file ${row.file}: ${reason}`];
    }
    result.lint = lint;
  }
  const conclusion = conclusionFor(result.verdict);
  const title = titleFor(result);
  const receiptId = result.receipt?.head ? `${result.receipt.kind}:${result.receipt.head.slice(0, 12)}` : null;
  const body = renderComment(result, { receiptId, sha });
  console.log(title);
  for (const r of result.reasons ?? []) console.log(`  • ${r}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body.replace(MARKER, "") + "\n");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${result.verdict}\nconclusion=${conclusion}\n`);

  if (repo && process.env.GITHUB_TOKEN) {
    // Check run: the only way to say NEUTRAL (an exit code can only fail or pass).
    if (sha) await gh(`/repos/${repo}/check-runs`, { method: "POST", body: { name: "memory-pulse", head_sha: sha, status: "completed", conclusion, output: { title, summary: body.replace(MARKER, "").slice(0, 60000) } } });
    // Sticky comment on the PR, updated in place.
    let prNumber = null;
    try { prNumber = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).pull_request?.number ?? null; } catch { /* not a PR event */ }
    if (prNumber) {
      const existing = findSticky(await gh(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`));
      if (existing) await gh(`/repos/${repo}/issues/comments/${existing.id}`, { method: "PATCH", body: { body } });
      else await gh(`/repos/${repo}/issues/${prNumber}/comments`, { method: "POST", body: { body } });
    }
  }
  // Exit code drives the job result: blocked fails; no_evidence is neutral in
  // the check-run and does NOT fail the job (it is loud, not fatal).
  process.exit(result.verdict === "blocked" ? 2 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
