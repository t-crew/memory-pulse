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
import http from "node:http";
import https from "node:https";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, realpathSync } from "node:fs";
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

function readEvents() {
  const path = ledgerPath();
  if (!existsSync(path)) return { path, events: [] };
  const events = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s);
      if (typeof e.cause === "string" && typeof e.effect === "string") events.push(e);
    } catch { /* a torn line does not take the ledger down */ }
  }
  return { path, events };
}

// The engine's injection-through-memory list, mirrored so a refusal happens
// before the write. Keep in step with the engine; the engine is authoritative.
const INSTRUCTION_PATTERNS = [
  ["override", /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|all|earlier)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?)\b/i],
  ["persona", /\byou are now\b|\bfrom now on,? you\b|\bact as (an?|the) (system|admin|developer)\b/i],
  ["fake-role-tag", /<\/?\s*(system|assistant|tool|user|human|developer)\s*>|\[(system|assistant|tool)\s*:?\s*\]/i],
  ["system-prompt", /\b(reveal|print|show|dump)\b[^.\n]{0,30}\b(system prompt|hidden prompt|your instructions)\b/i],
  ["command-exec", /\b(run|execute|paste)\b[^.\n]{0,25}\b(this|the following)\b[^.\n]{0,15}\b(command|script|shell|code)\b/i],
  ["shell-pipe", /\b(curl|wget)\b[^\n]{0,120}\|\s*(sudo\s+)?(sh|bash|zsh)\b/i],
  ["destructive", /\b(rm\s+-rf\s+[\/~]|drop\s+table|truncate\s+table|format\s+c:)/i],
  ["secret-exfil", /\b(send|post|upload|exfiltrat\w*|leak)\b[^.\n]{0,40}\b(api[\s_-]?keys?|secrets?|tokens?|passwords?|credentials?)\b/i],
  ["hide-from-user", /\b(do not|don't|never)\b[^.\n]{0,20}\b(tell|show|mention|reveal)\b[^.\n]{0,20}\b(the )?(user|human|operator)\b/i],
];
export function instructionLike(text) {
  if (typeof text !== "string" || !text) return [];
  return INSTRUCTION_PATTERNS.filter(([, re]) => re.test(text)).map(([id]) => id);
}

function appendEvent({ cause, effect, note, kind, tags, pinned, withdrawn, replacement }) {
  // Instruction-like notes are refused at the write. The engine quarantines
  // them at read time too (and reports it), but a note that would be rendered
  // into every future session as an instruction should never reach the ledger.
  // Same deterministic list as the engine; no model in the loop.
  const hits = instructionLike(note);
  if (hits.length) return { written: false, reason: "instruction-like note refused", patterns: hits, hint: "Record what happened, not what to do. Rephrase as a finding." };
  const { path, events } = readEvents();
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
export function telemetryFooter(c) {
  const k = c?.counters;
  if (!k || !k.calls) return "";
  const drift = c.drift?.reasons?.length ? ` · ⚠ drift: ${c.drift.reasons.join("; ")}` : "";
  return `— memory-pulse · ${k.pulse} re-entries · ${k.correctionsSurfaced} corrections surfaced · ~${fmtK(k.tokensSavedEst)} tokens saved (est., signed)${drift}`;
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
  return new Promise((resolve, reject) => {
    const req = mod.request(u, {
      method: "POST", agent: false,
      headers: { ...headers, "content-length": Buffer.byteLength(payload), connection: "close" },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end(payload);
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
  body = { ...body, project: projectName(), ...(prior ? { telemetry: prior } : {}) };
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
        tier: { type: "string", enum: TIERS, description: "index (smallest) → full. Default brief." },
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
        withdrawn: { type: "array", items: { type: "string" }, description: "For corrections: the exact strings that were withdrawn (a number, a name, a claim). The guard hook blocks an edit that writes them back." },
        replacement: { type: "array", items: { type: "string" }, description: "For corrections: the corrected value(s). An edit containing both a withdrawn term and a replacement (a comparison or disavowal) is allowed through the guard." },
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

  if (name === "pulse") return callApi("/v1/pulse", { events, tier: args.tier, root: args.root });
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
      serverInfo: { name: "memory-pulse", version: "0.1.9" },
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
async function cliBrief() {
  const { events } = readEvents();
  if (!events.length) return;
  try {
    const out = await callApi("/v1/pulse", { events, tier: process.env.MEMORY_PULSE_BRIEF_TIER || "brief" });
    if (out.text) process.stdout.write(out.text + "\n");
    if (Array.isArray(out.quarantined) && out.quarantined.length) {
      process.stdout.write(`⚠ ${out.quarantined.length} note(s) quarantined — instruction-like content was not rendered (t=${out.quarantined.map((q) => q.t).join(", ")})\n`);
    }
    const foot = telemetryFooter(out.telemetry);
    if (foot) process.stdout.write(foot + "\n");
  } catch (e) {
    // A dead network must not break session start — say so in one line.
    process.stdout.write(`memory-pulse: brief unavailable (${String(e?.message ?? e).split(".")[0]})\n`);
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
export function findViolations(events, text, filePath = "") {
  const hits = [];
  if (!text) return hits;
  // The ledger and its sidecars are where corrections are RECORDED; guarding
  // them would block the act of correcting.
  if (/(^|[\\/])\.memory-pulse([\\/]|$)/.test(filePath)) return hits;
  for (const e of events) {
    if (e.kind !== "correction" || !Array.isArray(e.withdrawn)) continue;
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
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload; try { payload = JSON.parse(raw); } catch { return; } // not a hook call: allow
  const text = textOfToolInput(payload.tool_input);
  const { events } = readEvents();
  const file = payload.tool_input?.file_path ?? "";
  const hits = findViolations(events, text, file);
  if (!hits.length) return;
  try { appendFileSync(violationsPath(), JSON.stringify({ at: new Date().toISOString(), file, hits: hits.map((h) => ({ term: h.term, t: h.t })) }) + "\n"); } catch { /* reporting is best effort */ }
  const lines = hits.map((h) => `  • "${h.term}" was withdrawn at ledger t${h.t} (${h.cause} -> ${h.effect})${h.note ? `: ${h.note}` : ""}${h.replacement?.length ? ` — use ${h.replacement.join(" / ")}` : ""}`);
  process.stderr.write(`memory-pulse guard: this edit reintroduces a withdrawn value.\n${lines.join("\n")}\nUse the corrected value (mentioning both old and new in a comparison is fine), or record a new correction if the old one is wrong.\n`);
  process.exit(2);
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
  const enforceable = corrections.filter((c) => c.withdrawn?.length);
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
  const project = process.argv.includes("--project");
  const home = process.env.MEMORY_PULSE_SETTINGS_DIR || (project ? join(process.cwd(), ".claude") : join(process.env.HOME || "", ".claude"));
  const file = join(home, "settings.json");
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
  if (!JSON.stringify(pre).includes(GUARD)) { pre.push({ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: GUARD }] }); changed++; }
  if (!changed) { console.log("hooks already installed — nothing to do"); return; }
  mkdirSync(home, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  console.log(`installed ${changed} hook(s) in ${file}`);
  console.log("SessionStart: every session re-enters through the ledger automatically.");
  console.log("PreToolUse (Edit/Write): an edit that writes back a withdrawn value is blocked and explained.");
  console.log(project ? "Project-scoped: commit .claude/settings.json and every clone is guarded." : "Tip: `install-hook --project` writes the hooks into this repo so teammates inherit them.");
  console.log("Remove either by deleting the memory-pulse entries from hooks.");
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
  if (sub === "install-hook") { cliInstallHook(); process.exit(0); }
  if (sub === "guard") { await cliGuard(); process.exit(0); }
  if (sub === "report") { cliReport(); process.exit(0); }
  if (sub === "bench") { await cliBench(); process.exit(0); }
  if (sub === "stats") { await cliStats(); process.exit(0); }
  if (sub === "badge") { cliBadge(); process.exit(0); }
  if (sub && sub !== "serve") { console.error(`unknown command: ${sub} (try: brief, guard, report, bench, stats, badge, install-hook)`); process.exit(1); }
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
