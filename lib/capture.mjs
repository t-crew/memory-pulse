// Automatic capture (2026-10-21, phase 1): memory-pulse records what the agent did with no model calls and no network, then turns it
// into findings that point at their evidence. Tests: test/capture.test.js.
//
//   capture      PostToolUse / PostToolUseFailure hook (installed async: a tool call never waits for it). One compact observation per
//                tool call into the session's episode, .memory-pulse/episodes/<session>.jsonl, chained like every ledger: an edit
//                (path, lines added and removed), a command (secrets scrubbed, a leading `cd ... &&` dropped, ok or failed with its exit
//                code and first error line), a read (path), any other tool (its name). Tool output is never stored, only its outcome;
//                error text that reads like an instruction is withheld.
//   consolidate  Stop / PreCompact hook, and SessionEnd with --final. A command that failed and later passed becomes a fix finding
//                (what failed, the files edited in between); a command whose last run failed becomes an open thread, retired by the
//                fix that follows it. --final adds a session summary and exports the episode as a .rain capsule. Every finding
//                carries evidence {episode, rows, head} (named apart from `origin`, which .rain merges use): the episode rows it rests on and the chain head after them, so anyone holding
//                the capsule can check the evidence without a key. Each finding is written once (capture_key).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";

const SECRET = [
  [/\b(?:mp_live_|sk-|sk_live_|rk_live_|ghp_|gho_|ghs_|github_pat_|xox[abposr]-|AKIA|ASIA|AIza|glpat-|npm_)[A-Za-z0-9_\-]{8,}/g, "<secret>"],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=\-]{12,}/gi, "$1 <secret>"],
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?)[A-Za-z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1<secret>"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, "$1<secret>@"],
  [/(--?(?:password|token|secret|api-key|apikey|key)[= ]+)\S+/gi, "$1<secret>"],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "<secret>"],
];
export const scrub = (s) => SECRET.reduce((t, [re, to]) => t.replace(re, to), String(s ?? ""));
const one = (s, n = 160) => { const v = String(s ?? "").replace(/\s+/g, " ").trim(); return v.length > n ? v.slice(0, n - 1) + "…" : v; };
const show = (p, cwd) => { if (!p) return ""; const a = isAbsolute(p) ? p : join(cwd, p); return a.startsWith(cwd + "/") ? relative(cwd, a) : a.startsWith(homedir()) ? "~" + a.slice(homedir().length) : a; };
export const commandKey = (cmd) => one(scrub(String(cmd ?? "").replace(/^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/, "")), 200);
const EDIT = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch"]);

export const episodeDir = (ledger) => join(dirname(ledger), "episodes");
export const episodePath = (ledger, session) => join(episodeDir(ledger), `${String(session ?? "session").replace(/[^\w.-]/g, "_").slice(0, 80)}.jsonl`);

function lineCounts(resp, input) {
  const patch = Array.isArray(resp?.structuredPatch) ? resp.structuredPatch : [];
  let added = 0, removed = 0;
  for (const h of patch) for (const l of h.lines ?? []) { if (l.startsWith("+")) added++; else if (l.startsWith("-")) removed++; }
  if (!patch.length && typeof input?.content === "string") added = input.content.split("\n").length;
  return { added, removed };
}

function firstError(text, instructionLike) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => !/^Exit code \d+$/i.test(l));
  const pick = lines.find((l) => /✖|✗|\berror\b|\bfail(?:ed|ure)?\b|traceback|exception|assert|panic|cannot|not found|denied/i.test(l)) ?? lines[0] ?? "";
  const v = one(scrub(pick));
  return v && instructionLike(v).length ? "(error text withheld: it reads like an instruction)" : v;
}

/** The observation one hook call carries, or null. Pure: no IO. */
export function observe(hook, { instructionLike }) {
  const ev = hook?.hook_event_name, name = hook?.tool_name, input = hook?.tool_input ?? {}, cwd = hook?.cwd || process.cwd();
  if ((ev !== "PostToolUse" && ev !== "PostToolUseFailure") || typeof name !== "string") return null;
  const failed = ev === "PostToolUseFailure" || hook?.tool_response?.interrupted === true;
  const at = new Date().toISOString();
  if (EDIT.has(name)) {
    const path = show(input.file_path ?? input.notebook_path ?? hook?.tool_response?.filePath ?? "", cwd);
    return { op: "edit", target: path, obs: { op: "edit", path, ...lineCounts(hook.tool_response, input), ok: !failed, ...(failed ? { err: firstError(hook.error, instructionLike) } : {}), at } };
  }
  if (name === "Bash") {
    const cmd = commandKey(input.command), exit = failed ? Number((/Exit code (\d+)/i.exec(String(hook.error ?? "")) ?? [])[1] ?? 1) : 0;
    const interrupted = hook?.is_interrupt === true || hook?.tool_response?.interrupted === true;
    return { op: "run", target: cmd, obs: { op: "run", cmd, ok: !failed, exit, ...(interrupted ? { interrupted: true } : {}), ...(failed ? { err: firstError(hook.error ?? hook?.tool_response?.stderr, instructionLike) } : {}), at } };
  }
  if (name === "Read") { const path = show(input.file_path ?? "", cwd); return { op: "read", target: path, obs: { op: "read", path, ok: !failed, at } }; }
  if (name === "Grep" || name === "Glob" || name === "TodoWrite") return null;          // searches and to-do lists say little later
  return { op: "tool", target: one(name, 80), obs: { op: "tool", name: one(name, 80), ok: !failed, at } };
}

