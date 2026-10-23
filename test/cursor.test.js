// Cursor (2026-10-21): hooks exist since Cursor 1.7 (cursor.com/docs/agent/hooks, read 2026-10-21), so memory-pulse runs there like on
// Claude Code: guard on preToolUse (failClosed, JSON permission on every call, because Cursor blocks on missing or invalid output),
// brief on sessionStart (additional_context), capture on postToolUse / postToolUseFailure, consolidate on stop and sessionEnd.
// One normalizer maps Cursor's payload (conversation_id, Shell / Write / Read, stringified tool_output) onto the shape the rest reads.
// Also for every host: capture records a tool call once (tool_use_id), and an exit code in tool_response decides a Codex command.
// Written before the adapter.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";

const fixture = () => { const home = realpathSync(mkdtempSync(join(tmpdir(), "mp-cursor-"))), work = join(home, "work"); mkdirSync(join(work, ".memory-pulse"), { recursive: true }); return { home, work }; };
const run = (f, args, stdin, extra = {}) => new Promise((resolve) => {
  const env = { ...process.env, HOME: f.home, MEMORY_PULSE_LEDGER: join(f.work, ".memory-pulse", "events.jsonl"), MEMORY_PULSE_AGENT: join(f.home, "agent.jsonl"), MEMORY_PULSE_API: "http://127.0.0.1:9", ...extra };
  delete env.MEMORY_PULSE_KEY;
  const p = spawn(process.execPath, [SERVER, ...args], { cwd: f.work, env });
  let out = "", err = ""; p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c)); p.on("close", (code) => resolve({ code, out, err, all: out + err }));
  p.stdin.end(stdin ?? "");
});
const cur = (f, event, extra) => JSON.stringify({ conversation_id: "conv-1", generation_id: "g-1", hook_event_name: event, cursor_version: "2.4.0", workspace_roots: [f.work], ...extra });
const episode = (f, sid) => { const p = join(f.work, ".memory-pulse", "episodes", `${sid}.jsonl`); return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };

test("guard on Cursor answers JSON on every call: allow when clean, deny with the reason when a withdrawn term comes back", async () => {
  const f = fixture();
  await run(f, ["remember", "price", "corrected", "--kind", "correction", "--withdrawn", "$49", "--replacement", "$29"]);
  const clean = await run(f, ["guard", "--host", "cursor"], cur(f, "preToolUse", { tool_name: "Write", tool_input: { file_path: join(f.work, "a.md"), contents: "the plan is $29" }, tool_use_id: "t1", cwd: f.work }));
  assert.equal(clean.code, 0); assert.deepEqual(JSON.parse(clean.out), { permission: "allow" });
  const bad = await run(f, ["guard", "--host", "cursor"], cur(f, "preToolUse", { tool_name: "Write", tool_input: { file_path: join(f.work, "a.md"), contents: "the plan is $49" }, tool_use_id: "t2", cwd: f.work }));
  assert.equal(bad.code, 0); const d = JSON.parse(bad.out);
  assert.equal(d.permission, "deny"); assert.match(d.user_message, /\$49/); assert.match(d.agent_message, /\$29/);
  const shell = await run(f, ["guard", "--host", "cursor"], cur(f, "preToolUse", { tool_name: "Shell", tool_input: { command: "echo 'the plan is $49' > a.md", working_directory: f.work }, tool_use_id: "t3", cwd: f.work }));
  assert.equal(JSON.parse(shell.out).permission, "deny", "a shell write is checked as an edit, as on Claude Code");
  const junk = await run(f, ["guard", "--host", "cursor"], "not json");
  assert.deepEqual(JSON.parse(junk.out), { permission: "allow" }, "even unreadable input gets valid JSON (Cursor blocks on none)");
});

