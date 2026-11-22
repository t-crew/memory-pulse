// The team path through git (2026-11-21). A project's corrections live in .memory-pulse/events.jsonl, committed, so a clone carries
// them. The file is a hash chain: every row names the row before it, so when two branches each append a row, git sees two different
// lines after the same line and reports a conflict, and no text merge of the two tails verifies (each tail's first row links to the
// common row, and both sides reuse the same t).
//
// What is here:
//   merge-driver <base> <ours> <theirs> [<path>]   the git merge driver (the %O %A %B %P contract: the result is written to <ours>,
//       exit 0 on a clean merge, non-zero to leave the path unmerged). For the ledger it keeps ours byte for byte and carries the
//       other side's rows after it through the product's own writer, by calling the code `state merge` runs (mergeCapsule in
//       server.mjs) on a scratch copy: each finding lands once, a carried row records where it came from, the other side's
//       bookkeeping stays with it, a note that reads like an instruction is held back. This file adds no merge rule. It adds three
//       checks around that one: the common ancestor's rows must still be on both sides (history rewritten is refused), a conflict
//       that leaves two contradicting corrections binding stops the merge (exit 1, both rows named, the merged ledger left in
//       place), and this machine's anchor and seal are compared with the result so the accept command is printed when one is needed.
//   For invariants.jsonl (keyed on the path) it merges the three versions as sets of lines. Git's built-in merge=union is not enough
//       there: `prereg settle` removes a seal's rules (lib/prereg.mjs), and union brings a removed line back and keeps a line both
//       sides added twice (measured with git 2.39.5; test/team-merge.test.js holds the case).
//   team setup | status | resolve   the .gitattributes lines (committed) and the driver definition (this clone's .git/config, which
//       git never shares); whether this clone would use the driver; and the same merge run on a path git left unmerged.
//       setup also sets merge.memory-pulse.recursive to binary: with two common ancestors (a criss-cross) git merges the ancestors
//       among themselves first, and that internal merge takes one ancestor's file instead of running the driver.
//
// The driver never writes this machine's anchor or seal. A merge is not final when the driver returns (git can still abort it), so
// the trust store is left as it is and the next `verify`, brief or guard run judges the ledger git actually put in place.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const DRIVER = "memory-pulse";
const ATTR = `merge=${DRIVER}`;
const DRIVER_NAME = "memory-pulse ledger merge: ours kept, the other side's rows re-appended through the writer";
const ATTR_COMMENT = "# memory-pulse: the committed ledger and the declared rules merge through the memory-pulse driver; each clone sets it once with: memory-pulse team setup";
const DEFAULT_LEDGER = ".memory-pulse/events.jsonl";
const MARKER = /^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)( |$)/m;
const WHY = "ledger merged by git, the other branch's rows come first";

const git = (cwd, ...args) => { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); return { ok: r.status === 0, status: r.status, out: String(r.stdout ?? "").replace(/\r?\n$/, ""), err: String(r.stderr ?? "") }; };
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
const parse = (l) => { try { const r = JSON.parse(l); return r && typeof r === "object" && !Array.isArray(r) ? r : null; } catch { return null; } };
const linesOfText = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean);
const clip = (s, n = 80) => { const x = String(s); return x.length > n ? `${x.slice(0, n)}…` : x; };
const isRules = (p) => basename(String(p)) === "invariants.jsonl";

