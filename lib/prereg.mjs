// Pre-registered research (0.18.0). Tests: test/now.test.js, test/command-invariant.test.js, test/prereg.test.js, test/ran.test.js.
//
// Three slips in one night of pre-registered work are the reason for this file: a time stamp typed from memory into a record, a
// run at sizes the builder's own amendment had reserved for confirmation, and a constant about a deployed system copied into a
// sealed spec from a summary. Each is now a command instead of a habit.
//
//   now      the machine clock as the two stamps a record uses. A record's stamp is pasted from here, never typed.
//   prereg   seal: every --assert is checked against the file that defines the value before anything is written; then one row,
//            through the ledger's own writer, with the stamp read from the clock here, the sha256 of the spec and of each file,
//            the assertions and the forbid patterns; each --forbid is declared as a rule on shell commands (below) owned by the
//            seal. verify: re-hash what was sealed (the evaluator's first step). settle: one row with the verdict file's hash,
//            citing the seal row, and the seal's rules are retired. list: open and settled seals.
//   ran      the shell commands the capture hook recorded (lib/capture.mjs: .memory-pulse/episodes/<session>.jsonl) that match a
//            pattern, with time and session: did a forbidden configuration run after the seal. It reads; capture is unchanged.
//
// A forbid rule is a tripwire against inattention, not a security boundary.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { scrub } from "./capture.mjs";   // the scrubber a recorded command already passes through

// Only `prereg` writes a row's `prereg` field: appendEvent refuses it from any caller that does not hold this (a Symbol, which
// `remember`, `append --json` and the MCP tool cannot carry), so a stamp or a hash in a seal row is never one a caller supplied.
export const PREREG_WRITE = Symbol("memory-pulse prereg write");

/** One reading of the clock in both forms: {utc: "2026-11-19 02:15 UTC", iso: "2026-11-19T02:15:07Z"}. Truncated, never rounded up. */
export function stamps(d = new Date()) {
  const iso = d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return { utc: `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`, iso };
}
export const STAMP_RULE = "a record's stamp is pasted from these lines, never typed from memory";

export function cliNow(argv) {
  if (argv.some((a) => a !== "--json")) { console.error("usage: memory-pulse now [--json]\n  prints the machine clock; it takes no time from the caller"); return 1; }
  const s = stamps();
  console.log(argv.includes("--json") ? JSON.stringify(s) : `${s.utc}\n${s.iso}\n${STAMP_RULE}`);
  return 0;
}

// ---- Rules on shell commands. A line of .memory-pulse/invariants.jsonl with "on": "command" is matched against a shell command (the
// guard on a Bash / shell tool call, and `check --kind command`) and against nothing else; `paths` does not apply to it. One whose
// `owner` names a prereg ({prereg, row}) was declared by `prereg seal --forbid`: its block says whose command this is and how to
// proceed, and it has one exemption, a command line that starts with MEMORY_PULSE_ROLE=evaluator among its environment assignments
// (after any leading `cd <dir> &&`). That marker is read from the command's text. It is a tripwire against inattention, not a
// security boundary: anyone who types the marker passes.
const ID = /^[A-Za-z0-9._-]+$/;
const ASSIGN = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s'"]*)`;
const EVALUATOR = new RegExp(String.raw`^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)*(?:env\s+)?(?:${ASSIGN}\s+)*MEMORY_PULSE_ROLE=(?:evaluator|'evaluator'|"evaluator")(?=\s|$)`);
export const EVALUATOR_MARK = "MEMORY_PULSE_ROLE=evaluator";
export const evaluatorCommand = (cmd) => EVALUATOR.test(String(cmd ?? ""));
const ownerOf = (inv) => { const o = inv?.owner; return o && typeof o === "object" && typeof o.prereg === "string" && ID.test(o.prereg) ? { prereg: o.prereg, row: Number.isInteger(o.row) ? o.row : null } : null; };

/**
 * commandHits(command, invariants, compilePattern) -> { hits, allowed, reasons }. `hits` are the rules on commands the command trips
 * (severity block or warn), each with its `reason`; `allowed` says which prereg rules an evaluator's command passed; `reasons` is
 * every line in order. The message of a prereg's rule is built from its owner, never from the stored statement. Pure.
 */
