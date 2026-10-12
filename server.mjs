#!/usr/bin/env node
/**
 * memory-pulse — MCP server (stdio) for Claude Code, Codex, Cursor, and any
 * MCP client.
 *
 * What runs where, stated plainly because it is the privacy contract:
 *
 *   - Your ledger is a local file: .memory-pulse/events.jsonl in your project.
 *     `remember` writes to it directly and works offline.
 *   - Read operations (pulse / recall / execute) send the ledger's events to
 *     the hosted engine over TLS, which computes the answer and forgets the
 *     request. The service keeps NO database of your memory — state arrives
 *     in the request and leaves in the response.
 *   - This client is the entire client. No SDK, no dependencies, one file
 *     you can read in one sitting.
 *
 * Config (env): run `memory-pulse help` for the full list with defaults.
 *   MEMORY_PULSE_KEY     license key (optional — free tier without one)
 *   MEMORY_PULSE_API     override the API base (default: hosted service)
 *   MEMORY_PULSE_LEDGER  override the ledger path (default: ./.memory-pulse/events.jsonl)
 *   MEMORY_PULSE_AGENT, MEMORY_PULSE_PROJECT, MEMORY_PULSE_MEMORY_KEY, MEMORY_PULSE_MODE,
 *   MEMORY_PULSE_SETTINGS_DIR, MEMORY_PULSE_BRIEF, MEMORY_PULSE_BRIEF_BUDGET, MEMORY_PULSE_BRIEF_TIER, NO_COLOR, HOME
 */
import { createHash, createCipheriv } from "node:crypto";
// http, https, zlib and readline load on first use: the guard runs as a fresh process on every tool call and never
// touches the network, so it does not pay for them (measured 2026-10-02: ~5 ms of a ~60 ms hook call).
import { createRequire } from "node:module";
const lazyRequire = createRequire(import.meta.url);
const builtin = (name) => lazyRequire(`node:${name}`);

// The version an MCP client displays. It was hardcoded and had drifted to
// 0.2.1 while the package shipped 0.5.3, so every client showed a version
// three releases stale. Read it from the manifest instead; a test pins them.
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8")).version;
  } catch { return "0.0.0"; }
})();
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, realpathSync, readdirSync, statSync, renameSync, unlinkSync, openSync, closeSync, writeSync, truncateSync} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { renderScaffold as renderScaffoldWith, DEFAULT_BUDGETS, SECTIONS } from "./lib/scaffold.mjs";
import { promptSlice as promptSliceWith, editSlice as editSliceWith } from "./lib/slices.mjs";

const API = (process.env.MEMORY_PULSE_API ?? "https://pulse.strategic-innovations.ai").replace(/\/$/, "");
const KEY = process.env.MEMORY_PULSE_KEY ?? null;

// ---------------------------------------------------------------- ledger ----
function ledgerPath() {
  const env = process.env.MEMORY_PULSE_LEDGER;
  if (env) return isAbsolute(env) ? env : join(process.cwd(), env);
  return join(process.cwd(), ".memory-pulse", "events.jsonl");
}

// Loads the ledger and says what loaded: a session must be able to tell
// whether its memory arrived whole (anthropics/claude-code #82056 — "loaded
// whole, truncated, or not at all"). `malformed` lists 1-based line numbers
// that were skipped; `digest` is the sha256 of the bytes read; `bytes` the size.
// ---- Agent identity mode (0.5.0, opt-in). The AGENT's own ledger, user-level, shared by every project and every
// tool: who the agent is (pinned self), the standing rules and preferences it has learned, the lessons it carries,
// the corrections that follow it everywhere. Same file format, same chain, same seal. Off by default.
export function agentPath() {
  const env = process.env.MEMORY_PULSE_AGENT;
  if (env) return isAbsolute(env) ? env : join(process.cwd(), env);
  return join(process.env.HOME || process.cwd(), ".memory-pulse", "agent", "events.jsonl");
}
export function readEvents(opts = {}) {
  const path = opts.path ?? (opts.scope === "agent" ? agentPath() : ledgerPath());
  if (!existsSync(path)) return { path, events: [], malformed: [], bytes: 0, digest: null, lines: 0 };
  const raw = readFileSync(path, "utf8");
  const events = [], malformed = [];
  const lines = raw.split("\n");
  lines.forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    try {
      const e = JSON.parse(s);
      if (typeof e.cause === "string" && typeof e.effect === "string") events.push(e); else malformed.push(i + 1);
    } catch { malformed.push(i + 1); /* a torn line does not take the ledger down — but it is reported */ }
  });
  return { path, events, malformed, bytes: Buffer.byteLength(raw), digest: createHash("sha256").update(raw).digest("hex").slice(0, 12), lines: lines.filter((l) => l.trim()).length };
}

// One line of provenance for the brief: what loaded, from where, what binds.
export function loadedLine(led, allEvents, opts = {}) {
  const events = inForce(allEvents); const rolledBack = allEvents.length - events.length;
  const retired = supersededSet(events);
  const binding = events.filter((e) => e.kind === "correction" && Array.isArray(e.withdrawn) && e.withdrawn.length && !retired.has(e.t));
  const terms = new Set(binding.flatMap((e) => e.withdrawn));
  const unenforceable = events.filter((e) => e.kind === "correction" && !(Array.isArray(e.withdrawn) && e.withdrawn.length)).length;
  const parts = [`loaded ${events.length} events from ${relPath(led.path)}`];
  if (led.digest) parts.push(`sha256 ${led.digest}`);
  parts.push(`${binding.length} binding correction${binding.length === 1 ? "" : "s"} (${terms.size} withdrawn term${terms.size === 1 ? "" : "s"})`);
  if (unenforceable) parts.push(`${unenforceable} correction${unenforceable === 1 ? "" : "s"} without withdrawn terms (surfaced, not enforced)`);
  if (retired.size) parts.push(`${retired.size} superseded`);
  if (rolledBack) parts.push(`${rolledBack} row${rolledBack === 1 ? "" : "s"} rolled back (kept on record, out of force)`);
  if (led.malformed?.length) parts.push(`⚠ ${led.malformed.length} malformed line${led.malformed.length === 1 ? "" : "s"} skipped: ${led.malformed.slice(0, 5).join(", ")}${led.malformed.length > 5 ? "…" : ""}`);
  if (opts.keyStatus?.status === "resumed") parts.push(`memory key resumed (+${opts.keyStatus.newEvents ?? 0} new)`);
  else if (opts.keyStatus?.status === "rebuilt") parts.push(`memory key rebuilt${opts.keyStatus.reason ? ` (${opts.keyStatus.reason})` : ""}`);
  if (opts.tier) parts.push(`tier ${opts.tier}${opts.chars ? `, ${opts.chars.toLocaleString()} chars` : ""}${opts.budget ? ` (budget ${opts.budget} tokens)` : ""}`);
  return `memory-pulse: ${parts.join(" · ")}`;
}
const relPath = (p) => { const cwd = process.cwd(); return p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p; };

// The engine's memory-safety checks, mirrored so a refusal happens
// before the write. Keep in step with the engine; the engine is authoritative.
const INSTRUCTION_PATTERNS = [
  ["protect-instructions", /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|all|earlier)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?)\b/i],
  ["protect-role", /\byou are now\b|\bfrom now on,? you\b|\bact as (an?|the) (system|admin|developer)\b/i],
  // Any XML-ish wrapper tag, not just the enumerated role names: Claude Code injects synthetic
  // user-turn content (<task-notification>, <local-command-stdout>, <command-name>, ...) that is
  // system/tool output, not something the human typed — it must never be read as a correction.
  ["protect-boundaries", /<\/?\s*[a-z][\w-]{2,40}\s*(?:[\s>]|$)|\[(system|assistant|tool)\s*:?\s*\]/i],
  ["protect-configuration", /\b(reveal|print|show|dump)\b[^.\n]{0,30}\b(system prompt|hidden prompt|your instructions)\b/i],
  ["protect-execution", /\b(run|execute|paste)\b[^.\n]{0,25}\b(this|the following)\b[^.\n]{0,15}\b(command|script|shell|code)\b/i],
  ["protect-installs", /\b(curl|wget)\b[^\n]{0,120}\|\s*(sudo\s+)?(sh|bash|zsh)\b/i],
  ["protect-data", /\b(rm\s+-rf\s+[\/~]|drop\s+table|truncate\s+table|format\s+c:)/i],
  ["protect-credentials", /\b(send|post|upload|exfiltrat\w*|leak|forward|email)\b[^.\n]{0,40}\b(api[\s_-]?keys?|secrets?|tokens?|passwords?|credentials?)\b[^.\n]{0,40}\b(to|via|at)\b[^.\n]{0,4}(https?:\/\/|[\w.-]+@[\w.-]+\b|this\b|the following\b|that (address|url|endpoint|server)\b|me\b)|\b(send|give|show|tell) me\b[^.\n]{0,30}\b(api[\s_-]?keys?|secrets?|tokens?|passwords?|credentials?)\b/i ],
  ["protect-transparency", /\b(do not|don't|never)\b[^.\n]{0,20}\b(tell|show|mention|reveal)\b[^.\n]{0,20}\b(the )?(user|human|operator)\b/i],
];
export function instructionLike(text) {
  if (typeof text !== "string" || !text) return [];
  return INSTRUCTION_PATTERNS.filter(([, re]) => re.test(text)).map(([id]) => id);
}

const t_next = (events) => events.reduce((m, e) => Math.max(m, e.t ?? 0), 0) + 1;
// ---- Hash chain (2026-09-03). Every appended row carries prev (hash of the previous chained row) and hash (sha256 of its
// own canonical JSON, keys sorted, prev included). Rows that existed before the chain are never rewritten: the first chained
// row seals them with a digest of their raw bytes. verifyChain() fails closed and the guard/check/lint refuse a broken ledger.
const canonicalJson = (v) => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonicalJson).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
export const rowHash = (row) => { const { hash, ...rest } = row; return createHash("sha256").update(canonicalJson(rest)).digest("hex"); };
export const sealDigest = (rawLines) => createHash("sha256").update(rawLines.map((l) => l.trim()).filter(Boolean).join("\n")).digest("hex");
const hasHash = (line) => { try { const o = JSON.parse(line); return o && typeof o.hash === "string"; } catch { return false; } };
export function verifyChain(path = ledgerPath()) {
  // Rows before the first hashed row are legacy (sealed by it). After that every chained row links to the previous
  // chained row AND seals the unchained rows written in between (gap_digest): an older writer appends rows without a
  // hash, and that is not an edit. An unchained tail is reported as `unsealed` (the next chained write seals it).
  if (!existsSync(path)) return { ok: true, legacy: 0, chained: 0, head: null, from: null, sealed: false, unsealed: 0 };
  return verifyChainLines(readFileSync(path, "utf8").split("\n"));
}
/** The same walk over raw lines — a state capsule carries the ledger's lines verbatim and is verified before it is trusted. */
export function verifyChainLines(rawLines) { return walkChain(rawLines.map((l) => l.trim()).filter(Boolean)).result; }
// The walk, resumable: `state` is where a previous walk stopped (the verification cache continues from it over
// appended rows instead of re-hashing the whole ledger on every hook call).
export function walkChain(lines, state = null) {
  let prev = state?.prev ?? null, chained = state?.chained ?? 0, from = state?.from ?? null, legacy = state?.legacy ?? 0;
  const gap = [...(state?.gap ?? [])];
  const out = (extra) => ({ legacy, chained, head: prev, from, ...extra });
  const done = (result) => ({ result, state: result.ok ? { prev, chained, from, legacy, gap: [...gap] } : null });
  for (const line of lines) {
    let row = null; try { row = JSON.parse(line); } catch { /* a torn line is an unchained row */ }
    if (!row || typeof row.hash !== "string") { gap.push(line); continue; }
    if (chained === 0) {
      from = row.t ?? null; legacy = gap.length;
      if (row.legacy_digest !== sealDigest(gap)) return done(out({ ok: false, head: null, reason: `legacy rows changed since the chain sealed them (digest mismatch at t=${row.t})`, brokenAt: row.t ?? null }));
    } else {
      if (row.prev !== prev) return done(out({ ok: false, reason: `row t=${row.t} does not link to the previous chained row (a row was removed, reordered or inserted)`, brokenAt: row.t ?? null }));
      const want = row.gap_digest ?? null;
      if (want === null ? gap.length > 0 : want !== sealDigest(gap)) return done(out({ ok: false, reason: `unchained rows before t=${row.t} do not match the gap it sealed (${gap.length} row(s); edited, removed or inserted)`, brokenAt: row.t ?? null }));
    }
    if (rowHash(row) !== row.hash) return done(out({ ok: false, reason: `row t=${row.t} does not match its own hash (edited in place)`, brokenAt: row.t ?? null }));
    prev = row.hash; chained++; gap.length = 0;
  }
  if (chained === 0) return done({ ok: true, legacy: gap.length, chained: 0, head: null, from: null, sealed: false, unsealed: 0 });
  return done(out({ ok: true, sealed: true, unsealed: gap.length }));
}

// ---- Integrity without lockout (2026-10-02). Another session wrote a row straight into the agent ledger, hashed
// over Python's json.dumps(row, sort_keys=True) instead of the canonical form, with a reused t. The chain broke at
// the tail and the guard then refused every Bash/Write/Edit in every session, including the edits that would have
// repaired the file. Three changes, all here:
//   1. inspectChain/quarantineTail: when every row after the last good one fails ON ITS OWN MERITS (bad JSON, its
//      own hash wrong, a non-increasing t, a link to nothing), those rows move byte-for-byte to
//      <ledger>.quarantine/<time>.jsonl and a canonical row records the move. Nothing is deleted.
//   2. a break with valid rows after it (an edit, a removal, an insertion mid-file) still blocks writes to the
//      ledger and its sidecars, and only warns everywhere else.
//   3. one locked writer: every append takes <ledger>.lock (O_EXCL), re-reads the file, and computes t, prev and
//      hash itself; `memory-pulse append` is the public way in for other tools.
const lineEntries = (buf) => {
  const out = []; let start = 0, n = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start); end = end === -1 ? buf.length : end + 1;
    out.push({ start, end, line: ++n, text: buf.subarray(start, end).toString("utf8").replace(/\r?\n$/, "") });
    start = end;
  }
  return out;
};
const rowT = (text) => { try { const t = JSON.parse(text).t; return Number.isInteger(t) ? t : null; } catch { return null; } };

/** Where the chain breaks, and whether everything from there on is bad on its own (a quarantinable tail). */
export function inspectChain(input) {
  const buf = Buffer.isBuffer(input) ? input : existsSync(input) ? readFileSync(input) : Buffer.alloc(0);
  const entries = lineEntries(buf).filter((e) => e.text.trim());
  const res = walkChain(entries.map((e) => e.text.trim())).result;
  if (res.ok) return { ...res, firstBad: null, tail: null };
  // the verified prefix ends at the last chained row the walk accepted (its hash is res.head)
  let keep = 0, maxT = 0, k = -1;
  if (res.head) {
    k = entries.findIndex((e) => { try { return JSON.parse(e.text).hash === res.head; } catch { return false; } });
    keep = entries[k].end;
  }
  for (const e of entries.slice(0, k + 1)) { const t = rowT(e.text); if (t !== null && t > maxT) maxT = t; }
  const bad = entries.find((e, i) => i > k && rowT(e.text) === res.brokenAt && (() => { try { return typeof JSON.parse(e.text).hash === "string"; } catch { return false; } })()) ?? entries[k + 1];
  // Judge every row after the prefix on its own: valid JSON, its own hash right, linked to the row before it in the
  // tail, t still increasing. One row that stands on its own makes this a mid-file break, not a bad tail.
  const tailRows = entries.slice(k + 1);
  let prevTail = null, lastT = maxT, selfValid = 0;
  for (const e of tailRows) {
    let row = null; try { row = JSON.parse(e.text); } catch { /* bad */ }
    let ok = !!row && typeof row.cause === "string" && typeof row.effect === "string" && Number.isInteger(row.t) && row.t > lastT;
    if (ok && typeof row.hash === "string") ok = rowHash(row) === row.hash && (prevTail === null || row.prev === prevTail);
    if (ok) { selfValid++; lastT = row.t; if (typeof row.hash === "string") prevTail = row.hash; }
  }
  return { ...res, firstBad: bad ? { t: rowT(bad.text), line: bad.line } : null,
    tail: { keepBytes: keep, rows: tailRows.length, allBad: tailRows.length > 0 && selfValid === 0, headT: maxT || null } };
}

const lockPathFor = (ledger) => `${ledger}.lock`;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** Run fn holding <ledger>.lock. A lock whose holder is dead, or older than staleMs, is broken; a live one is waited
 *  for until timeoutMs (MEMORY_PULSE_LOCK_TIMEOUT_MS, default 5000), then refused: never written past. */
export function withLedgerLock(path, fn, { timeoutMs = Number(process.env.MEMORY_PULSE_LOCK_TIMEOUT_MS ?? 5000), staleMs = 30_000 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const lock = lockPathFor(path); const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const fd = openSync(lock, "wx"); try { writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } finally { closeSync(fd); } break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      let holder = null, st = null;
      try { st = statSync(lock); holder = JSON.parse(readFileSync(lock, "utf8")); } catch { /* gone or half-written */ }
      const stale = st && ((holder && !pidAlive(holder.pid)) || Date.now() - st.mtimeMs > staleMs);
      if (stale) { try { if (statSync(lock).ino === st.ino) unlinkSync(lock); } catch { /* someone else broke it first */ } continue; }
      if (Date.now() >= deadline) { const err = new Error(`ledger is locked by pid ${holder?.pid ?? "?"} since ${holder?.at ?? "?"} (${lock})`); err.code = "ELEDGERLOCKED"; throw err; }
      sleepSync(10);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}

const isoStamp = () => new Date().toISOString().replace(/[:.]/g, "-");
// Called with the lock held. Moves a bad tail aside and records it; refuses anything that is not a bad tail.
function quarantineTailLocked(path) {
  if (!existsSync(path)) return { quarantined: false, reason: "no ledger" };
  const buf = readFileSync(path);
  const info = inspectChain(buf);
  if (info.ok) return { quarantined: false, reason: "the chain verifies" };
  if (!info.tail?.allBad) return { quarantined: false, notTail: true, reason: info.reason, firstBad: info.firstBad };
  const moved = buf.subarray(info.tail.keepBytes);
  const dir = `${path}.quarantine`; mkdirSync(dir, { recursive: true });
  let file = join(dir, `${isoStamp()}.jsonl`); if (existsSync(file)) file = join(dir, `${isoStamp()}-${process.pid}.jsonl`);
  writeFileSync(file, moved, { flag: "wx" });
  if (!readFileSync(file).equals(moved)) throw new Error(`quarantine copy of ${path} did not read back identically; ledger left as it was`);
  truncateSync(path, info.tail.keepBytes);
  const digest = createHash("sha256").update(moved).digest("hex");
  const event = appendRowLocked(path, {
    cause: "ledger-tail-quarantined", effect: `moved-${info.tail.rows}-row${info.tail.rows === 1 ? "" : "s"}-after-t${info.tail.headT ?? 0}-aside`, kind: "event", tags: ["integrity", "quarantine"],
    note: `${info.tail.rows} row(s) after t=${info.tail.headT ?? 0} failed on their own (${info.reason}) and were moved byte-for-byte to ${file}; nothing was deleted`,
    quarantine: { file, rows: info.tail.rows, sha256: digest, first_bad_t: info.firstBad?.t ?? null, reason: info.reason },
  });
  return { quarantined: true, file, rows: info.tail.rows, sha256: digest, firstBad: info.firstBad, reason: info.reason, t: event.t };
}
export function quarantineTail(path) { return withLedgerLock(path, () => quarantineTailLocked(path)); }

// Link a finished row to the chain and append it (lock held): t when the caller left it unset (the file's max t
// plus one, read under the lock, so two writers never share a t), prev = the last chained row's hash, gap_digest =
// the unchained rows since it (or legacy_digest = every row so far, for the first chained row), then its own hash.
function appendRowLocked(path, event) {
  if (!existsSync(path)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, ""); }
  const raw = readFileSync(path, "utf8");
  if (raw.length && !raw.endsWith("\n")) appendFileSync(path, "\n"); // a torn last line stays its own row
  const lines = raw.split("\n").filter((l) => l.trim()); let last = null, seen = false, maxT = 0; const gap = [];
  for (const l of lines) {
    let o = null; try { o = JSON.parse(l); } catch { /* torn */ }
    if (o && Number.isInteger(o.t) && o.t > maxT) maxT = o.t;
    if (o && typeof o.hash === "string") { seen = true; last = o.hash; gap.length = 0; } else gap.push(l);
  }
  delete event.prev; delete event.hash; delete event.gap_digest; delete event.legacy_digest;
  if (!Number.isInteger(event.t)) event.t = maxT + 1;
  if (seen) { event.prev = last; if (gap.length) event.gap_digest = sealDigest(gap); } else { event.legacy_digest = sealDigest(gap); event.prev = null; }
  event.hash = rowHash(event);
  appendFileSync(path, JSON.stringify(event) + "\n");
  return event;
}
// The one writer. A bad tail is moved aside before anything is chained onto it.
function chainAppend(path, event) {
  return withLedgerLock(path, () => {
    const info = existsSync(path) ? inspectChain(path) : { ok: true };
    if (!info.ok && info.tail?.allBad) quarantineTailLocked(path);
    return appendRowLocked(path, event);
  });
}

