// Making the memory a help, not noise (2026-10-22). Measured on one real session (Blue, 2026-10-21/22) before any code:
//  - every CASMI file written got 23-34 corrections from the estate ledger, all through slug words alone ("return", "public", "every",
//    "test" summed over a 300-word file), and one agent correction on every file because the agent ledger's 108 rows make any word rare;
//  - all 7 agent-memory lines injected on 7 real prompts were noise: a single shared word on a short prompt ("soul", "memory", "casmi"),
//    two generic words on a long one, and 11 of 12 "preferences" were one-off requests ambient capture saved ("i want you to find ...");
//  - the brief carried a handoff from 2026-10-04, 511 rows stale, because its dates are written "2026-10-04 04:30 UTC", not ISO;
//  - the over-cap note said the engine text was over the cap when the identity block put it over, and four full-length rules
//    (600-1,200 chars each) left the project sections a few lines;
//  - two memory-pulse briefs (plugin and settings) each printed the identity block in the same session.
// Fixture terms are invented: a real withdrawn term in this file would (rightly) be blocked by the guard. Written before the code.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SERVER = new URL("../server.mjs", import.meta.url).pathname;
const load = async (tag) => {
  const dir = mkdtempSync(join(tmpdir(), "mphelp-")); const ledger = join(dir, "events.jsonl"); writeFileSync(ledger, "");
  delete process.env.MEMORY_PULSE_MODE; process.env.MEMORY_PULSE_LEDGER = ledger; process.env.MEMORY_PULSE_AGENT = join(dir, "agent", "events.jsonl");
  return import("../server.mjs?" + tag + "=" + Date.now());
};
const corr = (t, withdrawn, replacement = [], extra = {}) => ({ t, cause: `c${t}`, effect: `e${t}`, kind: "correction", withdrawn, replacement, ...extra });
const filler = (n, from = 100) => Array.from({ length: n }, (_, i) => ({ t: from + i, cause: `row-${i}-alpha`, effect: `row-${i}-beta`, kind: "event", note: `row ${i}` }));

// ---- 1. write-time context: a correction bears on an edit through its terms (text or path) or its slug words in the PATH, not the text
test("editSlice: slug words shared with a long file's text do not attach a correction; its terms in the text, or its slug words in the path, do", async () => {
  const { editSlice } = await load("edit-slug");
  const rows = [...filler(400), corr(1, ["widget lane is closed"], [], { cause: "no-account-try-route", effect: "try-route-deployed-public-every-return" }),
                corr(2, ["Zephyrline 0.731"], ["Zephyrline 0.712"], { cause: "zephyrline-score", effect: "score-corrected" }),
                corr(3, ["quartz-gate"], [], { cause: "submit-one-guard", effect: "submit-one-refuses-repeat" })];
  const text = "def test_build():\n    # every public read must return the same rows; deployed or not, the test checks the try route\n" + "x = 1\n".repeat(200);
  assert.equal(editSlice(rows, [], { path: "kaggle/theirs/test_build.py", text }), "", "slug words in the text alone are noise");
  assert.match(editSlice(rows, [], { path: "notes.md", text: "the board read Zephyrline 0.731 yesterday" }), /"Zephyrline 0\.731" was withdrawn/, "a withdrawn term in the text still shows");
  // EDITED after the first run with code (stated): the path was submit_one.py, one slug word scoring ln(403) = 5.999 against the bar of 6, a
  // fixture on the boundary by accident; two of the correction's slug words in the path is what the assertion means
  assert.match(editSlice(rows, [], { path: "kaggle/daily/submit_guard.py", text: "x = 1" }), /"quartz-gate" was withdrawn \(t3\)/, "slug words in the path still show");
});

test("editSlice: a small agent ledger's slug words no longer attach its corrections to every file", async () => {
  const { editSlice } = await load("edit-agent");
  const agentRows = [corr(102, ["best board score is 0.111"], ["best board score is 0.222"], { cause: "casmi-team-best-score", effect: "crew-current-team-leaderboard-score-read" })];
  assert.equal(editSlice([], [], { path: "kaggle/theirs_v22_c3/build.py", text: "the casmi read scores the team's best board result" }, { agentRows }), "");
  assert.match(editSlice([], [], { path: "notes.md", text: "best board score is 0.111" }, { agentRows }), /agent t102/);
});

