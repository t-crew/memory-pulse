// Rule packs. A pack is a prepared, sourced set of rules for one stack: one JSONL file whose first line is the header
// {name, version, description, stack} and whose other lines are rules in the invariant shape (id, statement, patterns, paths,
// severity, replacement) plus `source`, the URL of the vendor page that states the change, and `verified`, the date that page was
// read. Bundled packs ship in packs/ beside this folder. An installed pack is a copy at .memory-pulse/packs/<name>.jsonl: its own
// file, committed and reviewed like any other change, removed by deleting it, never appended to invariants.jsonl and never a
// ledger row. The loader that guard, check and lint share (server.mjs readInvariants) reads installed packs through
// installedPackRules. A project's own choices (one rule off, to warn, or to block) live in .memory-pulse/packs/overrides.jsonl, so
// re-adding a newer pack never fights them. Nothing here reads the network. Plain code, Node built-ins only.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, lstatSync, realpathSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname, basename, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { INVARIANT_HINT } from "./prereg.mjs";

export const BUNDLED_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "packs");
const OVERRIDES = "overrides.jsonl";
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/, RULE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/;
const RESERVED = new Set(["overrides", "fixtures"]);
const HEADER_KEYS = new Set(["name", "version", "description", "stack"]);
const RULE_KEYS = new Set(["id", "statement", "patterns", "paths", "severity", "replacement", "source", "verified", "since", "note"]);