// ---- Verification cache (2026-10-02). The guard runs on every Bash/Write/Edit; re-parsing and re-hashing the
// whole ledger each time cost ~16 ms on 1,500 rows, twice per call. Keyed by inode, size, mtime and ctime (ctime
// moves on any write, even one that puts mtime back), so an edit is never served from the cache; a ledger that only
// grew is verified over the appended bytes after the old ones are matched by sha256.
const cachePathFor = (ledger) => join(dirname(ledger), "verify.cache.json");
const statKey = (st) => ({ ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
const sameKey = (a, b) => !!a && !!b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
// One read per process: the guard consults the cache three times per call (chain, rows, seal).
const cacheMemo = new Map();
function readCacheFile(ledger) {
  const f = cachePathFor(ledger);
  if (cacheMemo.has(f)) return cacheMemo.get(f);
  let all = {}; try { all = JSON.parse(readFileSync(f, "utf8")); } catch { /* none yet */ }
  cacheMemo.set(f, all); return all;
}
function readCache(ledger) { return readCacheFile(ledger)[basename(ledger)] ?? null; }
function writeCache(ledger, entry) {
  const all = { ...readCacheFile(ledger), [basename(ledger)]: entry };
  cacheMemo.set(cachePathFor(ledger), all);
  try { const tmp = `${cachePathFor(ledger)}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(all)); renameSync(tmp, cachePathFor(ledger)); }
  catch { /* read-only checkout: no cache, same answers */ }
}
export function verifyChainCached(path = ledgerPath(), { maxIncrementals = 256 } = {}) {
  if (!existsSync(path)) return { ...verifyChain(path), cache: "none" };
  const st = statSync(path); const key = statKey(st); const entry = readCache(path);
  if (entry && sameKey(entry.key, key)) return { ...entry.result, cache: "hit" };
  const buf = readFileSync(path);
  const digestOf = (b) => createHash("sha256").update(b).digest("hex");
  if (entry?.state && entry.result?.ok && entry.key.ino === key.ino && buf.length > entry.key.size && (entry.incrementals ?? 0) < maxIncrementals
      && buf[entry.key.size - 1] === 0x0a && digestOf(buf.subarray(0, entry.key.size)) === entry.prefixSha) {
    const added = buf.subarray(entry.key.size).toString("utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    const { result, state } = walkChain(added, entry.state);
    writeCache(path, { key, prefixSha: digestOf(buf), result, state: state && state.gap.length <= 100 ? state : null, incrementals: (entry.incrementals ?? 0) + 1, guard: null });
    return { ...result, cache: "incremental" };
  }
  const { result, state } = walkChain(buf.toString("utf8").split("\n").map((l) => l.trim()).filter(Boolean));
  writeCache(path, { key, prefixSha: digestOf(buf), result, state: state && state.gap.length <= 100 ? state : null, incrementals: 0, guard: null });
  return { ...result, cache: "full" };
}

// ---- Set head + seal (2026-09-03). The engine returns a signed seal on every read call: the order-free set head
// (MuHash-style fold mod a 3072-bit prime; rows enter as SHA-256(canonical row) → AES-256-CTR keystream → BigInt) over
// every row's full content, the row-chain head, a count and a watermark, under the engine's tag. The client keeps it
// beside the ledger and presents it with the next call. Locally it cannot check the tag (no secret here) but it CAN
// check content: rows up to the sealed watermark must still fold to the sealed head — a rogue edit below the watermark
// is caught before the ledger is trusted. The engine re-checks the tag and the fold on the next call.
const SEAL_P = (1n << 3072n) - 1103717n;
const sealMod = (a) => ((a % SEAL_P) + SEAL_P) % SEAL_P;
export function sealElement(row) {
  const { hash, ...rest } = row; const key = createHash("sha256").update(canonicalJson(rest)).digest();
  const v = BigInt("0x" + createCipheriv("aes-256-ctr", key, Buffer.alloc(16)).update(Buffer.alloc(384)).toString("hex")) % SEAL_P;
  return v === 0n ? 1n : v;
}
export const setHeadHex = (rows) => rows.reduce((v, r) => sealMod(v * sealElement(r)), 1n).toString(16).padStart(768, "0");
const sealPathFor = (ledger) => join(dirname(ledger), "seal.rain");
const sealPath = () => sealPathFor(ledgerPath());
export function readSeal(ledger) { try { return JSON.parse(readFileSync(ledger ? sealPathFor(ledger) : sealPath(), "utf8")); } catch { return null; } }
function writeSeal(seal) { if (!seal || typeof seal !== "object" || typeof seal.head !== "string") return; try { mkdirSync(dirname(sealPath()), { recursive: true }); writeFileSync(sealPath(), JSON.stringify(seal, null, 2) + "\n"); } catch { /* read-only checkout */ } }
const sealResumePathFor = (ledger) => join(dirname(ledger), "seal.resume.json");
// The set head is a product in an abelian group, so a head already folded over an append-only prefix is resumed with a
// group multiply over the rows added since — the same order-free property that lets disjoint shards fold without
// coordination. The row chain anchors it: a resume point is only taken when verifyChain passed AND the row it names
// still hashes to the recorded anchor, and that row's prev links pin every row before it. An edit below the resume
// point breaks the chain, so it can never be folded past. With no verified chain the whole prefix folds from identity.
export function setHeadResumed(rows, chain, ledger = ledgerPath()) {
  if (!chain || chain.ok !== true) return setHeadHex(rows);
  const file = sealResumePathFor(ledger);
  let acc = 1n, start = 0;
  try {
    const r = JSON.parse(readFileSync(file, "utf8"));
    if (Number.isInteger(r.n) && r.n > 0 && r.n <= rows.length && typeof r.head === "string" && /^[0-9a-f]{768}$/.test(r.head)
      && typeof r.anchor === "string" && rows[r.n - 1]?.hash === r.anchor) { acc = BigInt("0x" + r.head); start = r.n; }
  } catch { /* no resume point yet */ }
  for (let i = start; i < rows.length; i++) acc = sealMod(acc * sealElement(rows[i]));
  const head = acc.toString(16).padStart(768, "0");
  // Only a chained row can anchor the next resume. An unchained tail from an older writer leaves the point where it is.
  const last = rows[rows.length - 1];
  if (typeof last?.hash === "string") {
    const tmp = `${file}.${process.pid}.tmp`;
    try { writeFileSync(tmp, JSON.stringify({ n: rows.length, anchor: last.hash, head })); renameSync(tmp, file); }
    catch { try { unlinkSync(tmp); } catch { /* nothing to clean up */ } /* read-only checkout */ }
  }
  return head;
}

/** content check of the local ledger against the last seal — fails closed; { ok: null } when there is no seal yet */
export function verifyLocalSeal(events = readEvents().events, seal = readSeal(), chain = null, ledger = ledgerPath()) {
  if (!seal || typeof seal.head !== "string") return { ok: null, reason: "no seal yet (first engine call issues one)" };
  const covered = events.filter((e) => (Number(e.t) || 0) <= Number(seal.through));
  if (covered.length !== Number(seal.events)) return { ok: false, reason: `ledger has ${covered.length} rows up to the sealed watermark t=${seal.through}, the seal covers ${seal.events}`, seal };
  if (setHeadResumed(covered, chain, ledger) !== seal.head) return { ok: false, reason: `ledger content changed since the last sealed call (rows up to t=${seal.through} no longer fold to the sealed head)`, seal };
  return { ok: true, seal };
}

// Fields a row may carry beyond the finding itself. `rollback_to` marks a rollback row (state rollback); `origin` names
// the branch and row a merged row came from; `state` records which capsule an import or a merge came from.
const ROW_FIELDS = ["rollback_to", "origin", "state"];

export function appendEvent({ cause, effect, note, kind, tags, pinned, withdrawn, replacement, supersedes, override, scope, fields }) {
  // Instruction-like notes are refused at the write. The engine quarantines
  // them at read time too (and reports it), but a note that would be rendered
  // into every future session as an instruction should never reach the ledger.
  // Same deterministic list as the engine; no model in the loop.
  const hits = instructionLike(note);
  if (hits.length) return { written: false, reason: "instruction-like note refused", patterns: hits, hint: "Record what happened, not what to do. Rephrase as a finding." };
  const { path, events } = readEvents({ scope });
  // A duplicate is the same cause, effect, note AND terms. The old rule ignored the terms, so the product's
  // own hint ("record it again with withdrawn") was refused as a duplicate (daily-use review, 2026-09-09).
  const norm = (a) => JSON.stringify(Array.isArray(a) ? a.map((w) => String(w).trim()).filter(Boolean) : []);
  const dup = events.find((e) => e.cause === cause && e.effect === effect && (e.note ?? "") === (note ?? "") && norm(e.withdrawn) === norm(withdrawn) && norm(e.replacement) === norm(replacement));
  if (dup) return { written: false, reason: "duplicate", t: dup.t, ledger: path, hint: "Nothing written: a row with the same cause, effect, note and terms is refused as a duplicate. Record it again with withdrawn (and replacement) to add terms, or change the note if this is a new finding." };
  // t is assigned by the writer under the ledger lock (two writers never share one); this is only the order of keys.
  const event = { t: undefined, cause, effect, kind: kind || "event" };
  if (note) event.note = note;
  if (Array.isArray(tags) && tags.length) event.tags = tags;
  if (pinned) event.pinned = true;
  // Withdrawn terms are what the guard enforces: exact strings that must not
  // be written again. Only explicit terms count — the guard never guesses.
  const dropped = [];
  if (Array.isArray(withdrawn)) {
    const all = withdrawn.map((w) => String(w).trim()).filter(Boolean);
    const terms = all.filter((w) => w.length >= 2);
    dropped.push(...all.filter((w) => w.length < 2));
    if (terms.length) event.withdrawn = terms;
  }
  // Replacement terms let the guard tell a REINTRODUCTION ("price is $49")
  // apart from a DISAVOWAL or comparison ("was $49, now $29"): an edit that
  // carries a replacement alongside the withdrawn term is allowed.
  // A replacement anywhere in an edit releases every withdrawn term of its correction, so a one-character
  // replacement ("8") would release the block on nearly any text. Same floor as withdrawn terms.
  if (Array.isArray(replacement)) {
    const all = replacement.map((w) => String(w).trim()).filter(Boolean);
    const terms = all.filter((w) => w.length >= 2);
    dropped.push(...all.filter((w) => w.length < 2));
    if (terms.length) event.replacement = terms;
  }
  // A correction of a correction: the earlier event's withdrawn terms stop
  // binding (only the latest binds). The ledger is append-only, so this is
  // the only way to narrow a term that turned out too broad — the first
  // estate correction withdrew a bare "$79", which is also our own price.
  if (kind === "override" && override && typeof override.term === "string" && override.term.trim()) {
    event.override = { term: override.term.trim(), ...(override.path ? { path: String(override.path) } : {}), ...(override.reason ? { reason: String(override.reason).slice(0, 200) } : {}) };
  }
  if (Array.isArray(supersedes)) {
    const ts = [...new Set(supersedes.map(Number).filter((t) => Number.isInteger(t) && t >= 1 && t < t_next(events)))].sort((a, b) => a - b);
    if (ts.length) {
      if ((kind || "event") !== "correction") return { written: false, reason: "supersedes belongs on a correction", hint: "Set kind='correction' when retiring an earlier correction's withdrawn terms." };
      event.supersedes = ts;
    }
  }
  if (fields && typeof fields === "object") for (const k of ROW_FIELDS) if (fields[k] !== undefined) event[k] = fields[k];
  try { chainAppend(path, event); }
  catch (e) { if (e.code === "ELEDGERLOCKED") return { written: false, reason: e.message, ledger: path, hint: "Another writer holds the ledger lock; nothing was written. Retry, or remove the lock file if its holder is gone." }; throw e; }
  // Echo the canonical stored event back. A shell-quoting accident once ate a
  // word from a note SILENTLY; the caller must be able to see what the ledger
  // actually holds without re-reading the file.
  return { written: true, t: event.t, ledger: path, stored: event, ...(dropped.length ? { dropped } : {}) };
}

// ------------------------------------------------------------- telemetry ----
// The engine keeps no database, so telemetry lives HERE, beside your ledger,
// as a signed capsule the engine advances on every read call and hands back.
// You own it; delete the file and it restarts from zero.
const telemetryPath = () => join(dirname(ledgerPath()), "telemetry.rain");
function readTelemetry() {
  try { return JSON.parse(readFileSync(telemetryPath(), "utf8")); } catch { return null; }
}
function writeTelemetry(capsule) {
  if (!capsule || typeof capsule !== "object") return;
  try {
    mkdirSync(dirname(telemetryPath()), { recursive: true });
    writeFileSync(telemetryPath(), JSON.stringify(capsule, null, 2) + "\n");
  } catch { /* telemetry is a convenience; a read-only checkout must not break a read call */ }
}
const projectName = () => process.env.MEMORY_PULSE_PROJECT || process.cwd().split(/[\\/]/).filter(Boolean).pop() || "project";
const fmtK = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
/** The engine's own verdict on the seal the client presented — printed, never swallowed (silent success is the failure mode). */
export const sealDriftLine = (out) => (Array.isArray(out?.seal_drift) && out.seal_drift.length ? `⚠ ledger integrity (engine): ${out.seal_drift.join("; ")}` : "");
export function telemetryFooter(c) {
  const k = c?.counters;
  if (!k || !k.calls) return "";
  // Quarantine is printed on its own line by the brief; the footer carries
  // the drift reasons that are actually about the ledger changing.
  const reasons = (c.drift?.reasons ?? []).filter((r) => !/quarantined/.test(r));
  const drift = reasons.length ? ` · ⚠ drift: ${reasons.join("; ")}` : "";
  return `— memory-pulse · ${k.pulse} re-entries · ${k.correctionsSurfaced} corrections surfaced · ~${fmtK(k.tokensSavedEst)} tokens saved (est., signed)${drift}`;
}

// ------------------------------------------------------------ memory key ----
// State persistence without a database. After a read the engine hands back a
// signed memory key; presenting it on the next read resumes the memory and
// ingests only the events recorded since (measured: a full re-entry on an
// 825-event ledger went from 4.5 s to 1.5 s). It lives beside your ledger as
// memory.rain, it is yours, and a lost or stale key costs one rebuild — never
// data. It never enters the agent's context. MEMORY_PULSE_MEMORY_KEY=off disables it.
const memoryKeyPath = () => join(dirname(ledgerPath()), "memory.rain");
const memoryKeyOn = () => (process.env.MEMORY_PULSE_MEMORY_KEY || "on") !== "off";
function readMemoryKey() {
  if (!memoryKeyOn()) return null;
  try { return JSON.parse(readFileSync(memoryKeyPath(), "utf8")); } catch { return null; }
}
function writeMemoryKey(k) {
  if (!memoryKeyOn() || !k || typeof k !== "object") return;
  try {
    const dir = dirname(memoryKeyPath());
    mkdirSync(dir, { recursive: true });
    writeFileSync(memoryKeyPath(), JSON.stringify(k));
    // The ledger is the source of truth; the key is a rebuildable cache and
    // has no business in version control.
    // Only in the default layout: a custom ledger directory is the user's to
    // manage, and this client does not leave files in it uninvited.
    const gi = join(dir, ".gitignore");
    // Additive: an existing ignore file predates later derived artefacts, and a
    // rebuildable file that shows up in git status is a support ticket.
    if (dir.endsWith(".memory-pulse")) {
      const have = existsSync(gi) ? readFileSync(gi, "utf8") : "";
      const want = ["memory.rain", "seal.resume.json", "verify.cache.json"].filter((n) => !have.split("\n").some((l) => l.trim() === n));
      if (want.length) writeFileSync(gi, have + (have && !have.endsWith("\n") ? "\n" : "") + want.join("\n") + "\n");
    }
  } catch { /* a read-only checkout must not break a read call */ }
}

// ------------------------------------------------------------------- api ----
// Transport: Node's own http(s) on a FRESH HTTP/1.1 connection per call.
// The global fetch pools an HTTP/2 session that the edge retires after a
// few large requests, and undici then throws ERR_HTTP2_INVALID_SESSION on
// reuse instead of reconnecting — `bench` on an 822-event ledger lost 11 of
// 12 sequential calls to it, and a retry reused the same dead session. No
// pooling, no session, no dependency.
function postJson(url, headers, payload) {
  const u = new URL(url);
  const mod = builtin(u.protocol === "http:" ? "http" : "https");
  // Ledgers compress 5-10x (notes are prose); anything past 4 KB goes up
  // gzipped. The engine inflates it; a small body is not worth the header.
  const gz = Buffer.byteLength(payload) >= 4096;
  const body = gz ? builtin("zlib").gzipSync(payload) : Buffer.from(payload);
  return new Promise((resolve, reject) => {
    const req = mod.request(u, {
      method: "POST", agent: false,
      headers: { ...headers, ...(gz ? { "content-encoding": "gzip" } : {}), "content-length": body.length, connection: "close" },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

// Transient transport failures on a fresh connection (a TLS record hiccup, a
// reset) get exactly one retry — a new connection each time, so the retry
// means something. Anything else surfaces immediately with its real cause.
const TRANSIENT = /ERR_SSL|ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN/;
async function postJsonRetry(url, headers, payload) {
  try { return await postJson(url, headers, payload); }
  catch (first) {
    if (!TRANSIENT.test(String(first?.code || first?.message || ""))) throw first;
    return postJson(url, headers, payload);
  }
}

async function callApi(route, body) {
  const prior = readTelemetry();
  const mk = readMemoryKey();
  const wantKey = !mk && memoryKeyOn() && Array.isArray(body.events) && body.events.length >= 500;
  const priorSeal = readSeal();
  body = { ...body, project: projectName(), ...(prior ? { telemetry: prior } : {}), ...(priorSeal ? { seal: priorSeal } : {}), ...(mk ? { key: mk } : wantKey ? { wantKey: true } : {}) };
  let res;
  try {
    res = await postJsonRetry(`${API}${route}`, { "content-type": "application/json", ...(KEY ? { "x-mp-key": KEY } : {}) }, JSON.stringify(body));
  } catch (err) {
    const why = err?.cause?.code || err?.code || err?.message || String(err);
    throw new Error(
      `memory-pulse API unreachable (${why}). \`remember\` still works (it writes locally); ` +
      "pulse/recall/execute need the network. Check connectivity or MEMORY_PULSE_API.",
    );
  }
  const out = await res.json().catch(() => ({}));
  if (res.ok && out.telemetry) { writeTelemetry(out.telemetry); }
  if (res.ok && out.key) { writeMemoryKey(out.key); delete out.key; }
  if (res.ok && out.seal) { writeSeal(out.seal); delete out.seal; }
  if (!res.ok) {
    let msg = out.error ?? `API error ${res.status}`;
    if (out.upgrade) msg += ` — upgrade: ${out.upgrade}`;
    throw new Error(msg);
  }
  return out;
}

// ----------------------------------------------------------------- tools ----
const TIERS = ["index", "brief", "notes", "full"];
export const TOOLS = [
  {
    name: "pulse",
    description:
      "Re-enter a project without reading its history into context. Returns a salience-ranked brief " +
      "that ALWAYS carries every recorded correction first, so a superseded number cannot be quoted by " +
      "accident. Call this before answering questions about prior work.",
    inputSchema: {
      type: "object",
      properties: {
        tier: { type: "string", enum: TIERS, description: "index (smallest) → full. Default brief; omit it with `budget` to get the richest tier that fits." },
        budget: { type: "number", description: "Tokens you can spare for the brief. The brief is sized to fit; corrections always come first and whole." },
        root: { type: "string", description: "Entity to centre the causal front on." },
      },
    },
  },
  {
    name: "recall",
    description:
      "Query the causal graph: what an event caused (effects), what caused it (causes), a multi-hop " +
      "chain (pulse), or when a link was strongest (when). Hits carry a confidence; `exact` lists the " +
      "recorded links verbatim, so a weak read never hides a correction. Returns nothing rather than guessing.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["effects", "causes", "pulse", "when"] },
        subject: { type: "string", description: "Entity to query." },
        object: { type: "string", description: "Second entity — required by 'when', which scores an edge." },
        topk: { type: "number", description: "Max hits. Default 5." },
      },
      required: ["op", "subject"],
    },
  },
  {
    name: "remember",
    description:
      "Record a finding so the next session starts with it. Use kind='correction' when a claim is " +
      "withdrawn or a number is superseded — corrections are surfaced first at every tier and never decay. " +
      "Cheap, idempotent, and fully local (works offline).",
    inputSchema: {
      type: "object",
      properties: {
        cause: { type: "string" },
        effect: { type: "string" },
        note: { type: "string", description: "What was measured, and how." },
        kind: { type: "string", enum: ["event", "correction"], description: "Default event." },
        scope: { type: "string", enum: ["project", "agent"], description: "agent = the agent's own cross-project ledger (agent mode)." },
        withdrawn: { type: "array", items: { type: "string" }, description: "For corrections: the exact strings that were withdrawn (a number, a name, a claim). The guard hook blocks an edit that writes them back." },
        replacement: { type: "array", items: { type: "string" }, description: "For corrections: the corrected value(s). An edit containing both a withdrawn term and a replacement (a comparison or disavowal) is allowed through the guard." },
        supersedes: { type: "array", items: { type: "number" }, description: "For corrections: ledger t values of earlier corrections whose withdrawn terms no longer bind." },
        tags: { type: "array", items: { type: "string" } },
        pinned: { type: "boolean", description: "Never decays out of the brief." },
      },
      required: ["cause", "effect"],
    },
  },
  {
    name: "execute",
    description:
      "Run a JavaScript program against memory in a sandbox; ONLY its return value enters context. " +
      "Use for questions needing many lookups — filtering, counting, cross-referencing — where the " +
      "intermediates would otherwise cost more than the answer. `ctx.memory.effects|causes|pulse|when` " +
      "are available and async. Example: return (await ctx.memory.effects('x')).hits.length",
    inputSchema: {
      type: "object",
      properties: { program: { type: "string", description: "Body of an async function; must return." } },
      required: ["program"],
    },
  },
];

export async function handleCall(name, args = {}) {
  if (name === "remember") {
    if (!args.cause || !args.effect) throw new Error("remember needs both cause and effect");
    const bound = bindCorrection(args);
    const res = appendEvent(bound);
    if (res?.written === false) return res;
    // Terms read out of the effect slug are echoed by name: "price-corrected-to-29" binds the word "price",
    // which the caller may not have meant (daily-use review, 2026-09-09).
    const declared = Array.isArray(args.withdrawn) && args.withdrawn.some((w) => w && String(w).trim());
    if (!declared && Array.isArray(bound.withdrawn) && bound.withdrawn.length) {
      res.boundFromEffect = { withdrawn: bound.withdrawn, replacement: bound.replacement ?? [] };
      res.hint = `withdrawn and replacement were read from the effect slug, not declared: the guard now blocks ${bound.withdrawn.map((w) => JSON.stringify(w)).join(", ")} anywhere it appears bare. If that is not the term you meant, record the correction again with withdrawn and replacement, and supersedes: [${res.t}].`;
    }
    // A correction that binds nothing is still recorded, and the caller is told
    // so plainly instead of it passing silently. That includes a correction whose
    // every withdrawn term was under the 2-char floor and dropped.
    if (bound._unenforceable) return { ...res, enforceable: false, hint: bound._hint };
    if (bound.kind === "correction" && !res.stored?.withdrawn?.length) return { ...res, enforceable: false, hint: `This correction binds nothing: every withdrawn term was dropped (${(res.dropped ?? []).map((w) => JSON.stringify(w)).join(", ")} under the 2-character floor). Record it again with a longer term, for example the value with its unit or sign.` };
    return res;
  }

  const { path, events } = readEvents();
  if (!events.length) return { empty: true, ledger: path, hint: "Nothing recorded yet — use `remember` to start." };

  if (name === "pulse") return callApi("/v1/pulse", { events, ...(args.tier ? { tier: args.tier } : args.budget ? {} : { tier: undefined }), root: args.root, ...(Number.isFinite(args.budget) && args.budget >= 1 ? { budget: args.budget } : {}) });
  if (name === "recall") return callApi("/v1/recall", { events, op: args.op, subject: args.subject, object: args.object, topk: args.topk });
  if (name === "execute") return callApi("/v1/execute", { events, program: args.program });
  throw new Error(`unknown tool: ${name}`);
}

