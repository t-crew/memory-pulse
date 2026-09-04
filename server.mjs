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
 *   - This client is the entire client. No SDK, no dependencies, ~300 lines
 *     you can read in one sitting.
 *
 * Config (env):
 *   MEMORY_PULSE_KEY     license key (optional — free tier without one)
 *   MEMORY_PULSE_API     override the API base (default: hosted service)
 *   MEMORY_PULSE_LEDGER  override the ledger path (default: ./.memory-pulse/events.jsonl)
 */
import readline from "node:readline";
import { createHash, createCipheriv } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, realpathSync, readdirSync, statSync} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  const path = opts.scope === "agent" ? agentPath() : ledgerPath();
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
export function loadedLine(led, events, opts = {}) {
  const retired = supersededSet(events);
  const binding = events.filter((e) => e.kind === "correction" && Array.isArray(e.withdrawn) && e.withdrawn.length && !retired.has(e.t));
  const terms = new Set(binding.flatMap((e) => e.withdrawn));
  const unenforceable = events.filter((e) => e.kind === "correction" && !(Array.isArray(e.withdrawn) && e.withdrawn.length)).length;
  const parts = [`loaded ${events.length} events from ${relPath(led.path)}`];
  if (led.digest) parts.push(`sha256 ${led.digest}`);
  parts.push(`${binding.length} binding correction${binding.length === 1 ? "" : "s"} (${terms.size} withdrawn term${terms.size === 1 ? "" : "s"})`);
  if (unenforceable) parts.push(`${unenforceable} correction${unenforceable === 1 ? "" : "s"} without withdrawn terms (surfaced, not enforced)`);
  if (retired.size) parts.push(`${retired.size} superseded`);
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
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  let prev = null, chained = 0, from = null, legacy = 0; const gap = [];
  const out = (extra) => ({ legacy, chained, head: prev, from, ...extra });
  for (let i = 0; i < lines.length; i++) {
    if (!hasHash(lines[i])) { gap.push(lines[i]); continue; }
    const row = JSON.parse(lines[i]);
    if (chained === 0) {
      from = row.t ?? null; legacy = gap.length;
      if (row.legacy_digest !== sealDigest(gap)) return out({ ok: false, head: null, reason: `legacy rows changed since the chain sealed them (digest mismatch at t=${row.t})`, brokenAt: row.t ?? null });
    } else {
      if (row.prev !== prev) return out({ ok: false, reason: `row t=${row.t} does not link to the previous chained row (a row was removed, reordered or inserted)`, brokenAt: row.t ?? null });
      const want = row.gap_digest ?? null;
      if (want === null ? gap.length > 0 : want !== sealDigest(gap)) return out({ ok: false, reason: `unchained rows before t=${row.t} do not match the gap it sealed (${gap.length} row(s); edited, removed or inserted)`, brokenAt: row.t ?? null });
    }
    if (rowHash(row) !== row.hash) return out({ ok: false, reason: `row t=${row.t} does not match its own hash (edited in place)`, brokenAt: row.t ?? null });
    prev = row.hash; chained++; gap.length = 0;
  }
  if (chained === 0) return { ok: true, legacy: gap.length, chained: 0, head: null, from: null, sealed: false, unsealed: 0 };
  return out({ ok: true, sealed: true, unsealed: gap.length });
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
/** content check of the local ledger against the last seal — fails closed; { ok: null } when there is no seal yet */
export function verifyLocalSeal(events = readEvents().events, seal = readSeal()) {
  if (!seal || typeof seal.head !== "string") return { ok: null, reason: "no seal yet (first engine call issues one)" };
  const covered = events.filter((e) => (Number(e.t) || 0) <= Number(seal.through));
  if (covered.length !== Number(seal.events)) return { ok: false, reason: `ledger has ${covered.length} rows up to the sealed watermark t=${seal.through}, the seal covers ${seal.events}`, seal };
  if (setHeadHex(covered) !== seal.head) return { ok: false, reason: `ledger content changed since the last sealed call (rows up to t=${seal.through} no longer fold to the sealed head)`, seal };
  return { ok: true, seal };
}

export function appendEvent({ cause, effect, note, kind, tags, pinned, withdrawn, replacement, supersedes, override, scope }) {
  // Instruction-like notes are refused at the write. The engine quarantines
  // them at read time too (and reports it), but a note that would be rendered
  // into every future session as an instruction should never reach the ledger.
  // Same deterministic list as the engine; no model in the loop.
  const hits = instructionLike(note);
  if (hits.length) return { written: false, reason: "instruction-like note refused", patterns: hits, hint: "Record what happened, not what to do. Rephrase as a finding." };
  const { path, events } = readEvents({ scope });
  const dup = events.find((e) => e.cause === cause && e.effect === effect && (e.note ?? "") === (note ?? ""));
  if (dup) return { written: false, reason: "duplicate", t: dup.t, ledger: path };
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
  const t = events.reduce((m, e) => Math.max(m, e.t ?? 0), 0) + 1;
  const event = { t, cause, effect, kind: kind || "event" };
  if (note) event.note = note;
  if (Array.isArray(tags) && tags.length) event.tags = tags;
  if (pinned) event.pinned = true;
  // Withdrawn terms are what the guard enforces: exact strings that must not
  // be written again. Only explicit terms count — the guard never guesses.
  if (Array.isArray(withdrawn)) {
    const terms = withdrawn.map((w) => String(w).trim()).filter((w) => w.length >= 2);
    if (terms.length) event.withdrawn = terms;
  }
  // Replacement terms let the guard tell a REINTRODUCTION ("price is $49")
  // apart from a DISAVOWAL or comparison ("was $49, now $29"): an edit that
  // carries a replacement alongside the withdrawn term is allowed.
  if (Array.isArray(replacement)) {
    const terms = replacement.map((w) => String(w).trim()).filter((w) => w.length >= 1);
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
    { const raw = readFileSync(path, "utf8").split("\n").filter((l) => l.trim()); let last = null, seen = false; const gap = []; for (const l of raw) { if (hasHash(l)) { seen = true; last = JSON.parse(l).hash; gap.length = 0; } else gap.push(l); } if (seen) { event.prev = last; if (gap.length) event.gap_digest = sealDigest(gap); } else { event.legacy_digest = sealDigest(gap); event.prev = null; } event.hash = rowHash(event); }
appendFileSync(path, JSON.stringify(event) + "\n");
  // Echo the canonical stored event back. A shell-quoting accident once ate a
  // word from a note SILENTLY; the caller must be able to see what the ledger
  // actually holds without re-reading the file.
  return { written: true, t, ledger: path, stored: event };
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
    if (dir.endsWith(".memory-pulse") && !existsSync(gi)) writeFileSync(gi, "memory.rain\n");
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
  const mod = u.protocol === "http:" ? http : https;
  // Ledgers compress 5-10x (notes are prose); anything past 4 KB goes up
  // gzipped. The engine inflates it; a small body is not worth the header.
  const gz = Buffer.byteLength(payload) >= 4096;
  const body = gz ? gzipSync(payload) : Buffer.from(payload);
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
    return appendEvent(args);
  }

  const { path, events } = readEvents();
  if (!events.length) return { empty: true, ledger: path, hint: "Nothing recorded yet — use `remember` to start." };

  if (name === "pulse") return callApi("/v1/pulse", { events, ...(args.tier ? { tier: args.tier } : args.budget ? {} : { tier: undefined }), root: args.root, ...(Number.isFinite(args.budget) && args.budget >= 1 ? { budget: args.budget } : {}) });
  if (name === "recall") return callApi("/v1/recall", { events, op: args.op, subject: args.subject, object: args.object, topk: args.topk });
  if (name === "execute") return callApi("/v1/execute", { events, program: args.program });
  throw new Error(`unknown tool: ${name}`);
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
      serverInfo: { name: "memory-pulse", version: "0.2.1" },
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
export function identityBlock(led) {
  const events = led?.events ?? []; if (!events.length) return "";
  const self = tagged(events, "identity").filter((e) => e.pinned).slice(-1)[0] ?? tagged(events, "identity").slice(-1)[0];
  const rules = tagged(events, "rule"), prefs = tagged(events, "preference"), lessons = tagged(events, "lesson").slice().reverse();
  const corr = events.filter((e) => e.kind === "correction" && e.withdrawn?.length).length;
  const chain = verifyChain(led.path); const seal = readSeal(led.path);
  const name = self ? String(self.note ?? self.effect).split(/[;.\n]/)[0].trim() : "unnamed agent";
  const lines = [`AGENT IDENTITY — ${name} (agent ledger: ${events.length} rows, head ${chain.head ? chain.head.slice(0, 12) : "none"}${chain.ok ? "" : ", CHAIN BROKEN"}, seal ${seal?.digest ? seal.digest.slice(0, 12) : "not yet"})`];
  if (self) lines.push(`  self: ${self.note ?? self.effect}`);
  lines.push(`  fingerprint: chain head ${chain.head ?? "none"}${seal?.issued ? ` · sealed ${seal.issued}` : ""} — the same memory as last session iff these match`);
  if (rules.length) { lines.push(`  standing rules (${rules.length}):`); for (const r of rules) lines.push(`    rule: ${r.note ?? r.effect} (t${r.t})`); }
  if (prefs.length) { lines.push(`  preferences (${prefs.length}):`); for (const p of prefs) lines.push(`    preference: ${p.note ?? p.effect} (t${p.t})`); }
  if (lessons.length) { lines.push(`  lessons carried (${lessons.length}):`); for (const l of lessons.slice(0, 10)) lines.push(`    lesson: ${(l.note ?? l.effect).replace(/^lesson:\s*/i, "")} (t${l.t})`); }
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
  let lastUserIdx = -1; lines.forEach((o, i) => { if ((o.type === "user" || o.message.role === "user") && partText(o.message.content).trim()) lastUserIdx = i; });
  if (lastUserIdx < 0) return { user: "", assistant: "" };
  const user = partText(lines[lastUserIdx].message.content).trim();
  for (const o of lines.slice(lastUserIdx + 1)) if (o.type === "assistant" || o.message.role === "assistant") { const t = partText(o.message.content).trim(); if (t) assistants.push(t); }
  return { user, assistant: assistants.join(" ") };
};
const AMBIENT_SHAPES = [
  ["preference", "user", "agent", /\bI (?:prefer|like|want|always|never|don't want|hate)\b[^.!?\n]{3,120}/i, (m) => clip(m[0])],
  ["decision", "assistant", "project", /\b(?:we'll go with|we will go with|going with|decided (?:to|on)|let's use|we'll use|settled on)\b[^.!?\n]{3,120}/i, (m) => `Decision: ${clip(m[0])}`],
  ["lesson", "assistant", "agent", /\b(?:lesson|learned that|the fix was|root cause was|takeaway)\b[^\n]{3,160}/i, (m) => `Lesson: ${clip(m[0].replace(/^lesson:?\s*/i, ""), 160)}`],
];
export function extractAmbient(transcriptText) {
  const { user, assistant } = lastTurn(transcriptText);
  if (!user && !assistant) return [];
  if (instructionLike(user).length) return [];
  const out = [];
  const c = detectCorrection(user); if (c) out.push({ scope: "project", ...correctionEvent(c, user), tags: ["ambient", c.cue] });
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

// ---- Guard across every chat: a correction on the agent ledger binds in any project.
export function guardVerdict(action, { events, invariants = [] } = {}) {
  const led = events ? { events } : readEvents();
  const v = localCheck(led.events, action, invariants, { chain: verifyChain(), seal: verifyLocalSeal(led.events) });
  const ap = agentPath();
  if (existsSync(ap)) {
    const a = readEvents({ scope: "agent" });
    const av = localCheck(a.events, action, [], { chain: verifyChain(ap) });
    if (av.verdict === "blocked") { v.verdict = "blocked"; v.reasons = [...av.reasons.filter((r) => !/no recorded event/.test(r)).map((r) => r.replace(/\bledger t(\d+)/g, "agent ledger t$1").replace(/at t(\d+)/g, "at agent ledger t$1")), ...v.reasons]; }
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
  const r = setMode(want);
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
export function offlineBrief(led, events, { now = Date.now(), recent = 8 } = {}) {
  const lines = [`memory-pulse: engine unreachable — local render from ${events.length} events (corrections and recency only; no salience ranking)`];
  if (currentMode() === "agent" && existsSync(agentPath())) { const ib = identityBlock(readEvents({ scope: "agent" })); if (ib) lines.push(ib); }
  const hl = handoffLine(events, { now }); if (hl) lines.push(hl);
  const retired = supersededSet(events);
  const corr = events.filter((e) => e.kind === "correction" && !retired.has(e.t)).reverse().slice(0, 20);
  lines.push(`CORRECTIONS (${corr.length}) — read before quoting any number:`);
  for (const c of corr) lines.push(`  ! ${c.cause} -> ${c.effect} (t${c.t})${c.withdrawn?.length ? ` — withdrawn: ${c.withdrawn.join(", ")} → ${(c.replacement ?? []).join(", ") || "(no replacement recorded)"}` : ""}${c.note ? ` — ${String(c.note).slice(0, 120)}` : ""}`);
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
export function atRiskLines(events, { now = Date.now(), minBlocks = 2, blocks = readBlocks() } = {}) {
  if (!blocks.length) return "";
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
  const retired = supersededSet(events);
  const hay = `${operation} ${text}`.toLowerCase();
  const exact = events.filter((e) => e.kind === "correction" && !retired.has(e.t) && (e.withdrawn ?? []).some((w) => w && hay.includes(String(w).toLowerCase())));
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
export function extractHandoff(transcriptText, { maxAsks = 3, maxFiles = 6 } = {}) {
  const asks = [], files = []; let lastError = "", state = "";
  for (const line of String(transcriptText).split("\n")) {
    if (!line.trim()) continue; let o; try { o = JSON.parse(line); } catch { continue; }
    const m = o?.message; if (!m) continue;
    if (o.type === "user" || m.role === "user") {
      const txt = partText(m.content).trim(); if (txt) asks.push(txt.slice(0, 160));
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
    const transcript = typeof hook.transcript_path === "string" && existsSync(hook.transcript_path) ? readFileSync(hook.transcript_path, "utf8") : "";
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
const STOP = new Set(["a", "an", "the", "it", "its", "this", "that", "sure", "fine", "problem", "one", "thing", "same", "now", "here", "there", "yes", "no", "not", "just"]);
const term = (g) => { const v = g.find((x) => x != null); return v == null ? "" : String(v).replace(/[.,;:!?]+$/, "").trim(); };
const CORRECTION_SHAPES = [
  ["is-not", new RegExp(`\\b(?:is|are|was|were|be|called|named|=|:)\\s+${TERMU},?\\s+not\\s+${TERMU}`, "i"), (m) => ({ replacement: term(m.slice(1, 7)), withdrawn: term(m.slice(7, 13)) })],
  ["not-comma", new RegExp(`\\bnot\\s+${TERM}[^,;\\n]{0,40},\\s*(?:it's|it is|its|it should be|should be|rather|but|make it)\\s+${TERM}`, "i"), (m) => ({ withdrawn: term(m.slice(1, 7)), replacement: term(m.slice(7, 13)) })],
  ["change-to", new RegExp(`\\b(?:change|rename|replace|update|switch|correct)\\s+${TERM}\\s+(?:to|with|into)\\s+${TERM}`, "i"), (m) => ({ withdrawn: term(m.slice(1, 7)), replacement: term(m.slice(7, 13)) })],
  ["arrow", new RegExp(`${TERM2}\\s*(?:->|→|=>)\\s*${TERM2}`), (m) => ({ withdrawn: m[1].trim(), replacement: m[2].trim() })],
];
export function detectCorrection(prompt) {
  const p = String(prompt ?? ""); if (!p.trim()) return null;
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
  return { cause: `user-correction-${slug(d.withdrawn[0])}`, effect: `${slug(d.withdrawn[0])}-withdrawn-for-${slug(d.replacement[0])}`, kind: "correction", withdrawn: d.withdrawn, replacement: d.replacement, tags: ["ambient", d.cue], note: `User corrected "${d.withdrawn[0]}" to "${d.replacement[0]}" — prompt: "${String(prompt).replace(/\s+/g, " ").slice(0, 140)}"` };
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
    if (instructionLike(hook.prompt ?? "").length) { if (process.argv.includes("--verbose")) console.log("memory-pulse: prompt looks synthetic/instruction-like, skipped"); return; }
    const d = detectCorrection(hook.prompt ?? "");
    if (!d) { if (process.argv.includes("--verbose")) console.log("memory-pulse: no correction shape in this prompt"); return; }
    const r = appendEvent(correctionEvent(d, hook.prompt));
    if (process.argv.includes("--verbose") || r.written) console.log(r.written ? `memory-pulse: correction recorded (t=${r.t}) — "${d.withdrawn[0]}" withdrawn, "${d.replacement[0]}" replaces it; the guard enforces it from now on` : `memory-pulse: correction not recorded (${r.reason})`);
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
  try {
    const out = await callApi("/v1/pulse", { events, ...(tier ? { tier } : {}), ...(budget ? { budget } : {}) });
    process.stdout.write(loadedLine(led, events, { keyStatus: out.keyStatus, tier: out.tier ?? tier, chars: out.text?.length, budget }) + "\n");
    if (currentMode() === "agent" && existsSync(agentPath())) { const ib = identityBlock(readEvents({ scope: "agent" })); if (ib) process.stdout.write(ib + "\n"); }
    const hl = handoffLine(events); if (hl) process.stdout.write(hl + "\n");
    if (out.text) process.stdout.write(out.text + "\n");
    const risk = atRiskLines(events); if (risk) process.stdout.write(risk + "\n");
    if (Array.isArray(out.quarantined) && out.quarantined.length) {
      process.stdout.write(`⚠ ${out.quarantined.length} note(s) quarantined — instruction-like content was not rendered (t=${out.quarantined.map((q) => q.t).join(", ")})\n`);
    }
    const sd = sealDriftLine(out); if (sd) process.stdout.write(sd + "\n");
    const foot = telemetryFooter(out.telemetry);
    if (foot) process.stdout.write(foot + "\n");
  } catch (e) {
    // A dead network must not break session start — and must not hand it nothing: local render, labelled as such.
    process.stdout.write(`memory-pulse: brief unavailable (${String(e?.message ?? e).split(".")[0]})\n`);
    process.stdout.write(offlineBrief(led, events) + "\n");
  }
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
export function localCheck(events, action, invariants = [], opts = {}) {
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
        if (!term || !text.includes(term)) continue;
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
  if (text) for (const e of events) {
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
  else if (!evidence.length) { verdict = "no_evidence"; reasons.push(`no recorded event bears on this ${kind}; ${events.length} event(s) checked`); }
  else { verdict = "verified"; reasons.push(`${evidence.length} recorded event(s) bear on this ${kind}; none contradicted`); }
  const retiredT = supersededSet(events);
  const binding = events.filter((e) => e.kind === "correction" && Array.isArray(e.withdrawn) && e.withdrawn.length && !retiredT.has(e.t)).length;
  return { verdict, reasons, evidence: evidence.slice(0, 20), corrections, invariants: invHits, overrides, checked: { events: events.length, corrections: binding, invariants: invariants.length, action: kind, path: path || null } };
}
export const exitCodeFor = (verdict, { ci = false } = {}) => (verdict === "blocked" ? 2 : verdict === "no_evidence" && ci ? 1 : 0);

export function findViolations(events, text, filePath = "") {
  const hits = [];
  if (!text) return hits;
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
    for (const term of e.withdrawn) if (term && text.includes(term)) hits.push({ term, t: e.t, cause: e.cause, effect: e.effect, note: e.note ?? "", replacement: e.replacement ?? [] });
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
  let payload; try { payload = JSON.parse(raw); } catch { return; } // not a hook call: allow
  // Claude Code sends one file per Edit/Write; Codex sends one apply_patch
  // that may touch several. Either way: one check per file, its own path.
  const sections = patchSections(payload.tool_input);
  const actions = sections.length ? sections : [{ path: payload.tool_input?.file_path ?? "", text: textOfToolInput(payload.tool_input) }];
  const { events } = readEvents();
  const invariants = readInvariants();
  const blocked = [];
  for (const a of actions) {
    const v = guardVerdict({ kind: "edit", text: a.text, path: a.path }, { events, invariants });
    // no_evidence and verified pass SILENTLY here: a hook that warns on every
    // edit the ledger has nothing to say about livelocks the agent. The loud
    // form of no_evidence is `check --ci`.
    if (v.verdict === "blocked") blocked.push({ file: a.path, v });
  }
  if (!blocked.length) return;
  const lines = [];
  for (const { file, v } of blocked) {
    try { appendFileSync(violationsPath(), JSON.stringify({ at: new Date().toISOString(), file, hits: v.corrections.map((h) => ({ term: h.term, t: h.t })), invariants: v.invariants.map((i) => i.id) }) + "\n"); } catch { /* reporting is best effort */ }
    if (blocked.length > 1 || sections.length) lines.push(`  ${file || "(no path)"}:`);
    for (const r of v.reasons) if (!/^\d+ recorded event/.test(r)) lines.push(`  • ${r}`);
  }
  process.stderr.write(`memory-pulse guard: blocked.\n${lines.join("\n")}\nUse the corrected value (mentioning both old and new in a comparison is fine), record a new correction if the old one is wrong, or \`memory-pulse guard allow "<term>" --path <prefix> "<reason>"\` if this is a false block.\n`);
  process.exit(2);
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
  let v = localCheck(events, { kind, text, path }, invariants, { chain: verifyChain(), seal: verifyLocalSeal(events) });
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
  const { events } = readEvents();
  const corrections = events.filter((e) => e.kind === "correction");
  let blocks = [];
  try { blocks = readFileSync(violationsPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none yet */ }
  const byT = new Map();
  for (const b of blocks) for (const h of b.hits) byT.set(h.t, (byT.get(h.t) ?? 0) + 1);
  console.log(`memory-pulse report — ${corrections.length} corrections recorded, ${corrections.filter((c) => c.withdrawn?.length).length} with enforceable withdrawn terms`);
  console.log(`  edits blocked by the guard: ${blocks.reduce((n, b) => n + b.hits.length, 0)}${blocks.length ? ` (last: ${blocks[blocks.length - 1].at.slice(0, 10)})` : ""}`);
  const top = [...byT.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [t, n] of top) { const c = corrections.find((x) => x.t === t); console.log(`  ${n}× t${t} ${c ? `${c.cause} -> ${c.effect}` : ""} — withdrawn: ${c?.withdrawn?.join(", ")}`); }
  const unenforced = corrections.filter((c) => !c.withdrawn?.length);
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
  if (!JSON.stringify(pre).includes(GUARD)) { pre.push({ matcher: codex ? "Edit|Write|apply_patch" : "Edit|Write|MultiEdit", hooks: [{ type: "command", command: GUARD }] }); changed++; }
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
  console.log("PreCompact: what the session was doing is recorded before compaction and printed first at the next start.");
  if (process.argv.includes("--ambient")) console.log("UserPromptSubmit: a prompt shaped like a correction (\"X not Y\", \"change X to Y\", \"X -> Y\") is recorded with both terms; the guard enforces it.");
  if (codex) console.log("Codex runs no hook it has not been shown: open Codex, run /hooks, and trust the two memory-pulse entries (once per definition).");
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
  for (const f of files) {
    let text = ""; try { text = readFileSync(f, "utf8"); } catch { continue; }
    const v = localCheck(events, { kind: "lint", text, path: f }, invariants, { chain: verifyChain(), seal: verifyLocalSeal(events) });
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
  if (sub === "brief") { await cliBrief(); process.exit(0); }
  if (sub === "before") { await cliBefore(); process.exit(0); }
  if (sub === "install-hook") { cliInstallHook(); process.exit(0); }
  if (sub === "guard") { await cliGuard(); process.exit(0); }
  if (sub === "check") { await cliCheck(); process.exit(0); }
  if (sub === "handoff") { await cliHandoff(); process.exit(0); }
  if (sub === "ambient") { await cliAmbient(); process.exit(0); }
  if (sub === "mode") { await cliMode(); process.exit(0); }
  if (sub === "identity") { await cliIdentity(); process.exit(0); }
  if (sub === "observe") { await cliObserve(); process.exit(0); }
  if (sub === "verify") {
    // walk the row chain and check the ledger against the last seal; exit 2 on either failure (fail closed, like check)
    const chain = verifyChain(); const seal = verifyLocalSeal();
    if (process.argv.includes("--json")) { console.log(JSON.stringify({ chain, seal: { ok: seal.ok, reason: seal.reason ?? null, through: seal.seal?.through ?? null, events: seal.seal?.events ?? null, digest: seal.seal?.digest ?? null } }, null, 2)); process.exit(chain.ok && seal.ok !== false ? 0 : 2); }
    console.log(chain.ok ? `chain: OK — ${chain.chained} chained row(s)${chain.chained ? ` from t=${chain.from}` : ""}, ${chain.legacy} legacy row(s)${chain.sealed ? " sealed" : " (unsealed until the first chained write)"}${chain.head ? ` · head ${chain.head.slice(0, 12)}` : ""}${chain.unsealed ? ` · ${chain.unsealed} unsealed row(s) from an older writer (the next write seals them)` : ""}` : `chain: BROKEN — ${chain.reason}`);
    console.log(seal.ok === null ? `seal: none yet — ${seal.reason}` : seal.ok ? `seal: OK — engine-signed over ${seal.seal.events} row(s) through t=${seal.seal.through}${seal.seal.digest ? ` · ${seal.seal.digest.slice(0, 12)}` : ""}` : `seal: MISMATCH — ${seal.reason}`);
    process.exit(chain.ok && seal.ok !== false ? 0 : 2);
  }
  if (sub === "lint") { await cliLint(); process.exit(0); }
  if (sub === "report") { cliReport(); process.exit(0); }
  if (sub === "bench") { await cliBench(); process.exit(0); }
  if (sub === "stats") { await cliStats(); process.exit(0); }
  if (sub === "badge") { cliBadge(); process.exit(0); }
  if (sub && sub !== "serve") { console.error(`unknown command: ${sub} (try: brief, check, lint, guard, report, bench, stats, badge, install-hook [--codex] [--project])`); process.exit(1); }
  process.stderr.write(`memory-pulse: ledger ${ledgerPath()} — api ${API}\n`);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
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
