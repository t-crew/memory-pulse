// Rule packs. A pack is a prepared, sourced set of rules for one stack: one JSONL file whose first line is the header
// {name, version, description, stack} and whose other lines are rules in the invariant shape (id, statement, patterns, paths,
// severity, replacement) plus `source`, the URL of the vendor page that states the change, and `verified`, the date that page was
// read. Bundled packs ship in packs/ beside this folder. An installed pack is a copy at .memory-pulse/packs/<name>.jsonl: its own
// file, committed and reviewed like any other change, removed by deleting it, never appended to invariants.jsonl and never a
// ledger row. The loader that guard, check and lint share (server.mjs readInvariants) reads installed packs through
// installedPackRules. Nothing here reads the network. Plain code, Node built-ins only.
//
// A pack never blocks by default (review of 0.19.0, P-1). Every rule of an installed pack warns. A rule's `severity` in the pack
// file is the pack's recommendation: "block" marks a rule that is safe to block with, and it blocks only where the project turns
// it on, for the pack (`pack add <name> --block`, `pack rule <pack> block`) or for one rule (`pack rule <pack>/<rule> block`).
// Those choices live in .memory-pulse/packs/overrides.jsonl, so re-adding a newer pack never fights them.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, lstatSync, realpathSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname, basename, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { INVARIANT_HINT } from "./prereg.mjs";

export const BUNDLED_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "packs");
const OVERRIDES = "overrides.jsonl";
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/, RULE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/;
const RESERVED = new Set(["overrides", "fixtures"]);
const HEADER_KEYS = new Set(["name", "version", "description", "stack"]);
const RULE_KEYS = new Set(["id", "statement", "patterns", "paths", "severity", "replacement", "source", "verified", "since", "note", "mentions"]);

// ---- paths. An entry with a `*` is a glob; an entry without one is a prefix. In a glob: `**/` is zero or more directories, `**`
// anything, `*` anything inside one path segment, `?` one character of a segment, {a,b} either. Brackets and parentheses are
// literal (a Next.js route folder is app/[slug]/). A glob is matched against the project-relative form of the path, because
// Claude Code sends absolute paths. A glob that starts with `!` takes paths out of scope: ["**/*.py", "!**/tests/**"] is every
// Python file outside a tests folder. A glob may hold GLOB_STARS wildcards in one path segment: more than that backtracks on a
// long file name (a 24-star glob held the guard for 20 s on a 64-character name), so such a glob matches nothing and is reported.
export const isGlob = (p) => typeof p === "string" && p.includes("*");
const GLOB_STARS = 3;
export function globProblem(glob) {
  const g = String(glob).replace(/^!/, "");
  if (g.length > 300) return "is longer than 300 characters";
  for (const seg of g.split("/")) { const n = seg === "**" ? 0 : (seg.replace(/\*+/g, "*").match(/\*/g) ?? []).length; if (n > GLOB_STARS) return `has ${n} wildcards in one path segment (${GLOB_STARS} at most)`; }
  if ((g.match(/\*\*/g) ?? []).length > 6) return "has more than 6 ** parts";
  return null;
}
const esc = (c) => c.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
function globSource(g) {
  let re = "", i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      let j = i; while (g[j] === "*") j++;
      if (j - i >= 2 && (i === 0 || g[i - 1] === "/") && g[j] === "/") { re += "(?:[^/]+/)*"; i = j + 1; while (g.startsWith("**/", i)) i += 3; continue; }
      re += j - i >= 2 ? ".*" : "[^/]*"; i = j; continue;
    }
    if (c === "?") { re += "[^/]"; i++; continue; }
    if (c === "{") { const end = g.indexOf("}", i); if (end > i + 1) { re += `(?:${g.slice(i + 1, end).split(",").map(globSource).join("|")})`; i = end + 1; continue; } }
    re += esc(c); i++;
  }
  return re;
}
const GLOBS = new Map();
const NEVER = /(?!)/;
const norm = (p) => String(p).replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
const globRe = (glob) => { let re = GLOBS.get(glob); if (!re) { re = globProblem(glob) ? NEVER : new RegExp(`^${globSource(norm(glob))}$`); GLOBS.set(glob, re); } return re; };
// the project a path is made relative to: the folder that holds .memory-pulse/packs (set by the loader), then the working directory
let ROOTS = [];
const real = (p) => { let head = p, tail = ""; for (let i = 0; i < 64 && head && !existsSync(head); i++) { tail = join(basename(head), tail); const up = dirname(head); if (up === head) break; head = up; } try { return join(realpathSync(head), tail); } catch { return p; } };
/** The project-relative forms of a path. `strict`: an absolute path under no known root has none (a prefix must not reach outside the project). */
function relForms(path, strict = false) {
  const p = norm(path);
  if (!isAbsolute(String(path)) && !/^[A-Za-z]:\//.test(p)) return [p];
  const roots = [...new Set([...ROOTS, process.cwd()])];
  const under = (abs, root) => { const r = norm(root).replace(/\/+$/, ""); return abs.startsWith(r + "/") ? abs.slice(r.length + 1) : null; };
  let out = roots.map((r) => under(p, r)).filter((x) => x !== null);
  // /tmp against /private/tmp: the same folder under two names
  if (!out.length) { const rp = norm(real(String(path))); out = roots.map((r) => under(rp, real(r))).filter((x) => x !== null); }
  return out.length || strict ? out : [p.replace(/^\/+/, "")];
}
export function globMatch(glob, path) { const re = globRe(glob); return re !== NEVER && relForms(path).some((f) => re.test(f)); }
/**
 * One `paths` entry against a path: a prefix test for every entry, and the glob test for an entry with a `*`. The prefix is tried
 * on the path as given and on its project-relative form: an editor names a file by its absolute path, and 0.18.0 compared only
 * the raw path, so a rule scoped to "docs/" never fired in Claude Code (measured 2026-11-21). A path outside the project keeps
 * the as-given test alone, so a rule scoped to "tmp/" does not fire on /tmp/x (review of 0.19.0, S-1).
 */
export const scopeHas = (entry, path) => typeof entry === "string" && typeof path === "string"
  && (path.startsWith(entry) || relForms(path, true).some((f) => f.startsWith(norm(entry))) || (isGlob(entry) && globMatch(entry, path)));
const isExclusion = (p) => isGlob(p) && p.startsWith("!");
/** A rule's whole `paths` list against a path. No entry: every path. An exclusion glob wins over the entries that include. */
export function pathInScope(scope, path) {
  const list = (Array.isArray(scope) ? scope : []).filter((x) => typeof x === "string" && x), p = typeof path === "string" ? path : "";
  if (list.some((e) => isExclusion(e) && globMatch(e.slice(1), p))) return false;
  const include = list.filter((e) => !isExclusion(e));
  return !include.length || include.some((e) => scopeHas(e, p));
}
const inScope = (rule, path) => pathInScope(rule?.paths, path);

// ---- matching one text. mentionAt and matchOffsets are also the body of the worker thread below, so they use nothing from the
// module scope. A pattern written /…/flags is a regular expression, anything else a verbatim substring, as server.mjs reads them.
//
// A rule the pack marks to block (and any rule with "mentions": "skip") does not count a match that only NAMES the old API:
// a `#` or `//` comment, a block comment on the line, a match inside a string literal in Python, JavaScript or TypeScript, or any
// line of a Markdown or text file. The test reads one line, left to right, so a string or a docstring that began on an earlier
// line is not seen. In JSON, YAML, TOML and shell a string is the content, so only comments are skipped there.
function mentionAt(text, at, lang, commentsOnly) {
  if (lang.all) return true;
  const start = text.lastIndexOf("\n", at - 1) + 1, before = text.slice(start, at);
  if (lang.slash && /^\s*\*(\s|\/|$)/.test(before)) return true;                    // a JSDoc line
  let q = "";
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (q) { if (c === "\\") { i++; continue; } if (before.startsWith(q, i)) { i += q.length - 1; q = ""; } continue; }
    if (c === '"' || c === "'" || c === "`") { q = before.startsWith(c + c + c, i) ? c + c + c : c; i += q.length - 1; continue; }
    const open = i === 0 || /\s/.test(before[i - 1]);
    if (lang.hash && c === "#" && open) return true;
    if (lang.slash && c === "/" && before[i + 1] === "/" && open) return true;
    if (lang.slash && c === "/" && before[i + 1] === "*") { const end = before.indexOf("*/", i + 2); if (end < 0) return true; i = end + 1; }
  }
  return !!q && !!lang.strings && !commentsOnly;
}
/** Every offset where one pattern matches a text and the match counts (job: {src, flags} or {sub}, skip, lang, cap). */
function matchOffsets(job, text) {
  const out = [], cap = job.cap || 1;
  // judged where the match starts, and for a comment again where it ends: FastAPI(\n  # openapi_prefix=... starts in code and ends in a
  // comment. A match that starts in code and ends inside its own string argument (locale.format('%d') is a use, not a mention.
  const keep = (at, len) => { if (job.skip && (mentionAt(text, at, job.lang) || (len > 1 && mentionAt(text, at + len, job.lang, true)))) return; out.push(at); };
  if (typeof job.sub === "string") { for (let i = text.indexOf(job.sub); i >= 0 && out.length < cap; i = text.indexOf(job.sub, i + job.sub.length)) keep(i, job.sub.length); return out; }
  const re = new RegExp(job.src, job.flags.replace(/[gy]/g, "") + "g"); let m, n = 0;
  while ((m = re.exec(text)) && out.length < cap && n++ < 200000) { keep(m.index, m[0].length); if (m[0].length === 0) re.lastIndex++; }
  return out;
}
const HASH_EXT = new Set(["py", "pyi", "yml", "yaml", "toml", "sh", "bash", "zsh", "rb", "cfg", "ini", "tf", "env"]);
const SLASH_EXT = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "json", "jsonc", "json5", "go", "rs", "java", "kt", "cs", "php", "swift", "c", "h", "cpp"]);
const STRING_EXT = new Set(["py", "pyi", "js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"]);
const PROSE_EXT = new Set(["md", "mdx", "markdown", "rst", "txt", "adoc"]);
function langOf(path) {
  const base = norm(path ?? "").toLowerCase().split("/").pop() ?? "", ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  if (PROSE_EXT.has(ext)) return { all: true };
  return { hash: HASH_EXT.has(ext) || /^(makefile|dockerfile|justfile)/.test(base), slash: SLASH_EXT.has(ext), strings: STRING_EXT.has(ext) };
}
/** Does a match at this offset only name the thing (a comment, a string in code, a prose file)? Exported for the tests. */
export const isMention = (text, at, path) => mentionAt(String(text), at, langOf(path));
const reParts = (p) => (typeof p === "string" ? p.match(/^\/(.+)\/([a-z]*)$/s) : null);
function compile(p) {
  const m = reParts(p);
  if (m) { try { return { src: p, re: new RegExp(m[1], m[2].replace(/[gy]/g, "")) }; } catch { return null; } }
  return typeof p === "string" && p ? { src: p, sub: p } : null;
}
const jobsFor = (patterns, path, skip, cap) => (patterns ?? []).map(compile).filter(Boolean)
  .map((c) => ({ shown: c.src, job: { ...(c.sub !== undefined ? { sub: c.sub } : { src: c.re.source, flags: c.re.flags }), skip: !!skip, lang: langOf(path), cap } }));