// ---- Write-time gate (2026-09-07). A correction with no withdrawn term binds
// nothing: it prints in the brief and the guard lets every edit through. On this
// project's own ledger that is 153 of 164 corrections, so the guard enforced 7%
// of the record. Inference after the fact was measured and rejected: recovering
// the term from prose scored 7/11 at top-3, which is fine as a suggestion and
// would destroy the 1.0 precision as enforcement.
//
// Two things happen here instead, neither of them a guess. When the effect
// already states the transition, the terms are read straight out of it, which
// was 4/4 correct on the labelled set. Otherwise the correction is still
// recorded, and the result says plainly that it binds nothing and offers
// candidates, so the caller can record the terms in one more call.
const TRANSITION = /^(.+?)-(?:withdrawn-for|corrected-to|superseded-by|replaced-by)-(.+)$/;
const unslug = (s) => String(s).replace(/-/g, " ").trim();

function candidateTerms(args) {
  const text = `${args.cause ?? ""} ${args.effect ?? ""} ${args.note ?? ""}`;
  const seen = new Map();
  const shapes = [
    /\$\s?\d[\d,]*(?:\.\d+)?/g,                       // money
    /\bv?\d+\.\d+(?:\.\d+)?\b/g,                     // version
    /"([^"\n]{2,40})"/g,                                 // quoted
    /\b[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+\b/gi,            // identifier
  ];
  for (const re of shapes) {
    for (const m of text.matchAll(re)) {
      const raw = (m[1] ?? m[0]).trim();
      if (raw.length >= 2 && raw.length <= 44) seen.set(raw.toLowerCase(), raw);
    }
  }
  return [...seen.values()].slice(0, 5);
}

export function bindCorrection(args) {
  if (args?.kind !== "correction") return args;
  const declared = Array.isArray(args.withdrawn) && args.withdrawn.some((w) => w && String(w).trim());
  if (declared) return args;

  const eff = String(args.effect ?? "").trim();
  const m = !/\s/.test(eff) && TRANSITION.exec(eff);
  if (m) {
    const withdrawn = unslug(m[1]), replacement = unslug(m[2]);
    if (withdrawn && withdrawn.split(" ").length <= 6) {
      return { ...args, withdrawn: [withdrawn], replacement: replacement ? [replacement] : [] };
    }
  }
  const candidates = candidateTerms(args);
  return {
    ...args,
    _unenforceable: true,
    _hint: `This correction binds nothing: with no "withdrawn" term the guard cannot block an edit that reintroduces the old value, and it will only ever appear in the brief.${candidates.length ? ` Candidates from your own text: ${candidates.map((c) => JSON.stringify(c)).join(", ")}.` : ""} Record it again with withdrawn (and replacement, if there is one) to make it enforceable.`,
  };
}