test("capture on Cursor maps conversation_id, Shell and the stringified tool_output; consolidate reads Cursor's stop and sessionEnd", async () => {
  const f = fixture();
  await run(f, ["capture", "--host", "cursor"], cur(f, "postToolUseFailure", { tool_name: "Shell", tool_input: { command: "npm test" }, tool_use_id: "u1", cwd: f.work, error_message: "Exit code 1\n✖ adds tax" }));
  await run(f, ["capture", "--host", "cursor"], cur(f, "postToolUse", { tool_name: "Write", tool_input: { file_path: join(f.work, "tax.js"), contents: "x" }, tool_output: JSON.stringify({ success: true }), tool_use_id: "u2", cwd: f.work, duration: 12 }));
  await run(f, ["capture", "--host", "cursor"], cur(f, "postToolUse", { tool_name: "Shell", tool_input: { command: "npm test" }, tool_output: JSON.stringify({ output: "ℹ pass 4\nℹ fail 0", exitCode: 0 }), tool_use_id: "u3", cwd: f.work, duration: 900 }));
  const e = episode(f, "conv-1").filter((r) => r.kind === "observation");
  assert.deepEqual(e.map((r) => [r.obs.op, r.obs.ok]), [["run", false], ["edit", true], ["run", true]]);
  await run(f, ["consolidate", "--host", "cursor"], cur(f, "stop", { status: "completed", loop_count: 0 }));
  const led = readFileSync(join(f.work, ".memory-pulse", "events.jsonl"), "utf8");
  assert.match(led, /passed after editing tax\.js/);
});

test("brief on Cursor's sessionStart returns additional_context", async () => {
  const f = fixture();
  await run(f, ["remember", "price", "corrected", "--kind", "correction", "--withdrawn", "$49", "--replacement", "$29"]);
  const r = await run(f, ["brief", "--host", "cursor"], cur(f, "sessionStart", { session_id: "s-1", is_background_agent: false, composer_mode: "agent" }));
  const d = JSON.parse(r.out); assert.match(d.additional_context, /\$49/);
});

test("install-hook --cursor writes a version-1 hooks.json with a fail-closed guard, once", async () => {
  const f = fixture();
  await run(f, ["install-hook", "--cursor"]); const again = await run(f, ["install-hook", "--cursor"]);
  assert.match(again.out, /already installed/);
  const h = JSON.parse(readFileSync(join(f.home, ".cursor", "hooks.json"), "utf8"));
  assert.equal(h.version, 1);
  const guard = h.hooks.preToolUse.find((x) => /memory-pulse guard --host cursor/.test(x.command)); assert.ok(guard); assert.equal(guard.failClosed, true);
  for (const ev of ["sessionStart", "postToolUse", "postToolUseFailure", "stop", "sessionEnd"]) assert.ok((h.hooks[ev] ?? []).some((x) => /memory-pulse/.test(x.command)), ev);
  assert.ok(h.hooks.sessionEnd.some((x) => /consolidate --final --host cursor/.test(x.command)));
});

test("every host: a tool call is captured once; an exit code in tool_response decides a command (Codex)", async () => {
  const f = fixture();
  const p = JSON.stringify({ session_id: "s9", cwd: f.work, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "same", tool_input: { command: "npm test" }, tool_response: { stdout: "", exit_code: 1 } });
  await run(f, ["capture"], p); await run(f, ["capture"], p);
  const e = episode(f, "s9").filter((r) => r.kind === "observation");
  assert.equal(e.length, 1, "the same tool_use_id twice (two hosts reading one settings file) is one observation");
  assert.equal(e[0].obs.ok, false); assert.equal(e[0].obs.exit, 1);
});

test("review: the Cursor guard answers JSON even when stdin is the JSON value null or another non-object", async () => {
  const f = fixture();
  for (const input of ["null", "[]", "42", "\"x\""]) { const r = await run(f, ["guard", "--host", "cursor"], input); assert.deepEqual(JSON.parse(r.out), { permission: "allow" }, input); }
});

test("review: a check failed by its exit code alone (Codex, Cursor) keeps the runner's specific error", async () => {
  const f = fixture();
  await run(f, ["capture"], JSON.stringify({ session_id: "x1", cwd: f.work, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "e1", tool_input: { command: "npm test" }, tool_response: { stdout: "✖ adds tax (2 ms)\nℹ fail 1", stderr: "", exit_code: 1 } }));
  await run(f, ["capture", "--host", "cursor"], cur(f, "postToolUse", { tool_name: "Shell", tool_input: { command: "npm test" }, tool_output: JSON.stringify({ output: "✖ rounds refunds\nℹ fail 1", exitCode: 1 }), tool_use_id: "e2", cwd: f.work }));
  const errs = [...episode(f, "x1"), ...episode(f, "conv-1")].filter((r) => r.obs?.op === "run").map((r) => r.obs.err);
  assert.match(errs[0], /adds tax/); assert.match(errs[1], /rounds refunds/);
});