// ---- a time budget for every pattern that did not ship with this client (review of 0.19.0, P-4). A regular expression cannot be
// interrupted on the thread that runs it, so patterns of a pack that is not a byte-for-byte copy of a bundled one run on a worker
// thread: the main thread waits, and a pattern that has used PATTERN_BUDGET_MS of processor time on one text without an answer
// is given up (the worker is ended, the pattern is reported as skipped, the next one runs on a fresh worker). The budget is
// processor time, so a loaded machine does not skip a sound pattern; PATTERN_WALL_MS is the longest wait whatever the load.
// Bundled packs are held to the same budget by the suite (pack verify over every one) and run on the main thread.
export const PATTERN_BUDGET_MS = 400, PATTERN_WALL_MS = 15000;
function workerMain() {
  const { parentPort, workerData } = require("node:worker_threads");
  const st = new Int32Array(workerData.sab), port = workerData.port, probes = new Map(); let text = "";
  parentPort.on("message", (msg) => {
    if (typeof msg.text === "string") text = msg.text;
    for (const job of msg.jobs) {
      let r;
      try {
        let t = text;
        if (job.probe) { const k = `${job.probe.prefix}\u0000${job.probe.unit}\u0000${job.probe.n}`; t = probes.get(k); if (t === undefined) { t = job.probe.prefix + job.probe.unit.repeat(Math.ceil(job.probe.n / job.probe.unit.length)).slice(0, job.probe.n) + "\u0000"; if (probes.size > 48) probes.clear(); probes.set(k, t); } }
        r = matchOffsets(job, t);
      } catch (e) { r = { error: String((e && e.message) || e) }; }
      port.postMessage(r); Atomics.add(st, 0, 1); Atomics.notify(st, 0);
    }
  });
  Atomics.store(st, 1, 1); Atomics.notify(st, 1);
}
let RUNNER = null;
function startRunner() {
  try {
    const sab = new SharedArrayBuffer(8), st = new Int32Array(sab), { port1, port2 } = new MessageChannel();
    const worker = new Worker(`${mentionAt}\n${matchOffsets}\n(${workerMain})()`, { eval: true, workerData: { sab, port: port2 }, transferList: [port2] });
    worker.on("error", () => { /* a worker that dies is a skipped pattern, said below */ }); worker.unref(); port1.unref?.();
    if (Atomics.wait(st, 1, 0, PATTERN_WALL_MS) === "timed-out") { worker.terminate(); return null; }
    return { worker, st, port: port1, text: null };
  } catch { return null; }
}
const cpuMs = (since) => { const u = process.cpuUsage(since); return (u.user + u.system) / 1000; };
/** Run jobs against one text off the main thread, each under the budget. One result per job: {offsets} | {skipped} | {error}. */
function runJobs(jobs, text, budget = PATTERN_BUDGET_MS, stopAtSkip = false) {
  const out = []; let i = 0;
  while (i < jobs.length) {
    RUNNER ??= startRunner();
    if (!RUNNER) { for (; i < jobs.length; i++) out.push({ skipped: "the pattern runner did not start" }); break; }
    const { worker, st, port } = RUNNER, batch = jobs.slice(i);
    Atomics.store(st, 0, 0);
    worker.postMessage({ ...(RUNNER.text === text ? {} : { text }), jobs: batch }); RUNNER.text = text;
    let done = 0, stalled = null, cpu0 = process.cpuUsage(), wall0 = Date.now();
    while (done < batch.length && !stalled) {
      Atomics.wait(st, 0, done, 20);
      const now = Atomics.load(st, 0);
      if (now === done) {
        if (cpuMs(cpu0) > budget) stalled = `no answer in ${budget} ms of processor time`;
        else if (Date.now() - wall0 > PATTERN_WALL_MS) stalled = `no answer in ${PATTERN_WALL_MS / 1000} s`;
        continue;
      }
      while (done < now) { const r = receiveMessageOnPort(port)?.message; out.push(Array.isArray(r) ? { offsets: r } : { error: r?.error ?? "no result" }); done++; }
      cpu0 = process.cpuUsage(); wall0 = Date.now();
    }
    i += done;
    if (stalled) { out.push({ skipped: stalled }); i++; try { worker.terminate(); } catch { /* already gone */ } RUNNER = null; if (stopAtSkip) break; }
  }
  return out;
}
const matchJobs = (jobs, text, trusted) => (trusted ? jobs.map((j) => { try { return { offsets: matchOffsets(j, text) }; } catch (e) { return { error: String(e?.message ?? e) }; } }) : runJobs(jobs, text));

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