// ------------------------------------------------------- stdio transport ----
// STDOUT IS THE PROTOCOL. Never console.log here; diagnostics go to stderr.
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function dispatch(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    const wanted = params?.protocolVersion;
    return ok(id, {
      protocolVersion: SUPPORTED.includes(wanted) ? wanted : SUPPORTED[0],
      capabilities: { tools: {} },
      serverInfo: { name: "memory-pulse", version: PKG_VERSION },
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    try {
      const result = await handleCall(name, args || {});
      return ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      return ok(id, { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

// ------------------------------------------------------------------ cli ----
// `npx memory-pulse brief` — print the re-entry brief and exit. Built for
// SessionStart hooks: SILENT no-op (exit 0) when the project has no ledger,
// so installing the hook never adds noise to projects that don't use this.
// ---- Agent identity: the self block. Printed FIRST in every brief (online or offline) when the mode is agent.
const tagged = (events, tag) => events.filter((e) => Array.isArray(e.tags) && e.tags.includes(tag));
// A note that reads like an instruction is never rendered, here or by the engine: memory may inform the agent, never
// instruct it. Local writes refuse such a note; a row that arrived another way (an imported capsule, an older writer)
// is held back at render and said to be.
const HELD = "[held back: note reads like an instruction]";
const shown = (e) => (instructionLike(e?.note).length ? HELD : (e?.note ?? e?.effect));
export function identityBlock(led) {
  const events = inForce(led?.events ?? []); if (!events.length) return "";
  const self = tagged(events, "identity").filter((e) => e.pinned).slice(-1)[0] ?? tagged(events, "identity").slice(-1)[0];
  const rules = tagged(events, "rule"), prefs = tagged(events, "preference"), lessons = tagged(events, "lesson").slice().reverse();
  const corr = events.filter((e) => e.kind === "correction" && e.withdrawn?.length).length;
  const chain = verifyChain(led.path); const seal = readSeal(led.path);
  const name = self ? String(shown(self)).split(/[;.\n]/)[0].trim() : "unnamed agent";
  const lines = [`AGENT IDENTITY — ${name} (agent ledger: ${events.length} rows, head ${chain.head ? chain.head.slice(0, 12) : "none"}${chain.ok ? "" : ", CHAIN BROKEN"}, seal ${seal?.digest ? seal.digest.slice(0, 12) : "not yet"})`];
  if (self) lines.push(`  self: ${shown(self)}`);
  lines.push(`  fingerprint: chain head ${chain.head ?? "none"}${seal?.issued ? ` · sealed ${seal.issued}` : ""} — the same memory as last session iff these match`);
  if (rules.length) { lines.push(`  standing rules (${rules.length}):`); for (const r of rules) lines.push(`    rule: ${shown(r)} (t${r.t})`); }
  if (prefs.length) { lines.push(`  preferences (${prefs.length}):`); for (const p of prefs) lines.push(`    preference: ${shown(p)} (t${p.t})`); }
  if (lessons.length) { lines.push(`  lessons carried (${lessons.length}):`); for (const l of lessons.slice(0, 10)) lines.push(`    lesson: ${String(shown(l)).replace(/^lesson:\s*/i, "")} (t${l.t})`); }
  lines.push(`  corrections carried: ${corr} binding — enforced in every project`);
  return lines.join("\n");
}

// ---- Agent growth: ambient capture at the Stop hook. Last turn only; deterministic shapes; capped; instruction-like
// text yields nothing. Decisions and corrections belong to the project; preferences and lessons are the agent's.
const AMBIENT_CAP = 4;
const clip = (t, n = 140) => String(t).replace(/\s+/g, " ").trim().slice(0, n);
const lastTurn = (transcriptText) => {
  const users = [], assistants = []; let seenUser = false;
  const lines = String(transcriptText).split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o?.message);
  // the last thing a person typed; harness entries after it (a skill body, a notification) belong to the same turn
  let lastUserIdx = -1; lines.forEach((o, i) => { if (typedUserText(o)) lastUserIdx = i; });
  if (lastUserIdx < 0) return { user: "", assistant: "" };
  const user = typedUserText(lines[lastUserIdx]);
  for (const o of lines.slice(lastUserIdx + 1)) if (o.type === "assistant" || o.message.role === "assistant") { const t = partText(o.message.content).trim(); if (t) assistants.push(t); }
  return { user, assistant: assistants.join(" ") };
};
const AMBIENT_SHAPES = [
  // No bare "I want": ten of the eleven preferences on the estate's agent ledger were one-off requests in that
  // shape ("i want you to setup my OBS ...") and printed in every identity block (2026-10-12).
  ["preference", "user", "agent", /\bI (?:prefer|like|always|never|don't want|hate)\b[^.!?\n]{3,120}/i, (m) => clip(m[0])],
  ["decision", "assistant", "project", /\b(?:we'll go with|we will go with|going with|decided (?:to|on)|let's use|we'll use|settled on)\b[^.!?\n]{3,120}/i, (m) => `Decision: ${clip(m[0])}`],
  ["lesson", "assistant", "agent", /\b(?:lesson|learned that|the fix was|root cause was|takeaway)\b[^\n]{3,160}/i, (m) => `Lesson: ${clip(m[0].replace(/^lesson:?\s*/i, ""), 160)}`],
];
export function extractAmbient(transcriptText) {
  const { user, assistant } = lastTurn(transcriptText);
  if (!user && !assistant) return [];
  if (instructionLike(user).length) return [];
  const out = [];
  const c = detectCorrection(user) ?? detectProhibition(user); if (c) out.push({ scope: "project", ...correctionEvent(c, user), tags: ["ambient", c.cue] });
  for (const [tag, side, scope, re, note] of AMBIENT_SHAPES) {
    const text = side === "user" ? user : assistant; const m = re.exec(text); if (!m) continue;
    const n = note(m); if (instructionLike(n).length) continue;
    out.push({ scope, cause: `ambient-${tag}`, effect: slug(n.replace(/^[A-Za-z ]+: /, "")), kind: "event", tags: ["ambient", tag], note: n });
    if (out.length >= AMBIENT_CAP) break;
  }
  return out.slice(0, AMBIENT_CAP);
}
async function cliAmbient() {
  // Stop hook: exit 0 on every path; never runs when the hook itself is what stopped the turn.
  try {
    let raw = ""; try { raw = readFileSync(0, "utf8"); } catch { /* no stdin */ }
    let hook = {}; try { hook = raw.trim() ? JSON.parse(raw) : {}; } catch { hook = {}; }
    if (hook.stop_hook_active) return;
    const transcript = typeof hook.transcript_path === "string" && existsSync(hook.transcript_path) ? readFileSync(hook.transcript_path, "utf8") : "";
    const evs = extractAmbient(transcript); const written = [];
    for (const e of evs) { const r = appendEvent(e); if (r.written) written.push(`${e.scope}:${e.tags[1] ?? e.kind}`); }
    if (written.length) console.log(`memory-pulse: ${written.length} ambient row(s) recorded (${written.join(", ")})`);
  } catch { /* silent */ }
}

// ---- Colour, only where a human is looking. The guard writes to stderr on
// every blocked edit, and that message is the one moment the product is visible
// at all, so the retired value and its replacement are worth picking out. It
// stays off when stderr is not a terminal, so a log file or a CI transcript
// keeps plain text, and it honours NO_COLOR.
const COLOR = !process.env.NO_COLOR && process.env.TERM !== "dumb" && process.stderr.isTTY;
const C = {
  red: (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s),
  bold: (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s),
  strike: (s) => (COLOR ? `\x1b[9m${s}\x1b[0m` : s),
};

// ---- Guard across every chat: a correction on the agent ledger binds in any project.
// Since 2026-10-02 a broken chain no longer refuses every tool: a bad tail is quarantined on the spot (one warning
// line, the action proceeds) and a mid-file break blocks only writes that target the ledger or its sidecars.

// The rows the guard enforces (corrections and overrides in force), cached beside the verification result.
function guardRows(path) {
  if (!existsSync(path)) return [];
  const key = statKey(statSync(path)); const entry = readCache(path);
  if (entry && sameKey(entry.key, key) && Array.isArray(entry.guard)) return entry.guard;
  // only the fields the block decision reads; notes stay in the ledger (a 1,500-row ledger cached 419 KB with them)
  const keep = ["t", "kind", "cause", "effect", "withdrawn", "replacement", "supersedes", "override"];
  const rows = inForce(readEvents({ path }).events).filter((e) => e.kind === "correction" || e.kind === "override")
    .map((e) => Object.fromEntries(keep.filter((k) => e[k] !== undefined).map((k) => [k, e[k]])));
  if (entry && sameKey(entry.key, key)) writeCache(path, { ...entry, guard: rows });
  return rows;
}
// verifyLocalSeal needs every row; its verdict is cached under the ledger's key and the seal file's key.
function sealCheckCached(path, chain) {
  const sp = sealPathFor(path);
  if (!existsSync(sp) || !existsSync(path)) return verifyLocalSeal([], readSeal(path), chain, path);
  const key = statKey(statSync(path)), sk = statKey(statSync(sp)); const entry = readCache(path);
  if (entry && sameKey(entry.key, key) && entry.seal && sameKey(entry.seal.key, sk)) return entry.seal.result;
  const r = verifyLocalSeal(readEvents({ path }).events, readSeal(path), chain, path);
  if (entry && sameKey(entry.key, key)) writeCache(path, { ...entry, seal: { key: sk, result: { ok: r.ok, reason: r.reason ?? null } } });
  return r;
}
const cliPrefixFor = (path) => path === agentPath() ? "memory-pulse" : process.env.MEMORY_PULSE_LEDGER ? `MEMORY_PULSE_LEDGER=${path} memory-pulse` : "memory-pulse";
const scopeFlagFor = (path) => path === agentPath() ? " --scope agent" : "";
/** Verify one ledger for the guard; a bad tail is quarantined here, so the work that follows is not refused. */
export function ledgerHealth(path) {
  if (!existsSync(path)) return { path, chain: { ok: true }, warnings: [] };
  let chain = verifyChainCached(path); const warnings = [];
  if (!chain.ok) {
    try {
      const q = quarantineTail(path);
      if (q.quarantined) {
        chain = verifyChainCached(path);
        warnings.push(`memory-pulse: quarantined ${q.rows} row${q.rows === 1 ? "" : "s"} from the tail of ${path} (${q.reason}): moved byte-for-byte to ${q.file}, recorded at t=${q.t}, nothing deleted; to re-adopt after review: ${cliPrefixFor(path)} repair${scopeFlagFor(path)} --adopt-quarantine ${q.file}`);
      }
    } catch { /* locked by another writer or read-only: verified as it stands */ }
  }
  return { path, chain, warnings };
}
const SIDECAR_RE = /(^|[\\/])\.memory-pulse([\\/]|$)/;
const SIDECAR_NAMES = /^(seal\.rain|memory\.rain|telemetry\.rain|seal\.resume\.json|verify\.cache\.json|invariants\.jsonl)$/;
/** Does this action write to a ledger or one of its sidecars? Reading never counts. */
export function ledgerTargeted(action, ledgers) {
  const cmd = typeof action?.command === "string" ? action.command : "";
  if (cmd) {
    const mentions = ledgers.some((l) => cmd.includes(l)) || /\.memory-pulse\b|events\.jsonl|seal\.rain|memory\.rain|telemetry\.rain/.test(cmd);
    if (!mentions) return false;
    const c = cmd.replace(/\d*>&?\s*\/dev\/null/g, "");
    return /(^|[^<>&0-9])>>?|\bsed\s+(-[a-zA-Z]*i\b|--in-place)|\btee\b|\b(mv|cp|rm|truncate|dd|install|ln|touch)\b|writeFile|appendFile|\bopen\([^)]*["'][wa+]|\bperl\s+-[a-zA-Z]*i/.test(c);
  }
  const p = typeof action?.path === "string" && action.path ? resolvePath(action.path) : "";
  if (!p) return false;
  if (ledgers.includes(p) || SIDECAR_RE.test(p)) return true;
  return ledgers.some((l) => dirname(p) === dirname(l) && (basename(p).startsWith(basename(l)) || SIDECAR_NAMES.test(basename(p))));
}
export function guardVerdict(action, { events, invariants = [], health = null } = {}) {
  const proj = health?.project ?? ledgerHealth(ledgerPath());
  const ap = agentPath();
  const agent = health ? health.agent : existsSync(ap) ? ledgerHealth(ap) : null;
  const targeted = ledgerTargeted(action, [proj.path, agent?.path].filter(Boolean));
  const v = localCheck(events ?? guardRows(proj.path), action, invariants, { chain: !proj.chain.ok && targeted ? proj.chain : null, seal: sealCheckCached(proj.path, proj.chain), blockOnly: true });
  if (agent) {
    const av = localCheck(guardRows(agent.path), action, [], { chain: !agent.chain.ok && targeted ? agent.chain : null, blockOnly: true });
    if (av.verdict === "blocked") { v.verdict = "blocked"; v.reasons = [...av.reasons.filter((r) => !/no recorded event/.test(r)).map((r) => r.replace(/\bledger t(\d+)/g, "agent ledger t$1").replace(/at t(\d+)/g, "at agent ledger t$1")), ...v.reasons]; }
  }
  v.warnings = [...proj.warnings, ...(agent?.warnings ?? [])];
  for (const h of [proj, agent]) {
    if (h && !h.chain.ok && !targeted) v.warnings.push(`memory-pulse: ledger chain broken in ${h.path} (${h.chain.reason}); writes to that ledger are blocked until it is repaired, other work is not; run ${cliPrefixFor(h.path)} verify${scopeFlagFor(h.path)} for the fix`);
  }
  return v;
}

// ---- Mode switch. deliberate (default) | agent. The mode lives beside the agent ledger; the hooks are the mode.
const modeConfigPath = () => join(dirname(agentPath()), "config.json");
export function currentMode() {
  if (process.env.MEMORY_PULSE_MODE) return process.env.MEMORY_PULSE_MODE;
  try { return JSON.parse(readFileSync(modeConfigPath(), "utf8")).mode === "agent" ? "agent" : "deliberate"; } catch { return "deliberate"; }
}
export function setMode(mode) {
  if (!["agent", "deliberate"].includes(mode)) throw new Error("mode must be agent or deliberate");
  const home = process.env.MEMORY_PULSE_SETTINGS_DIR || join(process.env.HOME || "", ".claude");
  const file = join(home, "settings.json");
  let settings = {}; if (existsSync(file)) { try { settings = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error(`refusing to touch ${file}: it is not valid JSON`); } }
  settings.hooks = settings.hooks || {};
  const wanted = { Stop: "npx -y memory-pulse ambient", UserPromptSubmit: "npx -y memory-pulse observe" };
  let installed = 0, removed = 0;
  for (const [event, cmd] of Object.entries(wanted)) {
    const arr = (settings.hooks[event] = settings.hooks[event] || []);
    const has = JSON.stringify(arr).includes(cmd);
    if (mode === "agent" && !has) { arr.push({ hooks: [{ type: "command", command: cmd }] }); installed++; }
    if (mode === "deliberate" && has) { settings.hooks[event] = arr.filter((h) => !JSON.stringify(h).includes(cmd)); removed++; }
  }
  mkdirSync(home, { recursive: true }); writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  mkdirSync(dirname(modeConfigPath()), { recursive: true }); writeFileSync(modeConfigPath(), JSON.stringify({ mode }, null, 2) + "\n");
  if (mode === "agent" && !existsSync(agentPath())) writeFileSync(agentPath(), "");
  return { mode, installed, removed, settings: file };
}
async function cliMode() {
  const want = process.argv[3];
  if (!want) { const m = currentMode(); console.log(`mode: ${m}${m === "agent" ? ` — agent ledger ${agentPath()}` : " (default) — run \`memory-pulse mode agent\` for a persistent agent identity that grows across every chat"}`); return; }
  if (!["agent", "deliberate"].includes(want)) { console.error(`mode must be agent or deliberate (got "${want}")`); process.exit(1); }
  let r; try { r = setMode(want); } catch (e) { console.error(String(e?.message ?? e)); process.exit(1); }
  console.log(`mode: ${r.mode} — ${r.installed} hook(s) installed, ${r.removed} removed in ${r.settings}`);
  if (want === "agent") { console.log(`agent ledger: ${agentPath()}`); console.log("Set the agent's self once: memory-pulse identity \"<name>, <role>; <stance>\" — then every brief, in every tool, starts with who the agent is, what it has learned, and a fingerprint of which memory it is running on."); }
}
async function cliIdentity() {
  const note = process.argv.slice(3).filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!note) { console.error('usage: memory-pulse identity "<name>, <role>; <stance>"'); process.exit(1); }
  const r = appendEvent({ cause: "identity-set", effect: slug(note.split(/[;,]/)[0]), note, tags: ["identity"], pinned: true, scope: "agent" });
  console.log(r.written ? `identity recorded on the agent ledger (t=${r.t}) — pinned; supersede it by recording a new one` : `identity not recorded (${r.reason})`);
}

// ---- Core 1: offline brief (2026-09-03). A dead network must not hand the session nothing. This is a
// deterministic local render — corrections with their terms, the last handoff, recent rows — and it says so.
const ago = (ms) => (ms < 90e3 ? `${Math.max(1, Math.round(ms / 1e3))} s ago` : ms < 90 * 60e3 ? `${Math.round(ms / 60e3)} min ago` : ms < 36 * 3600e3 ? `${Math.round(ms / 3600e3)} h ago` : `${Math.round(ms / 86400e3)} d ago`);
const handoffTime = (e) => { const m = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(`${e.effect} ${e.note ?? ""}`); return m ? Date.parse(m[1]) : NaN; };
export function handoffLine(events, { now = Date.now(), maxAgeMs = 7 * 86400e3 } = {}) {
  const h = [...events].reverse().find((e) => Array.isArray(e.tags) && e.tags.includes("handoff"));
  if (!h) return "";
  const t = handoffTime(h); if (Number.isFinite(t) && now - t > maxAgeMs) return "";
  return `↩ last handoff (t=${h.t}${Number.isFinite(t) ? `, ${ago(now - t)}` : ""}): ${(h.note ?? h.effect).replace(/^handoff \S+: ?/, "")}`;
}
// 0.7.0: the scaffolded prompt memory (lib/scaffold.mjs), with this file's ledger helpers injected.
export { DEFAULT_BUDGETS };
export function renderScaffold(allEvents, opts = {}) {
  return renderScaffoldWith(allEvents, { ...opts, deps: { inForce, supersededSet, instructionLike, handoffLine, held: HELD } });
}
export function promptSlice(allEvents, prompt, opts = {}) {
  return promptSliceWith(allEvents, prompt, { ...opts, deps: { inForce, supersededSet, instructionLike, containsTerm, held: HELD } });
}
export function editSlice(rows, invariants, action, opts = {}) {
  return editSliceWith(rows, invariants, action, { ...opts, deps: { supersededSet, instructionLike, containsTerm } });
}
// Claude Code saves a hook's injected text over 10,000 chars to a file and shows the model a 2,000-char preview
// (docs/HOST_FACTS.md; the estate's 16,933-char brief was cut that way). A brief that will not arrive whole is
// replaced by the scaffold, which is built to fit.
export const BRIEF_CAP = 9500;
export function capBrief(text, scaffoldText, cap = BRIEF_CAP) {
  if (text.length <= cap) return text;
  return `memory-pulse: the engine brief was ${text.length.toLocaleString("en-US")} chars, over the ${cap.toLocaleString("en-US")} the hosts take whole; this is the scaffold instead.\n${scaffoldText}`;
}
function scaffoldFor(led, opts = {}) {
  const agentEvents = currentMode() === "agent" && existsSync(agentPath()) ? readEvents({ scope: "agent" }).events : [];
  const chain = verifyChain(led.path);
  return renderScaffold(led.events, { agentEvents, blocks: readBlocks(), chain: chain.ok ? null : chain, ...opts });
}
export function offlineBrief(led, allEvents, { now = Date.now(), recent = 8 } = {}) {
  const events = inForce(allEvents); const rolledBack = allEvents.length - events.length;
  const lines = [`memory-pulse: engine unreachable — local render from ${events.length} events (corrections and recency only; no salience ranking)${rolledBack ? ` · ${rolledBack} row(s) rolled back, kept on record` : ""}`];
  if (currentMode() === "agent" && existsSync(agentPath())) { const ib = identityBlock(readEvents({ scope: "agent" })); if (ib) lines.push(ib); }
  const hl = handoffLine(events, { now }); if (hl) lines.push(hl);
  const retired = supersededSet(events);
  const corr = events.filter((e) => e.kind === "correction" && !retired.has(e.t)).reverse().slice(0, 20);
  lines.push(`CORRECTIONS (${corr.length}) — read before quoting any number:`);
  for (const c of corr) lines.push(`  ! ${c.cause} -> ${c.effect} (t${c.t})${c.withdrawn?.length ? ` — withdrawn: ${c.withdrawn.join(", ")} → ${(c.replacement ?? []).join(", ") || "(no replacement recorded)"}` : ""}${c.note ? ` — ${instructionLike(c.note).length ? HELD : String(c.note).slice(0, 120)}` : ""}`);
  if (!corr.length) lines.push("  (none recorded)");
  const rec = events.slice(-recent).reverse();
  lines.push(`RECENT (${rec.length}):`);
  for (const e of rec) lines.push(`  t${e.t} ${e.cause} -> ${e.effect}`);
  const risk = atRiskLines(events, { now }); if (risk) lines.push(risk);
  return lines.join("\n");
}

// ---- The loop, closed mechanically (2026-09-04). Every block the guard records is a context in which a
// correction mattered; a correction that keeps biting is the one the agent needs BEFORE the next edit, not
// after. Deterministic counts over the local violation records — the honest form of "usage": nothing decays,
// nothing is deleted, an override is counted beside the blocks it answers.
export function readBlocks({ limit = 2000 } = {}) {
  try { return readFileSync(violationsPath(), "utf8").split("\n").filter(Boolean).slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((b) => b && Array.isArray(b.hits)); } catch { return []; }
}
export function atRiskLines(allEvents, { now = Date.now(), minBlocks = 2, blocks = readBlocks() } = {}) {
  if (!blocks.length) return "";
  const events = inForce(allEvents);
  const retired = supersededSet(events);
  const byT = new Map(); const corr = new Map(events.filter((e) => e.kind === "correction").map((e) => [e.t, e]));
  const overrides = new Map(); for (const e of events) if (e.kind === "override" && e.override?.term) overrides.set(String(e.override.term).toLowerCase(), (overrides.get(String(e.override.term).toLowerCase()) ?? 0) + 1);
  for (const b of blocks) for (const h of b.hits) {
    const t = Number(h.t); if (!corr.has(t) || retired.has(t)) continue;
    const m = byT.get(t) ?? { t, term: h.term, n: 0, dirs: new Map(), last: 0 }; m.n++; const dir = String(b.file ?? "").split("/").slice(0, -1).join("/") || "."; m.dirs.set(dir, (m.dirs.get(dir) ?? 0) + 1); m.last = Math.max(m.last, Date.parse(b.at) || 0); byT.set(t, m);
  }
  const rows = [...byT.values()].filter((m) => m.n >= minBlocks).sort((a, b) => b.n - a.n).slice(0, 5);
  if (!rows.length) return "";
  const lines = [`AT RISK (${rows.length}) — corrections the guard keeps having to block; read these before editing:`];
  for (const m of rows) {
    const c = corr.get(m.t); const ov = overrides.get(String(m.term).toLowerCase()) ?? 0;
    const where = [...m.dirs].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d, n]) => `${d} ×${n}`).join(", ");
    lines.push(`  ! t${m.t} "${m.term}" blocked ${m.n}× (${where})${c?.replacement?.length ? ` → use ${c.replacement.join(", ")}` : ""}${ov ? ` · ${ov} override(s)` : ""}${m.last ? ` · last ${ago(now - m.last)}` : ""}`);
  }
  return lines.join("\n");
}

// `memory-pulse before "<operation>" [--path p] [--text t]` — which corrections bear on what you are about to
// do, in your own words. The exact rung is local (a withdrawn term in the operation — the guard's rule); the
// associative rung is the engine's learned read over your events and your block records, and it answers `no
// evidence` when nothing resonates above the floor. Nothing is stored engine-side.
async function cliBefore() {
  const argv = process.argv.slice(3);
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const operation = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--path" && argv[i - 1] !== "--text").join(" ");
  const path = opt("path") ?? ""; const text = opt("text") ?? "";
  if (!operation && !path && !text) { console.error('usage: memory-pulse before "<what you are about to do>" [--path <file>] [--text <edit>]'); process.exit(1); }
  const { events } = readEvents();
  const retired = supersededSet(inForce(events));
  const hay = `${operation} ${text}`.toLowerCase();
  const exact = inForce(events).filter((e) => e.kind === "correction" && !retired.has(e.t) && (e.withdrawn ?? []).some((w) => w && hay.includes(String(w).toLowerCase())));
  const line = (c, why) => `  ! (t${c.t}) ${c.cause} -> ${c.effect}${c.withdrawn?.length ? ` — withdrawn ${c.withdrawn.map((w) => `"${w}"`).join(", ")}${c.replacement?.length ? ` → use ${c.replacement.join(", ")}` : ""}` : ""}${why ? ` · ${why}` : ""}`;
  if (exact.length) { console.log(`BEFORE "${operation || path}" · rung exact — the operation names a withdrawn term:`); for (const c of exact) console.log(line(c, "")); }
  try {
    const out = await callApi("/v1/before", { events, operation, path, text, blocks: readBlocks() });
    if (out.error) throw new Error(out.error);
    if (!exact.length) {
      if (out.rung === "none") console.log(`BEFORE "${operation || path}" · no evidence — ${out.reason}`);
      else { console.log(`BEFORE "${operation || path}" · rung ${out.rung} (${out.learned.registers} registers over ${out.learned.vocab} words):`); for (const h of out.hits) console.log(line(h, `${h.why}${h.paths?.length ? ` · bit under ${h.paths.map(([p, n]) => `${p} ×${n}`).join(", ")}` : ""}`)); }
    }
    if (Array.isArray(out.atRisk) && out.atRisk.length) console.log(`AT RISK: ${out.atRisk.map((m) => `t${m.t} ${m.withdrawn.map((w) => `"${w}"`).join(", ")} bit ${m.blocks}×`).join("; ")}`);
  } catch (e) {
    if (!exact.length) console.log(`BEFORE "${operation || path}" · exact rung only (engine unreachable: ${String(e?.message ?? e).split(".")[0]}) — no withdrawn term in the operation; the learned read needs the engine`);
    else console.log(`(learned read unavailable: ${String(e?.message ?? e).split(".")[0]})`);
  }
}

// ---- Core 2: compaction handoff (2026-09-03). Compaction loss is the #2 complaint in the demand research. A
// PreCompact hook reads the transcript and records what the session was doing AS FACTS (asks, files, last error,
// assistant state); the next session start prints it first, online or offline. Deterministic; no model.
const partText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text).join(" ") : "");
// Claude Code writes harness text into the transcript as user entries: skill bodies (isMeta), compaction
// summaries (isCompactSummary), task notifications and peer messages (origin.kind), tool results, a subagent's
// brief (isSidechain). Only what a person typed may become a correction or a handoff ask. Replayed over 107
// transcripts on 2026-10-12, ambient capture had recorded 18 corrections and none was real: 17 came from
// these entries. The leading-text check covers transcripts written before the flags existed.
const HARNESS_PREAMBLE = /^\s*(?:Base directory for this skill:|This session is being continued from a previous conversation|Caveat: The messages below|<command-|<local-command-|<task-notification>|<system-reminder>|<bash-|<user-prompt-submit-hook>)/;
export function typedUserText(o) {
  const m = o?.message; if (!m || !(o.type === "user" || m.role === "user")) return "";
  if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly || o.isSidechain === true || o.toolUseResult !== undefined) return "";
  if (o.origin && typeof o.origin === "object" && o.origin.kind !== "human") return "";
  if (Array.isArray(m.content) && m.content.some((p) => p?.type === "tool_result")) return "";
  const text = partText(m.content).trim();
  return HARNESS_PREAMBLE.test(text) ? "" : text;
}
export function extractHandoff(transcriptText, { maxAsks = 3, maxFiles = 6 } = {}) {
  const asks = [], files = []; let lastError = "", state = "";
  for (const line of String(transcriptText).split("\n")) {
    if (!line.trim()) continue; let o; try { o = JSON.parse(line); } catch { continue; }
    const m = o?.message; if (!m) continue;
    if (o.type === "user" || m.role === "user") {
      const txt = typedUserText(o); if (txt) asks.push(txt.slice(0, 160));
      if (Array.isArray(m.content)) for (const p of m.content) if (p?.type === "tool_result" && p.is_error) { const e = partText(p.content) || String(p.content ?? ""); if (e.trim()) lastError = e.trim().slice(0, 160); }
    } else if (o.type === "assistant" || m.role === "assistant") {
      const txt = partText(m.content).trim(); if (txt) state = txt.slice(0, 200);
      if (Array.isArray(m.content)) for (const p of m.content) if (p?.type === "tool_use" && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(p.name ?? "") && typeof p.input?.file_path === "string" && !files.includes(p.input.file_path)) files.push(p.input.file_path);
    }
  }
  return { asks: asks.slice(-maxAsks), files: files.slice(-maxFiles), lastError, state };
}
export function handoffEvent(hook = {}, transcriptText = "", { now = Date.now() } = {}) {
  const h = extractHandoff(transcriptText);
  const clean = (t) => (t && !instructionLike(t).length ? t : "");
  const asks = h.asks.map(clean).filter(Boolean);
  const iso = new Date(now).toISOString();
  const note = `handoff ${iso}: asked: ${asks.length ? asks.map((q) => `"${q}"`).join(" · ") : "n/a"} | files: ${h.files.join(", ") || "none"} | last error: ${clean(h.lastError) || "none"} | state: ${clean(h.state) || "n/a"}`;
  return { cause: `compaction-${hook.trigger || "auto"}-${String(hook.session_id || "session").slice(0, 8)}`, effect: `handoff-${iso}`, kind: "event", tags: ["handoff"], note };
}
async function cliHandoff() {
  // PreCompact hook: must never block compaction — exit 0 on every path, one line of output.
  try {
    let raw = ""; try { raw = readFileSync(0, "utf8"); } catch { /* no stdin */ }
    let hook = {}; try { hook = raw.trim() ? JSON.parse(raw) : {}; } catch { hook = {}; }
    // No transcript, no row: a bare invocation or a hook payload without transcript_path used to append an
    // "asked: n/a | files: none" row every time (fresh-user run, 2026-09-09).
    if (typeof hook.transcript_path !== "string" || !existsSync(hook.transcript_path)) { console.log("memory-pulse: handoff skipped (no transcript)"); return; }
    const transcript = readFileSync(hook.transcript_path, "utf8");
    const r = appendEvent(handoffEvent(hook, transcript));
    console.log(r.written ? `memory-pulse: handoff recorded (t=${r.t}) — the next session start prints it first` : `memory-pulse: handoff not recorded (${r.reason})`);
  } catch (e) { console.log(`memory-pulse: handoff skipped (${String(e?.message ?? e).split("\n")[0]})`); }
}

// ---- Core 3: ambient correction capture (2026-09-03), opt-in (install-hook --ambient). A UserPromptSubmit hook
// records a correction ONLY when the prompt's shape yields both the withdrawn and the replacement term; anything
// less is left alone. Deterministic patterns; the guard then enforces the terms like any other correction.
const TQ = `"([^"]{1,60})"|'([^']{1,60})'|\`([^\`]{1,60})\``;
const TD = `((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.? \\d{1,2}(?:,? \\d{4})?)`;
const TN = `(\\$?\\d[\\d.,]*[A-Za-z%]*)`;
const TW = `([A-Za-z][\\w.\\-/]*)`;
const TERM = `(?:${TQ}|${TD}|${TN}|${TW})`;
const TERM2 = `([\\w$.\\-/]+(?:\\s+[A-Za-z]+)?)`; // up to two tokens, for arrow forms
const TNU = `(\\$?\\d[\\d.,]*[A-Za-z%]*(?:\\s+(?!not\\b|it\\b|and\\b|or\\b|but\\b)[a-z]{2,})?)`; // number with an optional unit word
const TERMU = `(?:${TQ}|${TD}|${TNU}|${TW})`;
// Pronouns name no value: "why are we not iterating this" was recorded as "use 'we', not 'iterating'" (2026-10-12).
const STOP = new Set(["a", "an", "the", "it", "its", "this", "that", "sure", "fine", "problem", "one", "thing", "same", "now", "here", "there", "yes", "no", "not", "just",
  "i", "me", "we", "us", "you", "he", "she", "they", "them", "our", "your", "their"]);
const term = (g) => { const v = g.find((x) => x != null); return v == null ? "" : String(v).replace(/[.,;:!?]+$/, "").trim(); };
const CORRECTION_SHAPES = [
  ["is-not", new RegExp(`\\b(?:is|are|was|were|be|called|named|=|:)\\s+${TERMU},?\\s+not\\s+${TERMU}`, "i"), (m) => ({ replacement: term(m.slice(1, 7)), withdrawn: term(m.slice(7, 13)) })],
  ["not-comma", new RegExp(`\\bnot\\s+${TERM}[^,;\\n]{0,40},\\s*(?:it's|it is|its|it should be|should be|rather|but|make it)\\s+${TERM}`, "i"), (m) => ({ withdrawn: term(m.slice(1, 7)), replacement: term(m.slice(7, 13)) })],
  ["change-to", new RegExp(`\\b(?:change|rename|replace|update|switch|correct)\\s+${TERM}\\s+(?:to|with|into)\\s+${TERM}`, "i"), (m) => ({ withdrawn: term(m.slice(1, 7)), replacement: term(m.slice(7, 13)) })],
  ["arrow", new RegExp(`${TERM2}\\s*(?:->|→|=>)\\s*${TERM2}`), (m) => ({ withdrawn: m[1].trim(), replacement: m[2].trim() })],
];
// ---- Core 3b: prohibitions (2026-09-07). detectCorrection only sees a
// substitution, so it needs both a withdrawn and a replacement term. Most real
// corrections are prohibitions ("no em-dashes", "never cite that number") and
// name nothing to replace, so none of them were ever recorded. localCheck
// already blocks a withdrawn term whose replacement list is empty, so these are
// enforceable the moment they are written down.
// Measured against this repo's own session corpus: recall 3/11 -> 11/11 with
// precision unchanged at 1.00 over 19 negatives, including the pasted-document
// shape that caused the t918 false positive.
const OBJ_P = `((?:"[^"]{2,48}"|'[^']{2,48}'|\`[^\`]{2,48}\`|[A-Za-z$][\\w$.\\-/]*(?:[ -][A-Za-z][\\w$.\\-/]*){0,3}))`;
const SAY_NOT = new RegExp(`\\b(?:say|use|write|call it|make it|put)\\s+${OBJ_P}\\s*,?\\s+not\\s+${OBJ_P}`, "i");
const PROHIBIT_SHAPES = [
  ["no-x",    new RegExp(`(?:^|[.;!?]\\s+|,\\s*)(?:absolutely\\s+)?no\\s+${OBJ_P}`, "i")],
  ["never-x", new RegExp(`\\bnever\\s+(?:use|cite|say|write|mention|ship|publish)\\s+${OBJ_P}`, "i")],
  ["dont-x",  new RegExp(`\\b(?:do\\s?n['\u2019]?t|don['\u2019]?t|stop|quit)\\s+(?:use|using|say|saying|write|writing|cite|citing|mention|mentioning)\\s+${OBJ_P}`, "i")],
  ["avoid-x", new RegExp(`\\bavoid\\s+(?:the\\s+(?:term|word|phrase)\\s+)?${OBJ_P}`, "i")],
];
// Words that follow "no" in ordinary speech and name nothing enforceable.
const NOT_A_TERM = new Set(["worries","problem","idea","account","need","way","one","thing","more","longer","doubt","matter","such","other","further","additional","reason","time","rush","hurry","big","good","bad","difference","comment","clue","luck"]);
// A retirable term is a noun or an identifier. A verb phrase names an action and
// an action never appears in a file, so it could never be enforced.
const PARTICLE = /^(up|out|off|down|in|on|over|away|back|through|around|into)$/i;
const looksLikeTerm = (o) => {
  const head = String(o).trim().split(/[ -]/)[0].toLowerCase();
  return !PARTICLE.test(head) && !(/ing$/.test(head) && head.length > 5);
};
// A pasted document is not a correction. This is the t918 lesson: a design doc
// full of directive prose was recorded as a correction and the guard began
// enforcing a field name.
const looksPasted = (p) =>
  p.split("\n").filter((l) => l.trim()).length >= 4 ||
  /```|^#{1,6}\s/m.test(p) || p.length > 420;
// A term is only enforceable if an edit could contain it verbatim. The object
// pattern takes up to four tokens, so it drags in trailing prepositional
// phrases: "Inter for headings" never matches a file the way "Inter" does.
// Cut at the first preposition and the term becomes enforceable again.
const TAIL = /\s+(?:for|in|on|as|at|with|when|to|of|from|into|about|across|anywhere|everywhere)\b.*$/i;
const cleanTerm = (s) => String(s)
  .replace(/^["'`]|["'`]$/g, "")
  .replace(/[.,;:!?]+$/, "")
  .replace(/^(?:the|a|an)\s+(?:word|term|phrase)\s+/i, "")
  .replace(TAIL, "")
  .trim();

export function detectProhibition(prompt) {
  const p = String(prompt ?? "");
  if (!p.trim() || looksPasted(p)) return null;
  const ok = (o) => o && o.length >= 2 && looksLikeTerm(o) &&
    !NOT_A_TERM.has(o.toLowerCase().split(/[ -]/)[0]) &&
    !/^(it|that|this|those|these|them|they|the|a|an)$/i.test(o);
  const sn = SAY_NOT.exec(p);
  if (sn) {
    const keep = cleanTerm(sn[1] ?? ""), drop = cleanTerm(sn[2] ?? "");
    if (ok(drop)) return { withdrawn: [drop], replacement: keep ? [keep] : [], cue: "say-not" };
  }
  for (const [cue, re] of PROHIBIT_SHAPES) {
    const m = re.exec(p);
    if (!m) continue;
    const obj = cleanTerm(m[1] ?? "");
    if (ok(obj)) return { withdrawn: [obj], replacement: [], cue: `prohibit-${cue}` };
  }
  return null;
}

export function detectCorrection(prompt) {
  const p = String(prompt ?? ""); if (!p.trim() || looksPasted(p)) return null;
  for (const [cue, re, pick] of CORRECTION_SHAPES) {
    const m = re.exec(p); if (!m) continue;
    const { withdrawn, replacement } = pick(m);
    if (!withdrawn || !replacement || withdrawn.length < 2 || withdrawn.toLowerCase() === replacement.toLowerCase()) continue;
    if (STOP.has(withdrawn.toLowerCase()) || STOP.has(replacement.toLowerCase())) continue;
    return { withdrawn: [withdrawn], replacement: [replacement], cue };
  }
  return null;
}
const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "term";
export function correctionEvent(d, prompt) {
  // A prohibition retires a term and names nothing to replace it, so the slug
  // and the note must not read "withdrawn-for-undefined".
  const w = d.withdrawn[0];
  const r = Array.isArray(d.replacement) && d.replacement.length ? d.replacement[0] : null;
  const effect = r ? `${slug(w)}-withdrawn-for-${slug(r)}` : `${slug(w)}-withdrawn`;
  const said = r ? `User corrected "${w}" to "${r}"` : `User prohibited "${w}"`;
  return { cause: `user-correction-${slug(w)}`, effect, kind: "correction", withdrawn: d.withdrawn, replacement: r ? d.replacement : [], tags: ["ambient", d.cue], note: `${said} — prompt: "${String(prompt).replace(/\s+/g, " ").slice(0, 140)}"` };
}
/** The correction a submitted prompt carries, or null when it carries none or is not something a person typed. */
export function observeDecision(prompt) {
  const p = String(prompt ?? "");
  if (!p.trim() || instructionLike(p).length || HARNESS_PREAMBLE.test(p)) return null;
  return detectCorrection(p) ?? detectProhibition(p);
}
async function cliObserve() {
  // UserPromptSubmit hook: silent unless --verbose; exit 0 on every path (a hook must never block a prompt).
  try {
    let raw = ""; try { raw = readFileSync(0, "utf8"); } catch { /* no stdin */ }
    let hook = {}; try { hook = raw.trim() ? JSON.parse(raw) : {}; } catch { hook = {}; }
    // A "prompt" here can be synthetic — Claude Code delivers task-notifications and local-command
    // output as user-turn text, not something Travis typed. cliAmbient already screens the last user
    // turn this way; this hook fires on every submission and must too, or a "->" inside forwarded
    // agent output gets recorded as a binding correction (t898/t899, 2026-09-03).
    const d = observeDecision(hook.prompt ?? "");
    if (!d) { if (process.argv.includes("--verbose")) console.log("memory-pulse: no correction in this prompt (none found, or it reads as harness text or an instruction)"); return; }
    const r = appendEvent(correctionEvent(d, hook.prompt));
    if (process.argv.includes("--verbose") || r.written) console.log(r.written ? `memory-pulse: correction recorded (t=${r.t}) — "${d.withdrawn[0]}" withdrawn${d.replacement?.[0] ? `, "${d.replacement[0]}" replaces it` : ""}; the guard enforces it from now on` : `memory-pulse: correction not recorded (${r.reason})`);
  } catch { /* silent */ }
}

async function cliBrief() {
  const led = readEvents();
  const { events } = led;
  if (!events.length) return;
  const bi = process.argv.indexOf("--budget");
  const budget = bi >= 0 ? Number(process.argv[bi + 1]) : (process.env.MEMORY_PULSE_BRIEF_BUDGET ? Number(process.env.MEMORY_PULSE_BRIEF_BUDGET) : undefined);
  if (budget !== undefined && !(Number.isFinite(budget) && budget >= 1)) { console.error("brief --budget takes a positive number of tokens"); process.exit(1); }
  const tier = process.env.MEMORY_PULSE_BRIEF_TIER || (budget ? undefined : "brief");
  if (process.argv.includes("--offline")) { process.stdout.write(offlineBrief(led, events) + "\n"); return; }
  // 0.7.0: the free default is the local scaffold. The engine brief is asked for by a key, --engine, a budget or a tier.
  const mode = process.env.MEMORY_PULSE_BRIEF;
  const engine = mode !== "scaffold" && !process.argv.includes("--scaffold") &&
    (mode === "engine" || process.argv.includes("--engine") || bi >= 0 || process.env.MEMORY_PULSE_BRIEF_BUDGET || process.env.MEMORY_PULSE_BRIEF_TIER || process.env.MEMORY_PULSE_KEY);
  if (!engine) { const { text } = scaffoldFor(led); if (text) process.stdout.write(text + "\n"); return; }
  try {
    const out = await callApi("/v1/pulse", { events, ...(tier ? { tier } : {}), ...(budget ? { budget } : {}) });
    const parts = [loadedLine(led, events, { keyStatus: out.keyStatus, tier: out.tier ?? tier, chars: out.text?.length, budget })];
    if (currentMode() === "agent" && existsSync(agentPath())) { const ib = identityBlock(readEvents({ scope: "agent" })); if (ib) parts.push(ib); }
    const hl = handoffLine(events); if (hl) parts.push(hl);
    if (out.text) parts.push(out.text);
    const risk = atRiskLines(events); if (risk) parts.push(risk);
    if (Array.isArray(out.quarantined) && out.quarantined.length) {
      parts.push(`⚠ ${out.quarantined.length} note(s) quarantined — instruction-like content was not rendered (t=${out.quarantined.map((q) => q.t).join(", ")})`);
    }
    const sd = sealDriftLine(out); if (sd) parts.push(sd);
    const foot = telemetryFooter(out.telemetry);
    if (foot) parts.push(foot);
    const brief = parts.join("\n");
    process.stdout.write(capBrief(brief, brief.length > BRIEF_CAP ? scaffoldFor(led).text : "") + "\n");
  } catch (e) {
    // A dead network must not break session start — and must not hand it nothing: the local scaffold, labelled as such.
    process.stdout.write(`memory-pulse: brief unavailable (${String(e?.message ?? e).split(".")[0]})\n`);
    const { text } = scaffoldFor(led); if (text) process.stdout.write(text + "\n");
  }
}

// `memory-pulse scaffold [--section <name>] [--all]` — the organized memory the session starts from; --all lifts the budgets.
async function cliScaffold() {
  const si = process.argv.indexOf("--section"); const only = si >= 0 ? process.argv[si + 1] : null;
  if (only && !SECTIONS.includes(only)) { console.error(`unknown section "${only}" — one of ${SECTIONS.join(", ")}`); process.exit(1); }
  const all = process.argv.includes("--all");
  const budgets = all ? Object.fromEntries(SECTIONS.map((x) => [x, Infinity])) : undefined;
  const { text } = scaffoldFor(readEvents(), { only, ...(budgets ? { budgets } : {}) });
  if (text) process.stdout.write(text + "\n");
}

// UserPromptSubmit hook: inject the slice of the memory that bears on this prompt. Silent when nothing does; exit 0 always.
async function cliPrompt() {
  try {
    let raw = ""; try { raw = readFileSync(0, "utf8"); } catch { /* no stdin */ }
    let hook = {}; try { hook = raw.trim() ? JSON.parse(raw) : {}; } catch { return; }
    if (typeof hook.prompt !== "string") return;
    const slice = promptSlice(readEvents().events, hook.prompt, { blocks: readBlocks() });
    if (slice) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: slice } }));
  } catch { /* a hook must never block a prompt */ }
}

