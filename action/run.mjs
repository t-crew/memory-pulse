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
import { readFileSync, appendFileSync, existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import { addedLines } from "../lib/diff.mjs";

export const MARKER = "<!-- memory-pulse-check -->";

// Added lines of a unified diff (lib/diff.mjs): headers are skipped by position, so an added line that begins with ++ is read.
export { addedLines };

/** Check-run conclusion for a verdict. no_evidence is NEUTRAL, never success. */
export function conclusionFor(verdict) {
  return verdict === "blocked" ? "failure" : verdict === "verified" ? "success" : "neutral";
}

/** Title line for the check-run / summary. States what was checked, not "passed". */
export function titleFor(result) {
  const c = result.checked ?? {};
  const packBlocks = new Set((result.packs?.hits ?? []).filter((h) => h.severity === "block").map((h) => h.rule)).size;
  if (result.verdict === "blocked") return `memory-pulse blocked this change. ${result.corrections?.length ?? 0} withdrawn value(s) reintroduced${result.invariants?.length ? `, ${result.invariants.length} invariant(s) hit` : ""}${packBlocks ? `, ${packBlocks} rule-pack rule(s) hit` : ""}`;
  if (result.verdict === "verified") return `memory-pulse verified this change. ${c.events ?? 0} memories checked, ${result.evidence?.length ?? 0} bear on this change, ${c.corrections ?? "?"} correction(s) enforced`;
  return `memory-pulse found no evidence. ${c.events ?? 0} memories checked, none bear on this change (not a pass)`;
}

/** A receipt is asked for only when the workflow passed a key (the api-key input). */
export function wantsReceipt(env = process.env) { return Boolean(String(env.MEMORY_PULSE_KEY ?? "").trim()); }

/** The sticky comment body. Idempotent by MARKER; re-rendered, never appended. */
export function renderComment(result, { receiptId = null, sha = null, receiptNote = null } = {}) {
  const lines = [MARKER, `### ${titleFor(result)}`, ""];
  if (result.rulesChanged?.length) {
    const files = result.rulesChanged.map((f) => `\`${f}\``).join(", ");
    lines.push(`**This pull request changes the rules it is checked by**: ${files}. ${result.rulesMode === "head"
      ? "It was judged by its own rules only (`rules: head`)."
      : result.rulesBase ? `It was judged by the rules on \`${result.rulesBase}\` as well as its own, and the stricter verdict stands${result.blockedUnderBase ? ": its own rules would have let it through" : ""}.` : "There are no earlier rules to judge it by."}`, "");
  }
  if (result.verdict === "blocked") {
    lines.push("This change writes back a value the ledger retired, or trips a declared invariant. The verdict cites the line that binds.");
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
  if (receiptNote) foot.push(receiptNote);
  if (result.lint) {
    const L = result.lint;
    lines.push("", `**Governance files** (lint): ${L.summary.files} checked — ${L.summary.blocked} blocked, ${L.summary.verified} verified, ${L.summary.noEvidence} no evidence`);
    for (const row of L.rows) if (row.verdict === "blocked") { lines.push(`- \`${row.file}\` — BLOCKED`); for (const reason of row.reasons) lines.push(`  - ${reason}`); }
    if (L.ledger?.unenforceableCorrections) lines.push(`- ${L.ledger.unenforceableCorrections} correction(s) carry no withdrawn terms and cannot be enforced`);
  }
  if (result.packs) {
    const P = result.packs, hits = P.hits ?? [];
    lines.push("", `**Rule packs**: ${(P.rules ?? []).length} installed rule(s) checked over the added lines of ${P.files ?? 0} file(s) — ${P.block ?? 0} blocked, ${P.warn ?? 0} warning(s)`);
    for (const h of hits.slice(0, 20)) lines.push(`- ${h.severity === "block" ? "BLOCKED" : "warning"} \`${h.rule}\` at \`${h.file}:${h.line}\`: \`${String(h.text ?? "").trim().slice(0, 120)}\``);
    if (hits.length > 20) lines.push(`- and ${hits.length - 20} more; run \`memory-pulse pack check --installed --diff <base>\` for all of them`);
    if (hits.length) lines.push("", "A pack rule is changed for this project with `memory-pulse pack rule <pack>/<rule> off|warn|block`, without editing the pack. `memory-pulse pack show <pack>` gives each rule's source.");
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

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const git = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" }, ...opts });
const revExists = (ref) => { try { git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]); return true; } catch { return false; } };