/** A name for the other side, for the origin a carried row records: the branch git is merging, the branch being rebased, else "theirs". */
function otherSide(cwd) {
  const heads = Object.entries(process.env).filter(([k]) => /^GITHEAD_[0-9a-f]{40,64}$/.test(k)).map(([, v]) => v);
  let name = heads.length === 1 ? heads[0] : null;
  const gitFile = (rel) => { const p = git(cwd, "rev-parse", "--git-path", rel); if (!p.ok) return null; try { return readFileSync(resolve(cwd, p.out), "utf8").trim(); } catch { return null; } };
  // a rebase replays this branch's commits onto the other one, so the rows carried are this branch's
  if (!name) for (const d of ["rebase-merge", "rebase-apply"]) { const h = gitFile(`${d}/head-name`); if (h) { name = h.replace(/^refs\/heads\//, ""); break; } }
  if (!name) { const sha = gitFile("MERGE_HEAD"); if (sha && /^[0-9a-f]{40,64}$/.test(sha.split("\n")[0])) { const n = git(cwd, "name-rev", "--name-only", sha.split("\n")[0]); if (n.ok && n.out && n.out !== "undefined") name = n.out.replace(/^remotes\//, "").replace(/[~^].*$/, ""); } }
  name = String(name ?? "").replace(/[^A-Za-z0-9._/-]/g, "").slice(0, 80);
  return name || "theirs";
}

/** The first row of the common ancestor that a side no longer holds, or null. A side holds the ancestor when it begins with it, or
 *  when it took it through an earlier merge: then every ancestor row a merge carries is on it by content (bookkeeping rows, rows rolled
 *  back at source, held-back notes and credit rows are the ones a merge leaves behind, so they are not asked for). */
function missingFromAncestor(core, B, S) {
  const p = commonPrefix(B, S); if (p === B.length) return null;
  const force = core.inForceSet(core.parseRows(B).rows), have = new Set(core.parseRows(S).rows.map(core.contentKey));
  for (let i = p; i < B.length; i++) {
    const r = parse(B[i]);
    if (!r || typeof r.cause !== "string" || typeof r.effect !== "string") continue;
    if (core.isRollback(r) || (Array.isArray(r.tags) && r.tags.some((t) => core.STATE_TAGS.includes(t)))) continue;
    if (Number.isInteger(r.t) && !force.has(r.t)) continue;
    if (core.instructionLike(r.note).length) continue;
    if (r.credit && typeof r.credit === "object") continue;
    if (!have.has(core.contentKey(r))) return { t: Number.isInteger(r.t) ? r.t : "?", line: i + 1 };
  }
  return null;
}

/**
 * Merge the ledger file `theirs` into the ledger file `ours` (both diverged from `base`), writing the result to `ours`.
 * Returns { code, status, lines }: code 0 merged or nothing to do, 1 merged with a conflict named (the merged ledger is in `ours`),
 * 2 refused (`ours` is left exactly as it was). `ancestor: false` skips the common-ancestor check (team resolve --no-ancestor).
 */
export function mergeLedger(core, { base, ours, theirs, path = DEFAULT_LEDGER, cwd = process.cwd(), ancestor = true, label = null }) {
  const head = `memory-pulse merge-driver: ${path}:`;
  const keepOurs = `  to keep ours as it is: git add ${path}`;
  const refuse = (why, extra = [keepOurs]) => ({ code: 2, status: "refused", lines: [`${head} refused, nothing merged: ${why}`, ...extra] });
  const B = base ? core.linesOf(base) : [], O = core.linesOf(ours), T = core.linesOf(theirs);
  if (!T.length) return B.length ? refuse("theirs holds no rows and the common ancestor does: history was rewritten on that side") : { code: 0, status: "unchanged", lines: [] };
  if (!O.length) {
    if (B.length) return refuse("ours holds no rows and the common ancestor does: history was rewritten on this side", [`  to take the other side's ledger as it is: git checkout --theirs -- ${path} && git add ${path}`]);
    const tc = core.verifyChainLines(T); if (!tc.ok) return refuse(`theirs' row chain is broken: ${tc.reason}`);
    copyFileSync(theirs, ours);
    return { code: 0, status: "installed", lines: [`${head} ours held no rows: took the other side's ${T.length} row(s) as they are`] };
  }
  const oc = core.verifyChainLines(O);
  if (!oc.ok) return refuse(`ours' row chain is broken: ${oc.reason}`, ["  memory-pulse verify names the first bad row and the command that fixes it; merge again after that"]);
  const tc = core.verifyChainLines(T);
  if (!tc.ok) return refuse(`theirs' row chain is broken: ${tc.reason}`, [keepOurs, "  the other branch repairs its ledger first: there, memory-pulse verify names the first bad row and the command that fixes it"]);
  if (ancestor && B.length) for (const [side, S] of [["ours", O], ["theirs", T]]) {
    const miss = missingFromAncestor(core, B, S);
    if (miss) return refuse(`${side} no longer holds row t=${miss.t} of the common ancestor (line ${miss.line} there): history was rewritten on that side`,
      [keepOurs, `  to carry the other side's rows anyway, after reading them (git show :3:${path}): memory-pulse team resolve --no-ancestor`]);
  }

  // The merge itself is state merge's, run on a scratch copy of ours so nothing lands in the working tree until it verified.
  const dir = mkdtempSync(join(tmpdir(), "mp-merge-")), mine = join(dir, "ours", "events.jsonl"), other = join(dir, "theirs", "events.jsonl");
  const envBefore = process.env.MEMORY_PULSE_LEDGER;
  let r, after, id;
  try {
    mkdirSync(dirname(mine)); mkdirSync(dirname(other)); copyFileSync(ours, mine); copyFileSync(theirs, other);
    const before = readFileSync(mine);
    id = label ?? otherSide(cwd);
    const b = core.buildCapsule({ ledger: other, scope: "project", branch: id });
    if (b.error) return refuse(`theirs: ${b.error}`);
    process.env.MEMORY_PULSE_LEDGER = mine;
    r = core.mergeCapsule(b.capsule, { scope: "project" });
    if (r.status === "refused") return refuse(r.reason);
    if (r.status !== "merged") return { code: 0, status: "unchanged", lines: [`${head} nothing to carry from ${id}: ${r.reason ?? "every row is already here"}`] };
    after = readFileSync(mine);
    if (!after.subarray(0, before.length).equals(before)) return refuse("the merge did not keep ours byte for byte (this is a fault in memory-pulse; ours is left as it was)");
    const check = core.verifyChainLines(linesOfText(after.toString("utf8")));
    if (!check.ok) return refuse(`the merged ledger does not verify (${check.reason}; this is a fault in memory-pulse; ours is left as it was)`);
  } finally {
    if (envBefore === undefined) delete process.env.MEMORY_PULSE_LEDGER; else process.env.MEMORY_PULSE_LEDGER = envBefore;
    try { unlinkSync(core.anchorPathFor(mine)); } catch { /* the scratch copy never got an anchor */ }
    rmSync(dir, { recursive: true, force: true });
  }
  writeFileSync(ours, after);

  const L = linesOfText(after.toString("utf8")), rows = core.parseRows(L).rows, byT = new Map(rows.filter((x) => Number.isInteger(x.t)).map((x) => [x.t, x]));
  const from = (t) => `carried from ${id} t${byT.get(t)?.origin?.t ?? "?"}`;
  // A conflict is left to a person only while both corrections still bind in the merged ledger: one that the other side already
  // superseded is settled, and state merge's note keeps it on the record either way.
  const force = core.inForceSet(rows), retired = core.supersededSet(rows.filter((x) => !Number.isInteger(x.t) || force.has(x.t)));
  const binds = (x) => !!x && x.kind === "correction" && Array.isArray(x.withdrawn) && x.withdrawn.length > 0 && force.has(x.t) && !retired.has(x.t);
  const named = [];
  for (const c of r.conflicts ?? []) if (binds(byT.get(c.local)) && binds(byT.get(c.merged)) && !named.some((n) => n.a === c.local && n.b === c.merged))
    named.push({ a: c.local, b: c.merged, text: `"${clip(c.term)}" is withdrawn at t${c.local} (ours) and at t${c.merged} (${from(c.merged)}) with different replacements; both bind until one is superseded` });
  // One more pair state merge does not look for: a correction on one side whose replacement the other side's new correction withdraws.
  // After the merge the guard would block each side's replacement, so it is named the same way. Nothing is carried differently for it.
  const oursMax = core.parseRows(O).rows.reduce((m, x) => Math.max(m, Number.isInteger(x.t) ? x.t : 0), 0), carried = new Set(r.carried);
  const mineNew = rows.filter((x) => Number.isInteger(x.t) && x.t > r.fork && x.t <= oursMax && binds(x)), theirsNew = rows.filter((x) => carried.has(x.t) && binds(x));
  for (const o of mineNew) for (const c of theirsNew) {
    if (named.some((n) => n.a === o.t && n.b === c.t)) continue;
    const oc2 = (o.replacement ?? []).find((v) => c.withdrawn.includes(v)), co = (c.replacement ?? []).find((v) => o.withdrawn.includes(v));
    if (oc2 !== undefined) named.push({ a: o.t, b: c.t, text: `t${o.t} (ours) replaces "${clip(o.withdrawn[0])}" with "${clip(oc2)}" and t${c.t} (${from(c.t)}) withdraws "${clip(oc2)}": the two corrections contradict each other; both bind until one is superseded` });
    else if (co !== undefined) named.push({ a: o.t, b: c.t, text: `t${c.t} (${from(c.t)}) replaces "${clip(c.withdrawn[0])}" with "${clip(co)}" and t${o.t} (ours) withdraws "${clip(co)}": the two corrections contradict each other; both bind until one is superseded` });
  }
  const what = `carried ${r.carried.length} row(s) from ${id} as t${r.carried[0]}..t${r.carried[r.carried.length - 1]}; ${r.skipped.length} duplicate(s) skipped${r.held.length ? `; ${r.held.length} row(s) held back, note reads like an instruction` : ""}${r.atSource.length ? `; ${r.atSource.length} row(s) of the other side's bookkeeping left with it` : ""}; recorded at t${r.t}`;
  const lines = [];
  if (named.length) {
    const ts = [...new Set(named.flatMap((n) => [n.a, n.b]))].sort((x, y) => x - y);
    lines.push(`${head} ${what}. ${named.length} conflict(s) left for a person to decide; git keeps the path unmerged until then, and the ledger in place verifies with both rows binding`,
      ...named.map((n) => `  conflict: ${n.text}`),
      `  settle it with one row that supersedes them: memory-pulse remember "<cause>" "<effect>" --kind correction --withdrawn "<the value that stays withdrawn>" --replacement "<the value that stands>" ${ts.map((t) => `--supersedes ${t}`).join(" ")}`,
      `  then: git add ${path}   (and finish: git commit, or git rebase --continue)`);
  } else lines.push(`${head} ${what}`);
  // This machine's view of the ledger git is about to put in place. Ours is kept byte for byte, so the anchor and the seal hold
  // whenever ours is what this machine last saw; in a rebase ours is the other branch, and they do not.
  try {
    const real = resolve(cwd, path), accept = [];
    const a = core.readAnchor(real), moved = !!a && core.anchorCheck(L, a).ok === false;
    if (moved) accept.push(`memory-pulse anchor accept "${WHY}"`);
    const seal = core.readSeal(real); if (seal && core.verifyLocalSeal(rows, seal, null, real).ok === false) accept.push(`memory-pulse seal accept "${WHY}"`);
    // the rows this machine last saw are the other side's in a rebase (ours is the branch rebased onto); when they are neither side's,
    // the machine last saw another branch's ledger at this path, and the merge did not cause the mismatch
    const why = !moved ? "the engine seal stored on this machine does not match the merged ledger"
      : core.anchorCheck(T, a).ok === true ? "ours comes first in the merged ledger, and the rows this machine last saw at this path are the other side's (in a rebase, ours is the branch you rebase onto), so this machine's anchor does not match it"
      : "this machine last saw another branch's ledger at this path, so its anchor matched neither side before the merge and does not match the result";
    if (accept.length) lines.push(`${head} ${why}; verify will say so. When git has finished, record that you trust the ledger as it stands:`, ...accept.map((c) => `  ${c}`));
  } catch { /* no trust store to compare with */ }
  return { code: named.length ? 1 : 0, status: "merged", lines, carried: r.carried, conflicts: named };
}

/**
 * invariants.jsonl: the three versions merged as sets of lines. A line both sides hold lands once, a line one side added is kept, a
 * line one side removed stays removed. Ours' order first, then the other side's new lines in their order. One id with two different
 * lines, one from each side, is named and both are kept (exit 1): a person picks the rule.
 */
export function mergeRules({ base, ours, theirs, path = ".memory-pulse/invariants.jsonl" }) {
  const read = (f) => (f && existsSync(f) ? readFileSync(f, "utf8") : "");
  const split = (t) => t.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim());
  const B = split(read(base)), O = split(read(ours)), T = split(read(theirs));
  const key = (l) => l.trim(), inB = new Set(B.map(key)), inO = new Set(O.map(key)), inT = new Set(T.map(key));
  const out = [], seen = new Set(), idOf = (l) => { const r = parse(l); return r && typeof r.id === "string" ? r.id : null; };
  for (const l of O) { const k = key(l); if (seen.has(k) || (inB.has(k) && !inT.has(k))) continue; seen.add(k); out.push(l); }
  const oursById = new Map(); for (const l of out) { const id = idOf(l); if (id !== null) oursById.set(id, [...(oursById.get(id) ?? []), key(l)]); }
  const differ = new Set();
  for (const l of T) {
    const k = key(l); if (seen.has(k) || (inB.has(k) && !inO.has(k))) continue;
    seen.add(k); out.push(l);
    const id = idOf(l); if (id !== null && oursById.has(id)) differ.add(id);
  }
  writeFileSync(ours, out.length ? out.join("\n") + "\n" : "");
  const head = `memory-pulse merge-driver: ${path}:`;
  if (!differ.size) return { code: 0, status: "merged", lines: [] };
  return { code: 1, status: "merged", lines: [`${head} merged as a set of lines; ${[...differ].map((id) => `rule "${clip(id)}" differs between the two sides`).join("; ")}, and both versions are in the file`,
    `  keep one line for each id named, then: git add ${path}   (and finish: git commit, or git rebase --continue)`] };
}

/** `memory-pulse merge-driver <base> <ours> <theirs> [<path>]`, as git calls it. */
export function cliMergeDriver(argv, core) {
  const [base, ours, theirs, path] = argv;
  if (!base || !ours || !theirs) { console.error("usage: memory-pulse merge-driver <base> <ours> <theirs> [<path>]\n  the git merge driver that memory-pulse team setup configures as: merge-driver %O %A %B %P"); return 2; }
  const p = path || DEFAULT_LEDGER;
  let r;
  try { r = isRules(p) ? mergeRules({ base, ours, theirs, path: p }) : mergeLedger(core, { base, ours, theirs, path: p }); }
  catch (e) { r = { code: 2, lines: [`memory-pulse merge-driver: ${p}: refused, nothing merged: ${String(e?.message ?? e).split("\n")[0]}`] }; }
  for (const l of r.lines) console.error(l);
  return r.code;
}

// ---------------------------------------------------------------- team ----
const repoTop = (cwd) => { const r = git(cwd, "rev-parse", "--show-toplevel"); return r.ok && r.out ? r.out : null; };
/** The two paths the driver is named for, relative to the directory that holds .memory-pulse/ (where .gitattributes is written). */
function teamPaths(core, cwd) {
  const rel = relative(cwd, core.ledgerPath());
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { error: `the ledger this shell uses (${core.ledgerPath()}${process.env.MEMORY_PULSE_LEDGER ? ", from MEMORY_PULSE_LEDGER" : ""}) is outside this directory; a ledger shared through git lives in the repository, so run this where .memory-pulse/ is` };
  const ledger = rel.split(sep).join("/");
  return { ledger, rules: `${ledger.replace(/[^/]*$/, "")}invariants.jsonl` };
}
const attrPattern = (p) => (/\s/.test(p) ? `"${p.replace(/(["\\])/g, "\\$1")}"` : p);
const shQuote = (s) => `"${(process.platform === "win32" ? s.replace(/\\/g, "/") : s).replace(/(["$`\\])/g, "\\$1")}"`;
/** node by absolute path and a pinned copy of this client: the definition lives in one clone's .git/config, so one machine's paths
 *  are right there, a git client whose PATH has no node still merges, and no merge waits on npx or the network. */
function driverCommand(core) {
  const m = /^node "(.+)"$/.exec(core.pinnedRunner());
  return `${shQuote(process.execPath)} ${shQuote(m ? m[1] : resolve(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs"))} merge-driver %O %A %B %P`;
}
/** Is the driver defined for this clone, and does what it names exist? */
function driverState(cwd) {
  const r = git(cwd, "config", "--get", `merge.${DRIVER}.driver`);
  if (!r.ok || !r.out.trim()) return { ok: false, cmd: null, why: "git config does not define it" };
  const quoted = [...r.out.matchAll(/"((?:[^"\\]|\\.)+)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
  const gone = quoted.find((p) => isAbsolute(p) && !existsSync(p));
  if (gone) return { ok: false, cmd: r.out, why: `git config points it at ${gone}, which is not there` };
  return { ok: true, cmd: r.out, version: (/[\\/](\d+\.\d+\.\d+)[\\/]server\.mjs/.exec(r.out) ?? [])[1] ?? null };
}
const unmergedPaths = (cwd, paths) => { const r = git(cwd, "ls-files", "-u", "--", ...paths); return r.ok ? [...new Set(r.out.split("\n").filter(Boolean).map((l) => l.split("\t")[1]))] : []; };
const PLAIN = (rel, why) => `this clone merges ${rel} as plain text: .gitattributes names the memory-pulse merge driver and this clone's ${why}, so two branches that both recorded a row will conflict. Run once in this clone: memory-pulse team setup`;