// ---- 2. prompt recall: two matched words, one rare, covering a quarter of the prompt; one-off requests are not standing preferences
test("recall: one shared word is not enough, even on a short prompt; two words covering a quarter of the prompt are", async () => {
  const { recall } = await import("../lib/recall.mjs?floor=" + Date.now());
  const rows = [{ t: 1, note: "i like the soul as state, lets try running all three" }, { t: 2, note: "a kill needs a positive control through the same path" },
                { t: 3, note: "the CASMI deadline is 2026-12-14" }, { t: 4, note: "memory weights are committed and pass all three final checks on a replay" },
                ...Array.from({ length: 20 }, (_, i) => ({ t: 10 + i, note: `unrelated note number ${i} about gardening and weather` }))];
  assert.deepEqual(recall(rows, "is Soul mode on Blue?"), [], "one shared word on a short prompt");
  assert.deepEqual(recall(rows, "Is memory-pulse helping you?"), []);
  assert.deepEqual(recall(rows, "when is the casmi deadline").map((r) => r.t), [3]);
  assert.deepEqual(recall(rows, "can I kill this model without a positive control?").map((r) => r.t), [2]);
  assert.deepEqual(recall(rows, "okay go ahead make the fixes so memory is a real help with tdd, then find and install the duet plugin and replay checks"), [],
    "two common matches among many content words cover under a quarter of the prompt");
});

