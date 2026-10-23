// Soul mode recall (2026-10-21): each prompt brings back the agent's own lessons and memories that bear on it, ranked by BM25 with a floor.
// Why BM25: the pre-registered known-item benchmark on 219 real memory notes (engine docs/plans/2026-10-21-soul-as-state.md) read BM25 MRR
// 0.971 / 0.907 against 0.864 / 0.774 for word overlap; the decision rule chose BM25.
// Written before the code.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mp-soulrecall-"))), work = join(home, "work"); mkdirSync(join(work, ".memory-pulse"), { recursive: true });
  const env = { ...process.env, HOME: home, MEMORY_PULSE_LEDGER: join(work, ".memory-pulse", "events.jsonl"), MEMORY_PULSE_AGENT: join(home, ".memory-pulse", "agent", "events.jsonl"),
                MEMORY_PULSE_SETTINGS_DIR: join(home, ".claude"), MEMORY_PULSE_API: "http://127.0.0.1:9", CI: "1" };
  for (const k of ["MEMORY_PULSE_KEY", "MEMORY_PULSE_MODE", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  return { home, work, env };
}
const run = (f, args, input, extra = {}) => { const r = spawnSync(process.execPath, [SERVER, ...args], { cwd: f.work, env: { ...f.env, ...extra }, input: input ?? "", encoding: "utf8" }); return { code: r.status, out: r.stdout, all: r.stdout + r.stderr }; };
const prompt = (f, text) => { const r = run(f, ["prompt"], JSON.stringify({ session_id: "p1", cwd: f.work, hook_event_name: "UserPromptSubmit", prompt: text })); return r.out ? JSON.parse(r.out).hookSpecificOutput.additionalContext : ""; };
function seed(f, mode) {
  run(f, ["mode", mode]);
  for (const note of ["Lesson: a kill needs a positive control through the same path, or it is not a kill.", "Lesson: GitHub push protection refuses a published test key; assemble fixture secrets at run time.",
                      "Lesson: one randomization seed cannot tell bias from noise; run twelve."]) run(f, ["remember", "lesson", note.slice(8, 30), "--scope", "agent", "--tags", "lesson", "--note", note]);
  run(f, ["remember", "memory", "casmi-deadline", "--scope", "agent", "--tags", "memory", "--note", "The CASMI deadline is 2026-12-14."]);
}

test("recall ranks by BM25 and keeps only what clears the floor", async () => {
  const { recall } = await import("../lib/recall.mjs");
  const rows = [{ t: 1, note: "a kill needs a positive control through the same path" }, { t: 2, note: "push protection refuses a published test key" }, { t: 3, note: "the CASMI deadline is 2026-12-14" }];
  assert.deepEqual(recall(rows, "can I kill this model without a positive control?").map((r) => r.t), [1]);
  assert.deepEqual(recall(rows, "when is the casmi deadline").map((r) => r.t), [3]);
  assert.deepEqual(recall(rows, "make the landing page blue").map((r) => r.t), []);
});

test("in soul mode the prompt brings back the agent's own lessons and memories that bear on it, and nothing for an unrelated prompt", () => {
  const f = fixture(); seed(f, "soul");
  const a = prompt(f, "should I kill this model without a positive control?"); assert.match(a, /from the agent's own memory/); assert.match(a, /positive control through the same path/); assert.match(a, /agent t\d+/);
  assert.doesNotMatch(a, /push protection/);
  assert.match(prompt(f, "when is the CASMI deadline again"), /2026-12-14/);
  assert.equal(prompt(f, "make the landing page blue"), "");
});

test("agent mode keeps the prompt slice it had: no recall of lessons", () => {
  const f = fixture(); seed(f, "agent");
  assert.doesNotMatch(prompt(f, "should I kill this model without a positive control?"), /from the agent's own memory/);
});