// ---- paths. An entry with a `*` is a glob; an entry without one is a prefix, matched with startsWith on the path as given, which
// is what 0.18.0 did for every entry. In a glob: `**/` is zero or more directories, `**` anything, `*` anything inside one path
// segment, `?` one character of a segment, {a,b} either. Brackets and parentheses are literal (a Next.js route folder is
// app/[slug]/). A glob is matched against the project-relative form of the path, because Claude Code sends absolute paths.
export const isGlob = (p) => typeof p === "string" && p.includes("*");
const esc = (c) => c.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
function globSource(g) {
  let re = "", i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      if ((i === 0 || g[i - 1] === "/") && g[i + 2] === "/") { re += "(?:[^/]+/)*"; i += 3; continue; }
      re += ".*"; i += 2; continue;
    }
    if (c === "*") { re += "[^/]*"; i++; continue; }
    if (c === "?") { re += "[^/]"; i++; continue; }
    if (c === "{") { const end = g.indexOf("}", i); if (end > i + 1) { re += `(?:${g.slice(i + 1, end).split(",").map(globSource).join("|")})`; i = end + 1; continue; } }
    re += esc(c); i++;
  }
  return re;
}
const GLOBS = new Map();
const globRe = (glob) => { let re = GLOBS.get(glob); if (!re) { re = new RegExp(`^${globSource(norm(glob))}$`); GLOBS.set(glob, re); } return re; };
const norm = (p) => String(p).replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
// the project a path is made relative to: the folder that holds .memory-pulse/packs (set by the loader), then the working directory
let ROOTS = [];
const real = (p) => { let head = p, tail = ""; for (let i = 0; i < 64 && head && !existsSync(head); i++) { tail = join(basename(head), tail); const up = dirname(head); if (up === head) break; head = up; } try { return join(realpathSync(head), tail); } catch { return p; } };
function relForms(path) {
  const p = norm(path);
  if (!isAbsolute(String(path)) && !/^[A-Za-z]:\//.test(p)) return [p];
  const roots = [...new Set([...ROOTS, process.cwd()])];
  const under = (abs, root) => { const r = norm(root).replace(/\/+$/, ""); return abs.startsWith(r + "/") ? abs.slice(r.length + 1) : null; };
  let out = roots.map((r) => under(p, r)).filter((x) => x !== null);
  // /tmp against /private/tmp: the same folder under two names
  if (!out.length) { const rp = norm(real(String(path))); out = roots.map((r) => under(rp, real(r))).filter((x) => x !== null); }
  return out.length ? out : [p.replace(/^\/+/, "")];
}
export function globMatch(glob, path) { const re = globRe(glob); return relForms(path).some((f) => re.test(f)); }
/** One `paths` entry against a path: the 0.18.0 prefix test for every entry, and the glob test for an entry with a `*`. */
export const scopeHas = (entry, path) => typeof entry === "string" && typeof path === "string" && (path.startsWith(entry) || (isGlob(entry) && globMatch(entry, path)));
const inScope = (rule, path) => { const scope = Array.isArray(rule?.paths) ? rule.paths.filter((x) => typeof x === "string" && x) : []; return !scope.length || scope.some((p) => scopeHas(p, path)); };

// ---- patterns, as server.mjs compiles them: /…/flags is a regular expression, anything else a verbatim substring
const reParts = (p) => (typeof p === "string" ? p.match(/^\/(.+)\/([a-z]*)$/s) : null);
function compile(p) {
  const m = reParts(p);
  if (m) { try { return { src: p, re: new RegExp(m[1], m[2].replace(/[gy]/g, "")) }; } catch { return null; } }
  return typeof p === "string" && p ? { src: p, sub: p } : null;
}
/** Every match of one pattern in a text, as character offsets (a zero-length match never loops). */
function offsets(c, text, cap = 500) {
  const out = [];
  if (c.sub) { for (let i = text.indexOf(c.sub); i >= 0 && out.length < cap; i = text.indexOf(c.sub, i + c.sub.length)) out.push(i); return out; }
  const g = new RegExp(c.re.source, c.re.flags + "g"); let m;
  while ((m = g.exec(text)) && out.length < cap) { out.push(m.index); if (m[0].length === 0) g.lastIndex++; }
  return out;
}

// ---- the pack file
export function parsePack(text) {
  const findings = [], rules = []; let header = null, first = true;
  for (const [i, raw] of String(text).split("\n").entries()) {
    const l = raw.trim(); if (!l) continue; const n = i + 1; const wasFirst = first; first = false;
    let o; try { o = JSON.parse(l); } catch { findings.push(`line ${n}: not valid JSON`); continue; }
    if (!o || typeof o !== "object" || Array.isArray(o)) { findings.push(`line ${n}: not a JSON object`); continue; }
    if (wasFirst) {
      if (typeof o.name === "string" && o.id === undefined && o.patterns === undefined) { header = o; continue; }
      findings.push(`line ${n}: the first line must be the pack header: {"name","version","description","stack"}`);
    }
    rules.push({ line: n, rule: o });
  }
  return { header, rules, findings };
}
const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const show = (p) => (reParts(p) ? p : JSON.stringify(p));

// A long line must not stall the guard, which runs every pattern on every edit. Each regular expression is timed in a child
// process (a pattern that backtracks without end cannot be interrupted in this one) against lines of LONG characters: runs of
// common characters and of the pattern's own literal text. Over BUDGET ms on one line, or no answer before the child's deadline,
// and the pattern is refused.
const LONG = 200000, BUDGET = 250;
function timingChild() {
  const fs = require("node:fs");
  const { patterns, n, budget } = JSON.parse(fs.readFileSync(0, "utf8"));
  const rep = (s) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
  const BASE = ["a", " ", "0", ".", "-", "_", "/", "\"", "'", "(", "=", "<", "\t", "a ", "a.", "ab"];
  const CLASS = "bBdDsSwWnrtfvpPkux";
  for (let i = 0; i < patterns.length; i++) {
    fs.writeSync(1, `S ${i}\n`);
    const { src, flags } = patterns[i]; let re; try { re = new RegExp(src, flags); } catch { fs.writeSync(1, `D ${i} 0\n`); continue; }
    // the pattern's literal runs: text a real line could repeat in front of whatever the pattern then fails to find
    const lits = new Set(); let cur = "";
    const flush = () => { if (cur.length >= 2) lits.add(cur); cur = ""; };
    for (let j = 0; j < src.length; j++) {
      const c = src[j];
      if (c === "\\") { const d = src[j + 1] ?? ""; j++; if (CLASS.includes(d) || /\d/.test(d)) flush(); else cur += d; continue; }
      if (/[A-Za-z0-9_ ,:;=<>@#%&!~"'-]/.test(c)) cur += c; else flush();
    }
    flush();
    const own = [...lits].slice(0, 8);
    const probes = BASE.concat(own, own.map((l) => `${l} `), own.length > 1 ? [`${own.join(" ")} `] : []).map(rep);
    let worst = 0;
    for (const p of probes) { const t = process.hrtime.bigint(); re.test(`${p}\u0000`); const ms = Number(process.hrtime.bigint() - t) / 1e6; if (ms > worst) worst = ms; if (worst > budget) break; }
    fs.writeSync(1, `D ${i} ${worst.toFixed(1)}\n`);
  }
}
function slowPatterns(list) {
  const slow = new Map(); let rest = list.map((p, i) => ({ ...p, i }));
  while (rest.length) {
    const deadline = 3000 + 150 * rest.length;
    const r = spawnSync(process.execPath, ["--input-type=commonjs", "-e", `(${timingChild.toString()})()`], { input: JSON.stringify({ patterns: rest, n: LONG, budget: BUDGET }), encoding: "utf8", timeout: deadline, killSignal: "SIGKILL", maxBuffer: 1 << 20 });
    const done = new Map(); let started = -1;
    for (const line of String(r.stdout ?? "").split("\n")) { const m = /^([SD]) (\d+)(?: ([\d.]+))?$/.exec(line); if (!m) continue; if (m[1] === "S") started = Number(m[2]); else done.set(Number(m[2]), Number(m[3])); }
    for (const [k, ms] of done) if (ms > BUDGET) slow.set(rest[k].i, `${Math.round(ms)} ms on a line of ${LONG.toLocaleString("en-US")} characters`);
    if (started >= 0 && !done.has(started)) { slow.set(rest[started].i, `no answer in ${Math.round(deadline / 1000)} s on a line of ${LONG.toLocaleString("en-US")} characters`); rest = rest.slice(started + 1); continue; }
    if (started < 0 && rest.length) return { slow, failed: String(r.error?.message ?? r.stderr ?? "the timing run did not start").slice(0, 200) };
    break;
  }
  return { slow, failed: null };
}

/** Lint one pack file. errors refuse it (pack add will not install it); warnings do not. */
export function verifyPack(path, { timing = true } = {}) {
  let text; try { text = readFileSync(path, "utf8"); } catch (e) { return { ok: false, errors: [`cannot read ${path}: ${e.code ?? e.message}`], warnings: [], header: null, rules: [] }; }
  const { header, rules, findings } = parsePack(text); const errors = [...findings], warnings = [];
  if (header) {
    if (!NAME_RE.test(header.name)) errors.push(`header: name ${JSON.stringify(header.name)} must be lowercase letters, digits and dashes, 2 to 41 characters`);
    else if (RESERVED.has(header.name)) errors.push(`header: name ${JSON.stringify(header.name)} is reserved`);
    if (typeof header.version !== "string" || !/^\d+\.\d+\.\d+$/.test(header.version)) errors.push("header: version must be three numbers, such as 1.0.0");
    if (typeof header.description !== "string" || !header.description.trim() || /\n/.test(header.description)) errors.push("header: description is required, on one line");
    if (typeof header.stack !== "string" || !header.stack.trim()) errors.push("header: stack is required (the framework, language or vendor the rules are about)");
    for (const k of Object.keys(header)) if (!HEADER_KEYS.has(k)) warnings.push(`header: unknown field ${JSON.stringify(k)}`);
  }
  if (!rules.length) errors.push("the pack has no rules");
  const seen = new Map(), good = [], timed = []; const today = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  for (const { line, rule } of rules) {
    if (typeof rule.id !== "string" || !RULE_ID_RE.test(rule.id)) { errors.push(`line ${line}: a rule needs an id of lowercase letters, digits, dot, dash or underscore${typeof rule.id === "string" ? ` (got ${JSON.stringify(rule.id)})` : ""}`); continue; }
    const id = rule.id, bad = (m) => errors.push(`${id}: ${m}`);
    if (seen.has(id)) { errors.push(`line ${line}: rule id ${JSON.stringify(id)} appears twice (first on line ${seen.get(id)})`); continue; }
    seen.set(id, line); good.push(rule);
    if (rule.on !== undefined) bad('a rule on shell commands ("on": "command") is not accepted in a pack');
    const pats = Array.isArray(rule.patterns) ? rule.patterns : [];
    if (!pats.length || pats.some((p) => typeof p !== "string" || !p)) bad("no pattern: patterns must be a non-empty array of strings");
    for (const p of pats.filter((x) => typeof x === "string" && x)) {
      const c = compile(p);
      if (!c) { bad(`pattern ${show(p)} does not compile`); continue; }
      if (c.sub) { if (c.sub.trim().length < 4) bad(`pattern ${show(p)} is a verbatim substring and must be at least 4 characters`); continue; }
      const zero = c.re.test("") || ["a", "a b", "x.y(z)", "import x\n", "  \n"].some((s) => { const m = c.re.exec(s); return !!m && m[0].length === 0; });
      if (zero) { bad(`pattern ${show(p)} matches the empty string`); continue; }
      const m = reParts(p);
      if (/(^|[^\\[])\^|[^\\]\$($|\))/.test(m[1]) && !m[2].includes("m")) warnings.push(`${id}: pattern ${show(p)} anchors with ^ or $ and has no m flag, so it anchors to the whole edit and not to a line`);
      timed.push({ id, p, src: c.re.source, flags: c.re.flags });
    }
    if (typeof rule.source !== "string" || !rule.source.trim()) bad("no source: the https URL of the vendor page that states the change");
    else if (!/^https:\/\/[^\s/]+\.[^\s/]+(\/\S*)?$/.test(rule.source)) bad("source must be an https URL");
    if (!validDate(rule.verified)) bad("verified must be the date the source was read, as YYYY-MM-DD");
    else if (rule.verified > today) bad(`verified ${rule.verified} is in the future`);
    else if (Date.now() - Date.parse(`${rule.verified}T00:00:00Z`) > 365 * 864e5) warnings.push(`${id}: the source was last read on ${rule.verified}, more than a year ago`);
    const has = (k) => typeof rule[k] === "string" && rule[k].trim();
    if (!has("statement") && !has("replacement")) bad("needs a statement or a replacement");
    if (rule.severity !== "block" && rule.severity !== "warn") bad('severity must be "block" or "warn"');
    const paths = Array.isArray(rule.paths) ? rule.paths : null;
    if (!paths || !paths.length || paths.some((p) => typeof p !== "string" || !p)) bad('paths is required: one or more globs, such as "**/*.py"');
    else for (const p of paths) if (!isGlob(p)) bad(`paths entry ${JSON.stringify(p)} is a prefix, and a pack rule needs a glob (write ${JSON.stringify(p.endsWith("/") ? `${p}**` : `**/${p}`)})`);
    for (const k of Object.keys(rule)) if (!RULE_KEYS.has(k) && k !== "on") warnings.push(`${id}: unknown field ${JSON.stringify(k)}`);
  }
  if (timing && timed.length) {
    const { slow, failed } = slowPatterns(timed);
    for (const [i, why] of slow) errors.push(`${timed[i].id}: pattern ${show(timed[i].p)} takes too long on a long line (${why})`);
    if (failed) errors.push(`the long-line timing could not run: ${failed}`);
  }
  return { ok: errors.length === 0, errors, warnings, header, rules: good, text };
}

// ---- overrides: one line per standing choice, {"rule":"<pack>/<id>","severity":"off"|"warn"|"block","reason"?}; "<pack>/*" with
// "warn" is what `pack add --warn-only` writes (every rule of the pack reports, none blocks). The later line wins.
export function readOverrides(packsDir) {
  const out = new Map();
  let text; try { text = readFileSync(join(packsDir, OVERRIDES), "utf8"); } catch { return out; }
  for (const l of text.split("\n")) { if (!l.trim()) continue; try { const o = JSON.parse(l); if (o && typeof o.rule === "string" && ["off", "warn", "block"].includes(o.severity)) { out.delete(o.rule); out.set(o.rule, o); } } catch { /* a torn line is no choice */ } }
  return out;
}
function writeOverrides(packsDir, map) {
  const p = join(packsDir, OVERRIDES);
  if (!map.size) { try { unlinkSync(p); } catch { /* none */ } return; }
  mkdirSync(packsDir, { recursive: true });
  writeFileSync(p, [...map.values()].map((o) => JSON.stringify(o)).join("\n") + "\n");
}
const ownSeverity = (rule) => (rule.severity === "warn" ? "warn" : "block");
function effective(ov, name, id, own) {
  const one = ov.get(`${name}/${id}`); if (one) return one.severity;
  return ov.get(`${name}/*`)?.severity === "warn" ? "warn" : own;
}

// ---- the loader's half: every installed pack's rules, in the invariant shape, with this project's choices applied
const packFiles = (packsDir) => { try { return readdirSync(packsDir).filter((f) => f.endsWith(".jsonl") && f !== OVERRIDES).sort(); } catch { return []; } };
function readPackFile(path) {
  let text; try { text = readFileSync(path, "utf8"); } catch { return null; }
  const { header, rules } = parsePack(text);
  if (!header || typeof header.name !== "string" || !NAME_RE.test(header.name)) return null;
  return { ...header, path, text, rules: rules.map((r) => r.rule).filter((r) => typeof r.id === "string" && Array.isArray(r.patterns)) };
}
const asInvariant = (pack, rule, severity) => ({ id: `${pack.name}/${rule.id}`, ...(rule.statement ? { statement: rule.statement } : {}), patterns: rule.patterns, ...(Array.isArray(rule.paths) ? { paths: rule.paths } : {}), severity,
  ...(rule.replacement ? { replacement: rule.replacement } : {}), pack: { name: pack.name, rule: rule.id, version: pack.version, source: rule.source, verified: rule.verified, own: ownSeverity(rule), file: pack.path } });
export function installedPackRules(packsDir) {
  const files = packFiles(packsDir); if (!files.length) return [];
  if (basename(dirname(resolve(packsDir))) === ".memory-pulse") ROOTS = [dirname(dirname(resolve(packsDir)))];
  const ov = readOverrides(packsDir), out = [];
  for (const f of files) {
    const pack = readPackFile(join(packsDir, f)); if (!pack) continue;
    for (const rule of pack.rules) {
      if (rule.on !== undefined) continue;
      const severity = effective(ov, pack.name, rule.id, ownSeverity(rule));
      if (severity !== "off") out.push(asInvariant(pack, rule, severity));
    }
  }
  return out;
}

// ---- what a hit says. The line names the pack, the rule, what to use instead and the vendor page; the hint names the override.
export function packReason(inv, severity, matched) {
  const p = inv.pack, rep = typeof inv.replacement === "string" ? inv.replacement.trim().replace(/\.$/, "") : "";
  return `${severity === "warn" ? "warning " : ""}pack ${p.name}, rule ${p.rule}${inv.statement ? `: ${inv.statement}` : ""} (matched ${matched})${rep ? ` — instead: ${rep}` : ""}. Source: ${p.source} (read ${p.verified})`;
}
const shownPath = (p) => { const r = relative(process.cwd(), p); return r && !r.startsWith("..") && !isAbsolute(r) ? r.split("\\").join("/") : p; };
/** The guard's closing hint when a pack rule blocked: the override, in place of "an override does not apply". */
export function packHint(blocked, invariants, hint) {
  const byId = new Map((invariants ?? []).filter((i) => i?.pack).map((i) => [i.id, i]));
  const blocking = (b) => (b.v?.invariants ?? []).filter((h) => h.severity === "block");
  const ids = [...new Set(blocked.flatMap(blocking).map((h) => h.id).filter((id) => byId.has(id)))];
  if (!ids.length) return hint;
  const declared = blocked.some((b) => !b.command && blocking(b).some((h) => !byId.has(h.id)));
  const base = declared ? hint : String(hint ?? "").split("\n").filter((l) => l !== INVARIANT_HINT).join("\n");
  const files = [...new Set(ids.map((id) => shownPath(byId.get(id).pack.file)))].join(", ");
  const cmds = ids.slice(0, 3).map((id) => `memory-pulse pack rule ${id} warn (reports, does not block) or memory-pulse pack rule ${id} off`).join("; ");
  const text = `${ids.length > 1 ? "These rules come" : "This rule comes"} from an installed rule pack (${files}), not from a correction, so guard allow does not apply. Change the text. If the rule is wrong for this project, change it here without editing the pack: ${cmds}. The choice is written to ${shownPath(join(dirname(byId.get(ids[0]).pack.file), OVERRIDES))}.`;
  return [base, text].filter(Boolean).join("\n");
}
/** The warn-rule lines of one verdict, and the context the guard hands the agent when the edit is allowed. */
export const packWarnings = (v) => (v?.reasons ?? []).filter((r) => typeof r === "string" && r.startsWith("warning pack "));
export const packContext = (lines) => { const l = [...lines]; return l.length ? `memory-pulse: an installed rule pack has ${l.length === 1 ? "a warning" : `${l.length} warnings`} for this edit. The edit is not blocked:\n${l.map((x) => `  ${x}`).join("\n")}` : ""; };
/** The engine matches `paths` as prefixes and knows nothing of packs: a glob scope is settled here, and a pack rule's source rides in its replacement. */
export function forEngine(invariants, path) {
  const out = [];
  for (const inv of invariants ?? []) {
    const scope = Array.isArray(inv?.paths) ? inv.paths.filter((x) => typeof x === "string" && x) : [];
    if (!inv?.pack && !scope.some(isGlob)) { out.push(inv); continue; }
    if (!inScope(inv, typeof path === "string" ? path : "")) continue;
    const { pack, paths, ...rest } = inv;
    if (!pack) { out.push(rest); continue; }
    const rep = typeof inv.replacement === "string" ? inv.replacement.trim().replace(/\.$/, "") : "";
    out.push({ ...rest, statement: `pack ${pack.name}, rule ${pack.rule}: ${inv.statement ?? ""}`.replace(/: $/, ""), replacement: `${rep ? `${rep}. ` : ""}Source: ${pack.source} (read ${pack.verified})` });
  }
  return out;
}

// ---- pack check: a dry run over a tree, or over the added lines of a diff
const SKIP_DIRS = new Set([".git", "node_modules", ".memory-pulse", ".venv", "venv", "__pycache__", "site-packages", ".next", ".tox", ".mypy_cache"]);
const MAX_FILE = 2 * 1024 * 1024;
function* walk(root, rel = "") {
  let names; try { names = readdirSync(join(root, rel)).sort(); } catch { return; }
  for (const n of names) {
    const r = rel ? `${rel}/${n}` : n; let st; try { st = lstatSync(join(root, r)); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { if (!SKIP_DIRS.has(n)) yield* walk(root, r); continue; }
    if (st.isFile() && st.size <= MAX_FILE) yield r;
  }
}
const binary = (path) => { try { const fd = openSync(path, "r"); const b = Buffer.alloc(4096); const n = readSync(fd, b, 0, 4096, 0); closeSync(fd); return b.subarray(0, n).includes(0); } catch { return true; } };
/** rules: [{key, severity, statement, patterns, paths}]. lineOf maps a character offset of `text` to {line, text}. */
function hitsIn(rules, file, text, lineOf) {
  const out = [], seen = new Set();
  for (const r of rules) for (const p of r.patterns ?? []) {
    const c = compile(p); if (!c) continue;
    for (const at of offsets(c, text)) { const l = lineOf(at); const k = `${r.key}\n${l.line}`; if (seen.has(k)) continue; seen.add(k); out.push({ rule: r.key, severity: r.severity, file, line: l.line, text: l.text.trim().slice(0, 160) }); }
  }
  return out;
}
function wholeFile(text) {
  const starts = [0]; for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (at) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= at) lo = mid; else hi = mid - 1; } const end = text.indexOf("\n", starts[lo]); return { line: lo + 1, text: text.slice(starts[lo], end < 0 ? text.length : end) }; };
}
export function scanTree(rules, root) {
  const hits = []; let files = 0;
  for (const rel of walk(root)) {
    const mine = rules.filter((r) => inScope(r, rel)); if (!mine.length) continue;
    const abs = join(root, rel); if (binary(abs)) continue;
    let text; try { text = readFileSync(abs, "utf8"); } catch { continue; }
    files++; hits.push(...hitsIn(mine, rel, text, wholeFile(text)));
  }
  return { files, hits };
}
/** Added lines of a unified diff, per file: [{file, lines: [{line, text}]}]. */
export function addedByFile(diff) {
  const out = []; let cur = null, n = 0;
  for (const l of String(diff ?? "").split("\n")) {
    if (l.startsWith("+++ ")) { const f = l.slice(4).trim(); cur = f === "/dev/null" ? null : { file: f.replace(/^"?b\//, "").replace(/"$/, ""), lines: [] }; if (cur) out.push(cur); continue; }
    if (l.startsWith("--- ") || l.startsWith("diff --git ")) { if (l.startsWith("diff ")) cur = null; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l); if (h) { n = Number(h[1]); continue; }
    if (!cur) continue;
    if (l.startsWith("+")) { cur.lines.push({ line: n, text: l.slice(1) }); n++; } else if (l.startsWith(" ")) n++;
  }
  return out.filter((f) => f.lines.length);
}
export function scanDiff(rules, diff) {
  const hits = []; let files = 0;
  for (const f of addedByFile(diff)) {
    const mine = rules.filter((r) => inScope(r, f.file)); if (!mine.length) continue;
    files++; const text = f.lines.map((x) => x.text).join("\n"); const ends = []; let at = 0; for (const x of f.lines) { at += x.text.length + 1; ends.push(at); }
    hits.push(...hitsIn(mine, f.file, text, (o) => f.lines[Math.max(0, ends.findIndex((e) => o < e))] ?? f.lines[f.lines.length - 1]));
  }
  return { files, hits };
}

// ---- the command
export const PACK_USAGE = `usage: memory-pulse pack list [--json]
       memory-pulse pack show <name|path> [--json]
       memory-pulse pack add <name|path> [--warn-only]
       memory-pulse pack remove <name>
       memory-pulse pack check <name|path> [dir] [--json]
       memory-pulse pack check --installed [dir | --diff [base]] [--ci] [--json]
       memory-pulse pack rule <pack>/<rule> off|warn|block|default [--reason "..."]
       memory-pulse pack rule <pack> warn|default
       memory-pulse pack verify <name|path>`;
const counts = (rules) => { const warn = rules.filter((r) => r.severity === "warn").length; return { rules: rules.length, block: rules.length - warn, warn }; };
const countText = (c) => `${c.rules} rule${c.rules === 1 ? "" : "s"} (${c.block} block, ${c.warn} warn)`;
const verifiedSpan = (rules) => { const d = rules.map((r) => r.verified).filter(validDate).sort(); return !d.length ? "verified never" : d[0] === d[d.length - 1] ? `verified ${d[0]}` : `verified ${d[0]} to ${d[d.length - 1]}`; };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function cliPack(argv, { dir }) {
  const packsDir = join(dir, "packs");
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const valued = new Set(["--reason"]);
  const pos = []; let reason = null, diffBase;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reason") { reason = argv[++i] ?? ""; continue; }
    if (a === "--diff") { if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) diffBase = argv[++i]; continue; }
    if (a.startsWith("--") && !valued.has(a)) continue;
    pos.push(a);
  }
  const json = flags.has("--json"), say = (s = "") => console.log(s), fail = (s) => { console.error(s); return 1; };
  const installedPath = (name) => join(packsDir, `${name}.jsonl`);
  const bundled = () => packFiles(BUNDLED_DIR).map((f) => readPackFile(join(BUNDLED_DIR, f))).filter(Boolean);
  const installed = () => packFiles(packsDir).map((f) => readPackFile(join(packsDir, f))).filter(Boolean);
  // a name is an installed pack first (the copy in force here), then a bundled one; anything that exists on disk is a path
  const locate = (arg, { preferInstalled = true } = {}) => {
    if (typeof arg !== "string" || !arg) return { error: PACK_USAGE };
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return { error: `packs are not fetched from the network in this version: download the file, read it, then memory-pulse pack add <path>` };
    let isFile = false; try { isFile = lstatSync(arg).isFile(); } catch { /* a name */ }
    if (isFile) return { path: arg };
    if (NAME_RE.test(arg)) {
      if (preferInstalled && existsSync(installedPath(arg))) return { path: installedPath(arg), installed: true };
      if (existsSync(join(BUNDLED_DIR, `${arg}.jsonl`))) return { path: join(BUNDLED_DIR, `${arg}.jsonl`), bundled: true };
    }
    return { error: `no pack named ${JSON.stringify(arg)}: memory-pulse pack list shows the bundled packs, and a path to a pack file works too` };
  };
  const verb = argv[0];

  if (verb === "list") {
    const ov = readOverrides(packsDir), inst = installed(), bund = bundled();
    const row = (p, where) => {
      const mine = inst.find((x) => x.name === p.name), c = counts(p.rules);
      const local = [...ov.keys()].filter((k) => k.startsWith(`${p.name}/`)).length;
      const b = bund.find((x) => x.name === p.name);
      const status = !mine ? "not installed" : `installed${ov.get(`${p.name}/*`)?.severity === "warn" ? ", warn only" : ""}${b && mine.text !== b.text ? ` (differs from the bundled ${b.version})` : ""}${local ? `, ${plural(local, "local choice")}` : ""}`;
      return { name: p.name, version: p.version, stack: p.stack ?? "", description: p.description ?? "", ...c, verified: verifiedSpan(p.rules).replace(/^verified /, ""), bundled: where === "bundled", installed: !!mine, status };
    };
    const rows = [...bund.map((p) => row(inst.find((x) => x.name === p.name) ?? p, "bundled")), ...inst.filter((p) => !bund.some((b) => b.name === p.name)).map((p) => row(p, "local"))];
    if (json) { say(JSON.stringify(rows, null, 2)); return 0; }
    const w = (k) => Math.max(...rows.map((r) => String(r[k]).length), 4);
    const line = (r) => `  ${r.name.padEnd(w("name"))}  ${r.version.padEnd(w("version"))}  ${r.stack.padEnd(w("stack"))}  ${countText(r).padEnd(28)}  verified ${r.verified.padEnd(24)}  ${r.status}\n      ${r.description}`;
    const b = rows.filter((r) => r.bundled), l = rows.filter((r) => !r.bundled);
    say(`bundled with memory-pulse${b.length ? ":" : ": none"}`); for (const r of b) say(line(r));
    if (l.length) { say("installed from a local file:"); for (const r of l) say(line(r)); }
    say(`\ninstalled packs live in ${shownPath(packsDir)}/ as one file each. memory-pulse pack show <name> prints every rule; memory-pulse pack check <name> previews one against this tree; memory-pulse pack add <name> turns it on.`);
    return 0;
  }

  if (verb === "show") {
    const at = locate(pos[0]); if (at.error) return fail(at.error);
    const p = readPackFile(at.path); if (!p) return fail(`${at.path} is not a pack file: memory-pulse pack verify ${at.path} names what is wrong`);
    const here = existsSync(installedPath(p.name)), ov = here ? readOverrides(packsDir) : new Map();
    if (json) { say(JSON.stringify({ name: p.name, version: p.version, stack: p.stack, description: p.description, installed: here, rules: p.rules.map((r) => ({ ...r, effective: effective(ov, p.name, r.id, ownSeverity(r)) })) }, null, 2)); return 0; }
    say(`${p.name} ${p.version} (${p.stack ?? "?"}): ${p.description ?? ""}`);
    say(`${countText(counts(p.rules))}, ${verifiedSpan(p.rules).replace("verified", "sources read")}. ${here ? `Installed in ${shownPath(installedPath(p.name))}.` : `Not installed here: memory-pulse pack add ${at.bundled ? p.name : pos[0]}`}`);
    const w = Math.max(...p.rules.map((r) => r.id.length));
    for (const r of p.rules) {
      const own = ownSeverity(r), eff = effective(ov, p.name, r.id, own);
      say(`\n${r.id.padEnd(w)}  ${eff}${eff !== own ? ` (here; the pack says ${own})` : ""}`);
      if (r.statement) say(`  catches: ${r.statement}`);
      if (r.replacement) say(`  instead: ${r.replacement}`);
      say(`  pattern: ${(r.patterns ?? []).join("   ")}`);
      say(`  paths:   ${(r.paths ?? ["(every path)"]).join("  ")}`);
      say(`  source:  ${r.source ?? "(none)"} (read ${r.verified ?? "never"})`);
    }
    if (here) say(`\nchange one rule for this project without editing the pack: memory-pulse pack rule ${p.name}/<rule> off|warn|block|default`);
    return 0;
  }

  if (verb === "verify") {
    const at = locate(pos[0]); if (at.error) return fail(at.error);
    const v = verifyPack(at.path);
    const title = v.header ? `${v.header.name} ${v.header.version ?? "?"}` : at.path;
    for (const w of v.warnings) say(`  note: ${w}`);
    if (v.ok) { say(`${title}: ${plural(v.rules.length, "rule")}, no findings. Every rule has an id, a pattern that compiles and does not match the empty string or stall on a long line, a source URL, a verified date, paths, and a statement or a replacement.`); return 0; }
    for (const e of v.errors) console.error(`  ${e}`);
    return fail(`${title}: ${plural(v.errors.length, "finding")}. A pack with findings is not installed by pack add.`);
  }

  if (verb === "add") {
    const at = locate(pos[0], { preferInstalled: false }); if (at.error) return fail(at.error);
    const v = verifyPack(at.path);
    if (!v.ok) { for (const e of v.errors) console.error(`  ${e}`); return fail(`not installed: ${at.path} has ${plural(v.errors.length, "finding")} (memory-pulse pack verify ${pos[0]})`); }
    const name = v.header.name, dest = installedPath(name), c = countText(counts(v.rules));
    let before = null; try { before = readFileSync(dest, "utf8"); } catch { /* new */ }
    const was = before === null ? null : parsePack(before).header?.version ?? "?";
    if (before !== v.text) { mkdirSync(packsDir, { recursive: true }); writeFileSync(dest, v.text); }
    say(before === null ? `installed ${name} ${v.header.version}: ${c} in ${shownPath(dest)}` : before === v.text ? `${name} ${v.header.version} is already installed: ${c} in ${shownPath(dest)}` : `updated ${name} ${was} -> ${v.header.version}: ${c} in ${shownPath(dest)}`);
    const ov = readOverrides(packsDir);
    if (flags.has("--warn-only")) { ov.delete(`${name}/*`); ov.set(`${name}/*`, { rule: `${name}/*`, severity: "warn" }); writeOverrides(packsDir, ov); say(`warn only: every rule of ${name} reports and none blocks. memory-pulse pack rule ${name} default lifts that.`); }
    else if (ov.get(`${name}/*`)?.severity === "warn") say(`warn only is still in force here: every rule of ${name} reports and none blocks. memory-pulse pack rule ${name} default lifts that.`);
    const local = [...ov.keys()].filter((k) => k.startsWith(`${name}/`) && k !== `${name}/*`).length;
    if (local) say(`${plural(local, "local choice")} for single rules kept (${shownPath(join(packsDir, OVERRIDES))})`);
    say(`commit ${shownPath(dest)}: guard, check and lint read it from the next edit on. Nothing was added to invariants.jsonl or to the ledger.`);
    say(`preview what it catches in this tree: memory-pulse pack check ${name}`);
    return 0;
  }

  if (verb === "remove") {
    const name = pos[0]; if (!name) return fail(PACK_USAGE);
    if (!NAME_RE.test(name) || !existsSync(installedPath(name))) return fail(`${name} is not installed (memory-pulse pack list)`);
    unlinkSync(installedPath(name));
    const left = [...readOverrides(packsDir).keys()].filter((k) => k.startsWith(`${name}/`)).length;
    say(`removed ${name}: ${shownPath(installedPath(name))} is deleted and its rules no longer apply${left ? `. ${plural(left, "local choice")} for it stay in ${shownPath(join(packsDir, OVERRIDES))} and apply again if it is added back` : ""}`);
    return 0;
  }

  if (verb === "rule") {
    const target = pos[0], sev = pos[1];
    if (!target || !sev) return fail(PACK_USAGE);
    const slash = target.indexOf("/"); const name = slash < 0 ? target : target.slice(0, slash), id = slash < 0 ? "*" : target.slice(slash + 1);
    const pack = NAME_RE.test(name) && existsSync(installedPath(name)) ? readPackFile(installedPath(name)) : null;
    if (!pack) return fail(`${name} is not installed (memory-pulse pack list)`);
    const ov = readOverrides(packsDir), file = shownPath(join(packsDir, OVERRIDES));
    if (id === "*") {
      if (sev !== "warn" && sev !== "default") return fail(`a whole pack takes warn or default: memory-pulse pack rule ${name} warn (every rule reports, none blocks) or memory-pulse pack rule ${name} default. To stop using it: memory-pulse pack remove ${name}`);
      ov.delete(`${name}/*`); if (sev === "warn") ov.set(`${name}/*`, { rule: `${name}/*`, severity: "warn", ...(reason ? { reason } : {}) });
      writeOverrides(packsDir, ov);
      say(sev === "warn" ? `${name}: warn only. Every rule reports and none blocks (recorded in ${file}; the pack file is unchanged)` : `${name}: back to the pack's own severities, except rules with a choice of their own`);
      return 0;
    }
    const rule = pack.rules.find((r) => r.id === id);
    if (!rule) return fail(`no rule ${JSON.stringify(id)} in ${name} (memory-pulse pack show ${name})`);
    if (!["off", "warn", "block", "default"].includes(sev)) return fail(`a rule is set to off, warn, block or default, not ${JSON.stringify(sev)}`);
    const own = ownSeverity(rule), was = effective(ov, name, id, own);
    ov.delete(`${name}/${id}`); if (sev !== "default") ov.set(`${name}/${id}`, { rule: `${name}/${id}`, severity: sev, ...(reason ? { reason } : {}) });
    writeOverrides(packsDir, ov);
    const now = effective(ov, name, id, own);
    say(`${name}/${id}: ${was} -> ${now}${sev === "default" ? " (the pack's own)" : ` (recorded in ${file}; the pack file is unchanged)`}`);
    return 0;
  }

  if (verb === "check") {
    const all = flags.has("--installed"), ci = flags.has("--ci"), diff = flags.has("--diff");
    let rules, title, dirArg, packName = null;
    if (all) {
      rules = installedPackRules(packsDir).map((r) => ({ key: r.id, severity: r.severity, statement: r.statement, patterns: r.patterns, paths: r.paths }));
      if (!rules.length) return fail(`no pack is installed here (memory-pulse pack list)`);
      title = `${plural(new Set(rules.map((r) => r.key.split("/")[0])).size, "installed pack")}, with this project's choices`; dirArg = pos[0];
    } else {
      const at = locate(pos[0]); if (at.error) return fail(at.error);
      const p = readPackFile(at.path); if (!p) return fail(`${at.path} is not a pack file: memory-pulse pack verify ${at.path} names what is wrong`);
      rules = p.rules.filter((r) => r.on === undefined).map((r) => ({ key: r.id, severity: ownSeverity(r), statement: r.statement, patterns: r.patterns, paths: r.paths }));
      title = `${p.name} ${p.version}`; dirArg = pos[1]; packName = p.name;
    }
    let res, over;
    if (diff) {
      const args = diffBase ? ["diff", "--no-color", "--no-ext-diff", "--unified=0", `${diffBase}...HEAD`] : ["diff", "--no-color", "--no-ext-diff", "--unified=0"];
      const g = spawnSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      if (g.status !== 0) return fail(`could not read the diff: ${String(g.stderr || g.error?.message || "git failed").trim().slice(0, 300)}`);
      res = scanDiff(rules, g.stdout); over = diffBase ? `the lines added since ${diffBase}` : "the lines added in the working tree";
    } else {
      const root = resolve(dirArg ?? ".");
      let ok = false; try { ok = lstatSync(root).isDirectory(); } catch { /* missing */ }
      if (!ok) return fail(`${dirArg} is not a directory`);
      res = scanTree(rules, root); over = shownPath(root) || ".";
    }
    const order = new Map(rules.map((r, i) => [r.key, i]));
    res.hits.sort((a, b) => order.get(a.rule) - order.get(b.rule) || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    const nBlock = res.hits.filter((h) => h.severity === "block").length, nWarn = res.hits.length - nBlock;
    const code = ci && nBlock ? 1 : 0;
    if (json) { say(JSON.stringify({ pack: all ? null : packName, over, files: res.files, hits: res.hits, block: nBlock, warn: nWarn, rules: rules.map((r) => ({ rule: r.key, severity: r.severity, hits: res.hits.filter((h) => h.rule === r.key).length })) }, null, 2)); return code; }
    say(`pack check: ${title}, over ${over}\n`);
    const w = Math.max(...rules.map((r) => r.key.length)); const quiet = [];
    for (const r of rules) {
      const mine = res.hits.filter((h) => h.rule === r.key);
      if (!mine.length) { quiet.push(r.key); continue; }
      say(`${r.key.padEnd(w)}  ${r.severity.padEnd(5)}  ${plural(mine.length, "hit")}${r.statement ? `   ${r.statement}` : ""}`);
      for (const h of mine.slice(0, 20)) say(`  ${h.file}:${h.line}: ${h.text}`);
      if (mine.length > 20) say(`  +${mine.length - 20} more (--json lists every hit)`);
    }
    if (quiet.length) say(`${res.hits.length ? "\n" : ""}no hits: ${quiet.join(", ")}`);
    say(`\n${plural(res.files, "file")} read, ${plural(res.hits.length, "hit")} (${nBlock} from block rules, ${nWarn} from warn rules)`);
    say(code ? `pack check --ci: ${plural(nBlock, "hit")} from block rules, exit 1. Nothing was written.` : "dry run: nothing was blocked and nothing was written");
    return code;
  }

  return fail(PACK_USAGE);
}