/** One line for the brief when the committed attribute names a driver this clone does not have; "" otherwise. Costs one file read
 *  in a project without the attribute, and one `git config` call in a project with it. */
export function driverLine(ledger) {
  try {
    const dir = dirname(dirname(ledger)), file = join(dir, ".gitattributes");
    if (!existsSync(file)) return "";
    const rel = `${basename(dirname(ledger))}/${basename(ledger)}`;
    if (!readFileSync(file, "utf8").split("\n").some((l) => { const w = l.trim().split(/\s+/); return w[0] === rel && w.includes(ATTR); })) return "";
    const st = driverState(dir);
    if (st.ok || !repoTop(dir)) return "";
    return `memory-pulse: ${PLAIN(rel, st.why)}`;
  } catch { return ""; }
}

/** Write the .gitattributes lines and this clone's driver definition. Idempotent. `fromInstall` (install-hook --project) is silent
 *  outside a git work tree, where there is nothing to set up. */
export function teamSetup(core, { cwd = process.cwd(), fromInstall = false } = {}) {
  if (!repoTop(cwd)) return fromInstall ? { code: 0, lines: [] } : { code: 1, lines: ["memory-pulse team setup: not inside a git work tree. The ledger is shared by committing it: run this in the repository that holds .memory-pulse/"] };
  const P = teamPaths(core, cwd);
  if (P.error) return { code: fromInstall ? 0 : 1, lines: [`memory-pulse team setup: ${P.error}`] };
  const file = join(cwd, ".gitattributes"), had = existsSync(file) ? readFileSync(file, "utf8") : "";
  const have = new Set(had.split("\n").map((l) => l.trim())), add = [P.ledger, P.rules].map((p) => `${attrPattern(p)} ${ATTR}`).filter((l) => !have.has(l));
  if (add.length) writeFileSync(file, `${had}${had && !had.endsWith("\n") ? "\n" : ""}${had.includes(ATTR_COMMENT) ? "" : `${ATTR_COMMENT}\n`}${add.join("\n")}\n`);
  const cmd = driverCommand(core), cur = git(cwd, "config", "--local", "--get", `merge.${DRIVER}.driver`);
  const setDriver = !cur.ok || cur.out !== cmd;
  if (setDriver) { const w = git(cwd, "config", "--local", `merge.${DRIVER}.driver`, cmd); if (!w.ok) return { code: 1, lines: [`memory-pulse team setup: git config could not be written (${w.err.trim().split("\n")[0]})`] }; }
  // name: what git prints for the driver. recursive: with two common ancestors git first merges the ancestors among themselves; that
  // internal merge takes one ancestor's file (binary) and never runs the driver, whose check then asks both sides for that file's rows.
  for (const [k, v] of [["name", DRIVER_NAME], ["recursive", "binary"]]) { const c = git(cwd, "config", "--local", "--get", `merge.${DRIVER}.${k}`); if (!c.ok || c.out !== v) git(cwd, "config", "--local", `merge.${DRIVER}.${k}`, v); }
  const lines = [
    add.length ? `team setup: wrote ${add.length} line(s) to .gitattributes: ${P.ledger} and ${P.rules} merge through the memory-pulse driver` : `team setup: .gitattributes already names the driver for ${P.ledger} and ${P.rules}`,
    setDriver ? `team setup: set merge.${DRIVER}.driver in this clone's git config: ${cmd}` : "team setup: this clone's git config already defines the driver",
  ];
  if (add.length || setDriver) lines.push("next: commit .gitattributes. Git keeps the driver in .git/config, which it never shares, so every clone runs it once: memory-pulse team setup");
  const un = unmergedPaths(cwd, [P.ledger, P.rules]);
  if (un.length) lines.push(`team setup: ${un.join(" and ")} ${un.length === 1 ? "is" : "are"} unmerged in the index (a merge ran before the driver was set). Run the merge on ${un.length === 1 ? "it" : "them"} now: memory-pulse team resolve`);
  return { code: 0, lines };
}