/**
 * The range a change is read over, or the reason it cannot be read. There is no fallback to the working tree: a change that
 * cannot be read is a failure, never an empty diff reported as "nothing bears on this" (review 2026-11-21, A-3). The base is
 * fetched only when it is missing and never with --depth, which used to leave a full clone shallow (A-4).
 */
export function changeRange(base) {
  if (base) {
    const ref = `origin/${base}`;
    if (!revExists(ref)) { try { git(["fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`]); } catch { /* said below */ } }
    if (!revExists(ref)) return { error: `the base branch ${ref} is not in this checkout and could not be fetched` };
    try { git(["merge-base", ref, "HEAD"]); } catch { return { error: `${ref} and HEAD share no history in this checkout. With actions/checkout, set fetch-depth: 0` }; }
    return { range: `${ref}...HEAD`, baseRef: ref, baseName: base };
  }
  if (revExists("HEAD~1")) return { range: "HEAD~1..HEAD", baseRef: "HEAD~1", baseName: "the previous commit" };
  let shallow = "false"; try { shallow = git(["rev-parse", "--is-shallow-repository"]).trim(); } catch { /* not a repository: said by the next git call */ }
  if (shallow === "true") return { error: "the previous commit is not in this shallow checkout. With actions/checkout, set fetch-depth: 0" };
  return { range: `${EMPTY_TREE}..HEAD`, baseRef: null, baseName: null };   // the first commit of a repository
}

// One check as its own process, without blocking: stdout is the JSON verdict whatever the exit status.
const runCheck = (cli, args, input, env) => new Promise((done, fail) => {
  const p = spawn(process.execPath, [cli, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", (c) => { out += c; }); p.stderr.on("data", (c) => { err += c; });
  p.on("error", fail);
  p.on("close", () => { try { done(JSON.parse(out)); } catch { fail(new Error(err.split("\n").find((l) => l.trim()) ?? "check printed nothing")); } });
  p.stdin.on("error", () => { /* the check may exit before it has read everything */ });
  p.stdin.end(input);
});
export const CHECKS_AT_ONCE = 8;

/**
 * The ledger check, one file at a time, each under its own path (review 2026-11-21, A-1). A path scope (`paths` on a rule, the
 * prefix of a `guard allow`) means something only when the check is told which file a line is in; under the single path
 * "pull-request" none of them could apply. Files are checked CHECKS_AT_ONCE at a time: one after another, a pull request of
 * 1,000 files took over two minutes. Returns one verdict: blocked if any file is, else verified if any is, else no evidence.
 */
export async function checkFiles(cli, files, range, env) {
  const out = { verdict: "no_evidence", reasons: [], evidence: [], corrections: [], invariants: [], checked: null, files: 0 };
  const seen = { evidence: new Set(), corrections: new Set(), invariants: new Set() };
  const add = (key, items) => { for (const x of items ?? []) { const k = JSON.stringify(x); if (!seen[key].has(k)) { seen[key].add(k); out[key].push(x); } } };
  const one = (text, path) => runCheck(cli, ["check", "--ci", "--json", "--kind", "edit", "--path", path], text, env);
  const unreadable = (r) => { if (r.verdict === "unreadable") throw new Error((r.reasons ?? [])[0] ?? "the ledger is in a layout this client cannot read"); return r; };
  const results = new Array(files.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CHECKS_AT_ONCE, files.length) }, async () => {
    for (;;) {
      const i = next++; if (i >= files.length) return;
      const text = addedLines(git(["diff", range, "--unified=0", "--", files[i]]));
      if (text.trim()) results[i] = unreadable(await one(text, files[i]));
    }
  }));
  results.forEach((r, i) => {   // folded in the files' own order, so the comment reads the same on every run
    if (!r) return;
    const f = files[i];
    out.files++; out.checked ??= r.checked ?? null;
    if (r.verdict === "blocked") { out.verdict = "blocked"; for (const x of r.reasons ?? []) if (!/^\d+ recorded event/.test(x)) out.reasons.push(`\`${f}\`: ${x}`); }
    else if (r.verdict === "verified" && out.verdict !== "blocked") out.verdict = "verified";
    add("evidence", r.evidence); add("corrections", r.corrections); add("invariants", r.invariants);
  });
  if (!out.checked) out.checked = unreadable(await one("", "pull-request")).checked ?? null;   // how many memories there were to check, for the title
  return out;
}

/**
 * The rule files as they stand on the base, unpacked into a temporary folder: the rules a change is judged by before it changes
 * them. `paths` are the rule files by name (the ledger, the declared rules, the installed packs, the layout marker); the ones the
 * base does not have are left out. Returns the base ledger's path there, or null when the base has none of them.
 */
function baseRules(baseRef, ledgerRel, paths) {
  if (!baseRef) return null;
  const there = paths.filter((p) => { try { git(["cat-file", "-e", `${baseRef}:${p}`]); return true; } catch { return false; } });
  if (!there.length) return null;
  const tmp = mkdtempSync(join(tmpdir(), "mp-base-rules-"));
  execFileSync("tar", ["-x", "-C", tmp], { input: execFileSync("git", ["archive", "--format=tar", baseRef, "--", ...there], { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" } }) });
  return join(tmp, ledgerRel);
}

function packCheck(cli, baseRef, env) {
  try { return JSON.parse(execFileSync(process.execPath, [cli, "pack", "check", "--installed", "--diff", baseRef ?? EMPTY_TREE, "--ci", "--json"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] })); }
  catch (e) { try { return JSON.parse(String(e.stdout)); } catch { if (e.status !== undefined) console.error(`rule packs were not checked: ${String(e.stderr || e.message).split("\n").find((l) => l.trim()) ?? "no output"}`); return null; } }
}

export async function main() {
  { const { wholeOutput } = await import("../lib/stdio.mjs"); wholeOutput(); }   // the job log arrives whole on a macOS runner
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const base = process.env.MP_ACTION_BASE || process.env.GITHUB_BASE_REF || "";
  const cli = process.env.MP_ACTION_CLI || join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

  // The change: which files, over which range. A change that cannot be read fails the job (A-3).
  const where = changeRange(base);
  if (where.error) {
    const body = `### memory-pulse could not read this change\n\n${where.error}. Nothing was checked, so this is a failure and not a pass.`;
    console.error(`memory-pulse could not read this change: ${where.error}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body + "\n");
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "verdict=unread\nconclusion=failure\n");
    process.exit(1);
  }
  const { range, baseRef, baseName } = where;
  const ledger = process.env.MEMORY_PULSE_LEDGER || ".memory-pulse/events.jsonl";
  // Which changed files are the rules and which are content (review 2026-11-22, N-A2): the rules are the ledger file, the declared
  // rules, the installed packs and the layout marker beside it, and everything under a folder named .memory-pulse. A file that
  // merely sits beside a ledger kept somewhere else (docs/events.jsonl) is content and is checked.
  // Both sides through realpath: on macOS a temp folder is /var/... to the shell and /private/var/... to process.cwd().
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const ledgerRel = relative(real(process.cwd()), join(real(dirname(resolve(ledger))), basename(ledger))).split("\\").join("/");
  const outside = ledgerRel.startsWith("..") || resolve(ledgerRel) === ledgerRel;
  const dirRel = dirname(ledgerRel) === "." ? "" : dirname(ledgerRel);
  const beside = (name) => (dirRel ? `${dirRel}/${name}` : name);
  const ruleFiles = [ledgerRel, beside("invariants.jsonl"), beside("layout.json")], ruleDirs = [beside("packs"), beside("rows")];
  if (basename(dirRel) === ".memory-pulse") ruleDirs.push(dirRel);
  const inRules = (f) => !outside && (ruleFiles.includes(f) || ruleDirs.some((d) => f.startsWith(`${d}/`)));
  // --no-renames: a ledger moved out of the way is a removal here, not a rename that hides it (N-A3)
  const names = (filter) => git(["diff", "--name-only", "-z", "--no-renames", `--diff-filter=${filter}`, range]).split("\0").filter(Boolean);
  const changed = names("d");                                   // every file the change leaves in the tree
  const content = changed.filter((f) => !inRules(f));           // the ledger and the rules are not content checked against themselves (A-1)
  const rulesChanged = [...changed.filter(inRules), ...names("D").filter(inRules).map((f) => `${f} (removed)`)];
  const text = content.map((f) => addedLines(git(["diff", range, "--unified=0", "--", f]))).filter((t) => t.trim()).join("\n");

  const unchecked = (why) => {
    console.error(`memory-pulse could not check this change: ${why}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### memory-pulse could not check this change\n\n${why}\n\nNothing was checked, so this is a failure and not a pass.\n`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "verdict=unchecked\nconclusion=failure\n");
    process.exit(1);
  };
  let result;
  try { result = await checkFiles(cli, content, range, { ...process.env }); }
  catch (e) { unchecked(String(e.message)); }

  // Rule packs, file by file, under each file's own path. With no pack installed the command prints a sentence, not JSON,
  // and nothing is added. A block here blocks the pull request; a warning is listed.
  const foldPacks = (res, packs, label = "") => {
    if (!packs || !Array.isArray(packs.hits)) return;
    if (!label) res.packs = packs;
    const blocks = packs.hits.filter((h) => h.severity === "block");
    if (blocks.length) {
      res.verdict = "blocked";
      for (const h of blocks.slice(0, 20)) res.reasons = [...(res.reasons ?? []), `${label}rule pack ${h.rule} at ${h.file}:${h.line}: ${String(h.text ?? "").trim().slice(0, 120)}`];
    }
  };
  foldPacks(result, packCheck(cli, baseRef, { ...process.env }));

  // A pull request that changes the rules is also judged by the rules on the base (A-2). A superseding row, an override, a pack
  // rule turned off or a deleted ledger used to turn a block into "verified" or "no evidence" in the same change that broke the
  // rule. The stricter verdict stands, and the comment names the files. MP_ACTION_RULES=head judges by the change's own rules only.
  const rulesMode = String(process.env.MP_ACTION_RULES || "both") === "head" ? "head" : "both";
  if (rulesChanged.length) {
    result.rulesChanged = rulesChanged; result.rulesMode = rulesMode; result.rulesBase = baseName;
    const baseLedger = rulesMode === "both" && !outside ? baseRules(baseRef, ledgerRel, [...ruleFiles, ...ruleDirs]) : null;
    if (baseLedger) {
      const env = { ...process.env, MEMORY_PULSE_LEDGER: baseLedger };
      let under; try { under = await checkFiles(cli, content, range, env); } catch (e) { unchecked(`under the rules on ${baseName}: ${String(e.message)}`); }
      foldPacks(under, packCheck(cli, baseRef, env), "");
      if (under.verdict === "blocked" && result.verdict !== "blocked") {
        result.verdict = "blocked"; result.blockedUnderBase = true;
        result.corrections = under.corrections; result.invariants = under.invariants; if (under.packs) result.packs = under.packs;
        result.reasons = under.reasons.map((x) => `under the rules on \`${baseName}\`: ${x}`);
      }
    }
  }

  // Signed receipt (the api-key input). The verdict above was computed on the runner from files in the repository and it
  // stands: the engine is asked only to sign what it sees. With no key nothing is sent. An engine that is down, or that
  // answers differently, is reported in the comment and never changes the verdict.
  let receiptNote = null;
  if (wantsReceipt()) {
    let signed = null, why = null;
    try { signed = JSON.parse(execFileSync(process.execPath, [cli, "check", "--ci", "--json", "--receipt", "--kind", "edit", "--path", "pull-request"], { input: text, encoding: "utf8", env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] })); }
    catch (e) { try { signed = JSON.parse(String(e.stdout)); } catch { const errLines = String(e.stderr || e.message).split("\n").map((l) => l.trim()).filter(Boolean); why = (errLines.find((l) => /unreachable|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timed out/i.test(l)) ?? "the engine did not answer").replace(/^(?:Error: )?/, "").slice(0, 160); } }
    if (signed?.receipt?.head) result.receipt = signed.receipt;
    else receiptNote = `no receipt was issued (${(why ?? signed?.receiptHint ?? "the engine returned none").slice(0, 160)})`;
    if (signed?.verdict && signed.verdict !== result.verdict) receiptNote = [receiptNote, `the engine answered ${signed.verdict}; this check reports the verdict computed on the runner`].filter(Boolean).join("; ");
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
  const body = renderComment(result, { receiptId, sha, receiptNote });
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