// `npx memory-pulse stats` — the signed telemetry capsule, verified keylessly
// against the engine so the numbers you share are numbers we signed.
async function cliStats() {
  const c = readTelemetry();
  if (!c) { console.log("no telemetry yet — run a pulse first"); return; }
  const k = c.counters;
  console.log(`memory-pulse telemetry for "${c.project}" (${c.since.slice(0, 10)} → ${c.updated.slice(0, 10)})`);
  console.log(`  re-entries (pulse)      ${k.pulse}`);
  console.log(`  recall / execute        ${k.recall} / ${k.execute}`);
  console.log(`  corrections recorded    ${k.correctionsRecorded}`);
  console.log(`  corrections surfaced    ${k.correctionsSurfaced}`);
  console.log(`  largest ledger seen     ${k.maxEvents} events`);
  console.log(`  tokens saved (est.)     ~${k.tokensSavedEst.toLocaleString()}`);
  if (c.reset) console.log(`  note: ${c.reset}`);
  try {
    const res = await postJson(`${API}/v1/verify-telemetry`, { "content-type": "application/json" }, JSON.stringify({ telemetry: c }));
    const v = await res.json();
    console.log(v.valid ? "  signature               ✓ verified by the engine (keyless check anyone can repeat)" : `  signature               ✗ ${v.reason ?? "invalid"}`);
  } catch { console.log("  signature               ? engine unreachable"); }
}

// `npx memory-pulse badge` — a README badge from your own signed numbers.
function cliBadge() {
  const c = readTelemetry();
  const n = c?.counters?.tokensSavedEst ?? 0;
  const label = `${fmtK(n)}_tokens_saved`.replace(/-/g, "--");
  console.log(`[![memory-pulse](https://img.shields.io/badge/memory--pulse-${label}-6366f1)](https://pulse.strategic-innovations.ai)`);
}