export function cliCapture(core) {
  try {
    let raw = ""; try { raw = readFileSync(0, "utf8"); } catch { /* no stdin */ }
    let hook; try { hook = JSON.parse(raw); } catch { return 0; }
    const o = observe(hook, core); if (!o) return 0;
    const path = episodePath(core.ledgerPath(), hook.session_id); mkdirSync(dirname(path), { recursive: true });
    core.chainAppend(path, { cause: o.op, effect: o.target || o.op, kind: "observation", tags: ["capture", o.op], obs: o.obs });
  } catch { /* a capture hook never fails a tool call */ }
  return 0;
}

const readRows = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

/** Findings an episode supports. Pure over the episode rows. */
export function findings(rows, session) {
  const obs = rows.filter((r) => r.kind === "observation" && r.obs);
  const out = [], lastFail = new Map(), editsSince = new Map(), lastRun = new Map();
  for (const r of obs) {
    const o = r.obs;
    if (o.op === "edit" && o.ok) for (const [k, list] of editsSince) list.push(r);
    if (o.op !== "run" || !o.cmd) continue;
    lastRun.set(o.cmd, r);
    if (!o.ok && !o.interrupted) { if (!lastFail.has(o.cmd)) { lastFail.set(o.cmd, r); editsSince.set(o.cmd, []); } continue; }
    if (o.ok && lastFail.has(o.cmd)) {
      const f = lastFail.get(o.cmd), edits = editsSince.get(o.cmd), files = [...new Set(edits.map((e) => e.obs.path).filter(Boolean))];
      out.push({ type: files.length ? "fix" : "flaky", cmd: o.cmd, key: `${session}|fix|${o.cmd}|${f.t}`,
                 cause: `\`${o.cmd}\` failed: ${f.obs.err || `exit ${f.obs.exit}`}`,
                 effect: files.length ? `passed after editing ${files.slice(0, 4).join(", ")}${files.length > 4 ? ` and ${files.length - 4} more` : ""}` : "passed on a re-run with no edits in between (flaky?)",
                 rows: [f, ...edits, r] });
      lastFail.delete(o.cmd); editsSince.delete(o.cmd);
    }
  }
  for (const [cmd, f] of lastFail) if (lastRun.get(cmd) === f || !lastRun.get(cmd)?.obs.ok)
    out.push({ type: "open", cmd, key: `${session}|open|${cmd}`, cause: `\`${cmd}\` still failing`, effect: f.obs.err || `exit ${f.obs.exit}`, rows: [f] });
  return out;
}

export function sessionSummary(rows, session) {
  const obs = rows.filter((r) => r.kind === "observation" && r.obs);
  const files = [...new Set(obs.filter((r) => r.obs.op === "edit" && r.obs.ok).map((r) => r.obs.path))];
  const runs = obs.filter((r) => r.obs.op === "run"), failed = runs.filter((r) => !r.obs.ok).length;
  return { key: `${session}|session`, cause: `session ${String(session).slice(0, 12)}`,
           effect: `edited ${files.length} file${files.length === 1 ? "" : "s"}${files.length ? ` (${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""})` : ""}; ran ${runs.length} command${runs.length === 1 ? "" : "s"}, ${failed} failed`,
           rows: obs.length ? [obs[0], obs.at(-1)] : [] };
}

export function cliConsolidate(argv, core) {
  try {
    let raw = ""; try { raw = readFileSync(0, "utf8"); } catch { /* no stdin */ }
    let hook = {}; try { hook = raw.trim() ? JSON.parse(raw) : {}; } catch { hook = {}; }
    const session = hook.session_id; if (!session) return 0;
    const path = episodePath(core.ledgerPath(), session); const rows = readRows(path); if (!rows.length) return 0;
    const events = core.readEvents().events, have = new Set(events.map((e) => e.capture_key).filter(Boolean));
    const openRow = new Map(events.filter((e) => (e.tags ?? []).includes("open") && e.capture_key?.startsWith(`${session}|open|`)).map((e) => [e.capture_key.split("|").slice(2).join("|"), e.t]));
    const evidence = (rs) => ({ episode: session, rows: rs.map((r) => r.t), head: rs.at(-1)?.hash ?? null });
    let n = 0;
    for (const f of findings(rows, session)) {
      if (have.has(f.key)) continue;
      const supersedes = f.type !== "open" ? openRow.get(f.cmd) : undefined;
      const r = core.appendEvent({ cause: f.cause, effect: f.effect, kind: "event", tags: ["captured", f.type, ...(f.type === "fix" ? ["decision"] : [])],
                                   ...(supersedes ? { supersedes } : {}), fields: { capture_key: f.key, evidence: evidence(f.rows) } });
      if (r.written) n++;
    }
    if (argv.includes("--final")) {
      const s = sessionSummary(rows, session);
      if (!have.has(s.key)) { const r = core.appendEvent({ cause: s.cause, effect: s.effect, kind: "event", tags: ["captured", "session"], fields: { capture_key: s.key, evidence: evidence(s.rows) } }); if (r.written) n++; }
      const b = core.buildCapsule({ ledger: path, scope: "episode" });
      if (b.capsule) writeFileSync(path.replace(/\.jsonl$/, ".rain"), JSON.stringify(b.capsule, null, 2) + "\n");
    }
    if (n && argv.includes("--verbose")) console.log(`memory-pulse: ${n} finding(s) from this session`);
  } catch { /* a consolidate hook never blocks a stop, a compaction or an exit */ }
  return 0;
}