test("recall: an ambient 'i want ...' request is a task, not a standing preference; a preference written on purpose stays", async () => {
  const { standingPreference } = await import("../lib/recall.mjs?pref=" + Date.now());
  assert.equal(standingPreference({ t: 46, cause: "ambient-preference", tags: ["ambient", "preference"], note: "i want you to find the latest information on switch emulators" }), false);
  assert.equal(standingPreference({ t: 108, cause: "ambient-preference", tags: ["ambient", "preference"], note: "i like the soul as state , lets try running all 3" }), false);
  assert.equal(standingPreference({ t: 13, cause: "preference-seeded-from-claude-md", tags: ["preference"], note: "Travis prefers test-first builds shipped through the one-command release" }), true);
  assert.equal(standingPreference({ t: 50, cause: "ambient-preference", tags: ["ambient", "preference"], note: "from now on always run the full suite before a release" }), true,
    "an ambient line that states a standing rule is kept");
  assert.equal(standingPreference({ t: 51, tags: ["lesson"], note: "x" }), true, "not a preference: no opinion");
});

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mphelp-f-"))), work = join(home, "work"); mkdirSync(join(work, ".memory-pulse"), { recursive: true });
  const env = { ...process.env, HOME: home, MEMORY_PULSE_LEDGER: join(work, ".memory-pulse", "events.jsonl"), MEMORY_PULSE_AGENT: join(home, ".memory-pulse", "agent", "events.jsonl"),
                MEMORY_PULSE_SETTINGS_DIR: join(home, ".claude"), MEMORY_PULSE_API: "http://127.0.0.1:9", CI: "1" };
  for (const k of ["MEMORY_PULSE_KEY", "MEMORY_PULSE_MODE", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_SESSION_ID", "MEMORY_PULSE_BRIEF"]) delete env[k];
  const run = (args, input, extra = {}) => { const r = spawnSync(process.execPath, [SERVER, ...args], { cwd: work, env: { ...env, ...extra }, input: input ?? "", encoding: "utf8" }); return { code: r.status, out: r.stdout, all: r.stdout + r.stderr }; };
  return { home, work, env, run };
}

test("the soul-mode prompt hook leaves out ambient one-off requests even when they share the prompt's words", () => {
  const f = fixture(); f.run(["mode", "soul"]);
  // EDITED in the red phase (stated): the first draft passed "--tags ambient,preference", one tag, so the row was no preference and the test
  // passed before any code; tags are repeated flags
  f.run(["remember", "ambient-preference", "switch-emulators", "--scope", "agent", "--tags", "ambient", "--tags", "preference", "--note", "i want you to find the latest information on switch emulators"]);
  f.run(["remember", "lesson", "kill-control", "--scope", "agent", "--tags", "lesson", "--note", "Lesson: a kill needs a positive control through the same path, or it is not a kill."]);
  const ctx = (text) => { const r = f.run(["prompt"], JSON.stringify({ session_id: "p1", cwd: f.work, hook_event_name: "UserPromptSubmit", prompt: text })); return r.out ? JSON.parse(r.out).hookSpecificOutput.additionalContext : ""; };
  assert.doesNotMatch(ctx("find the latest switch emulators information"), /switch emulators/);
  assert.match(ctx("should I kill this model without a positive control?"), /positive control through the same path/);
});

// ---- 3. a stale handoff stays out of the brief: dates written "YYYY-MM-DD HH:MM UTC" count, and so do the rows written after it
test("handoffLine: a handoff dated in plain UTC text is aged by that date; one with 200+ rows after it is stale whatever its date", async () => {
  const { handoffLine } = await load("handoff");
  const now = Date.parse("2026-10-22T00:30:00Z");
  const old = { t: 1496, cause: "CASMI session 2026-10-03 10:48 UTC to 2026-10-04 04:30 UTC: handoff state before", effect: "best read 0.426", kind: "event", note: "Findings: ...", tags: ["casmi", "handoff"] };
  assert.equal(handoffLine([old, ...filler(10, 1497)], { now }), "", "18 days old");
  const fresh = { ...old, t: 2000, cause: "CASMI session 2026-10-21 18:00 UTC to 2026-10-21 23:50 UTC: handoff state before" };
  assert.match(handoffLine([fresh, ...filler(10, 2001)], { now }), /^↩ last handoff \(t=2000, \d+ (?:h|min) ago\)/);
  const undated = { ...old, t: 1, cause: "handoff state before", effect: "x" };
  assert.match(handoffLine([undated, ...filler(10, 2)], { now }), /last handoff \(t=1\)/, "undated and recent in rows: kept");
  assert.equal(handoffLine([undated, ...filler(250, 2)], { now }), "", "undated but 250 rows ago: stale");
});

// ---- 4. the over-cap note says what went over, and long rule lines are clipped before the project sections are starved
test("composeBrief: the over-cap note reports the composed size; long rules are clipped (citation kept) so the organized memory gets room", async () => {
  const { composeBrief } = await load("compose2");
  const rule = (t, n) => `    rule: Travis, 2026-09-21: "${"remember to always use the cloud GPUs for heavy work ".repeat(Math.ceil(n / 52)).slice(0, n)}" (t${t})`;
  const identity = ["AGENT IDENTITY — Blue (agent ledger: 108 rows, head abc, seal def)", "  self: Blue", "  soul: I am Blue.", "  standing rules (6):",
    "    rule: Commits are attributed to Travis only (t2)", rule(23, 900), rule(43, 1100), rule(48, 650), rule(101, 1200), "  fingerprint: chain head abc"].join("\n");
  let roomGiven = 0;
  const out = composeBrief({ head: ["memory-pulse: loaded 2036 events", identity], text: "z".repeat(6000), tail: ["— memory-pulse · footer"] },
    (room) => { roomGiven = room; return `CORRECTIONS IN FORCE\n${'  "x" was withdrawn (t1)\n'.repeat(400)}`.slice(0, room); });
  assert.ok(out.length <= 9500, `${out.length}`);
  assert.doesNotMatch(out, /engine brief was 6,000 chars, over the 9,500/, "the engine text alone was under the cap");
  assert.match(out, /this brief came to [\d,]+ chars/);
  for (const t of [2, 23, 43, 48, 101]) assert.match(out, new RegExp(`\\(t${t}\\)`), `rule t${t} keeps its citation`);
  for (const line of out.split("\n").filter((l) => /^\s+rule: /.test(l))) assert.ok(line.length <= 260, `${line.length}: ${line.slice(0, 60)}`);
  assert.ok(roomGiven >= 4000, `room for the organized memory ${roomGiven}`);
});

// ---- 5. one identity block per session: the second memory-pulse brief in a session points at the first
test("brief: two briefs in one session print the identity once; a compaction prints it again once", () => {
  const f = fixture(); f.run(["mode", "agent"]);
  f.run(["remember", "project-start", "ledger-created", "--note", "first project row"]);
  f.run(["identity", "Blue, research agent"]);
  f.run(["remember", "rule", "commit-attribution", "--scope", "agent", "--tags", "rule", "--note", "Commits are attributed to Travis only"]);
  // EDITED after the first run with code (stated): a hook's stdin is read only when CLAUDE_PROJECT_DIR is set, as Claude Code sets it for
  // hooks; the fixture deletes it, so the hook-style calls now pass it (the CLI call below still has none)
  const brief = (source) => f.run(["brief"], JSON.stringify({ session_id: "s-1", hook_event_name: "SessionStart", source }), { CLAUDE_PROJECT_DIR: f.work }).out;
  const a = brief("startup"), b = brief("startup");
  assert.match(a, /IDENTITY AND RULES|AGENT IDENTITY/, a.slice(0, 300));
  assert.doesNotMatch(b, /IDENTITY AND RULES|AGENT IDENTITY/, "the second brief of the session leaves it out");
  assert.match(b, /identity and rules: printed by the other memory-pulse brief this session/);
  assert.match(brief("compact"), /IDENTITY AND RULES|AGENT IDENTITY/, "after a compaction the identity is printed again");
  const cli = f.run(["brief"]).out; assert.match(cli, /IDENTITY AND RULES|AGENT IDENTITY/, "no session: always printed");
});