/** Would this clone merge the ledger with the driver? code 0 ready, 1 not set up (or not a repository), 2 the attribute without a
 *  working driver: the state git does not report. */
export function teamStatus(core, { cwd = process.cwd() } = {}) {
  if (!repoTop(cwd)) return { code: 1, lines: ["team: not inside a git work tree, so there is nothing to merge here. The ledger is shared by committing it; in the repository: memory-pulse team setup"] };
  const P = teamPaths(core, cwd); if (P.error) return { code: 1, lines: [`team: ${P.error}`] };
  const attr = (p) => { const r = git(cwd, "check-attr", "merge", "--", p); return r.ok ? r.out.split(": ").pop().trim() : "unspecified"; };
  const ledgerNamed = attr(P.ledger) === DRIVER, rulesNamed = attr(P.rules) === DRIVER, st = driverState(cwd);
  const lines = []; let code = 0;
  if (!ledgerNamed) { code = 1; lines.push(`team: not set up: .gitattributes does not name the memory-pulse merge driver for ${P.ledger}, so two branches that both recorded a row conflict in git. Set it up: memory-pulse team setup`); }
  else if (!st.ok) { code = 2; lines.push(`team: ${PLAIN(P.ledger, st.why)}`); }
  else {
    lines.push(`team: ready: ${rulesNamed ? `${P.ledger} and ${P.rules} merge` : `${P.ledger} merges`} through the memory-pulse driver in this clone (${st.cmd})`);
    if (!rulesNamed) lines.push(`team: ${P.rules} is not named in .gitattributes; memory-pulse team setup adds it`);
    if (st.version && core.version && st.version !== core.version) lines.push(`team: the driver runs the pinned copy of ${st.version} and this is ${core.version}; memory-pulse team setup pins this one`);
  }
  const un = unmergedPaths(cwd, [P.ledger, P.rules]);
  if (un.length) lines.push(`team: ${un.join(" and ")} ${un.length === 1 ? "is" : "are"} unmerged in the index. ${st.ok ? "Run" : "After team setup, run"} the merge on ${un.length === 1 ? "it" : "them"}: memory-pulse team resolve`);
  return { code, lines };
}