export function commandHits(command, invariants, compilePattern) {
  const text = typeof command === "string" ? command : ""; const hits = [], allowed = [], reasons = [];
  if (!text.trim()) return { hits, allowed, reasons };
  const evaluator = evaluatorCommand(text);
  for (const inv of invariants ?? []) {
    if (!inv || inv.on !== "command" || typeof inv.id !== "string") continue;
    const tests = (Array.isArray(inv.patterns) ? inv.patterns : []).map(compilePattern);
    if (tests.some((t) => t === null)) reasons.push(`invariant ${inv.id} ignored: a pattern does not compile`);
    const hit = tests.find((t) => t && t.test(text));
    if (!hit) continue;
    const owner = ownerOf(inv);
    if (owner && evaluator) { const line = `prereg ${owner.prereg} (sealed at row ${owner.row ?? "?"}) reserves this command for the evaluator (matched ${hit.src}); allowed, because the command line starts with ${EVALUATOR_MARK}`; allowed.push(line); reasons.push(line); continue; }
    const severity = inv.severity === "warn" ? "warn" : "block";
    const cite = (Array.isArray(inv.cite) ? inv.cite : []).map((c) => typeof c === "number" ? `t${c}` : /^t\d+$/.test(String(c)) ? String(c) : /^\d+$/.test(String(c)) ? `t${c}` : null).filter(Boolean);
    const replacement = typeof inv.replacement === "string" ? inv.replacement : "";
    const reason = owner
      ? `sealed by prereg ${owner.prereg} at row ${owner.row ?? "?"}: this command is the evaluator's (matched ${hit.src}). Hand it to an evaluator, whose command line starts with ${EVALUATOR_MARK}, or settle the prereg: memory-pulse prereg settle ${owner.prereg} --verdict <WORD> --file <verdict-file>`
      : `${severity === "warn" ? "warning" : "invariant"} ${inv.id}${inv.statement ? `: ${inv.statement}` : ""} (matched ${hit.src}, a rule on shell commands)${cite.length ? ` — ledger ${cite.join(", ")}` : ""}${replacement ? ` — instead: ${replacement}` : ""}`;
    hits.push({ id: inv.id, severity, pattern: hit.src, cite, replacement, on: "command", ...(owner ? { owner } : {}), reason });
    reasons.push(reason);
  }
  return { hits, allowed, reasons };
}
/** The invariants that apply to an action of this kind, for a reader that does not know "on" (the engine's /v1/check matches every pattern against any text). */
export const invariantsFor = (kind, text, invariants) => (invariants ?? []).filter((inv) => inv?.on !== "command" || (kind === "command" && !(ownerOf(inv) && evaluatorCommand(text))));
export const COMMAND_HINT = "This is a declared rule on shell commands (.memory-pulse/invariants.jsonl), not a withdrawn value, so an override does not apply. A prereg's rule holds until the prereg is settled. It is a tripwire against inattention, not a security boundary: do not reword the command to get past the pattern.";

// ---- prereg. A seal is one ledger row: cause `prereg <id>`, effect `sealed <first 12 hex of the spec's sha256>`, tags prereg /
// prereg:<id> / prereg-seal, and the manifest in `prereg`: {id, op: "seal", at, ms, dir, spec, files, asserts, forbid}. A settle
// row: effect `settled <WORD> <first 12 hex of the verdict file's sha256>`, `prereg`: {id, op: "settle", at, ms, verdict, file,
// seal}. The effects carry a hash so neither is a bare word a sentence could contain, and a row with the manifest is never
// counted as evidence by `check` or `lint` (server.mjs, localCheck). Rows are found again by that field. Every row on record counts,
// rolled back or not: a seal is a statement about files at a time, and its rules live in invariants.jsonl until it is settled.
const USAGE = `usage: memory-pulse prereg seal <id> --spec <file> [--file <path>]... [--assert '<path>::<text>']... [--forbid '<regex>']... [--note "..."]
       memory-pulse prereg verify <id> [--json]
       memory-pulse prereg settle <id> --verdict <WORD> --file <verdict-file> [--note "..."]
       memory-pulse prereg list [--json]`;
