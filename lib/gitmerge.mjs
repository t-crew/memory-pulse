// The team path through git (2026-11-21). A project's corrections live in .memory-pulse/events.jsonl, committed, so a clone carries
// them. The file is a hash chain: every row names the row before it, so when two branches each append a row, git sees two different
// lines after the same line and reports a conflict, and no text merge of the two tails verifies (each tail's first row links to the
// common row, and both sides reuse the same t).
//
// What is here:
//   merge-driver <base> <ours> <theirs> [<path>]   the git merge driver (the %O %A %B %P contract: the result is written to <ours>,
//       exit 0 on a clean merge, non-zero to leave the path unmerged). For the ledger it keeps ours byte for byte and carries the
//       other side's rows after it through the product's own writer, by calling the code `state merge` runs (mergeCapsule in
//       server.mjs) on a scratch copy: each finding lands once, a carried row records where it came from, the other side's merge
//       and resume records stay with it, a note that reads like an instruction is held back. Around that:
//         - the common ancestor's rows must still be on both sides (history rewritten is refused);
//         - a rollback on the other side is carried with its effect (state merge leaves it "at source", and in git the merged file
//           replaces the branch's ledger, so it was on no tip): see mergeLedger;
//         - a conflict that leaves two contradicting corrections binding stops the merge (exit 1, both rows named, the merged
//           ledger left in place);
//         - nothing is written unless ours is at the start byte for byte, the chain verifies, and the findings in force are the
//           ones the two sides hold; the write is a temp file in the same folder and a rename;
//         - this machine's anchor and seal are compared with the result, so the accept command is printed when one is needed.
//   For invariants.jsonl (keyed on the path) it merges the three versions as sets of lines. Git's built-in merge=union is not enough
//       there: `prereg settle` removes a seal's rules (lib/prereg.mjs), and union brings a removed line back and keeps a line both
//       sides added twice (measured with git 2.39.5; test/team-setup.test.js holds the case).
//   team setup | status | resolve   the .gitattributes lines (committed) and the driver definition (this clone's .git/config, which
//       git never shares); whether this clone would use the driver; and the same merge run on a path git left unmerged, or on a
//       ledger whose two sides were kept by hand. Resolve reads git's three versions into files without a pipe buffer and checks
//       each against the size git reports (a piped read was cut at 1 MiB and the cut file merged: review of 99824f1, M-1), and
//       keeps rows recorded on disk while the path was unmerged (M-2).
//       setup also sets merge.memory-pulse.recursive to binary: with two common ancestors (a criss-cross) git merges the ancestors
//       among themselves first, and that internal merge takes one ancestor's file instead of running the driver.
//
// The driver never writes this machine's anchor or seal. A merge is not final when the driver returns (git can still abort it), so
// the trust store is left as it is and the next `verify`, brief or guard run judges the ledger git actually put in place.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, unlinkSync, renameSync, statSync, openSync, closeSync } from "node:fs";
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
const CHAIN_FIELDS = ["hash", "prev", "gap_digest", "legacy_digest", "mac"];

// Small answers only come back through a pipe (a path, a config value, an object id). The buffer is set far above any of them, and
// a call that overran it, or did not run, is a failure and never a short answer. File contents never come through here: blobToFile.
const git = (cwd, ...args) => { const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); return { ok: !r.error && r.status === 0, status: r.status, out: String(r.stdout ?? "").replace(/\r?\n$/, ""), err: String(r.error?.message ?? r.stderr ?? "") }; };
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
const parse = (l) => { try { const r = JSON.parse(l); return r && typeof r === "object" && !Array.isArray(r) ? r : null; } catch { return null; } };
const linesOfText = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean);
const clip = (s, n = 80) => { const x = String(s); return x.length > n ? `${x.slice(0, n)}…` : x; };
const isRules = (p) => basename(String(p)) === "invariants.jsonl";
const tList = (ts, n = 8) => `${ts.slice(0, n).map((t) => `t${t}`).join(", ")}${ts.length > n ? `, … (${ts.length})` : ""}`;

/** Replace a file with a temp file written in the same folder and renamed over it: a reader sees the old bytes or the new ones, and
 *  any failure leaves the original exactly as it was. */
export function writeAtomic(file, bytes) {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try { let mode = 0o644; try { mode = statSync(file).mode & 0o777; } catch { /* a new file */ } writeFileSync(tmp, bytes, { mode, flag: "wx" }); renameSync(tmp, file); }
  catch (e) { try { unlinkSync(tmp); } catch { /* never written */ } throw e; }
}
/** One version of a path out of git's object store, written to a file by git itself, with no pipe buffer on the way (spawnSync cuts a
 *  piped answer at 1 MiB and still returns), then checked against the size git reports for the object. A cut file is refused. */