/** Run the driver's merge on a path git left unmerged (a merge that ran without the driver, or one the driver refused), from the
 *  three versions in the index. A clean result is staged. A file already merged in the working tree is left alone. */
export function teamResolve(core, { cwd = process.cwd(), ancestor = true } = {}) {
  if (!repoTop(cwd)) return { code: 1, lines: ["memory-pulse team resolve: not inside a git work tree"] };
  const P = teamPaths(core, cwd); if (P.error) return { code: 1, lines: [`memory-pulse team resolve: ${P.error}`] };
  const lines = []; let code = 0;
  for (const p of [P.ledger, P.rules]) {
    const u = git(cwd, "ls-files", "-u", "--", p); const st = {};
    for (const l of (u.ok ? u.out : "").split("\n").filter(Boolean)) { const m = /^\d+ ([0-9a-f]+) ([123])\t/.exec(l); if (m) st[m[2]] = m[1]; }
    if (!st[2] && !st[3]) continue;
    if (!st[2] || !st[3]) { lines.push(`team resolve: ${p}: one side removed the file; decide with git add ${p} or git rm ${p}`); code = Math.max(code, 1); continue; }
    const dir = mkdtempSync(join(tmpdir(), "mp-resolve-"));
    try {
      const f = {};
      for (const [n, name] of [["1", "base"], ["2", "ours"], ["3", "theirs"]]) { f[name] = join(dir, name); writeFileSync(f[name], st[n] ? spawnSync("git", ["cat-file", "blob", st[n]], { cwd }).stdout : ""); }
      const work = join(cwd, p), cur = existsSync(work) ? readFileSync(work) : Buffer.alloc(0);
      if (!cur.equals(readFileSync(f.ours)) && !MARKER.test(cur.toString("utf8"))) { lines.push(`team resolve: ${p}: nothing to resolve: the working tree already holds a merged file with no conflict markers. When the conflicts the merge named are settled: git add ${p}`); continue; }
      const r = isRules(p) ? mergeRules({ ...f, path: p }) : mergeLedger(core, { ...f, path: p, cwd, ancestor });
      lines.push(...r.lines);
      if (r.code === 2) { code = 2; continue; }
      copyFileSync(f.ours, work);
      if (r.code !== 0) { code = Math.max(code, 1); continue; }
      const a = git(cwd, "add", "--", p);
      lines.push(a.ok ? `team resolve: ${p} merged and staged; finish with git commit (or git rebase --continue)` : `team resolve: ${p} merged; git add did not run (${a.err.trim().split("\n")[0]}): git add ${p}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  if (!lines.length) lines.push(`team resolve: nothing to resolve: neither ${P.ledger} nor ${P.rules} is unmerged in the index`);
  return { code, lines };
}

const TEAM_USAGE = `usage: memory-pulse team [status]                  whether this clone merges the committed ledger through the memory-pulse driver; exit 0 ready, 1 not set up, 2 the attribute without a working driver
       memory-pulse team setup                     write the .gitattributes lines (commit them) and set this clone's driver in .git/config (every clone runs it once)
       memory-pulse team resolve [--no-ancestor]   run the driver's merge on a ledger git left unmerged, and stage a clean result; --no-ancestor skips the check that both sides still hold the common ancestor's rows`;
/** `memory-pulse team [status|setup|resolve]`. */
export function cliTeam(argv, core) {
  const op = argv[0] && !argv[0].startsWith("--") ? argv[0] : "status";
  const r = op === "setup" ? teamSetup(core) : op === "status" ? teamStatus(core) : op === "resolve" ? teamResolve(core, { ancestor: !argv.includes("--no-ancestor") }) : null;
  if (!r) { console.error(TEAM_USAGE); return 1; }
  for (const l of r.lines) (r.code === 0 || op === "status" ? console.log : console.error)(l);
  return r.code;
}