// ---------------------------------------------------------------- guard ----
// `npx memory-pulse guard` — a Claude Code PreToolUse hook for Edit/Write.
// Surfacing a correction is not enough (agents re-violate corrections they
// were just shown); this ENFORCES it: an edit that writes back a withdrawn
// term is blocked (exit 2) and the agent is told which ledger line retired
// it and when. Deterministic, offline, only explicit `withdrawn` terms count.
const violationsPath = () => join(dirname(ledgerPath()), "violations.jsonl");
function textOfToolInput(input) {
  if (!input || typeof input !== "object") return "";
  const parts = [];
  if (typeof input.new_string === "string") parts.push(input.new_string);
  if (typeof input.content === "string") parts.push(input.content);
  if (Array.isArray(input.edits)) for (const e of input.edits) if (typeof e?.new_string === "string") parts.push(e.new_string);
  return parts.join("\n");
}
// Codex edits files through `apply_patch`, whose argument is one patch that
// can touch several files. The guard checks what a change INTRODUCES, per
// file — an override or invariant scoped to a path must see that file's path,
// not the patch as a blob. The patch is located by its content, not by a
// field name, so the adapter does not depend on which key a host puts it in.
export function patchSections(input) {
  if (!input || typeof input !== "object") return [];
  const patch = Object.values(input).find((v) => typeof v === "string" && v.includes("*** Begin Patch"));
  if (!patch) return [];
  const out = [];
  let cur = null;
  for (const line of patch.split("\n")) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) { cur = { path: m[2].trim(), added: [] }; if (m[1] !== "Delete") out.push(cur); else cur = null; continue; }
    if (/^\*\*\* (Begin|End) Patch/.test(line)) { if (line.startsWith("*** End")) cur = null; continue; }
    if (!cur) continue;
    if (line.startsWith("+")) cur.added.push(line.slice(1));
  }
  return out.map((s) => ({ path: s.path, text: s.added.join("\n") }));
}
// ---- Shell writes (2026-09-07). A heredoc is not an edit tool, so nothing
// intercepted it and `check --ci` on the pull request was the only layer that
// caught it. The general case is undecidable: a script can write anything. The
// common case is a small, closed set of constructs whose target and content are
// both right there in the command string, and those are extracted statically.
// Nothing is executed and nothing is guessed. A command whose write target
// cannot be read is simply not returned, so a miss stays a miss and never
// becomes a false block.
export function shellWrites(input) {
  const cmd = typeof input === "string" ? input
    : input && typeof input === "object"
      ? Object.values(input).find((v) => typeof v === "string" && /[><]|tee\b/.test(v))
      : null;
  if (!cmd) return [];
  const out = [];
  const push = (path, text) => { if (path && text != null && String(text).trim()) out.push({ path: String(path).replace(/^["']|["']$/g, ""), text: String(text) }); };

  // cat > file <<'EOF' ... EOF   and   cat >> file <<EOF ... EOF
  const HEREDOC = /(?:^|[;&|]\s*)\w[\w./-]*\s*>>?\s*(["']?[\w./~-]+["']?)[^\n<]*<<[-]?\s*(["']?)([A-Za-z_][\w]*)\2\s*\n([\s\S]*?)\n\s*\3\s*(?:$|\n)/g;
  for (const m of cmd.matchAll(HEREDOC)) push(m[1], m[4]);

  // echo "..." > file   |   printf '...' > file
  const ECHO = /(?:^|[;&|]\s*)(?:echo|printf)\s+(-\w+\s+)*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*>>?\s*(["']?[\w./~-]+["']?)/g;
  for (const m of cmd.matchAll(ECHO)) push(m[3], m[2].slice(1, -1));

  // ... | tee file   |   ... | tee -a file
  const TEE = /\|\s*tee\s+(?:-a\s+)?(["']?[\w./~-]+["']?)/g;
  for (const m of cmd.matchAll(TEE)) {
    // Only useful when the piped content is a literal we can see.
    const lit = /(?:echo|printf)\s+(-\w+\s+)*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\|/.exec(cmd);
    if (lit) push(m[1], lit[2].slice(1, -1));
  }
  return out;
}

// Ledger t values whose withdrawn terms a later correction retired.
export function supersededSet(events) {
  const retired = new Set();
  for (const e of events) if (e.kind === "correction" && Array.isArray(e.supersedes)) for (const t of e.supersedes) retired.add(t);
  return retired;
}
const invariantsPath = () => join(dirname(ledgerPath()), "invariants.jsonl");
/** Declared invariants: .memory-pulse/invariants.jsonl, one {id, statement, patterns[], severity?} per line. Never inferred. */
export function readInvariants(path = invariantsPath()) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const l = line.trim(); if (!l) continue;
    try { const inv = JSON.parse(l); if (inv && typeof inv.id === "string" && Array.isArray(inv.patterns)) out.push(inv); } catch { /* a torn line is reported by check, not fatal here */ }
  }
  return out;
}
const compilePattern = (p) => {
  const m = typeof p === "string" ? p.match(/^\/(.+)\/([a-z]*)$/s) : null;
  if (m) { try { const re = new RegExp(m[1], m[2].replace(/g/g, "")); return { src: p, test: (t) => re.test(t) }; } catch { return null; } }
  return typeof p === "string" && p ? { src: p, test: (t) => t.includes(p) } : null;
};
/**
 * The three-verdict check, computed locally (no network) from files you own.
 * Mirrors the engine's src/check.js rule for rule; the engine is authoritative
 * and adds integrity + the signed receipt via `check --receipt`.
 *   blocked      withdrawn term without its replacement; invariant hit
 *   verified     recorded events bear on the text and none is contradicted
 *   no_evidence  nothing recorded bears on it — never reported as a pass
 */
export function localCheck(allEvents, action, invariants = [], opts = {}) {
  // A rolled-back row stays on the record but is out of force: it neither blocks nor counts as evidence.
  const events = inForce(allEvents);
  const chain = opts.chain ?? null; const chainBroken = !!(chain && chain.ok === false);
  const sealCheck = opts.seal ?? null; const sealBroken = !!(sealCheck && sealCheck.ok === false);
  const text = typeof action?.text === "string" ? action.text : "";
  const path = typeof action?.path === "string" ? action.path : "";
  const kind = action?.kind ?? "edit";
  const reasons = [], corrections = [], invHits = [], overrides = [];
  const overridesFor = events.filter((e) => e.kind === "override" && e.override?.term);
  const sidecar = /(^|[\\/])\.memory-pulse([\\/]|$)/.test(path);
  if (text && !sidecar) {
    const retired = supersededSet(events);
    for (const c of events) {
      if (c.kind !== "correction" || !Array.isArray(c.withdrawn) || retired.has(c.t)) continue;
      const disavowed = Array.isArray(c.replacement) && c.replacement.some((r) => r && text.includes(r));
      for (const term of c.withdrawn) {
        if (!containsTerm(text, term)) continue;
        if (disavowed) { reasons.push(`"${term}" appears beside its replacement (comparison or disavowal) — allowed, per ledger t${c.t}`); continue; }
        const o = overridesFor.find((x) => x.override.term === term && (!x.override.path || (path && path.startsWith(x.override.path))));
        if (o) { overrides.push({ t: o.t, term }); reasons.push(`"${term}" is withdrawn at t${c.t} but overridden at t${o.t}${o.override.reason ? ` (${o.override.reason})` : ""}`); continue; }
        corrections.push({ t: c.t, term, replacement: c.replacement ?? [], cause: c.cause, effect: c.effect, note: c.note ?? "" });
      }
    }
  }
  for (const h of corrections) reasons.push(`"${h.term}" was withdrawn at ledger t${h.t}: ${h.cause} -> ${h.effect}${h.replacement.length ? ` — use ${h.replacement.join(" / ")}` : ""}`);
  if (text) for (const inv of invariants) {
    if (!inv || typeof inv.id !== "string") continue;
    // `paths`: prefixes the invariant applies to; absent = every path. A rule
    // about public wording must not fire on a proofs file or a test fixture.
    const scope = Array.isArray(inv.paths) ? inv.paths.filter((x) => typeof x === "string" && x) : [];
    if (scope.length && !scope.some((p) => path.startsWith(p))) continue;
    const tests = (inv.patterns ?? []).map(compilePattern);
    if (tests.some((t) => t === null)) reasons.push(`invariant ${inv.id} ignored: a pattern does not compile`);
    const hit = tests.find((t) => t && t.test(text));
    if (!hit) continue;
    const severity = inv.severity === "warn" ? "warn" : "block";
    // `cite`: the ledger rows the invariant rests on; `replacement`: what to do instead — the block names both.
    const cite = (Array.isArray(inv.cite) ? inv.cite : []).map((c) => typeof c === "number" ? `t${c}` : /^t\d+$/.test(String(c)) ? String(c) : /^\d+$/.test(String(c)) ? `t${c}` : null).filter(Boolean);
    const replacement = typeof inv.replacement === "string" ? inv.replacement : "";
    invHits.push({ id: inv.id, severity, pattern: hit.src, cite, replacement });
    reasons.push(`${severity === "warn" ? "warning" : "invariant"} ${inv.id}${inv.statement ? `: ${inv.statement}` : ""} (matched ${hit.src})${cite.length ? ` — ledger ${cite.join(", ")}` : ""}${replacement ? ` — instead: ${replacement}` : ""}`);
  }
  const evidence = [];
  // The evidence walk touches every event and substring-searches the edit for
  // that event's cause, effect and replacements. It is the whole cost of this
  // function at scale: measured p95 per edit is 1.08 ms at 1,000 events and
  // 146 ms at 250,000, the Enterprise ceiling, and it is paid inside a
  // PreToolUse hook on every write. It exists only to separate `verified` from
  // `no_evidence`. A caller that needs nothing but the block decision, which is
  // what the guard hook needs and all it ever reports, says so and skips it.
  // Measured with the walk skipped: 5.09 ms at 250,000 events, 37x faster.
  if (text && !opts.blockOnly) for (const e of events) {
    if (e.kind === "override") continue;
    const terms = [e.cause, e.effect].filter((x) => typeof x === "string" && x.length >= 4).concat(Array.isArray(e.replacement) ? e.replacement.filter((r) => typeof r === "string" && r.length >= 2) : []);
    const via = terms.find((t) => text.includes(t));
    if (via) evidence.push({ t: e.t, cause: e.cause, effect: e.effect, kind: e.kind ?? "event", via });
  }
  evidence.sort((a, b) => (a.kind === "correction") === (b.kind === "correction") ? (b.t ?? 0) - (a.t ?? 0) : a.kind === "correction" ? -1 : 1);
  let verdict;
  if (chainBroken) reasons.unshift(`ledger chain broken: ${chain.reason ?? "verification failed"}${chain.brokenAt != null ? ` (at t=${chain.brokenAt})` : ""} — a memory whose own history is in question cannot vouch for anything`);
  if (sealBroken) reasons.unshift(`sealed head mismatch: ${sealCheck.reason} — the engine's last signed statement about this ledger no longer holds`);
  if (corrections.length || invHits.some((h) => h.severity === "block") || chainBroken || sealBroken) verdict = "blocked";
  else if (!text.trim()) { verdict = "no_evidence"; reasons.push("empty action text — nothing to check"); }
  else if (!opts.blockOnly && !evidence.length) { verdict = "no_evidence"; reasons.push(`no recorded event bears on this ${kind}; ${events.length} event(s) checked`); }
  else if (opts.blockOnly) { verdict = "not_blocked"; reasons.push("nothing withdrawn appears in this text; evidence not gathered (blockOnly)"); }
  else { verdict = "verified"; reasons.push(`${evidence.length} recorded event(s) bear on this ${kind}; none contradicted`); }
  const retiredT = supersededSet(events);
  const binding = events.filter((e) => e.kind === "correction" && Array.isArray(e.withdrawn) && e.withdrawn.length && !retiredT.has(e.t)).length;
  return { verdict, reasons, evidence: evidence.slice(0, 20), corrections, invariants: invHits, overrides, checked: { events: events.length, corrections: binding, invariants: invariants.length, action: kind, path: path || null } };
}
export const exitCodeFor = (verdict, { ci = false } = {}) => (verdict === "blocked" ? 2 : verdict === "no_evidence" && ci ? 1 : 0);

// A withdrawn term matches as a token, never inside another word or a longer number (2026-10-12). Substring
// matching blocked a withdrawn "ten" inside tenant/written/content and "$79" inside "$790M"; replayed over
// 25,166 files on the estate, it flagged 14,049 against 2,345 for this rule, and every hit only it found was
// false. An underscore separates words, so a snake_case name that restates the value still matches. A number
// may carry a unit (6144px) but not run on into more digits (220, 3.1416); a word of five letters or more
// keeps its inflections (embeddings); a shorter one may not run on (ten/tenant).
const ALNUM = /[\p{L}\p{N}]/u, DIGIT = /\d/, LETTER = /\p{L}/u;
function tokenAt(text, i, term) {
  const j = i + term.length, first = term[0], last = term[term.length - 1];
  if (ALNUM.test(first) && i > 0) {
    const p = text[i - 1];
    if (ALNUM.test(p)) return false;
    if (DIGIT.test(first) && (p === "." || p === ",") && i > 1 && DIGIT.test(text[i - 2])) return false;
  }
  if (ALNUM.test(last) && j < text.length) {
    const n = text[j];
    if (DIGIT.test(last)) {
      if (DIGIT.test(n)) return false;
      if ((n === "." || n === ",") && j + 1 < text.length && DIGIT.test(text[j + 1])) return false;
    } else if (ALNUM.test(n) && !(LETTER.test(last) && term.length >= 5)) return false;
  }
  return true;
}
export function containsTerm(text, term) {
  if (!text || !term) return false;
  for (let i = text.indexOf(term); i !== -1; i = text.indexOf(term, i + 1)) if (tokenAt(text, i, term)) return true;
  return false;
}

export function findViolations(allEvents, text, filePath = "") {
  const hits = [];
  if (!text) return hits;
  const events = inForce(allEvents);
  // The ledger and its sidecars are where corrections are RECORDED; guarding
  // them would block the act of correcting.
  if (/(^|[\\/])\.memory-pulse([\\/]|$)/.test(filePath)) return hits;
  const retired = supersededSet(events);
  for (const e of events) {
    if (e.kind !== "correction" || !Array.isArray(e.withdrawn)) continue;
    if (retired.has(e.t)) continue; // a later correction narrowed or replaced it
    // A comparison or disavowal names the old value next to the new one;
    // only a bare reintroduction is blocked. (Adversarial review, 2026-08-31:
    // a guard that fires on "the $49 figure is withdrawn" livelocks the agent.)
    const disavowed = Array.isArray(e.replacement) && e.replacement.some((r) => r && text.includes(r));
    if (disavowed) continue;
    for (const term of e.withdrawn) if (containsTerm(text, term)) hits.push({ term, t: e.t, cause: e.cause, effect: e.effect, note: e.note ?? "", replacement: e.replacement ?? [] });
  }
  return hits;
}
async function cliGuard() {
  // `guard allow "<term>" [--path p] "<reason>"` records an OVERRIDE: an
  // explicit decision that a hit is a false block, scoped to a path prefix.
  // Overrides are ledger events — they are the false-block signal the bench
  // and the signed capsule count. Never inferred.
  const argv = process.argv.slice(3);
  if (argv[0] === "allow") {
    const rest = argv.slice(1);
    const pi = rest.indexOf("--path");
    const path = pi >= 0 ? rest[pi + 1] : undefined;
    const pos = rest.filter((a, i) => a !== "--path" && rest[i - 1] !== "--path");
    const [term, reason] = pos;
    if (!term) { console.error('usage: memory-pulse guard allow "<withdrawn term>" [--path <prefix>] "<reason>"'); process.exit(1); }
    const r = appendEvent({ cause: "guard-allow", effect: `override:${term}`, kind: "override", note: reason, override: { term, path, reason } });
    console.log(r.written ? `override recorded at t${r.t}: "${term}"${path ? ` under ${path}` : " (any path)"} — counted as a false block in your report` : `not recorded: ${r.reason}`);
    process.exit(r.written ? 0 : 1);
  }
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload; try { payload = JSON.parse(raw); } catch {
    // Not a hook call: allow. Say so under --verbose, because a miswired hook (or a shell that mangled the
    // JSON) is otherwise indistinguishable from "no evidence" (fresh-user run, 2026-09-09).
    if (process.argv.includes("--verbose")) process.stderr.write("memory-pulse guard: stdin was not hook JSON, allowing\n");
    return;
  }
  // Claude Code sends one file per Edit/Write; Codex sends one apply_patch
  // that may touch several. Either way: one check per file, its own path.
  const sections = patchSections(payload.tool_input);
  // A shell command is not an edit tool, so a heredoc used to walk straight
  // past the guard and only `check --ci` on the pull request caught it. Where
  // the write target and its content are both readable from the command
  // string, they are checked like any other edit; where they are not, nothing
  // is returned and the miss stays a miss.
  const shell = sections.length ? [] : shellWrites(payload.tool_input);
  const actions = sections.length ? sections
    : shell.length ? shell
    : [{ path: payload.tool_input?.file_path ?? "", text: textOfToolInput(payload.tool_input) }];
  const command = typeof payload.tool_input?.command === "string" ? payload.tool_input.command : "";
  const invariants = readInvariants();
  const health = { project: ledgerHealth(ledgerPath()), agent: existsSync(agentPath()) ? ledgerHealth(agentPath()) : null };
  const blocked = []; const warnings = new Set();
  for (const a of actions) {
    const v = guardVerdict({ kind: "edit", text: a.text, path: a.path, ...(command ? { command } : {}) }, { invariants, health });
    for (const w of v.warnings ?? []) warnings.add(w);
    // no_evidence and verified pass SILENTLY here: a hook that warns on every
    // edit the ledger has nothing to say about livelocks the agent. The loud
    // form of no_evidence is `check --ci`. A quarantine or a broken chain that
    // does not touch this action is one line on stderr, and the action proceeds.
    if (v.verdict === "blocked") blocked.push({ file: a.path, v });
  }
  if (!blocked.length) {
    if (warnings.size) process.stderr.write([...warnings].join("\n") + "\n");
    // Allowed: add the memory that bears on this file as context. Never a permissionDecision — "allow" would skip the
    // user's permission prompt (docs/HOST_FACTS.md); the guard only blocks or informs.
    try {
      const rows = [...guardRows(ledgerPath()), ...(existsSync(agentPath()) ? guardRows(agentPath()) : [])];
      const seen = new Set(); const parts = [];
      for (const a of actions) {
        const sl = editSlice(rows, invariants, { path: a.path ?? "", text: a.text ?? "" });
        for (const line of sl.split("\n")) if (line && !seen.has(line)) { seen.add(line); parts.push(line); }
      }
      const ctx = parts.join("\n").slice(0, 2000);
      if (ctx) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: ctx } }));
    } catch { /* context is a convenience; the verdict above is what the hook is for */ }
    return;
  }
  const lines = [];
  for (const { file, v } of blocked) {
    try { appendFileSync(violationsPath(), JSON.stringify({ at: new Date().toISOString(), file, hits: v.corrections.map((h) => ({ term: h.term, t: h.t })), invariants: v.invariants.map((i) => i.id) }) + "\n"); } catch { /* reporting is best effort */ }
    if (blocked.length > 1 || sections.length) lines.push(`  ${file || "(no path)"}:`);
    for (const r of v.reasons) {
      if (/^\d+ recorded event/.test(r)) continue;
      // Pick out the retired value and what to use instead. The rest of the
      // line is the citation, which stays plain so the terms are what carries.
      const lit = r
        .replace(/"([^"]+)" was withdrawn/, (_, w) => `${C.red(C.strike(`"${w}"`))} was withdrawn`)
        .replace(/— use (.+)$/, (_, u) => `— use ${C.green(C.bold(u))}`);
      lines.push(`  ${C.red("•")} ${lit}`);
    }
  }
  // A broken chain and a stale seal are different failures with different ways out. A broken chain means a row
  // was edited, removed or inserted: only a copy you trust repairs that. A seal mismatch with the chain intact
  // means the rows verify but the engine's last signed statement no longer matches them — either something
  // rewrote the ledger and re-chained it, or the engine sealed a different view (2026-09-14: the worker sealed
  // the quarantined view of one row, and this hint sent the author to `git checkout` over 900 uncommitted
  // rows). The way out is a recorded decision, never a deleted ledger; guard allow cannot repair either.
  const allReasons = blocked.flatMap(({ v }) => v.reasons);
  const chainBroken = allReasons.some((r) => /^ledger chain broken/.test(r));
  const sealStale = !chainBroken && allReasons.some((r) => /^sealed head mismatch/.test(r));
  const envPrefix = process.env.MEMORY_PULSE_LEDGER ? `MEMORY_PULSE_LEDGER=${process.env.MEMORY_PULSE_LEDGER} ` : "";
  const hint = chainBroken
    ? "The ledger's own row chain is broken mid-file: a row was edited, removed or inserted and rows after it still verify, so writes to the ledger and its sidecars are blocked until it is restored from a copy you trust (`memory-pulse verify` names the first broken row and lists backups that verify). Other work is not blocked. Do not delete the ledger to clear this; the rows are the record. An override cannot repair a chain."
    : sealStale
      ? `Your rows verify (chain OK) but the engine's last seal no longer matches them: either something rewrote the ledger and re-chained it, or the engine sealed a different view. \`memory-pulse verify --json\` shows both sides. If you trust the file as it stands: \`${envPrefix}memory-pulse seal accept "<why>"\` records that decision as a ledger row and sets the old seal aside; the next engine call issues a fresh one.`
      : 'Use the corrected value (mentioning both old and new in a comparison is fine), record a new correction if the old one is wrong, or `memory-pulse guard allow "<term>" --path <prefix> "<reason>"` if this is a false block.';
  process.stderr.write(`${C.red(C.bold("memory-pulse guard: blocked."))}\n${lines.join("\n")}\n${C.dim(hint)}\n`);
  process.exit(2);
}

// `memory-pulse seal accept "<why>"` — the recorded way out of a stale seal. The guard fails closed when the
// engine's last seal no longer folds over the rows; when the row chain still verifies, the rows are intact as
// chained and the disagreement is between the file and the engine's statement about it. Accepting is a ledger
// row, so the decision is on the record; the old seal is set aside beside the ledger, never deleted; the next
// engine call issues a fresh seal over the ledger as it stands. Refused when the chain itself is broken: an
// edited ledger is not a stale seal, and accept is not a repair.
async function cliSeal() {
  const argv = process.argv.slice(3);
  if (argv[0] !== "accept") { console.error('usage: memory-pulse seal accept "<why you trust the ledger as it stands>"'); process.exit(1); }
  const reason = argv.slice(1).join(" ").trim();
  if (!reason) { console.error("seal accept needs a reason: it is recorded as a ledger row"); process.exit(1); }
  const ledger = ledgerPath();
  const chain = verifyChain(ledger);
  if (!chain.ok) { console.error(`refused: the row chain itself is broken (${chain.reason}); accept applies to a stale seal over rows that verify, not to an edited ledger`); process.exit(1); }
  const seal = readSeal(ledger);
  const check = verifyLocalSeal(readEvents().events, seal, chain, ledger);
  if (check.ok !== false) { console.log(check.ok === null ? "nothing to accept: no seal is stored yet" : "nothing to accept: the stored seal matches the ledger"); process.exit(0); }
  const r = appendEvent({ cause: "seal-accepted", effect: `stale-seal-set-aside:through-t${seal.through}`, note: reason, tags: ["seal"] });
  if (!r.written) { console.error(`not recorded: ${r.reason}`); process.exit(1); }
  const sp = sealPathFor(ledger), rp = sealResumePathFor(ledger);
  const aside = `${sp}.${new Date().toISOString().replace(/[:.]/g, "-")}.stale`;
  try { renameSync(sp, aside); } catch { /* already gone */ }
  try { unlinkSync(rp); } catch { /* no resume point */ }
  console.log(`accepted at t${r.t}: the seal through t=${seal.through} is set aside as ${basename(aside)}; the next engine call issues a fresh seal over the ledger as it stands`);
}

// `memory-pulse check [--ci] [--receipt] [--kind edit|publish|command|custom]
//                     [--path p] (--text "…" | --file f | --diff [base] | stdin)`
// The three-verdict check, local by default. --ci makes no_evidence loud
// (exit 1: never green on an empty evidence set); --receipt asks the engine
// for the signed, keyless-verifiable form and its integrity view.
async function cliCheck() {
  const argv = process.argv.slice(3);
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const has = (n) => argv.includes(`--${n}`);
  const ci = has("ci"), wantReceipt = has("receipt");
  const kind = flag("kind") ?? "edit";
  let text = flag("text"), path = flag("path");
  if (text == null && flag("file") != null) { path = path ?? flag("file"); text = readFileSync(flag("file"), "utf8"); }
  if (text == null && has("diff")) {
    // Added lines only: a check is about what the change INTRODUCES.
    const base = flag("diff") && !flag("diff").startsWith("--") ? flag("diff") : null;
    const { execFileSync } = await import("node:child_process");
    const args = base ? ["diff", `${base}...HEAD`, "--unified=0"] : ["diff", "--unified=0"];
    const out = execFileSync("git", args, { encoding: "utf8" });
    text = out.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");
    path = path ?? "git-diff";
  }
  if (text == null) { let raw = ""; for await (const c of process.stdin) raw += c; text = raw; }
  const { events } = readEvents();
  const invariants = readInvariants();
  const chain0 = verifyChain();
  let v = localCheck(events, { kind, text, path }, invariants, { chain: chain0, seal: verifyLocalSeal(events, readSeal(), chain0) });
  let receipt = null, integrity = null;
  if (wantReceipt) {
    const out = await callApi("/v1/check", { action: { kind, text, path }, events, invariants, ...(readMemoryKey() ? { verifyKey: true } : {}) });
    v = { ...out, local: v.verdict };
    receipt = out.receipt ?? null; integrity = out.integrity ?? null;
    if (out.receiptHint && !receipt) v.reasons.push(out.receiptHint);
  }
  const code = exitCodeFor(v.verdict, { ci });
  if (has("json")) { console.log(JSON.stringify({ ...v, receipt, integrity }, null, 2)); process.exit(code); }
  console.log(`memory-pulse check: ${v.verdict.toUpperCase()}${ci && v.verdict === "no_evidence" ? " (not a pass — the ledger has nothing to say about this)" : ""}`);
  for (const r of v.reasons) console.log(`  • ${r}`);
  if (v.evidence?.length) console.log(`  evidence: ${v.evidence.slice(0, 5).map((e) => `t${e.t} ${e.cause} -> ${e.effect}`).join("; ")}${v.evidence.length > 5 ? ` (+${v.evidence.length - 5})` : ""}`);
  if (integrity?.drift?.length) console.log(`  drift: ${integrity.drift.join("; ")}`);
  if (receipt) console.log(`  receipt: ${receipt.kind} ${receipt.verdict} over ${receipt.count} events, head ${receipt.head.slice(0, 12)}… — verify keyless at ${API}/v1/verify`);
  process.exit(code);
}

// `npx memory-pulse report` — correction re-violation scoreboard, computed
// on your machine from files you own. Nothing is sent anywhere.
function cliReport() {
  const events = inForce(readEvents().events);
  const corrections = events.filter((e) => e.kind === "correction");
  const retired = supersededSet(events);
  let blocks = [];
  try { blocks = readFileSync(violationsPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none yet */ }
  const byT = new Map();
  for (const b of blocks) for (const h of b.hits) byT.set(h.t, (byT.get(h.t) ?? 0) + 1);
  const superseded = corrections.filter((c) => retired.has(c.t)).length;
  console.log(`memory-pulse report — ${corrections.length} corrections recorded, ${corrections.filter((c) => c.withdrawn?.length && !retired.has(c.t)).length} with enforceable withdrawn terms${superseded ? ` (${superseded} superseded, no longer binding)` : ""}`);
  console.log(`  edits blocked by the guard: ${blocks.reduce((n, b) => n + b.hits.length, 0)}${blocks.length ? ` (last: ${blocks[blocks.length - 1].at.slice(0, 10)})` : ""}`);
  const top = [...byT.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [t, n] of top) { const c = corrections.find((x) => x.t === t); console.log(`  ${n}× t${t} ${c ? `${c.cause} -> ${c.effect}` : ""} — withdrawn: ${c?.withdrawn?.join(", ")}`); }
  const unenforced = corrections.filter((c) => !c.withdrawn?.length && !retired.has(c.t));
  if (unenforced.length) console.log(`  ${unenforced.length} correction(s) have no withdrawn terms and cannot be enforced — add them with remember(withdrawn: [...])`);
}

// `npx memory-pulse bench` — instant measured metrics on YOUR ledger: how much
// re-entry saves, whether every correction surfaces first, whether the guard
// would block each withdrawn term, and recall self-consistency on your own
// causal links. Numbers, not adjectives.
async function cliBench() {
  const { events } = readEvents();
  if (!events.length) { console.log("no ledger — nothing to measure yet"); return; }
  const corrections = events.filter((e) => e.kind === "correction");
  const dump = JSON.stringify(events).length;
  const pulse = await callApi("/v1/pulse", { events, tier: "brief" }).catch((e) => ({ error: e.message }));
  console.log(`memory-pulse bench — ${events.length} events, ${corrections.length} corrections`);
  if (pulse.error) { console.log(`  brief: unavailable (${pulse.error})`); }
  else {
    const lines = pulse.text.split("\n");
    const first = lines.findIndex((l) => l.startsWith("CORRECTIONS"));
    const headerN = Number((lines[first] ?? "").match(/CORRECTIONS \((\d+)\)/)?.[1] ?? 0);
    const listed = corrections.filter((c) => pulse.text.includes(`${c.cause} -> ${c.effect}`)).length;
    console.log(`  re-entry brief: ${pulse.chars.toLocaleString()} chars vs ${dump.toLocaleString()} char dump (${pulse.savedVsFullDump ?? "no saving on a ledger this small"})`);
    console.log(`  corrections: ${headerN}/${corrections.length} counted in the block${first === 0 ? " (block is first)" : first > 0 ? ` (block at line ${first + 1})` : " (NO BLOCK — check this)"}, ${listed} listed at this tier${headerN > listed ? ` (${headerN - listed} elided — a bigger tier lists them all)` : ""}`);
  }
  const retiredSet = supersededSet(events);
  const enforceable = corrections.filter((c) => c.withdrawn?.length && !retiredSet.has(c.t));
  const guardHits = enforceable.filter((c) => findViolations(events, c.withdrawn.join(" ")).length > 0).length;
  console.log(`  guard: ${guardHits}/${enforceable.length} withdrawn-term sets would be blocked if rewritten${corrections.length > enforceable.length ? ` (${corrections.length - enforceable.length} corrections lack withdrawn terms)` : ""}`);
  const sample = events.filter((e) => e.kind !== "correction").slice(-12);
  let ok = 0, tried = 0, errors = 0, lastErr = "";
  for (const e of sample) {
    tried++;
    // An API error is NOT a miss. Counting failures as misses would let a
    // broken network read as a broken memory — report them separately.
    let r;
    try { r = await callApi("/v1/recall", { events, op: "effects", subject: e.cause, topk: 3 }); }
    catch (err) { errors++; lastErr = String(err?.message ?? err); continue; }
    if (r?.result?.hits?.some((h) => h.entity === e.effect)) ok++;
  }
  if (tried) console.log(`  recall self-consistency: ${ok}/${tried - errors} recent links recovered (top-5 effects of the cause include the recorded effect)${errors ? ` — ${errors} call(s) errored: ${lastErr.slice(0, 80)}` : ""}`);
  console.log(`  telemetry: ${readTelemetry()?.counters ? "signed capsule present — run `stats`" : "none yet"}`);
}

// `npx memory-pulse install-hook` — make re-entry automatic: a Claude Code
// SessionStart hook that runs the brief. Idempotent; merges, never clobbers.
function cliInstallHook() {
  // --project writes to <repo>/.claude/settings.json so the hooks TRAVEL WITH
  // THE REPO: a teammate who clones is guarded without installing anything.
  // (Adversarial review, 2026-08-31: a user-scope hook does not spread.)
  // --codex targets Codex CLI instead: ~/.codex/hooks.json, or with --project
  // <repo>/.codex/hooks.json. Same hook JSON, same events (Codex's hooks are
  // Claude-Code-compatible; learn.chatgpt.com/docs/hooks, read 2026-09-01).
  // Two differences that matter: a file edit arrives as tool `apply_patch`
  // (matchers may also say Edit/Write), and Codex will not RUN a hook until
  // the user reviews and trusts its exact definition via /hooks.
  const project = process.argv.includes("--project");
  const codex = process.argv.includes("--codex");
  const dirName = codex ? ".codex" : ".claude";
  const home = process.env.MEMORY_PULSE_SETTINGS_DIR || (project ? join(process.cwd(), dirName) : join(process.env.HOME || "", dirName));
  const file = join(home, codex ? "hooks.json" : "settings.json");
  let settings = {};
  if (existsSync(file)) {
    try { settings = JSON.parse(readFileSync(file, "utf8")); }
    catch { console.error(`refusing to touch ${file}: it is not valid JSON`); process.exit(1); }
  }
  settings.hooks = settings.hooks || {};
  let changed = 0;
  const BRIEF = "npx -y memory-pulse brief";
  const start = (settings.hooks.SessionStart = settings.hooks.SessionStart || []);
  if (!JSON.stringify(start).includes(BRIEF)) { start.push({ hooks: [{ type: "command", command: BRIEF }] }); changed++; }
  const GUARD = "npx -y memory-pulse guard";
  const pre = (settings.hooks.PreToolUse = settings.hooks.PreToolUse || []);
  if (!JSON.stringify(pre).includes(GUARD)) { pre.push({ matcher: codex ? "Edit|Write|apply_patch" : "Edit|Write|MultiEdit|Bash", hooks: [{ type: "command", command: GUARD }] }); changed++; }
  const PROMPT = "npx -y memory-pulse prompt";
  const upsP = (settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || []);
  if (!JSON.stringify(upsP).includes(PROMPT)) { upsP.push({ hooks: [{ type: "command", command: PROMPT }] }); changed++; }
  const HANDOFF = "npx -y memory-pulse handoff";
  const pc = (settings.hooks.PreCompact = settings.hooks.PreCompact || []);
  if (!JSON.stringify(pc).includes(HANDOFF)) { pc.push({ hooks: [{ type: "command", command: HANDOFF }] }); changed++; }
  if (process.argv.includes("--ambient")) {
    const OBSERVE = "npx -y memory-pulse observe";
    const ups = (settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || []);
    if (!JSON.stringify(ups).includes(OBSERVE)) { ups.push({ hooks: [{ type: "command", command: OBSERVE }] }); changed++; }
  }
  if (!changed) { console.log("hooks already installed — nothing to do"); return; }
  mkdirSync(home, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  console.log(`installed ${changed} hook(s) in ${file}`);
  console.log("SessionStart: every session re-enters through the ledger automatically.");
  console.log(`PreToolUse (${codex ? "apply_patch" : "Edit/Write"}): an edit that writes back a withdrawn value is blocked and explained.`);
  console.log("UserPromptSubmit: the corrections and decisions that bear on each prompt ride along with it.");
  console.log("PreCompact: what the session was doing is recorded before compaction and printed first at the next start.");
  if (process.argv.includes("--ambient")) console.log("UserPromptSubmit: a prompt shaped like a correction (\"X not Y\", \"change X to Y\", \"X -> Y\") is recorded with both terms; the guard enforces it.");
  if (codex) console.log(`Codex runs no hook it has not been shown: open Codex, run /hooks, and trust the ${changed} memory-pulse entries (once per definition).`);
  console.log(project ? `Project-scoped: commit ${dirName}/${codex ? "hooks.json" : "settings.json"} and every clone is guarded.` : "Tip: `install-hook --project` writes the hooks into this repo so teammates inherit them.");
  console.log("Remove either by deleting the memory-pulse entries from hooks.");
}


// `memory-pulse lint [--ci] [--json] [paths…]` — the dry run for the rules a
// session will load. Governance files (CLAUDE.md, AGENTS.md, .claude/rules,
// .cursorrules, …) are checked against the ledger the way the guard checks an
// edit: a rule that still states a withdrawn value is BLOCKED and cites the
// ledger line that retired it; a rule the ledger agrees with is VERIFIED; a
// file the ledger knows nothing about is NO EVIDENCE — never a pass. Asked
// for as "a hook dry-run mode and a lint-style consistency check" across
// "4+ governance layers with no declared precedence" (claude-code #90350).
const LINT_DEFAULTS = ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md", ".claude/rules", ".cursorrules", ".cursor/rules", ".github/copilot-instructions.md", ".codex/AGENTS.md", ".memory-pulse/invariants.jsonl"];
function lintTargets(args) {
  const out = [];
  const add = (p) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) { for (const f of readdirSync(p, { recursive: true })) { const fp = join(p, String(f)); if (statSync(fp).isFile() && /\.(md|mdc|txt|jsonl)$/i.test(fp)) out.push(fp); } }
    else out.push(p);
  };
  for (const p of args.length ? args : LINT_DEFAULTS) add(p);
  return [...new Set(out)];
}
async function cliLint() {
  const argv = process.argv.slice(3);
  const ci = argv.includes("--ci"), asJson = argv.includes("--json");
  const paths = argv.filter((a) => !a.startsWith("--"));
  const led = readEvents();
  const { events } = led;
  const invariants = readInvariants();
  const files = lintTargets(paths).filter((f) => !/(^|[\\/])\.memory-pulse[\\/]events\.jsonl$/.test(f));
  const rows = [];
  // Neither the chain walk nor the seal fold depends on the file being linted, so both are computed once for the run.
  const lintChain = verifyChain();
  const lintSeal = verifyLocalSeal(events, readSeal(), lintChain);
  for (const f of files) {
    let text = ""; try { text = readFileSync(f, "utf8"); } catch { continue; }
    const v = localCheck(events, { kind: "lint", text, path: f }, invariants, { chain: lintChain, seal: lintSeal });
    rows.push({ file: f, verdict: v.verdict, reasons: v.reasons.filter((r) => !/^\d+ recorded event/.test(r)), corrections: v.corrections.map((h) => ({ term: h.term, t: h.t })), invariants: v.invariants.map((i) => i.id) });
  }
  const retired = supersededSet(events);
  const ledger = {
    events: events.length, malformed: led.malformed, digest: led.digest,
    bindingCorrections: events.filter((e) => e.kind === "correction" && Array.isArray(e.withdrawn) && e.withdrawn.length && !retired.has(e.t)).length,
    unenforceableCorrections: events.filter((e) => e.kind === "correction" && !(Array.isArray(e.withdrawn) && e.withdrawn.length)).length,
    superseded: retired.size,
  };
  const blocked = rows.filter((r) => r.verdict === "blocked");
  const summary = { files: rows.length, blocked: blocked.length, verified: rows.filter((r) => r.verdict === "verified").length, noEvidence: rows.filter((r) => r.verdict === "no_evidence").length };
  if (asJson) { console.log(JSON.stringify({ ledger, rows, summary }, null, 2)); }
  else {
    console.log(loadedLine(led, events));
    if (!rows.length) console.log("lint: no governance files found (looked for " + LINT_DEFAULTS.join(", ") + ") — pass paths to lint something else");
    for (const r of rows) {
      const tag = r.verdict === "blocked" ? "BLOCKED    " : r.verdict === "verified" ? "verified   " : "no evidence";
      console.log(`  ${tag} ${r.file}`);
      for (const reason of r.reasons) if (r.verdict !== "no_evidence") console.log(`             • ${reason}`);
    }
    if (ledger.unenforceableCorrections) console.log(`  note: ${ledger.unenforceableCorrections} correction(s) carry no withdrawn terms — they surface in the brief but nothing can enforce them; add withdrawn: [...] to make them bind`);
    console.log(`lint: ${summary.files} file(s) — ${summary.blocked} blocked, ${summary.verified} verified, ${summary.noEvidence} no evidence${summary.blocked ? " — a rule your ledger retired is still being loaded into sessions" : ""}`);
  }
  if (blocked.length) process.exit(2);
  if (ci && !rows.length) process.exit(1);
  process.exit(0);
}

// ---- help (2026-09-09). There was none: --help, -h and help all hit the unknown-command branch, whose list named
// 9 of 19 subcommands. Every subcommand and every environment variable is listed here; test/help.test.js reads
// the dispatch table and the process.env reads out of this file and fails when a line is missing.
function cliHelp() {
  console.log(`memory-pulse ${PKG_VERSION} — corrections that outlive the session. Ledger: .memory-pulse/events.jsonl in the current directory.

usage: memory-pulse <command> [options]        (npx -y memory-pulse <command> without a global install)

Commands
  serve                               start the MCP server on stdio (the default with no command); tools: pulse, recall, remember, execute
  help                                this text (also --help, -h, or --help after any command)
  brief [--engine] [--budget N] [--offline]
                                      the SessionStart re-entry: the scaffold by default; with a key, --engine or --budget the engine brief (tier fitting N tokens), replaced by the scaffold when over 9,500 chars; --offline is the plain local list
  scaffold [--section S] [--all]      the organized memory: identity and rules, corrections in force, project state, recent findings, open threads; every line cites its row
  prompt                              UserPromptSubmit hook: the corrections and decisions that bear on the prompt, as context; silent when none do
  remember <cause> <effect> [--kind event|correction] [--note "..."] [--withdrawn T]... [--replacement T]... [--supersedes N]... [--tags a]... [--pinned] [--scope project|agent]
                                      record a finding or a correction from the shell; same rules as the remember tool; prints the stored row as JSON; exit 1 when refused
  before "<what you are about to do>" [--path <file>] [--text <edit>]
                                      which corrections bear on the change you are about to make: the exact rung locally, the learned rung from the engine
  check [--ci] [--receipt] [--json] [--kind edit|publish|command|custom] [--path p] (--text "..." | --file f | --diff [base] | stdin)
                                      one of three verdicts: BLOCKED (exit 2), VERIFIED (0), NO_EVIDENCE (1 under --ci, never a pass)
  verify [--json] [--scope project|agent]
                                      walk the row chain and check the last engine seal; on a break, name the first bad row and print the command that fixes it; exit 2 if either fails
  append [--scope project|agent] (--json '<row>' | -)
                                      the one way for another tool to write a row: takes the ledger lock and computes t, prev and hash; never write a ledger file directly
  repair [--scope project|agent] (--quarantine-tail | --adopt-quarantine <file> [--yes])
                                      move a tail of rows that fail on their own aside byte-for-byte (recorded, nothing deleted); re-append quarantined rows through the writer after a person reviews them
  seal accept "<why>"                 the recorded way out of a stale seal: appends the decision as a row and sets the old seal aside (never deleted); refused when the chain is broken
  state [export|branch|import|merge|rollback|verify]
                                      agent state as a .rain capsule: export it, cut a branch at a row, import or merge it elsewhere, roll back to a row as an appended row, verify a capsule; no argument prints where the ledger stands
  lint [--ci] [--json] [paths...]     the guard's check over CLAUDE.md, AGENTS.md, .claude/rules, .cursorrules and the other governance files a session loads
  guard [--verbose]                   PreToolUse hook: reads the tool call from stdin, exit 2 with the ledger line when an edit writes a withdrawn value back
  guard allow "<term>" [--path <prefix>] "<reason>"
                                      record a false block as an override scoped to a path prefix
  report                              correction re-violation scoreboard from .memory-pulse/violations.jsonl, no network
  bench                               measured metrics on your own ledger (brief size, guard coverage, recall self-consistency); needs the engine
  stats                               the signed telemetry capsule, signature verified by the engine
  badge                               README badge markdown from the capsule's counters
  install-hook [--codex] [--project] [--ambient]
                                      write three hooks (SessionStart brief, PreToolUse guard, PreCompact handoff) into ~/.claude/settings.json; --codex targets ~/.codex/hooks.json; --project writes them into the repo; --ambient adds the UserPromptSubmit observer
  mode [agent|deliberate]             show or set the mode; agent adds a Stop and a UserPromptSubmit hook and an agent ledger at ~/.memory-pulse/agent/
  identity "<name>, <role>; <stance>" pin the agent's self on the agent ledger (agent mode prints it first in every brief)
  handoff                             PreCompact hook: record what the session was doing from the transcript on stdin
  ambient                             Stop hook (agent mode): record a stated decision, preference, lesson or correction from the last turn, at most four rows
  observe [--verbose]                 UserPromptSubmit hook: record a prompt shaped like a correction ("X not Y", "change X to Y", "X -> Y") with both terms

Environment
  MEMORY_PULSE_API                    engine base URL (default https://pulse.strategic-innovations.ai)
  MEMORY_PULSE_KEY                    licence key, sent as x-mp-key; without it the engine answers on the free tier
  MEMORY_PULSE_LEDGER                 project ledger path (default ./.memory-pulse/events.jsonl); sidecar files live beside it
  MEMORY_PULSE_AGENT                  agent ledger path (default $HOME/.memory-pulse/agent/events.jsonl)
  MEMORY_PULSE_PROJECT                project name sent with every engine call (default: basename of the current directory)
  MEMORY_PULSE_MEMORY_KEY             off disables the signed memory key (.memory-pulse/memory.rain, requested at 500+ events)
  MEMORY_PULSE_MODE                   agent or deliberate for this invocation, overriding ~/.memory-pulse/agent/config.json
  MEMORY_PULSE_SETTINGS_DIR           directory that receives settings.json or hooks.json for install-hook and mode (tests use it)
  MEMORY_PULSE_BRIEF                  scaffold or engine: which re-entry brief prints (default: scaffold without a key, engine brief with one)
  MEMORY_PULSE_BRIEF_BUDGET           default for brief --budget, in tokens
  MEMORY_PULSE_BRIEF_TIER             tier for brief when no budget is given: index, brief (default), notes or full
  MEMORY_PULSE_LOCK_TIMEOUT_MS        how long a writer waits for the ledger lock before refusing (default 5000); a lock whose holder has exited is broken at once
  NO_COLOR, TERM                      colour in the guard's block message only when NO_COLOR is unset, TERM is not dumb and stderr is a TTY
  HOME                                root for the agent ledger, ~/.claude/settings.json and ~/.codex/hooks.json

Exit codes: 0 done; 1 usage or refused (remember, append, repair without --yes, mode, lint --ci with nothing to check, check --ci with no evidence); 2 blocked (guard, check, lint), verification failed (verify) or not a tail (repair --quarantine-tail).
Guide: docs/GUIDE.md in the repository (https://github.com/t-crew/memory-pulse/blob/main/docs/GUIDE.md).`);
}

// ---- append, repair, verify (2026-10-02). `append` is the public way for any other tool to write a row: it takes
// the ledger lock and computes t, prev and hash. A row written into the file by hand (the 2026-10-02 incident: a
// Python json.dumps with the wrong separators and a reused t) breaks the chain for every session on the machine.
const argValue = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const scopeOf = (argv, cmd) => {
  const scope = argValue(argv, "--scope") ?? "project";
  if (!["project", "agent"].includes(scope)) { console.error(`memory-pulse ${cmd}: --scope must be project or agent`); process.exit(1); }
  return scope;
};
async function cliAppend() {
  const argv = process.argv.slice(3);
  const scope = scopeOf(argv, "append");
  let raw = argValue(argv, "--json");
  if (raw === undefined && argv.includes("-")) { raw = ""; for await (const c of process.stdin) raw += c; }
  if (raw === undefined) { console.error(`usage: memory-pulse append [--scope project|agent] (--json '{"cause":"...","effect":"..."}' | -)\n  the one way for another tool to write a row: t, prev and hash are computed here; never write a ledger file directly`); process.exit(1); }
  let row; try { row = JSON.parse(raw); } catch (e) { console.error(`memory-pulse append: not JSON (${e.message})`); process.exit(1); }
  if (!row || typeof row !== "object" || typeof row.cause !== "string" || typeof row.effect !== "string" || !row.cause.trim() || !row.effect.trim()) { console.error("memory-pulse append: the row needs string cause and effect"); process.exit(1); }
  const fields = {}; for (const k of ROW_FIELDS) if (row[k] !== undefined) fields[k] = row[k];
  const res = appendEvent({ cause: row.cause, effect: row.effect, note: row.note, kind: row.kind, tags: row.tags, pinned: row.pinned, withdrawn: row.withdrawn, replacement: row.replacement, supersedes: row.supersedes, override: row.override, scope, fields });
  console.log(JSON.stringify(res));
  process.exit(res.written ? 0 : 1);
}

// Copies beside the ledger (events.jsonl.bak-..., events.jsonl.orig) that verify on their own: restore candidates.
function trustedBackups(ledger) {
  let names = []; try { names = readdirSync(dirname(ledger)); } catch { return []; }
  const base = basename(ledger);
  return names.filter((n) => n.startsWith(`${base}.`) && !/\.(lock|quarantine|tmp)$/.test(n) && !n.endsWith(".verify.json"))
    .map((n) => join(dirname(ledger), n)).filter((f) => { try { return statSync(f).isFile(); } catch { return false; } })
    .map((file) => ({ file, ...verifyChain(file) })).filter((b) => b.ok && b.chained > 0)
    .map((b) => ({ file: b.file, chained: b.chained, head: b.head }));
}

function cliVerify() {
  const argv = process.argv.slice(3);
  const scope = scopeOf(argv, "verify");
  const ledger = scope === "agent" ? agentPath() : ledgerPath();
  const chain = verifyChain(ledger); const seal = verifyLocalSeal(readEvents({ path: ledger }).events, readSeal(ledger), chain, ledger);
  const info = chain.ok ? null : inspectChain(ledger);
  const flag = scope === "agent" ? " --scope agent" : "";
  const prefix = scope === "agent" ? "memory-pulse" : cliPrefixFor(ledger);
  const backups = chain.ok || info?.tail?.allBad ? [] : trustedBackups(ledger);
  const fix = chain.ok ? null : info?.tail?.allBad ? `${prefix} repair${flag} --quarantine-tail` : backups.length ? `cp "${backups[0].file}" "${ledger}"` : null;
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ledger, chain, firstBad: info?.firstBad ?? null, tail: info?.tail ? { rows: info.tail.rows, allBad: info.tail.allBad } : null, fix, backups, seal: { ok: seal.ok, reason: seal.reason ?? null, through: seal.seal?.through ?? null, events: seal.seal?.events ?? null, digest: seal.seal?.digest ?? null } }, null, 2));
    process.exit(chain.ok && seal.ok !== false ? 0 : 2);
  }
  console.log(chain.ok ? `chain: OK — ${chain.chained} chained row(s)${chain.chained ? ` from t=${chain.from}` : ""}, ${chain.legacy} legacy row(s)${chain.sealed ? " sealed" : " (unsealed until the first chained write)"}${chain.head ? ` · head ${chain.head.slice(0, 12)}` : ""}${chain.unsealed ? ` · ${chain.unsealed} unsealed row(s) from an older writer (the next write seals them)` : ""}` : `chain: BROKEN — ${chain.reason}`);
  if (info) {
    console.log(`first bad row: t=${info.firstBad?.t ?? "?"} (line ${info.firstBad?.line ?? "?"})`);
    if (info.tail?.allBad) {
      console.log(`every row from line ${info.firstBad?.line ?? "?"} on fails on its own (${info.tail.rows} row(s)): a bad tail. Move it aside byte-for-byte, recorded, nothing deleted (the guard also does this on its next run):\n  ${fix}`);
    } else {
      console.log(`the rows after it verify on their own, so this is not a bad tail: a row at or before line ${info.firstBad?.line ?? "?"} was edited, removed or inserted. Writes to this ledger stay blocked; other work is not. Restore it from a copy you trust:`);
      if (backups.length) for (const b of backups) console.log(`  ${b.file} verifies (${b.chained} chained row(s), head ${b.head.slice(0, 12)}): cp "${b.file}" "${ledger}"`);
      else console.log("  no copy beside the ledger verifies; restore from version control or another machine's copy");
    }
  }
  console.log(seal.ok === null ? `seal: none yet — ${seal.reason}` : seal.ok ? `seal: OK — engine-signed over ${seal.seal.events} row(s) through t=${seal.seal.through}${seal.seal.digest ? ` · ${seal.seal.digest.slice(0, 12)}` : ""}` : `seal: MISMATCH — ${seal.reason}`);
  process.exit(chain.ok && seal.ok !== false ? 0 : 2);
}