function blobToFile(cwd, sha, file) {
  const fd = openSync(file, "w"); let r;
  try { r = spawnSync("git", ["cat-file", "blob", sha], { cwd, stdio: ["ignore", fd, "pipe"] }); } finally { closeSync(fd); }
  if (r.error || r.status !== 0) throw new Error(`git cat-file blob ${sha.slice(0, 12)} did not run (${String(r.error?.message ?? r.stderr ?? "").trim().split("\n")[0]})`);
  const want = git(cwd, "cat-file", "-s", sha), got = statSync(file).size;
  if (!want.ok || Number(want.out.trim()) !== got) throw new Error(`git handed over ${got} byte(s) of object ${sha.slice(0, 12)} and reports ${want.out.trim() || "?"}; a cut file is never merged`);
}

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
    if (core.isBookkeeping(r)) continue;
    if (Number.isInteger(r.t) && !force.has(r.t)) continue;
    if (core.instructionLike(r.note).length) continue;
    if (r.credit && typeof r.credit === "object") continue;
    if (!have.has(core.contentKey(r))) return { t: Number.isInteger(r.t) ? r.t : "?", line: i + 1 };
  }
  return null;
}

/** A ledger's rows, which of them are in force, and the content of the findings in force (`keys`) and of every finding (`all`). A
 *  finding is any row that is not a branch's own bookkeeping; its content is what state merge dedupes on. */
function view(core, lines) {
  const rows = core.parseRows(lines).rows, force = core.inForceSet(rows), live = (r) => !Number.isInteger(r.t) || force.has(r.t), keys = new Set(), all = new Set();
  for (const r of rows) { if (core.isBookkeeping(r)) continue; const k = core.contentKey(r); all.add(k); if (live(r)) keys.add(k); }
  return { rows, force, live, keys, all };
}
/** A ledger whose two sides of a git conflict were both kept by hand: the rows up to the one both tails link to, the first tail, and
 *  the tail whose first row links back to that earlier row. null for any other file. */
function splitHandMerge(lines) {
  const at = new Map(); let last = null;
  for (let i = 0; i < lines.length; i++) {
    const r = parse(lines[i]); if (!r || typeof r.hash !== "string") continue;
    if (last !== null && r.prev !== last && typeof r.prev === "string" && at.has(r.prev)) { const j = at.get(r.prev); return { prefix: lines.slice(0, j + 1), a: lines.slice(j + 1, i), b: lines.slice(i), afterT: parse(lines[j])?.t ?? "?" }; }
    at.set(r.hash, i); last = r.hash;
  }
  return null;
}
/** Rebuild such a ledger by the merge rule: the first tail is kept and the second is carried after it. Returns { bytes, lines,
 *  afterT, a, b, conflicts }, { error }, or null when the file is not a hand merge. */