// pack verify times each regular expression on the worker, under the same processor-time budget idea as the guard, against
// lines built from the pattern's own text: runs of each literal character and literal word of the pattern, of common characters,
// and of pairs of the pattern's characters, short (64) and long (LONG). A short run is what an exponential pattern stalls on
// ((x+x+)+y on forty x), a long one what a quadratic pattern stalls on (an unbounded .* after a word the line repeats).
const LONG = 100000, VERIFY_BUDGET_MS = 250;
function probesFor(src) {
  const CLASS = { d: "1", w: "a", s: " ", D: "a", W: " ", S: "a" };
  const chars = [], lits = []; let cur = "";
  const flush = () => { if (cur.length >= 2 && !lits.includes(cur)) lits.push(cur); cur = ""; };
  const lit = (c) => { cur += c; if (!chars.includes(c)) chars.push(c); };
  for (let j = 0; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { const d = src[++j] ?? ""; if (CLASS[d]) { flush(); if (!chars.includes(CLASS[d])) chars.push(CLASS[d]); } else if (/[bBnrtfv0-9pPkux]/.test(d)) flush(); else lit(d); continue; }
    if (/[A-Za-z0-9_ ,:;=<>@#%&!~"'`/-]/.test(c)) lit(c); else flush();
  }
  flush();
  const base = ["a", " ", "0", ".", "-", "_", "/", "\"", "'", "(", "=", "<", "\t", "a ", "a.", "ab", "A", "Aa"];
  const units = [...new Set([...base, ...chars.slice(0, 16), ...lits.slice(0, 8), ...lits.slice(0, 8).map((l) => `${l} `)])];
  const top = chars.slice(0, 6), pairs = top.flatMap((a) => top.map((b) => a + b)).filter((u) => !units.includes(u));
  const out = [];
  for (const u of units) { out.push({ prefix: "", unit: u, n: 64 }); out.push({ prefix: "", unit: u, n: LONG }); }
  for (const u of pairs) out.push({ prefix: "", unit: u, n: 64 });
  for (const l of lits.slice(0, 4)) for (const c of top) out.push({ prefix: l, unit: c, n: 64 });
  return out;
}
function slowPatterns(list) {
  const slow = new Map();
  for (const [i, p] of list.entries()) {
    const res = runJobs(probesFor(p.src).map((probe) => ({ src: p.src, flags: p.flags, cap: 1, probe })), "", VERIFY_BUDGET_MS, true);   // the first line a pattern stalls on settles it
    const bad = res.find((r) => r.skipped);
    if (bad) slow.set(i, bad.skipped);
    if (res.some((r) => r.skipped === "the pattern runner did not start")) return { slow, failed: "the pattern runner did not start" };
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
    if (rule.severity !== "block" && rule.severity !== "warn") bad('severity must be "block" (safe to block with, once a project turns it on) or "warn"');
    if (rule.mentions !== undefined && rule.mentions !== "skip") bad('mentions, when given, is "skip": do not count a match in a comment or in a string of code');
    const paths = Array.isArray(rule.paths) ? rule.paths : null;
    if (!paths || !paths.length || paths.some((p) => typeof p !== "string" || !p)) bad('paths is required: one or more globs, such as "**/*.py"');
    else if (paths.every(isExclusion)) bad('paths needs one glob that puts files in scope, such as "**/*.py"; an entry that starts with ! only takes files out');
    else for (const p of paths) { if (!isGlob(p)) bad(`paths entry ${JSON.stringify(p)} is a prefix, and a pack rule needs a glob (write ${JSON.stringify(p.endsWith("/") ? `${p}**` : `**/${p}`)})`); else { const g = globProblem(p); if (g) bad(`paths glob ${JSON.stringify(p.length > 60 ? `${p.slice(0, 57)}...` : p)} ${g}`); } }
    for (const k of Object.keys(rule)) if (!RULE_KEYS.has(k) && k !== "on") warnings.push(`${id}: unknown field ${JSON.stringify(k)}`);
  }
  if (timing && timed.length) {
    const { slow, failed } = slowPatterns(timed);
    for (const [i, why] of slow) if (why !== failed) errors.push(`${timed[i].id}: pattern ${show(timed[i].p)} takes too long on a long line (${why}, on a line built from the pattern's own characters)`);
    if (failed) errors.push(`the long-line timing could not run: ${failed}`);
  }
  return { ok: errors.length === 0, errors, warnings, header, rules: good, text };
}

// ---- this project's choices: one line each in overrides.jsonl, {"rule":"<pack>/<id>","severity":"off"|"warn"|"block","reason"?}.
// "<pack>/*" with "block" is what `pack add --block` writes: the rules the pack marks safe to block, block. The later line wins.
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
const ownSeverity = (rule) => (rule.severity === "block" ? "block" : "warn");
const blockingOn = (ov, name) => ov.get(`${name}/*`)?.severity === "block";
/** What a rule does here: its own choice if it has one; the pack's mark if blocking is on for the pack; a warning otherwise. */
function effective(ov, name, id, own) {
  const one = ov.get(`${name}/${id}`); if (one) return one.severity;
  return blockingOn(ov, name) ? own : "warn";
}

// ---- loading. A pack file loads whole or not at all: a line that is not JSON, a missing header, a rule without an id or
// patterns, and the file is not applied and says so on every run (review of 0.19.0, P-3: a pack left with merge conflict markers
// switched itself off without a word). `packProblems()` is what the last load found.
const packFiles = (packsDir) => { try { return readdirSync(packsDir).filter((f) => f.endsWith(".jsonl") && f !== OVERRIDES).sort(); } catch { return []; } };
const BUNDLED_TEXT = new Map();
const bundledText = (name) => { if (!BUNDLED_TEXT.has(name)) { let t = null; try { t = readFileSync(join(BUNDLED_DIR, `${name}.jsonl`), "utf8"); } catch { /* not a bundled pack */ } BUNDLED_TEXT.set(name, t); } return BUNDLED_TEXT.get(name); };
function loadPack(path) {
  let text; try { text = readFileSync(path, "utf8"); } catch (e) { return { path, problem: `cannot be read: ${e.code ?? e.message}` }; }
  const { header, rules, findings } = parsePack(text);
  const named = header && typeof header.name === "string" && NAME_RE.test(header.name) && !RESERVED.has(header.name);
  const torn = rules.find((r) => typeof r.rule.id !== "string" || !Array.isArray(r.rule.patterns));
  const problem = findings[0] ?? (!named ? "line 1: no pack header with a name" : torn ? `line ${torn.line}: a rule needs an id and patterns` : !rules.length ? "the pack has no rules" : null);
  return { ...(header ?? {}), name: named ? header.name : null, path, text, problem, rules: rules.map((r) => r.rule).filter((r) => typeof r.id === "string" && Array.isArray(r.patterns)),
    trusted: !!named && text === bundledText(header.name) };
}
const shownPath = (p) => { const r = relative(process.cwd(), p); return r === "" ? "." : !r.startsWith("..") && !isAbsolute(r) ? r.split("\\").join("/") : p; };
const problemLine = (p) => `memory-pulse: rule pack file ${shownPath(p.path)} does not load (${p.problem}), so none of its rules ran. memory-pulse pack verify ${shownPath(p.path)} names what is wrong`;
let PROBLEMS = [];
/** One line per installed pack file (or rule) that the last load could not apply. Empty when every pack loaded. */
export const packProblems = () => PROBLEMS.slice();
const asInvariant = (pack, rule, severity) => ({ id: `${pack.name}/${rule.id}`, ...(rule.statement ? { statement: rule.statement } : {}), patterns: rule.patterns, ...(Array.isArray(rule.paths) ? { paths: rule.paths } : {}), severity,
  ...(rule.replacement ? { replacement: rule.replacement } : {}), pack: { name: pack.name, rule: rule.id, version: pack.version, source: rule.source, verified: rule.verified, own: ownSeverity(rule), file: pack.path,
    skip: ownSeverity(rule) === "block" || rule.mentions === "skip", trusted: !!pack.trusted } });
const usable = (pack, rule, problems) => {
  if (rule.on !== undefined) return false;
  const g = (Array.isArray(rule.paths) ? rule.paths : []).filter(isGlob).map((p) => globProblem(p)).find(Boolean);
  if (g) { problems?.push(`memory-pulse: rule ${rule.id} of ${shownPath(pack.path)} is not applied: a paths glob ${g}. memory-pulse pack verify ${shownPath(pack.path)} names it`); return false; }
  return true;
};
/** One pack file's rules in the invariant shape, at the severities the pack marks (no project choices applied). */
export function packAsInvariants(path) { const pack = loadPack(path); return pack.problem ? [] : pack.rules.filter((r) => usable(pack, r)).map((r) => asInvariant(pack, r, ownSeverity(r))); }
/** Every installed pack's rules, in the invariant shape, with this project's choices applied: a warning unless turned on. */
export function installedPackRules(packsDir) {
  PROBLEMS = [];
  const files = packFiles(packsDir); if (!files.length) return [];
  if (basename(dirname(resolve(packsDir))) === ".memory-pulse") ROOTS = [dirname(dirname(resolve(packsDir)))];
  const ov = readOverrides(packsDir), out = [];
  for (const f of files) {
    const pack = loadPack(join(packsDir, f));
    if (pack.problem) { PROBLEMS.push(problemLine(pack)); continue; }
    for (const rule of pack.rules) {
      if (!usable(pack, rule, PROBLEMS)) continue;
      const severity = effective(ov, pack.name, rule.id, ownSeverity(rule));
      if (severity !== "off") out.push(asInvariant(pack, rule, severity));
    }
  }
  return out;
}

// ---- what a hit says. The line names the pack, the rule, what to use instead and the vendor page; the hint names the override.
const clip = (s, n) => { const v = String(s ?? "").replace(/\s+/g, " ").trim(); return v.length > n ? `${v.slice(0, Math.max(1, n - 1))}…` : v; };
const PACK_LINE_CHARS = 300;
const SHORT = new Map();   // a warning's full line -> the line the agent is handed (no pattern text, clipped)
/** The first match of a pack rule that counts, as {src}, under the time budget. A skipped pattern is said in `reasons`. */
export function packHit(inv, text, path, reasons = []) {
  const p = inv.pack, jobs = jobsFor(inv.patterns, path, p.skip, 1); let hit;
  for (const [k, r] of matchJobs(jobs.map((j) => j.job), text, p.trusted).entries()) {
    if (r.offsets) { if (!hit && r.offsets.length) hit = { src: jobs[k].shown }; continue; }
    reasons.push(`warning pack ${p.name}, rule ${p.rule}: pattern ${show(jobs[k].shown)} was skipped on this text (${r.skipped ?? r.error}), so it did not judge the edit. memory-pulse pack verify ${shownPath(p.file)} tests every pattern of the pack`);
  }
  return hit;
}
export function packReason(inv, severity, matched) {
  const p = inv.pack, rep = typeof inv.replacement === "string" ? inv.replacement.trim().replace(/\.$/, "") : "";
  const head = `${severity === "warn" ? "warning " : ""}pack ${p.name}, rule ${p.rule}`, tail = `. Source: ${p.source}`;
  const full = `${head}${inv.statement ? `: ${inv.statement}` : ""} (matched ${matched})${rep ? ` — instead: ${rep}` : ""}${tail} (read ${p.verified})`;
  if (severity === "warn") {
    const room = Math.max(60, PACK_LINE_CHARS - head.length - tail.length - 16), st = inv.statement ? clip(inv.statement, Math.max(40, room - Math.min(rep.length, room >> 1))) : "";
    SHORT.set(full, `${head}${st ? `: ${st}` : ""}${rep ? ` — instead: ${clip(rep, Math.max(30, room - st.length))}` : ""}${tail}`);
  }
  return full;
}
/** The guard's closing hint when a pack rule blocked: the override, in place of "an override does not apply". */
export function packHint(blocked, invariants, hint) {
  const byId = new Map((invariants ?? []).filter((i) => i?.pack).map((i) => [i.id, i]));
  const blocking = (b) => (b.v?.invariants ?? []).filter((h) => h.severity === "block");
  const ids = [...new Set(blocked.flatMap(blocking).map((h) => h.id).filter((id) => byId.has(id)))];
  if (!ids.length) return [hint, ...PROBLEMS].filter(Boolean).join("\n");
  const declared = blocked.some((b) => !b.command && blocking(b).some((h) => !byId.has(h.id)));
  const base = declared ? hint : String(hint ?? "").split("\n").filter((l) => l !== INVARIANT_HINT).join("\n");
  const files = [...new Set(ids.map((id) => shownPath(byId.get(id).pack.file)))].join(", ");
  const cmds = ids.slice(0, 3).map((id) => `memory-pulse pack rule ${id} warn (reports, does not block) or memory-pulse pack rule ${id} off`).join("; ");
  const text = `${ids.length > 1 ? "These rules come" : "This rule comes"} from an installed rule pack (${files}), where this project turned blocking on, not from a correction, so guard allow does not apply. Change the text. If the rule is wrong for this project, change it here without editing the pack: ${cmds}. The choice is written to ${shownPath(join(dirname(byId.get(ids[0]).pack.file), OVERRIDES))}.`;
  return [base, text, ...PROBLEMS].filter(Boolean).join("\n");
}
/** The warn-rule lines of one verdict (and any pattern that was skipped). */
export const packWarnings = (v) => (v?.reasons ?? []).filter((r) => typeof r === "string" && r.startsWith("warning pack "));
/**
 * What the guard says about packs when the edit is allowed: a pack file that did not load, then the warnings, one short line
 * each. `room` is what is left of the edit's context after the ledger's own lines, which come first and are never cut for this
 * (review of 0.19.0, P-2: pack warnings pushed the ledger's correction out of the 2,000 characters). Pack warnings take at most
 * PACK_CONTEXT_CHARS of it; what does not fit is counted in a closing "and N more" line.
 */
export const PACK_CONTEXT_CHARS = 1200;
export function packContext(lines, room = PACK_CONTEXT_CHARS) {
  const budget = Math.min(PACK_CONTEXT_CHARS, room), out = []; let used = 0;
  const put = (l) => { if (used + l.length + (out.length ? 1 : 0) > budget) return false; used += l.length + (out.length ? 1 : 0); out.push(l); return true; };
  for (const p of PROBLEMS) put(clip(p, PACK_LINE_CHARS));
  const all = [...(lines ?? [])].map((l) => SHORT.get(l) ?? clip(l, PACK_LINE_CHARS));
  if (!all.length) return out.join("\n");
  const more = (n) => `  and ${n} more: memory-pulse pack check --installed <file> lists every one`;
  const head = `memory-pulse: ${all.length === 1 ? "an installed rule pack has a warning" : `installed rule packs have ${all.length} warnings`} for this edit. The edit is not blocked:`;
  if (used + head.length + 4 + Math.min(all[0].length, 80) > budget) { put(`memory-pulse: ${all.length} rule pack warning${all.length === 1 ? "" : "s"} for this edit did not fit here: memory-pulse pack check --installed <file> lists every one`); return out.join("\n"); }
  put(head);
  for (let i = 0; i < all.length; i++) {
    const left = all.length - i - 1, line = `  ${all[i]}`;
    if (used + 1 + line.length + (left ? more(left).length + 1 : 0) > budget) { put(more(all.length - i)); break; }
    put(line);
  }
  return out.join("\n");
}
/** The engine matches `paths` as prefixes and knows nothing of packs: a glob scope is settled here, and a pack rule's source rides in its replacement. */
export function forEngine(invariants, path) {
  const out = [];
  for (const inv of invariants ?? []) {
    const scope = Array.isArray(inv?.paths) ? inv.paths.filter((x) => typeof x === "string" && x) : [];
    if (!inv?.pack && !scope.some(isGlob)) { out.push(inv); continue; }
    if (!inScope(inv, path)) continue;
    const { pack, paths, ...rest } = inv;
    if (!pack) { out.push(rest); continue; }
    const rep = typeof inv.replacement === "string" ? inv.replacement.trim().replace(/\.$/, "") : "";
    out.push({ ...rest, statement: `pack ${pack.name}, rule ${pack.rule}: ${inv.statement ?? ""}`.replace(/: $/, ""), replacement: `${rep ? `${rep}. ` : ""}Source: ${pack.source} (read ${pack.verified})` });
  }
  return out;
}

// ---- pack check: a dry run over a tree, or over the lines a change adds
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
/** rules: [{key, severity, statement, patterns, paths, skip, trusted}]. lineOf maps a character offset of `text` to {line, text}. */
function hitsIn(rules, file, text, lineOf, skipped) {
  const out = [], seen = new Set();
  for (const r of rules) {
    const jobs = jobsFor(r.patterns, file, r.skip, 20000);
    for (const [k, res] of matchJobs(jobs.map((j) => j.job), text, r.trusted).entries()) {
      if (!res.offsets) { skipped.push(`rule ${r.key.split("/").pop()}: pattern ${show(jobs[k].shown)} was skipped on ${file} (${res.skipped ?? res.error})`); continue; }
      for (const at of res.offsets) { const l = lineOf(at); const key = `${r.key}\n${l.line}`; if (seen.has(key)) continue; seen.add(key); out.push({ rule: r.key, severity: r.severity, file, line: l.line, text: l.text.trim().slice(0, 160) }); }
    }
  }
  return out;
}
function wholeFile(text) {
  const starts = [0]; for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (at) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= at) lo = mid; else hi = mid - 1; } const end = text.indexOf("\n", starts[lo]); return { line: lo + 1, text: text.slice(starts[lo], end < 0 ? text.length : end) }; };
}
const readText = (abs) => { try { const st = lstatSync(abs); if (!st.isFile() || st.size > MAX_FILE || binary(abs)) return null; return readFileSync(abs, "utf8"); } catch { return null; } };
export function scanTree(rules, root) {
  const hits = [], skipped = []; let files = 0;
  for (const rel of walk(root)) {
    const mine = rules.filter((r) => inScope(r, rel)); if (!mine.length) continue;
    const text = readText(join(root, rel)); if (text === null) continue;
    files++; hits.push(...hitsIn(mine, rel, text, wholeFile(text), skipped));
  }
  return { files, hits, skipped };
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
/** changed: [{file, lines: [{line, text}]}], the lines a change adds, each file under its own path. */
export function scanDiff(rules, changed) {
  const hits = [], skipped = []; let files = 0;
  for (const f of typeof changed === "string" ? addedByFile(changed) : changed) {
    const mine = rules.filter((r) => inScope(r, f.file)); if (!mine.length) continue;
    files++; const text = f.lines.map((x) => x.text).join("\n"); const ends = []; let at = 0; for (const x of f.lines) { at += x.text.length + 1; ends.push(at); }
    hits.push(...hitsIn(mine, f.file, text, (o) => f.lines[Math.max(0, ends.findIndex((e) => o < e))] ?? f.lines[f.lines.length - 1], skipped));
  }
  return { files, hits, skipped };
}
/**
 * The lines a change adds, from git, with paths relative to the working directory. With a base: what the branch adds since it
 * (`git diff <base>...HEAD`), which is committed work. With no base: everything not yet committed, which is staged changes,
 * unstaged changes and untracked files (review of 0.19.0, P-6: a bare `git diff` saw only unstaged edits to tracked files, so a
 * pre-commit hook, where the change is staged, passed everything).
 */
function changedLines(base) {
  const git = (args) => spawnSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const diff = ["diff", "--no-color", "--no-ext-diff", "--relative", "--unified=0"], why = (g) => String(g.stderr || g.error?.message || "git failed").trim().slice(0, 300);
  if (base) { const g = git([...diff, `${base}...HEAD`]); return g.status === 0 ? { changed: addedByFile(g.stdout) } : { error: why(g) }; }
  let g = git([...diff, "HEAD"]), text = g.stdout ?? "";
  if (g.status !== 0) {   // no commit yet: the index against nothing, then the working tree against the index
    const staged = git([...diff, "--cached"]), unstaged = git(diff);
    if (staged.status !== 0 && unstaged.status !== 0) return { error: why(g) };
    text = `${staged.stdout ?? ""}\n${unstaged.stdout ?? ""}`;
  }
  const changed = addedByFile(text), u = git(["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const f of u.status === 0 ? u.stdout.split("\0").filter(Boolean) : []) {
    const t = readText(resolve(f)); if (t === null || changed.some((c) => c.file === f)) continue;
    const lines = t.split("\n"); if (lines[lines.length - 1] === "") lines.pop();
    if (lines.length) changed.push({ file: f, lines: lines.map((x, i) => ({ line: i + 1, text: x })) });
  }
  return { changed };
}

// ---- the command
export const PACK_USAGE = `usage: memory-pulse pack list [--json]
       memory-pulse pack show <name|path> [--json]
       memory-pulse pack add <name|path> [--block]
       memory-pulse pack remove <name>
       memory-pulse pack check <name|path> [dir] [--json]
       memory-pulse pack check --installed [dir | --diff [base]] [--ci] [--json]
       memory-pulse pack rule <pack>/<rule> off|warn|block|default [--reason "..."]
       memory-pulse pack rule <pack> block|warn
       memory-pulse pack verify <name|path>
A pack never blocks by default: every rule warns until this project turns blocking on (pack add --block, or pack rule).
--diff with no base reads staged, unstaged and untracked changes; --diff <base> reads what the branch adds since <base>.`;
const counts = (rules) => { const block = rules.filter((r) => r.severity === "block").length; return { rules: rules.length, block, warn: rules.length - block }; };
const countText = (c) => `${c.rules} rule${c.rules === 1 ? "" : "s"} (${c.block} can block, ${c.warn} warn)`;
const verifiedSpan = (rules) => { const d = rules.map((r) => r.verified).filter(validDate).sort(); return !d.length ? "verified never" : d[0] === d[d.length - 1] ? `verified ${d[0]}` : `verified ${d[0]} to ${d[d.length - 1]}`; };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Runs the command and returns its exit code once stdout has drained: a long report over a pipe must not be cut by the exit. */
export async function cliPack(argv, opts) {
  const code = runPack(argv, opts);
  await new Promise((done) => process.stdout.write("", () => done()));
  return code;
}
function runPack(argv, { dir }) {
  const packsDir = join(dir, "packs");
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const pos = []; let reason = null, diffBase;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reason") { reason = argv[++i] ?? ""; continue; }
    if (a === "--diff") { if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) diffBase = argv[++i]; continue; }
    if (a.startsWith("--")) continue;
    pos.push(a);
  }
  const json = flags.has("--json"), say = (s = "") => console.log(s), fail = (s) => { console.error(s); return 1; };
  const installedPath = (name) => join(packsDir, `${name}.jsonl`);
  const loadAll = (d) => packFiles(d).map((f) => loadPack(join(d, f)));
  const bundled = () => loadAll(BUNDLED_DIR).filter((p) => !p.problem);
  // a name is an installed pack first (the copy in force here), then a bundled one; anything that exists on disk is a path
  const locate = (arg, { preferInstalled = true } = {}) => {
    if (typeof arg !== "string" || !arg) return { error: PACK_USAGE };
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return { error: `packs are not fetched from the network in this version: download the file, read it, then memory-pulse pack add <path>` };
    if (NAME_RE.test(arg)) {
      if (preferInstalled && existsSync(installedPath(arg))) return { path: installedPath(arg), installed: true };
      if (existsSync(join(BUNDLED_DIR, `${arg}.jsonl`))) return { path: join(BUNDLED_DIR, `${arg}.jsonl`), bundled: true };
    }
    let isFile = false; try { isFile = lstatSync(arg).isFile(); } catch { /* a name */ }
    if (isFile) return { path: arg };
    return { error: `no pack named ${JSON.stringify(arg)}: memory-pulse pack list shows the bundled packs, and a path to a pack file works too` };
  };
  const marked = (pack) => pack.rules.filter((r) => ownSeverity(r) === "block").map((r) => r.id);
  const blockingNow = (pack, ov) => pack.rules.filter((r) => effective(ov, pack.name, r.id, ownSeverity(r)) === "block").map((r) => r.id);
  const standing = (pack, ov) => { const b = blockingNow(pack, ov); return b.length ? `${plural(b.length, "rule")} block${b.length === 1 ? "s" : ""} (${b.join(", ")}); the other ${pack.rules.length - b.length} warn${pack.rules.length - b.length === 1 ? "s" : ""}` : "every rule warns and none blocks"; };
  const verb = argv[0];

  if (verb === "list") {
    const ov = readOverrides(packsDir), all = loadAll(packsDir), inst = all.filter((p) => !p.problem), broken = all.filter((p) => p.problem), bund = bundled();
    const row = (p, where) => {
      const mine = inst.find((x) => x.name === p.name), c = counts(p.rules);
      const local = [...ov.keys()].filter((k) => k.startsWith(`${p.name}/`) && k !== `${p.name}/*`).length, b = bund.find((x) => x.name === p.name), on = mine ? blockingNow(mine, ov).length : 0;
      const status = !mine ? "not installed" : `installed, ${on ? `${plural(on, "rule")} block${on === 1 ? "s" : ""}` : "every rule warns"}${b && mine.text !== b.text ? ` (differs from the bundled ${b.version})` : ""}${local ? `, ${plural(local, "local choice")}` : ""}`;
      return { name: p.name, version: p.version, stack: p.stack ?? "", description: p.description ?? "", ...c, blocking: on, verified: verifiedSpan(p.rules).replace(/^verified /, ""), bundled: where === "bundled", installed: !!mine, status };
    };
    const rows = [...bund.map((p) => row(inst.find((x) => x.name === p.name) ?? p, "bundled")), ...inst.filter((p) => !bund.some((b) => b.name === p.name)).map((p) => row(p, "local"))];
    if (json) { say(JSON.stringify(rows.concat(broken.map((p) => ({ file: shownPath(p.path), problem: p.problem, installed: false }))), null, 2)); return 0; }
    const w = (k) => Math.max(...rows.map((r) => String(r[k]).length), 4);
    const line = (r) => `  ${r.name.padEnd(w("name"))}  ${r.version.padEnd(w("version"))}  ${r.stack.padEnd(w("stack"))}  ${countText(r).padEnd(32)}  verified ${r.verified.padEnd(24)}  ${r.status}\n      ${r.description}`;
    const b = rows.filter((r) => r.bundled), l = rows.filter((r) => !r.bundled);
    say(`bundled with memory-pulse${b.length ? ":" : ": none"}`); for (const r of b) say(line(r));
    if (l.length) { say("installed from a local file:"); for (const r of l) say(line(r)); }
    if (broken.length) { say("installed, and not applied:"); for (const p of broken) say(`  ${shownPath(p.path)}  does not load (${p.problem}): memory-pulse pack verify ${shownPath(p.path)}`); }
    say(`\ninstalled packs live in ${shownPath(packsDir)}/ as one file each, and every rule of one warns until this project turns blocking on. "can block" counts the rules a pack marks safe for that. memory-pulse pack show <name> prints every rule; memory-pulse pack check <name> previews one against this tree; memory-pulse pack add <name> installs it.`);
    return 0;
  }

  if (verb === "show") {
    const at = locate(pos[0]); if (at.error) return fail(at.error);
    const p = loadPack(at.path); if (p.problem) return fail(`${at.path} is not a pack file (${p.problem}): memory-pulse pack verify ${at.path} names what is wrong`);
    const here = existsSync(installedPath(p.name)), ov = here ? readOverrides(packsDir) : new Map();
    if (json) { say(JSON.stringify({ name: p.name, version: p.version, stack: p.stack, description: p.description, installed: here, rules: p.rules.map((r) => ({ ...r, effective: here ? effective(ov, p.name, r.id, ownSeverity(r)) : null })) }, null, 2)); return 0; }
    say(`${p.name} ${p.version} (${p.stack ?? "?"}): ${p.description ?? ""}`);
    say(`${countText(counts(p.rules))}, ${verifiedSpan(p.rules).replace("verified", "sources read")}. ${here ? `Installed in ${shownPath(installedPath(p.name))}: ${standing(p, ov)}.` : `Not installed here: memory-pulse pack add ${at.bundled ? p.name : pos[0]}`}`);
    const w = Math.max(...p.rules.map((r) => r.id.length));
    for (const r of p.rules) {
      const own = ownSeverity(r), eff = here ? effective(ov, p.name, r.id, own) : null;
      const sev = !here ? (own === "block" ? "can block (a warning until a project turns it on)" : "warn")
        : eff === "block" ? `block (turned on here${own === "block" ? "" : "; the pack recommends warn"})`
        : eff === "off" ? "off (here)" : own === "block" ? `warn (can block: memory-pulse pack rule ${p.name}/${r.id} block)` : "warn";
      say(`\n${r.id.padEnd(w)}  ${sev}`);
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
    if (flags.has("--block") && flags.has("--warn-only")) return fail("pack add takes --block or --warn-only, not both");
    const at = locate(pos[0], { preferInstalled: false }); if (at.error) return fail(at.error);
    const v = verifyPack(at.path);
    if (!v.ok) { for (const e of v.errors) console.error(`  ${e}`); return fail(`not installed: ${at.path} has ${plural(v.errors.length, "finding")} (memory-pulse pack verify ${pos[0]})`); }
    const name = v.header.name, dest = installedPath(name), pack = { name, rules: v.rules }, c = countText(counts(v.rules));
    let before = null; try { before = readFileSync(dest, "utf8"); } catch { /* new */ }
    const was = before === null ? null : parsePack(before).header?.version ?? "?";
    if (before !== v.text) { mkdirSync(packsDir, { recursive: true }); writeFileSync(dest, v.text); }
    say(before === null ? `installed ${name} ${v.header.version}: ${c} in ${shownPath(dest)}` : before === v.text ? `${name} ${v.header.version} is already installed: ${c} in ${shownPath(dest)}` : `updated ${name} ${was} -> ${v.header.version}: ${c} in ${shownPath(dest)}`);
    const ov = readOverrides(packsDir);
    if (flags.has("--block")) { ov.delete(`${name}/*`); ov.set(`${name}/*`, { rule: `${name}/*`, severity: "block" }); writeOverrides(packsDir, ov); }
    if (flags.has("--warn-only") && ov.delete(`${name}/*`)) writeOverrides(packsDir, ov);
    const m = marked(pack);
    say(`${standing(pack, ov)}. ${blockingNow(pack, ov).length ? `memory-pulse pack rule ${name} warn turns blocking off again`
      : m.length ? `The ${m.length === 1 ? "one rule" : `${m.length} rules`} the pack marks safe to block ${m.length === 1 ? "is" : "are"} turned on with memory-pulse pack add ${name} --block, or one at a time with memory-pulse pack rule ${name}/<rule> block`
      : "The pack marks no rule as safe to block; memory-pulse pack rule " + name + "/<rule> block turns one on all the same"}`);
    const local = [...ov.keys()].filter((k) => k.startsWith(`${name}/`) && k !== `${name}/*`).length;
    if (local) say(`${plural(local, "local choice")} for single rules kept (${shownPath(join(packsDir, OVERRIDES))})`);
    say(`commit ${shownPath(dest)}: guard, check and lint read it from the next edit on. Nothing was added to invariants.jsonl or to the ledger.`);
    say(`preview what it catches in this tree: memory-pulse pack check ${name}`);
    return 0;
  }

  if (verb === "remove") {
    const name = pos[0]; if (!name) return fail(PACK_USAGE);
    if (!NAME_RE.test(name) || RESERVED.has(name) || !existsSync(installedPath(name))) return fail(`${name} is not installed (memory-pulse pack list)`);
    unlinkSync(installedPath(name));
    const left = [...readOverrides(packsDir).keys()].filter((k) => k.startsWith(`${name}/`)).length;
    say(`removed ${name}: ${shownPath(installedPath(name))} is deleted and its rules no longer apply${left ? `. ${plural(left, "local choice")} for it stay in ${shownPath(join(packsDir, OVERRIDES))} and apply again if it is added back` : ""}`);
    return 0;
  }

  if (verb === "rule") {
    const target = pos[0], sev = pos[1];
    if (!target || !sev) return fail(PACK_USAGE);
    const slash = target.indexOf("/"); const name = slash < 0 ? target : target.slice(0, slash), id = slash < 0 ? "*" : target.slice(slash + 1);
    const loaded = NAME_RE.test(name) && !RESERVED.has(name) && existsSync(installedPath(name)) ? loadPack(installedPath(name)) : null;
    if (!loaded) return fail(`${name} is not installed (memory-pulse pack list)`);
    if (loaded.problem) return fail(problemLine(loaded).replace(/^memory-pulse: /, ""));
    const pack = loaded, ov = readOverrides(packsDir), file = shownPath(join(packsDir, OVERRIDES));
    if (id === "*") {
      if (!["block", "warn", "default"].includes(sev)) return fail(`a whole pack takes block or warn: memory-pulse pack rule ${name} block (the rules the pack marks safe to block, block) or memory-pulse pack rule ${name} warn (every rule warns). To stop using it: memory-pulse pack remove ${name}`);
      ov.delete(`${name}/*`); if (sev === "block") ov.set(`${name}/*`, { rule: `${name}/*`, severity: "block", ...(reason ? { reason } : {}) });
      writeOverrides(packsDir, ov);
      say(`${name}: ${standing(pack, ov)}${sev === "block" ? ` (recorded in ${file}; the pack file is unchanged)` : ""}`);
      return 0;
    }
    const rule = pack.rules.find((r) => r.id === id);
    if (!rule) return fail(`no rule ${JSON.stringify(id)} in ${name} (memory-pulse pack show ${name})`);
    if (!["off", "warn", "block", "default"].includes(sev)) return fail(`a rule is set to off, warn, block or default, not ${JSON.stringify(sev)}`);
    const own = ownSeverity(rule), was = effective(ov, name, id, own);
    ov.delete(`${name}/${id}`); if (sev !== "default") ov.set(`${name}/${id}`, { rule: `${name}/${id}`, severity: sev, ...(reason ? { reason } : {}) });
    writeOverrides(packsDir, ov);
    const now = effective(ov, name, id, own);
    say(`${name}/${id}: ${was} -> ${now}${sev === "default" ? ` (no choice of its own now; ${blockingOn(ov, name) ? "blocking is on for this pack" : "a pack rule warns until it is turned on"})` : ` (recorded in ${file}; the pack file is unchanged)`}`);
    return 0;
  }

  if (verb === "check") {
    const all = flags.has("--installed"), ci = flags.has("--ci"), diff = flags.has("--diff");
    let rules, title, dirArg, packName = null, problems = [];
    if (all) {
      rules = installedPackRules(packsDir).map((r) => ({ key: r.id, severity: r.severity, statement: r.statement, patterns: r.patterns, paths: r.paths, skip: r.pack.skip, trusted: r.pack.trusted }));
      problems = packProblems().map((p) => p.replace(/^memory-pulse: /, ""));
      if (!rules.length && !problems.length) return fail(`no pack is installed here (memory-pulse pack list)`);
      title = `${plural(new Set(rules.map((r) => r.key.split("/")[0])).size, "installed pack")}, with this project's choices`; dirArg = pos[0];
    } else {
      const at = locate(pos[0]); if (at.error) return fail(at.error);
      const p = loadPack(at.path); if (p.problem) return fail(`${at.path} is not a pack file (${p.problem}): memory-pulse pack verify ${at.path} names what is wrong`);
      rules = p.rules.filter((r) => usable(p, r, problems)).map((r) => ({ key: r.id, severity: ownSeverity(r), statement: r.statement, patterns: r.patterns, paths: r.paths, skip: ownSeverity(r) === "block" || r.mentions === "skip", trusted: p.trusted }));
      problems = problems.map((x) => x.replace(/^memory-pulse: /, ""));
      title = `${p.name} ${p.version}, as the pack marks its rules`; dirArg = pos[1]; packName = p.name;
    }
    let res, over;
    if (diff) {
      const got = changedLines(diffBase);
      if (got.error) return fail(`could not read the diff: ${got.error}`);
      res = scanDiff(rules, got.changed); over = diffBase ? `the lines added since ${diffBase}` : "staged, unstaged and untracked changes";
    } else {
      const root = resolve(dirArg ?? ".");
      let ok = false; try { ok = lstatSync(root).isDirectory(); } catch { /* missing */ }
      if (!ok) return fail(`${dirArg} is not a directory`);
      res = scanTree(rules, root); over = shownPath(root) || ".";
    }
    const order = new Map(rules.map((r, i) => [r.key, i]));
    res.hits.sort((a, b) => order.get(a.rule) - order.get(b.rule) || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    const nBlock = res.hits.filter((h) => h.severity === "block").length, nWarn = res.hits.length - nBlock;
    const skipped = [...new Set(res.skipped)];
    const code = ci && (nBlock || problems.length) ? 1 : 0;
    if (json) { say(JSON.stringify({ pack: all ? null : packName, over, files: res.files, hits: res.hits, block: nBlock, warn: nWarn, problems, skipped, rules: rules.map((r) => ({ rule: r.key, severity: r.severity, hits: res.hits.filter((h) => h.rule === r.key).length })) }, null, 2)); return code; }
    say(`pack check: ${title}, over ${over}\n`);
    for (const p of problems) say(`${p}\n`);
    const label = (r) => (all ? r.severity : r.severity === "block" ? "can block" : "warn");
    const w = Math.max(...rules.map((r) => r.key.length), 4), lw = all ? 5 : 9; const quiet = [];
    for (const r of rules) {
      const mine = res.hits.filter((h) => h.rule === r.key);
      if (!mine.length) { quiet.push(r.key); continue; }
      say(`${r.key.padEnd(w)}  ${label(r).padEnd(lw)}  ${plural(mine.length, "hit")}${r.statement ? `   ${r.statement}` : ""}`);
      for (const h of mine.slice(0, 20)) say(`  ${h.file}:${h.line}: ${h.text}`);
      if (mine.length > 20) say(`  +${mine.length - 20} more (--json lists every hit)`);
    }
    if (quiet.length) say(`${res.hits.length ? "\n" : ""}no hits: ${quiet.join(", ")}`);
    for (const s of skipped.slice(0, 10)) say(`\n${s}`);
    say(`\n${plural(res.files, "file")} read, ${plural(res.hits.length, "hit")} (${nBlock} from ${all ? "block rules" : "rules that can block"}, ${nWarn} from warn rules)`);
    say(code ? `pack check --ci: ${nBlock ? `${plural(nBlock, "hit")} from block rules` : ""}${nBlock && problems.length ? ", and " : ""}${problems.length ? `${plural(problems.length, "pack file")} that did not load` : ""}, exit 1. Nothing was written.` : "dry run: nothing was blocked and nothing was written");
    return code;
  }

  return fail(PACK_USAGE);
}