async function cliRepair() {
  const argv = process.argv.slice(3);
  const scope = scopeOf(argv, "repair");
  const ledger = scope === "agent" ? agentPath() : ledgerPath();
  const flag = scope === "agent" ? " --scope agent" : "";
  const prefix = scope === "agent" ? "memory-pulse" : cliPrefixFor(ledger);
  const usage = `usage: memory-pulse repair [--scope project|agent] --quarantine-tail\n       memory-pulse repair [--scope project|agent] --adopt-quarantine <file> [--yes]`;
  if (argv.includes("--quarantine-tail")) {
    let q; try { q = quarantineTail(ledger); } catch (e) { console.error(`memory-pulse repair: ${e.message}`); process.exit(1); }
    if (q.quarantined) { console.log(`quarantined ${q.rows} row(s) from the tail of ${ledger} (${q.reason}): moved byte-for-byte to ${q.file} (sha256 ${q.sha256.slice(0, 12)}), recorded at t=${q.t}; nothing deleted`); process.exit(0); }
    if (q.notTail) { console.log(`refused: not a tail. The chain breaks at t=${q.firstBad?.t ?? "?"} (line ${q.firstBad?.line ?? "?"}) and rows after it verify on their own (${q.reason}); restore the ledger from a copy you trust (${prefix} verify${flag} lists copies that verify)`); process.exit(2); }
    console.log(`nothing to quarantine: ${q.reason}`); process.exit(0);
  }
  const file = argValue(argv, "--adopt-quarantine");
  if (file === undefined) { console.error(usage); process.exit(1); }
  if (!file || !existsSync(file)) { console.error(`memory-pulse repair: no quarantine file at ${file}\n${usage}`); process.exit(1); }
  const rows = [], skipped = [];
  for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    let r = null; try { r = JSON.parse(line); } catch { skipped.push(`line ${i + 1}: not JSON`); continue; }
    if (!r || typeof r.cause !== "string" || typeof r.effect !== "string") { skipped.push(`line ${i + 1}: no cause/effect`); continue; }
    if (instructionLike(r.note).length) { skipped.push(`line ${i + 1}: note reads like an instruction`); continue; }
    rows.push({ r, line: i + 1 });
  }
  if (!argv.includes("--yes")) {
    console.log(`would re-append ${rows.length} row(s) from ${file} to ${ledger} through the writer (new t, prev and hash; each keeps origin {quarantine, t, hash}):`);
    for (const { r, line } of rows) console.log(`  line ${line}: t=${r.t ?? "?"} ${r.cause} -> ${r.effect}`);
    for (const x of skipped) console.log(`  skipped ${x}`);
    console.log(`Nothing written. A quarantined row is unverified: a person reviews it first, then runs:\n  ${prefix} repair${flag} --adopt-quarantine ${file} --yes`);
    process.exit(1);
  }
  const done = [], refused = [];
  for (const { r, line } of rows) {
    const res = appendEvent({ cause: r.cause, effect: r.effect, note: r.note, kind: r.kind, tags: r.tags, pinned: r.pinned, withdrawn: r.withdrawn, replacement: r.replacement, scope, fields: { origin: { quarantine: file, t: r.t ?? null, hash: r.hash ?? null } } });
    if (res.written) done.push(res.t); else refused.push(`line ${line}: ${res.reason}`);
  }
  console.log(`re-appended ${done.length} row(s) to ${ledger}${done.length ? ` at t=${done.join(", ")}` : ""}${skipped.length ? `; skipped ${skipped.join("; ")}` : ""}${refused.length ? `; refused ${refused.join("; ")}` : ""}`);
  process.exit(refused.length && !done.length ? 1 : 0);
}

// ---- remember from the shell (2026-09-09). The Action's no-evidence comment told every reader to run
// `memory-pulse remember`, which did not exist, and the "any MCP client" route had no way to record the first
// correction without driving JSON-RPC by hand. Same appendEvent/bindCorrection path as the tool.
async function cliRemember() {
  const argv = process.argv.slice(3);
  const multi = new Set(["withdrawn", "replacement", "supersedes", "tags"]);
  const single = new Set(["note", "kind", "scope"]);
  const opts = { withdrawn: [], replacement: [], supersedes: [], tags: [] }; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pinned") { opts.pinned = true; continue; }
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
    if (!m) { pos.push(a); continue; }
    const [, k, inline] = m;
    if (!multi.has(k) && !single.has(k)) { console.error(`memory-pulse remember: unknown option --${k} (run memory-pulse help)`); process.exit(1); }
    const v = inline ?? argv[++i];
    if (v == null) { console.error(`memory-pulse remember: --${k} needs a value`); process.exit(1); }
    if (multi.has(k)) opts[k].push(v); else opts[k] = v;
  }
  const [cause, effect] = pos;
  if (!cause || !effect) {
    console.error('usage: memory-pulse remember <cause> <effect> [--kind event|correction] [--note "..."] [--withdrawn <term>]... [--replacement <term>]... [--supersedes <t>]... [--tags <tag>]... [--pinned] [--scope project|agent]\n  repeat --withdrawn for each spelling; a term is never split on commas');
    process.exit(1);
  }
  if (opts.kind && !["event", "correction"].includes(opts.kind)) { console.error("memory-pulse remember: --kind must be event or correction"); process.exit(1); }
  if (opts.scope && !["project", "agent"].includes(opts.scope)) { console.error("memory-pulse remember: --scope must be project or agent"); process.exit(1); }
  const args = { cause, effect, kind: opts.kind || "event", scope: opts.scope || "project" };
  if (opts.note) args.note = opts.note;
  if (opts.withdrawn.length) args.withdrawn = opts.withdrawn;
  if (opts.replacement.length) args.replacement = opts.replacement;
  if (opts.supersedes.length) args.supersedes = opts.supersedes.map(Number);
  if (opts.tags.length) args.tags = opts.tags;
  if (opts.pinned) args.pinned = true;
  let res;
  try { res = await handleCall("remember", args); } catch (e) { console.error(`memory-pulse remember: ${String(e?.message ?? e)}`); process.exit(1); }
  console.log(JSON.stringify(res, null, 2));
  process.exit(res?.written ? 0 : 1);
}

// ------------------------------------------------------------ agent state ----
// Agent state travels as a `.rain` state capsule (2026-09-21): the ledger's rows verbatim, the row-chain head, the
// order-free set head, the engine's last seal and the declared invariants, under one digest. A fresh machine
// verifies the capsule before it trusts it, installs the rows byte-identical, and records where they came from as
// a row. A branch is a capsule cut at a row. A rollback is a row that puts a range out of force without deleting
// anything. A merge carries the other branch's rows across once, in chain order, and names every conflict. Nothing
// here rewrites a row: the record only grows, and the same finding lands once however many branches carried it.
export const STATE_SCHEMA = "catalyst.rain.state.v1";
const STATE_TAGS = ["state", "merge", "rollback"];
const isRollback = (e) => !!e && Array.isArray(e.tags) && e.tags.includes("rollback") && Number.isInteger(e.rollback_to);
/**
 * The row numbers (t) in force at the head. A rollback row restores the ledger as it stood at its target t and keeps
 * everything recorded after itself, so rolling back past a rollback restores what that rollback removed. Rows without
 * an integer t are never rolled back.
 */
export function inForceSet(events) {
  const byT = new Map(); for (const e of events) if (Number.isInteger(e?.t) && !byT.has(e.t)) byT.set(e.t, e);
  const ts = [...byT.keys()].sort((a, b) => a - b);
  // the state at a target X is the state after the last row with t <= X; snapshots are kept at those rows only
  const anchorOf = (X) => { let a = 0; for (const t of ts) { if (t > X) break; a = t; } return a; };
  const anchors = new Set(); for (const t of ts) { const e = byT.get(t); if (isRollback(e) && e.rollback_to < t) anchors.add(anchorOf(e.rollback_to)); }
  const snapshots = new Map([[0, new Set()]]);
  let s = new Set();
  for (const t of ts) {
    const e = byT.get(t);
    if (isRollback(e) && e.rollback_to < t) s = new Set(snapshots.get(anchorOf(e.rollback_to)) ?? []);
    s.add(t);
    if (anchors.has(t)) snapshots.set(t, new Set(s));
  }
  return s;
}
/** The rows in force: the whole list when no rollback was ever recorded (the common case costs nothing). */
export function inForce(events) {
  if (!Array.isArray(events) || !events.some(isRollback)) return events;
  const s = inForceSet(events);
  return events.filter((e) => !Number.isInteger(e?.t) || s.has(e.t));
}
/** What a finding IS, apart from where it sits: the key a merge dedupes on and the order-free content head folds. */
const contentKey = (r) => canonicalJson({ cause: r.cause, effect: r.effect, kind: r.kind ?? "event", note: r.note ?? "", withdrawn: r.withdrawn ?? [], replacement: r.replacement ?? [], override: r.override ?? null });
/** Order-free head over the findings in force, bookkeeping rows excluded: two ledgers that carried the same findings in any order fold to the same value. */
export const contentHeadHex = (rows) => setHeadHex(inForce(rows).filter((r) => !(Array.isArray(r.tags) && r.tags.some((t) => STATE_TAGS.includes(t)))).map((r) => ({ content: contentKey(r) })));

const ledgerFor = (scope) => (scope === "agent" ? agentPath() : ledgerPath());
const linesOf = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : []);
// A line that is not a row (a torn write, an older writer) is carried verbatim and never counted: the chain's gap
// digests cover it, readEvents skips it, the engine's seal folds only rows. Same rule here, so the estate ledger
// (three such lines) still exports. `malformed` lists their 1-based line numbers.
const parseRows = (lines) => { const rows = [], malformed = []; for (const [i, l] of lines.entries()) { let r = null; try { r = JSON.parse(l); } catch { /* not JSON */ } if (r && typeof r === "object" && typeof r.cause === "string" && typeof r.effect === "string") rows.push(r); else malformed.push(i + 1); } return { rows, malformed }; };
const maxT = (rows) => rows.reduce((m, r) => Math.max(m, Number.isInteger(r?.t) ? r.t : 0), 0);
const short = (h) => (typeof h === "string" && h ? h.slice(0, 12) : "none");
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
const capsuleDigest = (cap) => { const { digest, ...rest } = cap; return createHash("sha256").update(canonicalJson(rest)).digest("hex"); };
function writeSealTo(ledger, seal) { if (!seal || typeof seal !== "object" || typeof seal.head !== "string") return; try { mkdirSync(dirname(ledger), { recursive: true }); writeFileSync(sealPathFor(ledger), JSON.stringify(seal, null, 2) + "\n"); } catch { /* read-only checkout */ } }