const TRIPWIRE = `The forbid patterns are a tripwire against inattention, not a security boundary: a command line that starts with ${EVALUATOR_MARK} passes.`;
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const utcOf = (iso) => `${String(iso).slice(0, 10)} ${String(iso).slice(11, 16)} UTC`;
const clip = (l, n = 200) => { const v = String(l).trimEnd(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };
const tilde = (p) => { const h = homedir(); return h && p === h ? "~" : h && p.startsWith(h + sep) ? `~${p.slice(h.length)}` : p; };
const untilde = (p) => (p === "~" || p.startsWith("~/") || p.startsWith(`~${sep}`) ? join(homedir(), p.slice(1)) : p);
// how a path is kept in a row: relative to the directory the seal is made in when the file is under it, else with ~ for home
const shown = (p, cwd = process.cwd()) => { const a = resolve(cwd, p); return a.startsWith(cwd + sep) ? relative(cwd, a) : tilde(a); };
// where a kept path is now: in the directory the seal was made in when the file is there, else under the current directory
const located = (p, dir) => { const q = untilde(String(p)); if (isAbsolute(q)) return q; const a = dir ? join(untilde(String(dir)), q) : null; return a && existsSync(a) ? a : resolve(q); };
const rulesFile = (core) => join(dirname(core.ledgerPath()), "invariants.jsonl");
// a --forbid value is a regular expression as typed; it is kept as /re/, the form an invariant's pattern takes
export const toPattern = (src) => { try { return src ? { src: `/${src}/`, re: new RegExp(src) } : null; } catch { return null; } };

function parse(argv, { single = [], multi = [], flags = [] }) {
  const opts = Object.fromEntries(multi.map((k) => [k, []])), pos = [];
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(argv[i]);
    if (!m) { pos.push(argv[i]); continue; }
    const [, k, inline] = m;
    if (flags.includes(k) && inline === undefined) { opts[k] = true; continue; }
    if (!single.includes(k) && !multi.includes(k)) return { error: `unknown option --${k}` };   // there is no option for a stamp: the clock is read here
    const v = inline ?? argv[++i];
    if (v == null) return { error: `--${k} needs a value` };
    if (multi.includes(k)) opts[k].push(v); else opts[k] = v;
  }
  return { opts, pos };
}
const usage = (why) => { console.error(`${why ? `memory-pulse prereg: ${why}\n` : ""}${USAGE}`); return 1; };

const isPrereg = (e) => !!e && !!e.prereg && typeof e.prereg === "object" && typeof e.prereg.id === "string" && (e.prereg.op === "seal" || e.prereg.op === "settle");
/** Every seal on record, oldest first: {id, row, at, seal, settle}. A settle row closes the latest open seal of its id before it. */
export function seals(events) {
  const out = [];
  for (const e of events ?? []) {
    if (!isPrereg(e)) continue;
    if (e.prereg.op === "seal") out.push({ id: e.prereg.id, row: e.t, at: e.prereg.at, seal: e, settle: null });
    else { const s = out.findLast((x) => x.id === e.prereg.id && !x.settle); if (s) s.settle = e; }
  }
  return out;
}

