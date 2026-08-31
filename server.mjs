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
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = (process.env.MEMORY_PULSE_API ?? "https://memory-pulse.strategic-innovations.workers.dev").replace(/\/$/, "");
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

function appendEvent({ cause, effect, note, kind, tags, pinned }) {
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
function telemetryFooter(c) {
  const k = c?.counters;
  if (!k || !k.calls) return "";
  return `— memory-pulse · ${k.pulse} re-entries · ${k.correctionsSurfaced} corrections surfaced · ~${fmtK(k.tokensSavedEst)} tokens saved (est., signed)`;
}

// ------------------------------------------------------------------- api ----
async function callApi(route, body) {
  const prior = readTelemetry();
  body = { ...body, project: projectName(), ...(prior ? { telemetry: prior } : {}) };
  let res;
  try {
    res = await fetch(`${API}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(KEY ? { "x-mp-key": KEY } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      "memory-pulse API unreachable. `remember` still works (it writes locally); " +
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
      "chain (pulse), or when a link was strongest (when). Returns nothing rather than guessing " +
      "when the answer is not confident enough.",
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
      serverInfo: { name: "memory-pulse", version: "0.1.5" },
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
    const res = await fetch(`${API}/v1/verify-telemetry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telemetry: c }) });
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

// `npx memory-pulse install-hook` — make re-entry automatic: a Claude Code
// SessionStart hook that runs the brief. Idempotent; merges, never clobbers.
function cliInstallHook() {
  const home = process.env.MEMORY_PULSE_SETTINGS_DIR || join(process.env.HOME || "", ".claude");
  const file = join(home, "settings.json");
  let settings = {};
  if (existsSync(file)) {
    try { settings = JSON.parse(readFileSync(file, "utf8")); }
    catch { console.error(`refusing to touch ${file}: it is not valid JSON`); process.exit(1); }
  }
  const CMD = "npx -y memory-pulse brief";
  settings.hooks = settings.hooks || {};
  const list = (settings.hooks.SessionStart = settings.hooks.SessionStart || []);
  const present = JSON.stringify(list).includes(CMD);
  if (present) { console.log("hook already installed — nothing to do"); return; }
  list.push({ hooks: [{ type: "command", command: CMD }] });
  mkdirSync(home, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  console.log(`installed SessionStart hook in ${file}`);
  console.log("Every Claude Code session now re-enters through the ledger automatically.");
  console.log("Remove it any time by deleting the memory-pulse entry from hooks.SessionStart.");
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
  if (sub === "stats") { await cliStats(); process.exit(0); }
  if (sub === "badge") { cliBadge(); process.exit(0); }
  if (sub && sub !== "serve") { console.error(`unknown command: ${sub} (try: brief, stats, badge, install-hook)`); process.exit(1); }
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