/** Build a capsule from a ledger: every row (or every row through `at`, for a branch), verified before it is packed. */
export function buildCapsule({ ledger = ledgerPath(), scope = "project", branch = null, at = null } = {}) {
  let lines = linesOf(ledger);
  if (!lines.length) return { error: `no ledger at ${ledger}` };
  const all = parseRows(lines);
  if (!all.rows.length) return { error: "no rows to pack (every line is malformed)" };
  const parentHead = setHeadHex(all.rows);
  if (at != null) {
    if (!Number.isInteger(at) || at < 1) return { error: "--at must be a row number (t) of 1 or more" };
    const cut = all.rows.findIndex((r) => Number.isInteger(r.t) && r.t > at);
    if (cut === 0) return { error: `no row at or before t=${at}` };
    if (cut > 0) lines = lines.slice(0, cut);
  }
  const chain = verifyChainLines(lines);
  if (!chain.ok) return { error: `row chain broken: ${chain.reason}`, chain };
  const rows = at != null ? parseRows(lines).rows : all.rows;
  const head = setHeadHex(rows);
  const force = inForceSet(rows); const inForceRows = rows.filter((r) => !Number.isInteger(r.t) || force.has(r.t));
  const through = maxT(rows);
  const seal0 = readSeal(ledger);
  const seal = seal0 && typeof seal0.head === "string" && Number(seal0.through) <= through ? seal0 : null;
  // the branch this ledger is on: the last import or merge named it, else main
  const lastState = [...rows].reverse().find((r) => Array.isArray(r.tags) && r.tags.includes("state") && r.state?.branch);
  const cap = {
    schema: STATE_SCHEMA, issued: new Date().toISOString(), project: projectName(), scope,
    branch: at != null || branch ? { id: branch || "main", parent: createHash("sha256").update(parentHead).digest("hex"), at } : { id: lastState?.state?.branch ?? "main", parent: lastState?.state?.head ?? null, at: null },
    through, rows: rows.length, malformed: parseRows(lines).malformed.length, lines,
    chain: { head: chain.head, chained: chain.chained, legacy: chain.legacy, from: chain.from, unsealed: chain.unsealed ?? 0 },
    head, in_force: { rows: inForceRows.length, rolled_back: rows.length - inForceRows.length, head: setHeadHex(inForceRows) },
    seal, invariants: readInvariants(join(dirname(ledger), "invariants.jsonl")),
  };
  cap.digest = capsuleDigest(cap);
  return { capsule: cap };
}

/** Verify a capsule: digest, every row, the chain, the heads, and the seal's fold. Fails closed with the first reason. */
export function verifyCapsule(cap) {
  const fail = (reason) => ({ ok: false, reason });
  if (!cap || typeof cap !== "object" || Array.isArray(cap)) return fail("not a state capsule");
  if (cap.schema !== STATE_SCHEMA) return fail(`schema ${JSON.stringify(cap.schema ?? null)} is not ${STATE_SCHEMA}`);
  if (!Array.isArray(cap.lines) || !cap.lines.every((l) => typeof l === "string")) return fail("the capsule carries no rows");
  if (typeof cap.digest !== "string" || capsuleDigest(cap) !== cap.digest) return fail("digest does not match the capsule's content (edited or truncated in transit)");
  const p = parseRows(cap.lines);
  if (p.rows.length !== cap.rows) return fail(`capsule says ${cap.rows} row(s) and carries ${p.rows.length}`);
  if (cap.malformed != null && p.malformed.length !== Number(cap.malformed)) return fail(`capsule says ${cap.malformed} malformed line(s) and carries ${p.malformed.length}`);
  const chain = verifyChainLines(cap.lines); if (!chain.ok) return fail(`row chain broken inside the capsule: ${chain.reason}`);
  if ((chain.head ?? null) !== (cap.chain?.head ?? null)) return fail("chain head does not match the rows");
  if (setHeadHex(p.rows) !== cap.head) return fail("rows do not fold to the capsule's head");
  const force = inForceSet(p.rows); const inF = p.rows.filter((r) => !Number.isInteger(r.t) || force.has(r.t));
  if (!cap.in_force || setHeadHex(inF) !== cap.in_force.head) return fail("rows in force do not fold to the capsule's in-force head");
  if (cap.seal != null) {
    if (typeof cap.seal !== "object" || typeof cap.seal.head !== "string") return fail("the seal is malformed");
    const covered = p.rows.filter((r) => (Number(r.t) || 0) <= Number(cap.seal.through));
    if (covered.length !== Number(cap.seal.events)) return fail(`the seal covers ${cap.seal.events} row(s) through t=${cap.seal.through}; the capsule carries ${covered.length}`);
    if (setHeadHex(covered) !== cap.seal.head) return fail(`rows through t=${cap.seal.through} do not fold to the sealed head`);
  }
  return { ok: true, rows: p.rows, malformed: p.malformed, chain, inForce: inF.length, rolledBack: p.rows.length - inF.length };
}

/**
 * Install a capsule into an empty ledger, or fast-forward a ledger the capsule extends. A ledger that diverged is
 * refused (that is a merge). The engine's seal and the declared invariants travel with the state; a row records
 * where the state came from.
 */
export function importCapsule(cap, { scope = "project" } = {}) {
  const ledger = ledgerFor(scope);
  const v = verifyCapsule(cap); if (!v.ok) return { status: "refused", reason: v.reason, code: 2 };
  const local = linesOf(ledger);
  const prefix = commonPrefix(local, cap.lines);
  let status, appended;
  if (!local.length) { mkdirSync(dirname(ledger), { recursive: true }); withLedgerLock(ledger, () => writeFileSync(ledger, cap.lines.join("\n") + "\n")); status = "installed"; appended = cap.lines.length; }
  else if (prefix === local.length && prefix === cap.lines.length) return { status: "unchanged", reason: "the ledger already holds this state", code: 0 };
  else if (prefix === cap.lines.length) return { status: "unchanged", reason: `the ledger is ahead of this capsule by ${local.length - prefix} row(s); nothing to import`, code: 0 };
  else if (prefix === local.length) { withLedgerLock(ledger, () => appendFileSync(ledger, cap.lines.slice(prefix).join("\n") + "\n")); status = "fast-forwarded"; appended = cap.lines.length - prefix; }
  else return { status: "refused", reason: `the ledger and the capsule diverged after row ${prefix} (${local.length - prefix} local row(s) against ${cap.lines.length - prefix} in the capsule); \`memory-pulse state merge\` carries the capsule's rows across`, code: 1 };
  const localSeal = readSeal(ledger);
  if (cap.seal && (!localSeal || Number(localSeal.through) < Number(cap.seal.through))) writeSealTo(ledger, cap.seal);
  const inv = join(dirname(ledger), "invariants.jsonl");
  if (Array.isArray(cap.invariants) && cap.invariants.length && !existsSync(inv)) { try { writeFileSync(inv, cap.invariants.map((i) => JSON.stringify(i)).join("\n") + "\n"); } catch { /* read-only checkout */ } }
  const id = cap.branch?.id ?? "main";
  // Rows whose note reads like an instruction are installed (the record is the record) but named here, and every
  // local render holds such a note back; the engine quarantines the same rows at read time.
  const held = v.rows.filter((r) => instructionLike(r.note).length).map((r) => r.t);
  const r = appendEvent({ cause: "state-resumed", effect: `from-${id}-${short(cap.head)}`, tags: ["state"], scope,
    note: `resumed from .rain state capsule ${short(cap.digest)}: branch ${id}, ${cap.rows} row(s) through t=${cap.through}, issued ${cap.issued}${cap.seal ? `, engine seal through t=${cap.seal.through}` : ""}${held.length ? `; ${held.length} row(s) held back from every render, note reads like an instruction` : ""}`,
    fields: { state: { capsule: cap.digest, head: short(cap.head), branch: id, parent: cap.branch?.parent ?? null, at: cap.branch?.at ?? null } } });
  return { status, appended, rows: cap.rows, through: cap.through, head: cap.head, branch: id, held, t: r.t, code: 0 };
}

/**
 * Merge a capsule into a ledger that diverged from it: every finding the branch holds in force and this ledger does
 * not is appended once, in the branch's order, chained here, carrying its origin. Duplicates are skipped by content,
 * an instruction-like note is held back, the branch's own rollbacks are applied at source and never carried, and a
 * correction that withdraws a term this ledger withdraws with a different replacement is named as a conflict, not
 * resolved. Merging the same capsule twice appends nothing.
 */
export function mergeCapsule(cap, { scope = "project" } = {}) {
  const ledger = ledgerFor(scope);
  const v = verifyCapsule(cap); if (!v.ok) return { status: "refused", reason: v.reason, code: 2 };
  const local = linesOf(ledger);
  if (!local.length) return importCapsule(cap, { scope });
  const lchain = verifyChainLines(local); if (!lchain.ok) return { status: "refused", reason: `this ledger's row chain is broken: ${lchain.reason}`, code: 2 };
  const prefix = commonPrefix(local, cap.lines);
  if (prefix === cap.lines.length) return { status: "unchanged", reason: "every row in the capsule is already on this ledger", code: 0, carried: [] };
  // A merge always carries row by row, even when this ledger is a prefix of the capsule: `import` is the verbatim
  // fast-forward, `merge` is the one that dedupes, holds back and leaves the branch's bookkeeping with the branch.
  const localRows = parseRows(local).rows;
  const fork = prefix ? (localRows[prefix - 1].t ?? 0) : 0;
  const branchForce = inForceSet(v.rows);
  const foreign = v.rows.slice(prefix);
  const have = new Set(localRows.map(contentKey));
  const tMap = new Map(); for (const r of localRows) if (Number.isInteger(r.t) && r.t <= fork) tMap.set(r.t, r.t);
  const localCorr = inForce(localRows).filter((e) => e.kind === "correction" && Array.isArray(e.withdrawn));
  const id = cap.branch?.id ?? "main";
  let next = maxT(localRows) + 1;
  const carried = [], skipped = [], held = [], atSource = [], conflicts = [];
  for (const r of foreign) {
    const fromT = r.t;
    if (isRollback(r) || (Array.isArray(r.tags) && r.tags.some((t) => STATE_TAGS.includes(t)))) { atSource.push(fromT); continue; }
    if (Number.isInteger(fromT) && !branchForce.has(fromT)) { atSource.push(fromT); continue; }
    const key = contentKey(r);
    if (have.has(key)) { skipped.push(fromT); continue; }
    if (instructionLike(r.note).length) { held.push(fromT); continue; }
    const row = { ...r }; delete row.hash; delete row.prev; delete row.gap_digest; delete row.legacy_digest;
    row.t = next++;
    row.origin = { branch: id, t: fromT ?? null, capsule: short(cap.digest) };
    if (Array.isArray(row.supersedes)) { const m = row.supersedes.map((t) => tMap.get(t)).filter((t) => Number.isInteger(t)); if (m.length) row.supersedes = m; else delete row.supersedes; }
    if (r.kind === "correction" && Array.isArray(row.withdrawn)) for (const term of row.withdrawn) { const lc = localCorr.find((c) => c.withdrawn.includes(term) && canonicalJson(c.replacement ?? []) !== canonicalJson(row.replacement ?? [])); if (lc) conflicts.push({ term, local: lc.t, merged: row.t }); }
    chainAppend(ledger, row); carried.push(row.t); have.add(key); if (Number.isInteger(fromT)) tMap.set(fromT, row.t);
  }
  if (!carried.length) return { status: "unchanged", reason: `nothing new to carry: ${skipped.length} duplicate(s)${held.length ? `, ${held.length} held back` : ""}${atSource.length ? `, ${atSource.length} applied at source` : ""}`, code: 0, carried, skipped, held, atSource };
  const note = `merged ${carried.length} row(s) from branch ${id} (.rain state capsule ${short(cap.digest)}, head ${short(cap.head)}); fork after t=${fork}; ${skipped.length} duplicate(s) skipped${held.length ? `; ${held.length} row(s) held back, note reads like an instruction` : ""}${atSource.length ? `; ${atSource.length} row(s) applied at source, not carried` : ""}${conflicts.length ? `; ${conflicts.length} conflict(s): ${conflicts.map((c) => `"${c.term}" t${c.local} against t${c.merged}`).join(", ")}` : ""}`;
  const m = appendEvent({ cause: "state-merged", effect: `from-${id}-${short(cap.head)}`, note, tags: ["merge"], scope, fields: { state: { capsule: cap.digest, head: short(cap.head), branch: id, fork, carried: carried.length, conflicts } } });
  return { status: "merged", carried, skipped, held, atSource, conflicts, fork, t: m.t, code: 0 };
}

/** Roll the ledger back to how it stood at row `to`: one appended row; every row after `to` stays on record, out of force. */
export function rollbackTo(to, why, { scope = "project" } = {}) {
  const { events } = readEvents({ scope }); const head = maxT(events);
  if (!events.length) return { written: false, reason: "nothing to roll back: the ledger is empty" };
  if (!Number.isInteger(to) || to < 0) return { written: false, reason: "--to must be a row number (t); 0 rolls back every row" };
  if (to >= head) return { written: false, reason: `--to must be below the head (t=${head})` };
  if (!why || !String(why).trim()) return { written: false, reason: "a reason is required: the rollback is a row on the record" };
  const before = inForceSet(events);
  const out = events.filter((e) => Number.isInteger(e.t) && before.has(e.t) && e.t > to);
  const r = appendEvent({ cause: "state-rollback", effect: `rolled-back-to-t${to}`, kind: "decision", note: String(why).trim(), tags: ["rollback"], scope, fields: { rollback_to: to } });
  if (!r.written) return r;
  return { ...r, to, outOfForce: out.map((e) => e.t), corrections: out.filter((e) => e.kind === "correction").length };
}

async function cliState() {
  const argv = process.argv.slice(3);
  const op = argv[0] && !argv[0].startsWith("--") ? argv[0] : "status";
  const rest = op === "status" ? argv : argv.slice(1);
  const flag = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
  const pos = rest.filter((a, i) => !a.startsWith("--") && !(rest[i - 1] ?? "").startsWith("--"));
  const usage = () => { console.error(`usage: memory-pulse state                                    where this ledger stands: rows, in force, heads, seal, branch
       memory-pulse state export [--out <file>] [--scope project|agent]      write the .rain state capsule (stdout by default)
       memory-pulse state branch <id> [--at <t>] [--out <file>]     a capsule cut at row t (default: the head), named as a branch
       memory-pulse state import <file|-> [--scope project|agent]  install into an empty ledger or fast-forward; refuses a diverged ledger
       memory-pulse state merge <file|-> [--scope project|agent]   carry a diverged branch's rows across once; conflicts are named
       memory-pulse state rollback --to <t> "<why>" [--scope ...]  one row that puts every row after t out of force; nothing is deleted
       memory-pulse state verify <file|->                          verify a capsule without touching any ledger; exit 2 on failure`); process.exit(1); };
  const scope = flag("scope") ?? "project"; if (!["project", "agent"].includes(scope)) usage();
  const ledger = ledgerFor(scope);
  const readCapsule = async (file) => {
    if (!file) usage();
    let text; try { if (file === "-") { text = ""; for await (const c of process.stdin) text += c; } else text = readFileSync(file, "utf8"); } catch (e) { console.error(`memory-pulse state ${op}: cannot read ${file} (${String(e?.message ?? e).split("\n")[0]})`); process.exit(2); }
    try { return JSON.parse(text); } catch { console.error(`memory-pulse state ${op}: ${file === "-" ? "stdin" : file} is not a state capsule (not JSON)`); process.exit(2); }
  };
  if (op === "status") {
    const lines = linesOf(ledger);
    if (!lines.length) { console.log(`state: no ledger at ${relPath(ledger)} — nothing recorded yet`); return; }
    const p = parseRows(lines); const chain = verifyChainLines(lines); const seal = readSeal(ledger);
    const rows = p.rows; const force = inForceSet(rows); const inF = rows.filter((r) => !Number.isInteger(r.t) || force.has(r.t));
    const last = [...rows].reverse().find((r) => Array.isArray(r.tags) && r.tags.some((t) => ["state", "merge"].includes(t)));
    console.log(`state: ${relPath(ledger)} · ${rows.length} row(s) through t=${maxT(rows)}${p.malformed.length ? ` (+${p.malformed.length} malformed line(s) carried, not counted)` : ""} · ${inF.length} in force, ${rows.length - inF.length} rolled back · chain ${chain.ok ? `OK head ${short(chain.head)}` : `BROKEN (${chain.reason})`} · set head ${short(setHeadHex(rows))} · seal ${seal?.head ? `through t=${seal.through}` : "none yet"} · branch ${last?.state?.branch ?? "main"}${last ? ` · last ${last.cause === "state-merged" ? "merge" : "resume"} at t${last.t} from capsule ${last.state?.capsule ? short(last.state.capsule) : "?"}` : ""}`);
    process.exit(chain.ok ? 0 : 2);
  }
  if (op === "export" || op === "branch") {
    const id = op === "branch" ? pos[0] : (flag("branch") ?? null);
    if (op === "branch" && !id) usage();
    const at = op === "branch" && flag("at") != null ? Number(flag("at")) : null;
    const b = buildCapsule({ ledger, scope, branch: id, at });
    if (b.error) { console.error(`memory-pulse state ${op}: ${b.error}`); process.exit(2); }
    const out = flag("out"); const text = JSON.stringify(b.capsule) + "\n";
    if (!out || out === "-") process.stdout.write(text); else writeFileSync(out, text);
    const c = b.capsule;
    console.error(`state ${op}: ${c.rows} row(s) through t=${c.through}, head ${short(c.head)}, chain ${short(c.chain.head)}, ${c.in_force.rolled_back} rolled back, seal ${c.seal ? `through t=${c.seal.through}` : "none"}, branch ${c.branch.id}${c.branch.at != null ? ` cut at t=${c.branch.at}` : ""} → ${out && out !== "-" ? out : "stdout"} (capsule ${short(c.digest)})`);
    return;
  }
  if (op === "verify") {
    const cap = await readCapsule(pos[0]); const v = verifyCapsule(cap);
    if (!v.ok) { console.log(`capsule: FAILED — ${v.reason}`); process.exit(2); }
    console.log(`capsule: OK — ${v.rows.length} row(s) through t=${maxT(v.rows)}${v.malformed?.length ? ` (+${v.malformed.length} malformed line(s) carried)` : ""}, ${v.inForce} in force, ${v.rolledBack} rolled back, chain head ${short(v.chain.head)}, head ${short(cap.head)}, branch ${cap.branch?.id ?? "main"}${cap.seal ? `, engine seal through t=${cap.seal.through} folds (its tag is checked by the engine on the next call)` : ", no engine seal"}`);
    return;
  }
  if (op === "import" || op === "merge") {
    const cap = await readCapsule(pos[0]);
    const r = op === "import" ? importCapsule(cap, { scope }) : mergeCapsule(cap, { scope });
    if (r.status === "refused") { console.error(`memory-pulse state ${op}: refused — ${r.reason}`); process.exit(r.code); }
    if (r.status === "unchanged") { console.log(`state ${op}: nothing to do — ${r.reason}`); process.exit(0); }
    if (r.status === "merged") {
      console.log(`state merge: ${r.carried.length} row(s) carried from branch ${cap.branch?.id ?? "main"} as t${r.carried[0]}..t${r.carried[r.carried.length - 1]}; fork after t=${r.fork}; ${r.skipped.length} duplicate(s) skipped${r.held.length ? `; ${r.held.length} held back` : ""}${r.atSource.length ? `; ${r.atSource.length} applied at source` : ""}; recorded at t${r.t}`);
      for (const c of r.conflicts) console.log(`  ! conflict: "${c.term}" is withdrawn at t${c.local} and at t${c.merged} with different replacements — both bind until one is superseded`);
      return;
    }
    console.log(`state import: ${r.status} — ${r.appended} row(s) from branch ${r.branch} (through t=${r.through}, head ${short(r.head)}); recorded at t${r.t}${r.held?.length ? `; ${r.held.length} row(s) held back from every render (note reads like an instruction): t${r.held.join(", t")}` : ""}`);
    return;
  }
  if (op === "rollback") {
    const to = flag("to") != null ? Number(flag("to")) : NaN; const why = pos.join(" ").trim();
    const r = rollbackTo(to, why, { scope });
    if (!r.written) { console.error(`memory-pulse state rollback: ${r.reason}`); process.exit(1); }
    console.log(`state rollback: recorded at t${r.t} — ${r.outOfForce.length} row(s) after t=${r.to} are out of force (${r.corrections} correction(s) among them); every row stays on the record`);
    return;
  }
  usage();
}

// Importable for tests; the transport runs only when this file is the entry
// point. Compared by REALPATH, not by name: npm invokes the bin through a
// .bin/memory-pulse symlink, and a basename comparison silently failed there —
// the published package installed, exited 0, and served nothing. Found by
// running the stranger-install test against the real registry.
let isMain = false;
try {
  isMain = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
} catch { /* argv[1] missing or unreadable — we are being imported */ }
if (isMain) {
  const sub = process.argv[2];
  if (sub === "help" || sub === "--help" || sub === "-h" || process.argv.slice(2).some((a) => a === "--help" || a === "-h")) { cliHelp(); process.exit(0); }
  if (sub === "remember") { await cliRemember(); process.exit(0); }
  if (sub === "brief") { await cliBrief(); process.exit(0); }
  if (sub === "scaffold") { await cliScaffold(); process.exit(0); }
  if (sub === "prompt") { await cliPrompt(); process.exit(0); }
  if (sub === "before") { await cliBefore(); process.exit(0); }
  if (sub === "install-hook") { cliInstallHook(); process.exit(0); }
  if (sub === "guard") { await cliGuard(); process.exit(0); }
  if (sub === "check") { await cliCheck(); process.exit(0); }
  if (sub === "handoff") { await cliHandoff(); process.exit(0); }
  if (sub === "ambient") { await cliAmbient(); process.exit(0); }
  if (sub === "mode") { await cliMode(); process.exit(0); }
  if (sub === "identity") { await cliIdentity(); process.exit(0); }
  if (sub === "observe") { await cliObserve(); process.exit(0); }
  if (sub === "verify") cliVerify();
  if (sub === "append") { await cliAppend(); process.exit(0); }
  if (sub === "repair") { await cliRepair(); process.exit(0); }
  if (sub === "seal") { await cliSeal(); process.exit(0); }
  if (sub === "state") { await cliState(); process.exit(0); }
  if (sub === "lint") { await cliLint(); process.exit(0); }
  if (sub === "report") { cliReport(); process.exit(0); }
  if (sub === "bench") { await cliBench(); process.exit(0); }
  if (sub === "stats") { await cliStats(); process.exit(0); }
  if (sub === "badge") { cliBadge(); process.exit(0); }
  if (sub && sub !== "serve") { console.error(`unknown command: ${sub} (run memory-pulse help for the list)`); process.exit(1); }
  process.stderr.write(`memory-pulse: ledger ${ledgerPath()} — api ${API}\n`);
  const rl = builtin("readline").createInterface({ input: process.stdin, terminal: false });
  // In-flight calls are drained before exit. Exiting the moment stdin closes
  // would kill network requests mid-flight and swallow their responses — found
  // by piping a scripted session rather than assuming the happy path.
  const inflight = new Set();
  rl.on("line", (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); }
    catch { process.stderr.write("memory-pulse: dropped malformed line\n"); return; }
    const job = dispatch(msg)
      .catch((e) => { if (msg && msg.id !== undefined) fail(msg.id, -32603, String(e?.message ?? e)); })
      .finally(() => inflight.delete(job));
    inflight.add(job);
  });
  rl.on("close", async () => {
    await Promise.allSettled([...inflight]);
    process.exit(0);
  });
  process.on("uncaughtException", (e) => process.stderr.write(`memory-pulse: ${e.stack}\n`));
}