// "A constant a spec states about a deployed system is asserted against the file that defines it." An assertion is a statement
// about a value, so it holds only when a line of code states the text whole: the line's trailing comment is set aside (# or // to
// the end of the line, where it starts the line or follows whitespace), and the text must sit between boundaries, with no letter,
// digit, underscore or dot directly before or after it. `LIMIT = 50` does not hold against `LIMIT = 500`, and `RATE = 0.5` does not
// hold against `RATE = 0.25  # was RATE = 0.5`. When it does not hold, the lines that carry the name before the first "=" or ":"
// are shown: the real value, on screen. The text and every line shown pass the secret scrubber first, and the row keeps the
// scrubbed text: an assertion the scrubber changed is marked, because its value is then not on record.
const COMMENT = /(^|\s)(#|\/\/).*$/;
const codeOf = (line) => line.replace(COMMENT, "").trim();
const WORDISH = /[A-Za-z0-9_.]/;
const statesWhole = (code, text) => {
  for (let i = code.indexOf(text); i !== -1; i = code.indexOf(text, i + 1)) {
    const before = code[i - 1], after = code[i + text.length];
    if (!(before && WORDISH.test(before)) && !(after && WORDISH.test(after))) return true;
  }
  return false;
};
/** The 1-based number of the first line of `body` that states `text` whole, outside a comment; 0 when none does. `scrubbed`: compare after the scrubber, for a text kept scrubbed. */
const lineStating = (body, text, { scrubbed = false } = {}) => body.split("\n").findIndex((l) => statesWhole(scrubbed ? scrub(codeOf(l)) : codeOf(l), text)) + 1;
// why an --assert value is not an assertion, or null: it is refused as written, before any file is read
const assertRefusal = (text) => (!/[A-Za-z0-9]/.test(text) ? "the text needs a letter or a digit" : /[\r\n]/.test(text) ? "the text is one line" : null);
function checkAssert(path, text) {
  const at = shown(path), kept = scrub(text), scrubbed = kept !== text;
  if (!isFile(path)) return { path: at, text: kept, ok: false, why: `${at} does not exist`, lines: [] };
  const body = readFileSync(path, "utf8"), rows = body.split("\n");
  const line = lineStating(body, text);
  if (line) return { path: at, text: kept, ok: true, sha256: sha256(path), line, shows: clip(scrub(rows[line - 1])), scrubbed };
  const k = /[=:]/.exec(text), key = k ? text.slice(0, k.index).trim() : "", lines = [];
  if (key) {
    const hits = rows.map((l, i) => [i + 1, l]).filter(([, l]) => l.includes(key));
    for (const [n, l] of hits.slice(0, 5)) lines.push(`${at}:${n}: ${clip(scrub(l))}`);
    if (hits.length > 5) lines.push(`(+${hits.length - 5} more line(s) with "${scrub(key)}")`);
    if (!hits.length) lines.push(`no line of ${at} contains "${scrub(key)}"`);
  }
  if (COMMENT.test(text)) lines.push("the text has # or // at its start or after a space: what follows one on a line is read as a comment, not as a value");
  return { path: at, text: kept, ok: false, why: `${at} does not contain "${kept}" as a whole value outside a comment`, lines };
}

function seal(argv, core) {
  const p = parse(argv, { single: ["spec", "note"], multi: ["file", "assert", "forbid"] });
  if (p.error) return usage(p.error);
  const [id, ...extra] = p.pos, { spec, note } = p.opts;
  if (!id || extra.length || !spec) return usage();
  if (!ID.test(id)) { console.error(`memory-pulse prereg seal: "${id}" is not an id (letters, digits, dot, dash and underscore)`); return 1; }
  const open = seals(core.readEvents().events).findLast((s) => s.id === id && !s.settle);
  if (open) { console.error(`memory-pulse prereg seal: "${id}" already has an open seal (row ${open.row}, ${utcOf(open.at)}); settle it, or seal under another id. Nothing was written`); return 1; }
  for (const f of [spec, ...p.opts.file]) if (!isFile(f)) { console.error(`memory-pulse prereg seal: ${f}: no such file; nothing was written`); return 1; }
  const forbid = [];
  for (const src of p.opts.forbid) { const pat = toPattern(src); if (!pat) { console.error(`memory-pulse prereg seal: --forbid '${src}' is not a regular expression; nothing was written`); return 1; } forbid.push(pat.src); }
  // every assertion is checked before anything is written
  const asserts = [];
  for (const a of p.opts.assert) {
    const i = a.indexOf("::"), text = i > 0 ? a.slice(i + 2).trim() : "", why = i > 0 ? assertRefusal(text) : null;
    if (i <= 0 || why) { console.error(`memory-pulse prereg seal: --assert takes '<path>::<text>' (got '${scrub(a)}')${why ? `: ${why}` : ""}; nothing was written`); return 1; }
    asserts.push(checkAssert(a.slice(0, i), text));
  }
  const failed = asserts.filter((a) => !a.ok);
  if (failed.length) {
    console.error(`memory-pulse prereg seal ${id}: ${failed.length} of ${asserts.length} assertion(s) failed; nothing was written`);
    for (const a of failed) { console.error(`  assert FAILED: ${a.why}`); for (const l of a.lines) console.error(`    ${l}`); }
    console.error("A constant a spec states about a deployed system is asserted against the file that defines it. Correct the spec, then seal again.");
    return 1;
  }
  const entry = (f) => ({ path: shown(f), sha256: sha256(f), bytes: statSync(f).size });
  const specEntry = entry(spec), files = p.opts.file.map(entry);
  const now = new Date(), s = stamps(now);   // the stamp is this reading of the clock; no caller supplies one
  const auto = `prereg ${id} sealed ${s.utc} (${s.iso}): spec ${specEntry.path} sha256 ${specEntry.sha256.slice(0, 12)}; ${files.length} more file(s), ${asserts.length} assertion(s), ${forbid.length} forbid pattern(s)`;
  const r = core.appendEvent({ cause: `prereg ${id}`, effect: `sealed ${specEntry.sha256.slice(0, 12)}`, note: note ? `${auto}. ${note}` : auto, tags: ["prereg", `prereg:${id}`, "prereg-seal"], owner: PREREG_WRITE,
    // capture_key names this one event, so a seal is never refused as a restatement of an earlier row with the same words
    fields: { capture_key: `prereg|${id}|seal|${now.getTime()}`, prereg: { id, op: "seal", at: s.iso, ms: now.getTime(), dir: tilde(process.cwd()), spec: specEntry, files, asserts: asserts.map(({ path, text, sha256: h, line, scrubbed }) => ({ path, text, sha256: h, line, ...(scrubbed ? { scrubbed: true } : {}) })), forbid } } });
  if (!r.written) { console.error(`memory-pulse prereg seal: not recorded: ${r.reason}${r.hint ? ` (${r.hint})` : ""}`); return 1; }
  if (forbid.length) {
    const file = rulesFile(core);
    const lines = forbid.map((pat, i) => JSON.stringify({ id: `prereg:${id}:forbid-${i + 1}`, on: "command", statement: `sealed by prereg ${id} at row ${r.t}: this command is the evaluator's; hand it to an evaluator, or settle the prereg`,
      patterns: [pat], severity: "block", owner: { prereg: id, row: r.t }, cite: [r.t] }));
    try { mkdirSync(dirname(file), { recursive: true }); const had = existsSync(file) ? readFileSync(file, "utf8") : ""; appendFileSync(file, `${had && !had.endsWith("\n") ? "\n" : ""}${lines.join("\n")}\n`); }
    catch (e) { console.error(`memory-pulse prereg seal: sealed at row ${r.t}, but the forbid pattern(s) could not be declared in ${file} (${e.message}): the guard does not block them`); return 1; }
  }
  console.log(`prereg ${id}: sealed at row ${r.t}`);
  console.log(`stamp: ${s.utc} · ${s.iso} (paste this)`);
  console.log(`  spec    ${specEntry.path}  sha256 ${specEntry.sha256}`);
  for (const f of files) console.log(`  file    ${f.path}  sha256 ${f.sha256}`);
  for (const a of asserts) {
    console.log(`  assert  ${a.path} :: ${a.text}  (holds)  ${a.path}:${a.line}: ${a.shows}`);
    if (a.scrubbed) console.log(`          kept scrubbed: the secret scrubber took a value out of this assertion, so the row does not record it; prereg verify can compare it only while ${a.path} is as it was sealed`);
  }
  for (const pat of forbid) console.log(`  forbid  ${pat}  blocked by the guard as a shell command while this seal is open`);
  if (forbid.length) console.log(TRIPWIRE);
  console.log(`next: the evaluator runs  memory-pulse prereg verify ${id}  first`);
  return 0;
}

function verify(argv, core) {
  const p = parse(argv, { flags: ["json"] });
  if (p.error) return usage(p.error);
  const [id, ...extra] = p.pos;
  if (!id || extra.length) return usage();
  const s = seals(core.readEvents().events).filter((x) => x.id === id).at(-1);
  if (!s) { console.error(`memory-pulse prereg verify: no seal for "${id}" on this ledger (memory-pulse prereg list shows what is sealed)`); return 1; }
  const m = s.seal.prereg;
  const files = [{ role: "spec", ...m.spec }, ...(Array.isArray(m.files) ? m.files : []).map((f) => ({ role: "file", ...f }))].map((f) => {
    const at = located(f.path, m.dir), now = isFile(at) ? sha256(at) : null;
    return { path: f.path, role: f.role, sealed: f.sha256, now, status: now === null ? "missing" : now === f.sha256 ? "unchanged" : "changed" };
  });
  // an assertion is re-checked by the rule the seal used. One kept scrubbed holds while its file is as it was sealed; once the file
  // changed, a scrubbed value cannot be compared (holds: null), unless no line states even the scrubbed text any more
  const asserts = (Array.isArray(m.asserts) ? m.asserts : []).map((a) => {
    const at = located(a.path, m.dir), body = isFile(at) ? readFileSync(at, "utf8") : null;
    const holds = body === null ? false : !a.scrubbed ? lineStating(body, a.text) > 0 : sha256(at) === a.sha256 ? true : lineStating(body, a.text, { scrubbed: true }) > 0 ? null : false;
    return { path: a.path, text: a.text, holds };
  });
  // files beside the spec that are newer than the seal and were not sealed (an amendment, a second spec): named, never judged
  const since = Number.isFinite(m.ms) ? m.ms : Date.parse(m.at), specAt = located(m.spec.path, m.dir), sealedAt = new Set(files.map((f) => located(f.path, m.dir)));
  let newer = [];
  try {
    newer = readdirSync(dirname(specAt)).sort().map((n) => { const f = join(dirname(specAt), n); if (sealedAt.has(f)) return null; try { const st = statSync(f); return st.isFile() && st.mtimeMs > since ? { path: join(dirname(m.spec.path), n), mtime: new Date(st.mtimeMs).toISOString() } : null; } catch { return null; } }).filter(Boolean);
  } catch { /* the spec's directory is gone: the spec is reported MISSING above */ }
  // commands the guard blocked under this seal (violations.jsonl beside the ledger, local to this machine)
  let blocked = [];
  try { blocked = readFileSync(join(dirname(core.ledgerPath()), "violations.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((b) => b && Array.isArray(b.invariants) && b.invariants.some((i) => String(i).startsWith(`prereg:${id}:`)) && Date.parse(b.at) >= since).map((b) => ({ at: b.at, command: typeof b.command === "string" ? b.command : "" })); } catch { /* none recorded */ }
  const bad = files.filter((f) => f.status !== "unchanged").length, ok = bad === 0;
  const status = s.settle ? "settled" : "open";
  if (p.opts.json) { console.log(JSON.stringify({ id, row: s.row, at: m.at, status, verdict: s.settle?.prereg.verdict ?? null, settled_row: s.settle?.t ?? null, ok, files, asserts, newer, blocked }, null, 2)); return ok ? 0 : 2; }
  console.log(`prereg ${id}: sealed at row ${s.row}, ${utcOf(m.at)} (${s.settle ? `settled ${s.settle.prereg.verdict} at row ${s.settle.t}` : "open"})`);
  for (const f of files) console.log(f.status === "unchanged" ? `  unchanged  ${f.path}  sha256 ${f.sealed}` : f.status === "changed" ? `  CHANGED    ${f.path}  sealed ${f.sealed}  now ${f.now}` : `  MISSING    ${f.path}  sealed ${f.sealed}`);
  for (const a of asserts) console.log(`  ${a.holds ? "assert holds          " : a.holds === null ? "assert NOT COMPARED   " : "assert NO LONGER HOLDS"}  ${a.path} :: ${a.text}${a.holds === null ? "  (kept scrubbed, and the file changed since the seal)" : ""}`);
  if (newer.length) console.log(`  newer than the seal, not sealed: ${newer.slice(0, 20).map((n) => `${n.path} (${n.mtime})`).join(", ")}${newer.length > 20 ? `, +${newer.length - 20} more` : ""}`);
  if (blocked.length) console.log(`  blocked by the guard under this seal: ${blocked.length} command(s), last ${blocked.at(-1).at}: ${blocked.at(-1).command}`);
  console.log(ok ? `verify: all ${files.length} sealed file(s) unchanged` : `verify: ${bad} of ${files.length} sealed file(s) changed or missing`);
  return ok ? 0 : 2;
}

// The seal's rules leave invariants.jsonl; every other line stays byte for byte. The seal row keeps the patterns on record.
function retireRules(file, id) {
  if (!existsSync(file)) return [];
  const keep = [], gone = []; let n = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let inv = null; try { inv = line.trim() ? JSON.parse(line) : null; } catch { inv = null; }
    if (inv && inv.on === "command" && ownerOf(inv)?.prereg === id) { n++; gone.push(...(Array.isArray(inv.patterns) ? inv.patterns : [])); } else keep.push(line);
  }
  if (!n) return gone;
  const text = keep.join("\n");
  if (!text.trim()) unlinkSync(file); else { const tmp = `${file}.tmp-${process.pid}`; writeFileSync(tmp, text); renameSync(tmp, file); }
  return gone;
}

function settle(argv, core) {
  const p = parse(argv, { single: ["verdict", "file", "note"] });
  if (p.error) return usage(p.error);
  const [id, ...extra] = p.pos, { verdict, file, note } = p.opts;
  if (!id || extra.length || !verdict || !file) return usage();
  if (!ID.test(verdict)) { console.error(`memory-pulse prereg settle: --verdict takes one word (letters, digits, dot, dash and underscore), such as KEEP or KILL; the reasons go in the verdict file`); return 1; }
  const mine = seals(core.readEvents().events).filter((s) => s.id === id), open = mine.findLast((s) => !s.settle);
  if (!open) { const last = mine.at(-1); console.error(`memory-pulse prereg settle: no open seal for "${id}"${last ? `: it was settled ${last.settle.prereg.verdict} at row ${last.settle.t}` : " on this ledger (memory-pulse prereg list shows what is sealed)"}. Nothing was written`); return 1; }
  if (!isFile(file)) { console.error(`memory-pulse prereg settle: ${file}: no such file; nothing was written`); return 1; }
  const f = { path: shown(file), sha256: sha256(file), bytes: statSync(file).size };
  const now = new Date(), s = stamps(now);
  const auto = `prereg ${id} settled ${verdict} ${s.utc} (${s.iso}): verdict file ${f.path} sha256 ${f.sha256.slice(0, 12)}; seal row ${open.row}`;
  const r = core.appendEvent({ cause: `prereg ${id}`, effect: `settled ${verdict} ${f.sha256.slice(0, 12)}`, note: note ? `${auto}. ${note}` : auto, tags: ["prereg", `prereg:${id}`, "prereg-settle"], owner: PREREG_WRITE,
    fields: { capture_key: `prereg|${id}|settle|${now.getTime()}`, prereg: { id, op: "settle", at: s.iso, ms: now.getTime(), verdict, file: f, seal: open.row } } });
  if (!r.written) { console.error(`memory-pulse prereg settle: not recorded: ${r.reason}${r.hint ? ` (${r.hint})` : ""}`); return 1; }
  let retired = [];
  try { retired = retireRules(rulesFile(core), id); }
  catch (e) { console.error(`memory-pulse prereg settle: settled at row ${r.t}, but the seal's rules could not be removed from ${rulesFile(core)} (${e.message}): delete the lines whose owner is this prereg, or the guard keeps blocking`); return 1; }
  console.log(`prereg ${id}: settled ${verdict} at row ${r.t} (seal row ${open.row})`);
  console.log(`stamp: ${s.utc} · ${s.iso} (paste this)`);
  console.log(`  verdict  ${f.path}  sha256 ${f.sha256}`);
  for (const pat of retired) console.log(`  retired  ${pat}  no longer blocked`);
  return 0;
}

function list(argv, core) {
  const p = parse(argv, { flags: ["json"] });
  if (p.error || p.pos.length) return usage(p.error);
  const all = seals(core.readEvents().events).map((s) => ({ id: s.id, row: s.row, at: s.at, status: s.settle ? "settled" : "open", verdict: s.settle?.prereg.verdict ?? null, settled_row: s.settle?.t ?? null, settled_at: s.settle?.prereg.at ?? null }));
  if (p.opts.json) { console.log(JSON.stringify(all, null, 2)); return 0; }
  if (!all.length) { console.log("prereg: no seals on this ledger"); return 0; }
  console.log(`prereg: ${all.length} seal(s), ${all.filter((s) => s.status === "open").length} open`);
  for (const s of all) console.log(`  ${s.id}  ${s.status === "open" ? "open" : `settled ${s.verdict}`}  row ${s.row}  ${utcOf(s.at)}${s.status === "settled" ? `  settled at row ${s.settled_row}, ${utcOf(s.settled_at)}` : ""}`);
  return 0;
}

/** `memory-pulse prereg seal|verify|settle|list`. core: {ledgerPath, readEvents, appendEvent}. Returns the exit code. */
export function cliPrereg(argv, core) {
  const [op, ...rest] = argv;
  return op === "seal" ? seal(rest, core) : op === "verify" ? verify(rest, core) : op === "settle" ? settle(rest, core) : op === "list" ? list(rest, core) : usage();
}

// ---- ran. Capture writes one observation per tool call into the session's episode file; for a shell command that is obs.cmd (the
// first 200 characters, secrets scrubbed, a leading `cd <dir> &&` dropped), obs.at (the time it finished), obs.ok and obs.exit.
const RAN_USAGE = `usage: memory-pulse ran '<regex>' [--since <row|ISO time>] [--json]
  the recorded shell commands that match, with time and session; --since takes a prereg row (its stamp) or a time as memory-pulse now prints it`;
const RAN_LIMIT = "This is what the capture hook recorded on this machine: the first 200 characters of each command, secrets scrubbed, a leading cd dropped. A command run where the hook is not installed is not here.";
// a time as `now` prints it (2026-11-19 02:15 UTC, 2026-11-19T02:15:07Z), read as UTC; anything else Date.parse reads
function timeOf(v) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2}(?:\.\d+)?))?)?\s*(?:Z|UTC)?$/.exec(String(v).trim());
  return m ? Date.parse(`${m[1]}T${m[2] ?? "00:00"}:${m[3] ?? "00"}Z`) : Date.parse(v);
}
export function cliRan(argv, core) {
  // the pattern comes first and is taken as written: '--n 4096' and '--confirm' are patterns, not options
  const lead = argv.length && !/^--(?:json|since)(?:=|$)/.test(argv[0]) ? [argv[0]] : [];
  const p = parse(argv.slice(lead.length), { single: ["since"], flags: ["json"] });
  if (p.error) { console.error(`memory-pulse ran: ${p.error}\n${RAN_USAGE}`); return 1; }
  const [src, ...extra] = [...lead, ...p.pos];
  if (!src || extra.length) { console.error(RAN_USAGE); return 1; }
  const pat = toPattern(src);
  if (!pat) { console.error(`memory-pulse ran: '${src}' is not a regular expression`); return 1; }
  let since = null, sinceText = "";
  if (p.opts.since !== undefined) {
    if (/^\d+$/.test(p.opts.since)) {
      const t = Number(p.opts.since), row = core.readEvents().events.find((e) => e.t === t);
      if (!row) { console.error(`memory-pulse ran: no row ${t} on this ledger`); return 1; }
      since = isPrereg(row) ? (Number.isFinite(row.prereg.ms) ? row.prereg.ms : Date.parse(row.prereg.at)) : NaN;
      if (!Number.isFinite(since)) { console.error(`memory-pulse ran: row ${t} carries no stamp (a prereg row records the clock; other rows do not). Pass a time instead: memory-pulse now prints one`); return 1; }
      sinceText = `row ${t} (${row.cause} ${row.effect}, ${row.prereg.at})`;
    } else {
      since = timeOf(p.opts.since);
      if (!Number.isFinite(since)) { console.error(`memory-pulse ran: --since takes a row number or a time (2026-11-19T02:15:07Z or "2026-11-19 02:15 UTC"), not '${p.opts.since}'`); return 1; }
      sinceText = new Date(since).toISOString();
    }
  }
  const dir = join(dirname(core.ledgerPath()), "episodes");
  let files = []; try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort(); } catch { /* no episodes: capture has not run here */ }
  const matches = [], sessions = new Set(); let commands = 0;
  for (const f of files) {
    const session = f.slice(0, -".jsonl".length);
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      let o = null; try { o = line.trim() ? JSON.parse(line).obs : null; } catch { o = null; }
      if (!o || o.op !== "run" || typeof o.cmd !== "string") continue;
      commands++;
      if (since !== null && !(Date.parse(o.at) >= since)) continue;
      if (!pat.re.test(o.cmd)) continue;
      sessions.add(session);
      matches.push({ at: o.at, session, cmd: o.cmd, ok: o.ok === true, exit: o.exit ?? null, ...(o.denied ? { denied: true } : {}), ...(o.interrupted ? { interrupted: true } : {}), evaluator: evaluatorCommand(o.cmd) });
    }
  }
  matches.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  if (p.opts.json) { console.log(JSON.stringify({ pattern: pat.src, since: since === null ? null : new Date(since).toISOString(), searched: { sessions: files.length, commands }, matches }, null, 2)); return 0; }
  if (!files.length) { console.log(`ran ${pat.src}: no capture record beside this ledger (${dir} holds no episode). The capture hook has not run here, so this says nothing about what ran.`); return 0; }
  console.log(`ran ${pat.src}: ${matches.length} of ${commands} recorded command(s) match, in ${sessions.size} of ${files.length} session(s)${sinceText ? `, since ${sinceText}` : ""}`);
  for (const m of matches) console.log(`  ${m.at}  session ${m.session}  ${m.denied ? "denied" : m.interrupted ? "interrupted" : m.ok ? "ok" : `exit ${m.exit ?? "?"}`}  ${m.cmd}${m.evaluator ? "  [evaluator]" : ""}`);
  console.log(RAN_LIMIT);
  return 0;
}