function healHandMerge(core, lines, { path, cwd, depth = 0 }) {
  const sp = splitHandMerge(lines); if (!sp || depth > 6) return null;
  const dir = mkdtempSync(join(tmpdir(), "mp-heal-"));
  try {
    const f = { base: join(dir, "base"), ours: join(dir, "ours"), theirs: join(dir, "theirs") };
    writeFileSync(f.base, sp.prefix.join("\n") + "\n"); writeFileSync(f.ours, [...sp.prefix, ...sp.a].join("\n") + "\n"); writeFileSync(f.theirs, [...sp.prefix, ...sp.b].join("\n") + "\n");
    const r = mergeLedger(core, { ...f, path, cwd, ancestor: false, label: "hand-merge", depth: depth + 1, trust: false });
    if (r.code === 2) return { error: r.lines[0] ?? "the two tails could not be merged" };
    const bytes = readFileSync(f.ours);
    return { bytes, lines: linesOfText(bytes.toString("utf8")), afterT: sp.afterT, a: sp.a.length, b: sp.b.length, conflicts: r.conflicts?.length ?? 0 };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Merge the ledger file `theirs` into the ledger file `ours` (both diverged from `base`), writing the result to `ours`.
 * Returns { code, status, lines }: code 0 merged or nothing to do, 1 merged with a conflict named (the merged ledger is in `ours`),
 * 2 refused (`ours` is left exactly as it was). `ancestor: false` skips the common-ancestor check (team resolve --no-ancestor).
 * `extra` are rows found on disk that neither side holds (recorded while the path was unmerged): they are kept.
 *
 * What must be in force afterwards is the three-way reading of the two sides against where they started, by content: a finding both
 * sides hold in force stays; one a side added stays; one a side put out of force (a rollback) goes out of force. State merge leaves
 * the other side's rollback "at source", which is right for a capsule and loses the rollback in git, where the merged file replaces
 * the branch's ledger. So when the other side rolled back rows this ledger still holds in force, the same rollback is recorded here
 * (to the last row at which nothing it removes was in force) and the rows of this ledger that must stay are recorded again after
 * it, each naming the row it repeats. Before anything is written the result is checked: ours byte for byte at its start, the chain
 * verifies, and the findings in force are exactly the ones the reading asks for. Otherwise the merge is refused.
 */
export function mergeLedger(core, { base, ours, theirs, path = DEFAULT_LEDGER, cwd = process.cwd(), ancestor = true, label = null, extra = [], depth = 0, trust = true }) {
  const head = `memory-pulse merge-driver: ${path}:`;
  const keepOurs = `  to keep ours as it is: git add ${path}`;
  const refuse = (why, more = [keepOurs]) => ({ code: 2, status: "refused", lines: [`${head} refused, nothing merged: ${why}`, ...more] });
  const B = base ? core.linesOf(base) : [], O = core.linesOf(ours); let T = core.linesOf(theirs), healed = null;
  if (!T.length && !extra.length) return B.length ? refuse("theirs holds no rows and the common ancestor does: history was rewritten on that side") : { code: 0, status: "unchanged", lines: [] };
  if (!O.length) {
    if (B.length) return refuse("ours holds no rows and the common ancestor does: history was rewritten on this side", [`  to take the other side's ledger as it is: git checkout --theirs -- ${path} && git add ${path}`]);
    const tc = core.verifyChainLines(T); if (!tc.ok) return refuse(`theirs' row chain is broken: ${tc.reason}`);
    if (extra.length) return refuse("ours holds no rows, and rows were recorded while the path was unmerged; take one side with git checkout and record them again");
    try { writeAtomic(ours, readFileSync(theirs)); } catch (e) { return refuse(`the result could not be written (${String(e?.message ?? e).split("\n")[0]})`); }
    return { code: 0, status: "installed", lines: [`${head} ours held no rows: took the other side's ${T.length} row(s) as they are`] };
  }
  const oc = core.verifyChainLines(O);
  if (!oc.ok) {
    const sp = splitHandMerge(O);
    return sp ? refuse(`ours was merged by hand (after row t=${sp.afterT} it holds two tails, each a chain of its own)`, ["  rebuild it first: git merge --abort (or git rebase --abort), then memory-pulse team resolve, commit, and merge again"])
      : refuse(`ours' row chain is broken: ${oc.reason}`, ["  memory-pulse verify names the first bad row and the command that fixes it; merge again after that"]);
  }
  const notes = [];
  if (!core.verifyChainLines(T).ok) {
    // the other side kept both tails of a conflict by hand, in a clone without the driver: merge its two tails by the rule first
    const h = healHandMerge(core, T, { path, cwd, depth });
    if (!h || h.error) return refuse(`theirs' row chain is broken: ${h?.error ?? core.verifyChainLines(T).reason}`, [keepOurs, "  the other branch repairs its ledger first: there, memory-pulse verify names the first bad row and the command that fixes it"]);
    healed = h; T = h.lines;
    notes.push(`${head} theirs was merged by hand in a clone without the driver (after row t=${h.afterT} it held two tails of ${h.a} and ${h.b} row(s)): its tails were merged by the driver's rule first${h.conflicts ? `; ${h.conflicts} pair(s) of corrections inside it contradict each other and both bind` : ""}`);
  }
  if (ancestor && B.length) for (const [side, S] of [["ours", O], ["theirs", T]]) {
    const miss = missingFromAncestor(core, B, S);
    if (miss) return refuse(`${side} no longer holds row t=${miss.t} of the common ancestor (line ${miss.line} there): history was rewritten on that side`,
      [keepOurs, `  to carry the other side's rows anyway, after reading them (git show :3:${path}): memory-pulse team resolve --no-ancestor`]);
  }
  // ---- what must be in force afterwards, by content
  const fork = commonPrefix(O, T), vB = view(core, ancestor && B.length ? B : O.slice(0, fork)), vO = view(core, O), vT = view(core, T);
  // a finding in force on one side only goes out of force when the other side holds that row and put it out of force (a rollback
  // there); a row the other side never held is new to it, whatever the ancestor held
  const want = new Set();
  for (const k of vO.keys) if (vT.keys.has(k) || !vB.keys.has(k) || !vT.all.has(k)) want.add(k);
  for (const k of vT.keys) if (vO.keys.has(k) || !vB.keys.has(k) || !vO.all.has(k)) want.add(k);
  // rows of the other side that no merge carries (a note that reads like an instruction, a credit for a memory left behind) are not asked for
  const unasked = new Set(vT.rows.filter((r) => !core.isBookkeeping(r) && vT.live(r) && (core.instructionLike(r.note).length || (r.credit && typeof r.credit === "object"))).map(core.contentKey).filter((k) => !vO.keys.has(k)));
  const remove = vO.rows.filter((r) => !core.isBookkeeping(r) && vO.live(r) && !want.has(core.contentKey(r)));
  if (remove.some((r) => !Number.isInteger(r.t))) return refuse("the other side rolled back a row that has no row number here, and such a row cannot be rolled back");
  for (const x of extra) if (core.isBookkeeping(x)) return refuse(`a ${x.cause} row (t${x.t ?? "?"}) was recorded while the path was unmerged, and a rollback or merge record cannot be moved`, ["  git merge --abort (or git rebase --abort), set the driver with memory-pulse team setup, and merge again"]);

  // The merge itself runs on a scratch copy of ours, so nothing lands in the working tree until it verified.
  const dir = mkdtempSync(join(tmpdir(), "mp-merge-")), mine = join(dir, "ours", "events.jsonl"), other = join(dir, "theirs", "events.jsonl");
  const envBefore = process.env.MEMORY_PULSE_LEDGER;
  let r = null, after, id, replay = null, again = [], kept = [];
  try {
    mkdirSync(dirname(mine)); mkdirSync(dirname(other)); copyFileSync(ours, mine);
    if (healed) writeFileSync(other, healed.bytes); else copyFileSync(theirs, other);
    const before = readFileSync(mine), strip = (x) => { const row = { ...x }; for (const k of CHAIN_FIELDS) delete row[k]; return row; };
    const now = () => view(core, core.linesOf(mine)), topT = (v) => v.rows.reduce((m, x) => Math.max(m, Number.isInteger(x.t) ? x.t : 0), 0);
    // references a re-recorded row carries (supersedes, resolves, credit) follow the rows they name; one whose row is gone is dropped
    const remap = (row, tMap) => {
      for (const f of ["supersedes", "resolves"]) if (Array.isArray(row[f])) { const m = row[f].map((t) => tMap.get(Number(t))).filter((t) => Number.isInteger(t)); if (m.length) row[f] = m; else delete row[f]; }
      if (row.credit && typeof row.credit === "object" && !Array.isArray(row.credit)) { const c = {}; for (const [k, v] of Object.entries(row.credit)) { const to = tMap.get(Number(k)); if (Number.isInteger(to)) c[to] = v; } if (!Object.keys(c).length) return null; row.credit = c; }
      return row;
    };
    id = label ?? otherSide(cwd);
    process.env.MEMORY_PULSE_LEDGER = mine;
    if (remove.length) {
      // the last point of this ledger's own history at which nothing the other side removed (and nothing else unwanted) was in force
      const first = Math.min(...remove.map((x) => x.t)), ts = [...new Set(vO.rows.map((x) => x.t).filter((t) => Number.isInteger(t) && t < first))].sort((a, b) => b - a).slice(0, 64);
      let Z = 0, stateZ = new Set();
      for (const t of ts) { const st = core.inForceSet(vO.rows.filter((x) => Number.isInteger(x.t) && x.t <= t)); if (vO.rows.every((x) => !st.has(x.t) || core.isBookkeeping(x) || want.has(core.contentKey(x)))) { Z = t; stateZ = st; break; } }
      const theirRollbacks = vT.rows.filter((x) => core.isRollback(x) && vT.live(x)).map((x) => x.t);
      const w = core.appendEvent({ cause: "state-rollback", effect: `rolled-back-to-t${Z}`, kind: "decision", tags: ["rollback"], scope: "project",
        note: `merge with ${id}: that side rolled back ${remove.length} row(s) this ledger still held in force (${tList(remove.map((x) => x.t))}), so the same rollback is recorded here; the rows of this ledger that stay in force are recorded again after this row`,
        fields: { rollback_to: Z, origin: { branch: id, t: theirRollbacks.at(-1) ?? null, rollback: remove.map((x) => x.t) } } });
      if (!w.written) return refuse(`the other side's rollback could not be recorded here (${w.reason})`);
      const tMap = new Map([...stateZ].map((t) => [t, t])), stay = vO.rows.filter((x) => !core.isBookkeeping(x) && vO.live(x) && want.has(core.contentKey(x)) && !stateZ.has(x.t));
      let next = w.t + 1; const batch = [];
      for (const x of stay) { const row = strip(x); row.t = next++; row.origin = { branch: "ours", t: x.t ?? null, replay: w.t, ...(x.origin ? { from: x.origin } : {}) }; tMap.set(x.t, row.t); batch.push(row); }
      core.chainAppendMany(mine, batch.map((row) => remap(row, tMap)).filter(Boolean));
      replay = { to: Z, at: w.t, removed: remove.map((x) => x.t), stay: stay.length };
    }
    // a finding this ledger holds out of force and the other side holds in force (it recorded it again, or restored it): state merge
    // skips it as a duplicate, so it is recorded again here
    { const v = now(), tMap = new Map(v.rows.filter((x) => Number.isInteger(x.t) && v.live(x)).map((x) => [x.t, x.t])); let next = topT(v) + 1; const batch = [], seen = new Set();
      for (const x of vT.rows) {
        const k = core.contentKey(x);
        if (core.isBookkeeping(x) || !vT.live(x) || !want.has(k) || v.keys.has(k) || !v.all.has(k) || seen.has(k) || core.instructionLike(x.note).length) continue;
        const row = remap({ ...strip(x), t: next, origin: { branch: id, t: x.t ?? null, again: true } }, new Map([...tMap].filter(([t]) => t <= (parse(O[fork - 1] ?? "")?.t ?? 0))));
        if (!row) continue; next++; seen.add(k); batch.push(row); again.push(row.t);
      }
      core.chainAppendMany(mine, batch); }
    const b = core.buildCapsule({ ledger: other, scope: "project", branch: id });
    if (b.error) return refuse(`theirs: ${b.error}`);
    r = core.mergeCapsule(b.capsule, { scope: "project" });
    if (r.status === "refused") return refuse(r.reason);
    // rows recorded on disk while the path was unmerged, which neither side holds
    if (extra.length) { const v = now(); let next = topT(v) + 1; const batch = [];
      for (const x of extra) { if (v.keys.has(core.contentKey(x))) continue; const row = strip(x); delete row.supersedes; delete row.resolves; delete row.credit; row.t = next++; row.origin = { branch: "working-tree", t: x.t ?? null }; batch.push(row); kept.push(row.t); }
      core.chainAppendMany(mine, batch); }
    after = readFileSync(mine);
    if (after.equals(before)) return { code: 0, status: "unchanged", lines: [...notes, `${head} nothing to carry from ${id}: ${r.reason ?? "every row is already here"}`] };
    // ---- nothing is written unless the result holds what went in
    if (!after.subarray(0, before.length).equals(before)) return refuse("the merge did not keep ours byte for byte (a fault in memory-pulse; ours is left as it was)");
    const L = linesOfText(after.toString("utf8")), check = core.verifyChainLines(L);
    if (!check.ok) return refuse(`the merged ledger does not verify (${check.reason}; a fault in memory-pulse; ours is left as it was)`);
    const vR = view(core, L), extraKeys = new Set(extra.map(core.contentKey));
    const gone = [...want, ...extraKeys].filter((k) => !vR.keys.has(k) && !unasked.has(k)), over = [...vR.keys].filter((k) => !want.has(k) && !extraKeys.has(k));
    if (gone.length || over.length) return refuse(`the merged ledger would not hold in force what the two sides hold: ${gone.length} finding(s) missing, ${over.length} that a side put out of force still in force (a fault in memory-pulse; ours is left as it was)`);
  } catch (e) {
    return refuse(`${String(e?.message ?? e).split("\n")[0]} (ours is left as it was)`);
  } finally {
    if (envBefore === undefined) delete process.env.MEMORY_PULSE_LEDGER; else process.env.MEMORY_PULSE_LEDGER = envBefore;
    try { unlinkSync(core.anchorPathFor(mine)); } catch { /* the scratch copy never got an anchor */ }
    rmSync(dir, { recursive: true, force: true });
  }
  try { writeAtomic(ours, after); } catch (e) { return refuse(`the result could not be written (${String(e?.message ?? e).split("\n")[0]}); ours is left as it was`); }

  const L = linesOfText(after.toString("utf8")), rows = core.parseRows(L).rows, byT = new Map(rows.filter((x) => Number.isInteger(x.t)).map((x) => [x.t, x]));
  const merged = r.status === "merged", carriedTs = merged ? r.carried : [];
  const from = (t) => `carried from ${id} t${byT.get(t)?.origin?.t ?? "?"}`;
  // A conflict is left to a person only while both corrections still bind in the merged ledger: one that the other side already
  // superseded is settled, and state merge's note keeps it on the record either way.
  const force = core.inForceSet(rows), retired = core.supersededSet(rows.filter((x) => !Number.isInteger(x.t) || force.has(x.t)));
  const binds = (x) => !!x && x.kind === "correction" && Array.isArray(x.withdrawn) && x.withdrawn.length > 0 && force.has(x.t) && !retired.has(x.t);
  const named = [], pair = new Set(), name = (a, b, text) => { if (pair.has(`${a}:${b}`)) return; pair.add(`${a}:${b}`); named.push({ a, b, text }); };
  for (const c of (merged ? r.conflicts : []) ?? []) if (binds(byT.get(c.local)) && binds(byT.get(c.merged)))
    name(c.local, c.merged, `"${clip(c.term)}" is withdrawn at t${c.local} (ours) and at t${c.merged} (${from(c.merged)}) with different replacements; both bind until one is superseded`);
  // One more pair state merge does not look for: a correction on one side whose replacement the other side's new correction withdraws.
  // After the merge the guard would block each side's replacement, so it is named the same way. Nothing is carried differently for it.
  // Indexed by term, so the search is one pass over each side's terms.
  const theirsNew = [...carriedTs, ...again].map((t) => byT.get(t)).filter(binds), theirsT = new Set(theirsNew.map((x) => x.t));
  const mineNew = rows.filter((x) => binds(x) && !theirsT.has(x.t) && !vB.all.has(core.contentKey(x)));
  const index = (field) => { const m = new Map(); for (const c of theirsNew) for (const v of c[field] ?? []) m.set(v, [...(m.get(v) ?? []), c]); return m; };
  const withdrawnBy = index("withdrawn"), replacedBy = index("replacement");
  for (const o of mineNew) {
    for (const v of o.replacement ?? []) for (const c of withdrawnBy.get(v) ?? []) name(o.t, c.t, `t${o.t} (ours) replaces "${clip(o.withdrawn[0])}" with "${clip(v)}" and t${c.t} (${from(c.t)}) withdraws "${clip(v)}": the two corrections contradict each other; both bind until one is superseded`);
    for (const w of o.withdrawn) for (const c of replacedBy.get(w) ?? []) name(o.t, c.t, `t${c.t} (${from(c.t)}) replaces "${clip(c.withdrawn[0])}" with "${clip(w)}" and t${o.t} (ours) withdraws "${clip(w)}": the two corrections contradict each other; both bind until one is superseded`);
  }
  const lines = [...notes];
  if (replay) lines.push(`${head} ${id} rolled back ${replay.removed.length} row(s) this ledger still held in force (${tList(replay.removed)}): the same rollback is recorded here at t${replay.at} (to t${replay.to}), and ${replay.stay} row(s) of this ledger that stay in force are recorded again after it`);
  if (again.length) lines.push(`${head} ${again.length} finding(s) this ledger held out of force are in force on ${id} and are recorded again here (${tList(again)})`);
  if (kept.length) lines.push(`${head} ${kept.length} row(s) recorded while the path was unmerged are kept (${tList(kept)})`);
  const what = merged ? `carried ${r.carried.length} row(s) from ${id} as t${r.carried[0]}..t${r.carried[r.carried.length - 1]}; ${r.skipped.length} duplicate(s) skipped${r.held.length ? `; ${r.held.length} row(s) held back, note reads like an instruction` : ""}${r.atSource.length ? `; ${r.atSource.length} row(s) of the other side's bookkeeping left with it` : ""}; recorded at t${r.t}` : `nothing else to carry from ${id}`;
  if (named.length) {
    const ts = [...new Set(named.flatMap((n) => [n.a, n.b]))].sort((x, y) => x - y);
    lines.push(`${head} ${what}. ${named.length} conflict(s) left for a person to decide; git keeps the path unmerged until then, and the ledger in place verifies with both rows binding`,
      ...named.slice(0, 20).map((n) => `  conflict: ${n.text}`), ...(named.length > 20 ? [`  … and ${named.length - 20} more, each a pair of rows among ${tList(ts, 40)}`] : []),
      `  settle it with one row that supersedes them: memory-pulse remember "<cause>" "<effect>" --kind correction --withdrawn "<the value that stays withdrawn>" --replacement "<the value that stands>" ${ts.slice(0, 40).map((t) => `--supersedes ${t}`).join(" ")}`,
      `  then: git add ${path}   (and finish: git commit, or git rebase --continue)`);
  } else lines.push(`${head} ${what}`);
  // This machine's view of the ledger git is about to put in place. Ours is kept byte for byte, so the anchor and the seal hold
  // whenever ours is what this machine last saw; in a rebase ours is the other branch, and they do not.
  if (trust) try {
    const real = resolve(cwd, path), accept = [];
    const a = core.readAnchor(real), moved = !!a && core.anchorCheck(L, a).ok === false;
    if (moved) accept.push(`memory-pulse anchor accept "${WHY}"`);
    const seal = core.readSeal(real); if (seal && core.verifyLocalSeal(rows, seal, null, real).ok === false) accept.push(`memory-pulse seal accept "${WHY}"`);
    // the rows this machine last saw are the other side's in a rebase (ours is the branch rebased onto); when they are neither side's,
    // the machine last saw another branch's ledger at this path, and the merge did not cause the mismatch
    const why = !moved ? "the engine seal stored on this machine does not match the merged ledger"
      : core.anchorCheck(core.linesOf(theirs), a).ok === true ? "ours comes first in the merged ledger, and the rows this machine last saw at this path are the other side's (in a rebase, ours is the branch you rebase onto), so this machine's anchor does not match it"
      : "this machine last saw another branch's ledger at this path, so its anchor matched neither side before the merge and does not match the result";
    if (accept.length) lines.push(`${head} ${why}; verify will say so. When git has finished, record that you trust the ledger as it stands:`, ...accept.map((c) => `  ${c}`));
  } catch { /* no trust store to compare with */ }
  return { code: named.length ? 1 : 0, status: "merged", lines, carried: carriedTs, conflicts: named };
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
  const head = `memory-pulse merge-driver: ${path}:`;
  try { writeAtomic(ours, out.length ? out.join("\n") + "\n" : ""); } catch (e) { return { code: 2, status: "refused", lines: [`${head} refused, nothing merged: the result could not be written (${String(e?.message ?? e).split("\n")[0]}); ours is left as it was`] }; }
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
  // a ledger whose two sides were kept by hand and committed: not a state to work in
  else { const abs = join(cwd, P.ledger), ins = existsSync(abs) ? core.inspectChain(abs) : null; if (ins && !ins.ok && ins.tail?.forked) { code = 2; lines.push(`team: ${core.handMergedLine(P.ledger, ins.tail.forked).replace(/^memory-pulse: /, "")}`); } }
  return { code, lines };
}

/** Run the driver's merge on a path git left unmerged (a merge that ran without the driver, or one the driver refused), from the
 *  three versions in the index, and on a committed ledger whose two sides were kept by hand. A clean result is staged. The working
 *  file is read and replaced under the ledger's lock, by a rename; rows recorded in it while it was unmerged are kept; a file already
 *  merged in the working tree is left alone. */
export function teamResolve(core, { cwd = process.cwd(), ancestor = true } = {}) {
  if (!repoTop(cwd)) return { code: 1, lines: ["memory-pulse team resolve: not inside a git work tree"] };
  const P = teamPaths(core, cwd); if (P.error) return { code: 1, lines: [`memory-pulse team resolve: ${P.error}`] };
  const lines = []; let code = 0;
  for (const p of [P.ledger, P.rules]) {
    const u = git(cwd, "ls-files", "-u", "--", p), st = {}, work = join(cwd, p);
    for (const l of (u.ok ? u.out : "").split("\n").filter(Boolean)) { const m = /^\d+ ([0-9a-f]+) ([123])\t/.exec(l); if (m) st[m[2]] = m[1]; }
    let r;
    try {
      if (!st[2] && !st[3]) { if (isRules(p) || !existsSync(work)) continue; r = core.withLedgerLock(work, () => resolveByHand(core, { work, p, cwd })); if (!r) continue; }
      else if (!st[2] || !st[3]) r = { code: 1, lines: [`team resolve: ${p}: one side removed the file; decide with git add ${p} or git rm ${p}`] };
      else r = isRules(p) ? resolveIndex(core, { st, work, p, cwd, ancestor }) : core.withLedgerLock(work, () => resolveIndex(core, { st, work, p, cwd, ancestor }));
    } catch (e) { r = { code: 2, lines: [`team resolve: ${p}: refused, nothing written: ${String(e?.message ?? e).split("\n")[0]}`] }; }
    lines.push(...r.lines); code = Math.max(code, r.code);
  }
  if (!lines.length) lines.push(`team resolve: nothing to resolve: neither ${P.ledger} nor ${P.rules} is unmerged in the index, and the ledger is not two tails kept by hand`);
  return { code, lines };
}
/** A path unmerged in the index: the merge of stage 2 (ours) and stage 3 (theirs) against stage 1, written over the working file. */
function resolveIndex(core, { st, work, p, cwd, ancestor }) {
  const dir = mkdtempSync(join(tmpdir(), "mp-resolve-"));
  try {
    const f = {};
    for (const [n, name] of [["1", "base"], ["2", "ours"], ["3", "theirs"]]) { f[name] = join(dir, name); if (st[n]) blobToFile(cwd, st[n], f[name]); else writeFileSync(f[name], ""); }
    const cur = existsSync(work) ? readFileSync(work) : Buffer.alloc(0), text = cur.toString("utf8"), marked = MARKER.test(text);
    const onDisk = text.split("\n").filter((l) => l.trim() && !MARKER.test(l)).map((l) => l.trim());
    let extra = [];
    if (!isRules(p)) {
      // a file that is ours as git left it, or holds markers, or does not verify (both sides kept by hand) is merged from the index;
      // one that verifies and is neither is a merge someone already finished
      if (!cur.equals(readFileSync(f.ours)) && !marked && core.verifyChainLines(onDisk).ok) return { code: 0, lines: [`team resolve: ${p}: nothing to resolve: the working tree already holds a merged file with no conflict markers. When the conflicts the merge named are settled: git add ${p}`] };
      // rows on disk that neither version holds were recorded while the path was unmerged (the writer still takes a row then, and
      // git has no copy of it): they are kept, or the command refuses
      const known = new Set([...core.linesOf(f.ours), ...core.linesOf(f.theirs)]), unknown = onDisk.filter((l) => !known.has(l)), rows = unknown.map(parse);
      const bad = rows.findIndex((x) => !x || typeof x.cause !== "string" || typeof x.effect !== "string");
      if (bad >= 0) return { code: 2, lines: [`team resolve: ${p}: refused, nothing written: the working file holds a line that is neither side's row nor a row (${clip(unknown[bad], 60)}). Remove that line, or take one side with git checkout, then run this again`] };
      extra = rows;
    } else if (!cur.equals(readFileSync(f.ours)) && !marked) return { code: 0, lines: [`team resolve: ${p}: nothing to resolve: the working tree already holds a merged file with no conflict markers. When it holds one line for each rule id: git add ${p}`] };
    const r = isRules(p) ? mergeRules({ ...f, path: p }) : mergeLedger(core, { ...f, path: p, cwd, ancestor, extra });
    if (r.code === 2) return r;
    writeAtomic(work, readFileSync(f.ours));
    if (r.code !== 0) return r;
    const a = git(cwd, "add", "--", p);
    return { code: 0, lines: [...r.lines, a.ok ? `team resolve: ${p} merged and staged; finish with git commit (or git rebase --continue)` : `team resolve: ${p} merged; git add did not run (${a.err.trim().split("\n")[0]}): git add ${p}`] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
/** A committed ledger that is two tails after one row (both sides of a conflict kept by hand): rebuilt by the merge rule. null when
 *  the working ledger is not that. */
function resolveByHand(core, { work, p, cwd }) {
  const L = core.linesOf(work); if (core.verifyChainLines(L).ok) return null;
  const h = healHandMerge(core, L, { path: p, cwd }); if (!h) return null;
  if (h.error) return { code: 2, lines: [`team resolve: ${p}: refused, nothing written: it was merged by hand, and its two tails could not be merged (${h.error})`] };
  writeAtomic(work, h.bytes);
  return { code: 0, lines: [`team resolve: ${p} was merged by hand (after row t=${h.afterT} it held two tails of ${h.a} and ${h.b} row(s), each a chain of its own): rebuilt by the driver's rule, with every row kept${h.conflicts ? `; ${h.conflicts} pair(s) of corrections in it contradict each other and both bind` : ""}. Commit it: git add ${p} && git commit -m "rebuild the memory-pulse ledger"`] };
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
