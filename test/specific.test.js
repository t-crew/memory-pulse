/**
 * A correction captured automatically does not bind one ordinary word (lib/specific.mjs, lib/typed.mjs).
 *
 * Measured on one real ledger (2026-11-21): of 166 term blocks recorded between 2026-09-01 and 2026-11-20, 125 came from
 * seven corrections that ambient capture wrote by itself and whose withdrawn term was one ordinary word (merge 85,
 * send 16, ten 9, trigger 5, universal 5, just 3, capture 2). The other 41 came from terms isSpecificTerm calls
 * specific. The rule is 0.17.1's: one word of letters only is not specific, whatever its capitals. A first version of this
 * module let a camelCase name and a capital word of three letters or more bind, on the median share of files such a word
 * sits in (0.20% and 0.34% of 5,917 files). The median hid the words people name: in a fixed sample of 3,000 files JSON is
 * in 14.9%, API in 8.6%, URL in 7.0%, HTTP in 2.8%, README in 1.9%, against 6.1% for merge (review, 2026-11-21).
 *
 * 0.17.1 stopped the guard blocking on such a row at read time. From here the row is not written as binding at all:
 * it records what was heard, says it is not enforced, and gives the command that enforces the word on purpose.
 * A word a person records with `remember --withdrawn` still binds, and the result says the term is broad.
 */
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
for (const k of ["MEMORY_PULSE_LEDGER", "MEMORY_PULSE_PROJECT", "MEMORY_PULSE_KEY", "MEMORY_PULSE_BOARD"]) delete process.env[k];
process.env.MEMORY_PULSE_MODE = "deliberate"; process.env.MEMORY_PULSE_AGENT = "/nonexistent/agent/events.jsonl";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advisoryTerm, correctionEvent, observeDecision, extractAmbient, typedUserText, renderScaffold } from "../server.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SERVER = join(HERE, "..", "server.mjs");
const specific = () => import("../lib/specific.mjs");
const typed = () => import("../lib/typed.mjs");
const mk = () => {
  const cwd = mkdtempSync(join(tmpdir(), "mp-spec-"));
  const env = { ...process.env, MEMORY_PULSE_MODE: "deliberate", MEMORY_PULSE_AGENT: join(cwd, "agent", "events.jsonl"), MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_SETTINGS_DIR: join(cwd, "settings"), NO_COLOR: "1" };
  delete env.MEMORY_PULSE_LEDGER;
  const run = (args, input = "") => { const r = spawnSync(process.execPath, [SERVER, ...args], { cwd, env, input, encoding: "utf8" }); let json = null; try { json = JSON.parse(r.stdout); } catch { /* not JSON */ } return { ...r, json }; };
  const ledger = join(cwd, ".memory-pulse", "events.jsonl");
  const rows = () => (existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const write = (content, file = "src/mail.js") => run(["guard"], JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(cwd, file), content } }));
  return { cwd, env, run, ledger, rows, write };
};

// ---------------------------------------------------------------- the predicate ----
test("isSpecificTerm: a phrase, a digit or a symbol; one word of letters only is not, whatever its capitals", async () => {
  const { isSpecificTerm } = await specific();
  for (const t of ["two words", "Player join", "$49", "3/11", "us-east-1", "memory_key", "v2", "em-dashes", "a.b", "@scope", "#general", "don't", "0.18.0", "48 tests"])
    assert.equal(isSpecificTerm(t), true, `${t} is specific`);
  // 0.17.1's rule, which the first version of this module loosened for capitals and a review put back (2026-11-21): in a fixed
  // sample of 3,000 files JSON is in 14.9%, API 8.6%, URL 7.0%, forEach 4.1%, toString 3.9%, HTTP 2.8%, README 1.9%; merge is in 6.1%
  for (const t of ["merge", "send", "ten", "trigger", "universal", "just", "capture", "only", "upgrades", "Merge", "Postgres", "TO", "ID",
                   "JSON", "HTTP", "API", "URL", "README", "TODO", "useEffect", "innerHTML", "forEach", "toString", "camelCase", "OpenAI", "Ünïcode", "", "  ", null, undefined, 49])
    assert.equal(isSpecificTerm(t), false, `${JSON.stringify(t)} is not specific`);
});

test("isSpecificTerm separates the recorded blocks: the seven words behind 125 of 166 blocks are not specific; values and phrases are", async () => {
  const { isSpecificTerm } = await specific();
  const noisy = { merge: 85, send: 16, ten: 9, trigger: 5, universal: 5, just: 3, capture: 2 };
  assert.equal(Object.values(noisy).reduce((a, b) => a + b, 0), 125);
  for (const t of Object.keys(noisy)) assert.equal(isSpecificTerm(t), false, t);
  for (const t of ["3/11", "renderer swap", "Player join", "$79"]) assert.equal(isSpecificTerm(t), true, t);
  // a number by itself is as broad as a word (second review, 2026-11-22): 6144 and 0.030 were themselves overheard rows on this ledger
  for (const t of ["6144", "0.030"]) assert.equal(isSpecificTerm(t), false, t);
});

test("advisoryTerm is 0.17.1's rule: an ambient word of letters only is never enforced, whatever its capitals", () => {
  const amb = (term) => ({ kind: "correction", cause: `user-correction-${term.toLowerCase()}`, withdrawn: [term], tags: ["ambient", "prohibit-no-x"] });
  for (const w of ["send", "TO", "JSON", "HTTP", "README", "useEffect", "innerHTML"]) {
    assert.equal(advisoryTerm(amb(w), w), true, w);
    assert.equal(advisoryTerm({ kind: "correction", cause: `user-correction-${w.toLowerCase()}`, withdrawn: [w] }, w), true, `${w}, as the guard's cached row (no tags)`);
  }
  assert.equal(advisoryTerm(amb("don't"), "don't"), false, "not letters only: enforced, as 0.17.1 and 0.18.0 read it");
  assert.equal(advisoryTerm(amb("us-east-1"), "us-east-1"), false);
  assert.equal(advisoryTerm(amb(""), ""), false);
  assert.equal(advisoryTerm({ kind: "correction", cause: "naming-review", withdrawn: ["users"] }, "users"), false, "a word a person recorded is enforced");
});

// ---------------------------------------------------------------- what capture writes ----
test("correctionEvent: one ordinary word is recorded as heard, without withdrawn terms, with the command that enforces it; a specific term binds as before", () => {
  const prompt = "no merge, we build our components and systems from the ground up";
  const d = observeDecision(prompt); assert.deepEqual(d?.withdrawn, ["merge"]); assert.equal(d.cue, "prohibit-no-x");
  const row = correctionEvent(d, prompt);
  assert.equal(row.kind, "correction"); assert.equal(row.withdrawn, undefined, "no withdrawn terms: nothing for the guard to block");
  assert.equal(row.replacement, undefined);
  assert.deepEqual(row.tags, ["ambient", "prohibit-no-x"]);
  assert.equal(row.cause, "user-correction-merge"); assert.equal(row.effect, "merge-heard-not-enforced");
  assert.match(row.note, /^Heard a prohibition of "merge"\. Not enforced: "merge" is one ordinary word, and blocking it would block every edit that contains it\./);
  assert.ok(row.note.includes('memory-pulse remember deliberate-merge merge-withdrawn --kind correction --withdrawn "merge"'), row.note);
  assert.ok(row.note.includes('Prompt: "no merge, we build'), row.note);
  assert.ok(!/—/.test(row.note), "no dash aside in the note");

  const sub = observeDecision("the unit is seconds, not minutes");
  const subRow = correctionEvent(sub, "the unit is seconds, not minutes");
  assert.equal(subRow.withdrawn, undefined); assert.equal(subRow.replacement, undefined);
  assert.match(subRow.note, /^Heard "minutes" corrected to "seconds"\. Not enforced: "minutes" is one ordinary word/);
  assert.ok(subRow.note.includes('memory-pulse remember deliberate-minutes minutes-withdrawn-for-seconds --kind correction --withdrawn "minutes" --replacement "seconds"'), subRow.note);

  const kept = correctionEvent(observeDecision("no, the cap is 20, not 48"), "no, the cap is 20, not 48");
  // a number by itself is heard and not enforced (second review, 2026-11-22: "48" stands in 10.3% of files)
  assert.equal(kept.withdrawn, undefined); assert.match(kept.effect, /heard-not-enforced$/); assert.match(kept.note, /"48" is a number by itself/);
  const unit = correctionEvent(observeDecision("no, the plan is $29, not $49"), "no, the plan is $29, not $49");
  assert.deepEqual(unit.withdrawn, ["$49"]); assert.deepEqual(unit.replacement, ["$29"]);
  const phrase = correctionEvent(observeDecision("renderer swap -> 2x performance"), "renderer swap -> 2x performance");
  assert.deepEqual(phrase.withdrawn, ["renderer swap"]);
});

test("observe (UserPromptSubmit): 'no merge, ...' writes a correction that binds nothing, the guard lets the word through, and the hook says how to enforce it", () => {
  const { run, rows, write } = mk();
  const r = run(["observe"], JSON.stringify({ prompt: "no merge, we build our components and systems from the ground up" }));
  assert.equal(r.status, 0);
  const all = rows(); assert.equal(all.length, 1);
  assert.equal(all[0].kind, "correction"); assert.equal(all[0].withdrawn, undefined); assert.deepEqual(all[0].tags, ["ambient", "prohibit-no-x"]);
  assert.match(r.stdout, /^memory-pulse: heard "merge" \(t=1\), not enforced: one ordinary word would block every edit that contains it\. To enforce it: memory-pulse remember deliberate-merge merge-withdrawn --kind correction --withdrawn "merge"\n$/);
  assert.doesNotMatch(r.stdout, /the guard enforces it from now on/);
  const g = write("git merge main && echo merged");
  assert.equal(g.status, 0, g.stderr + g.stdout);
});

// The review's capture table (2026-11-21, C-1): one overheard sentence, then one ordinary line that holds the word. Expected: what
// 0.18.0 let through, this version lets through, both for a row it writes and for the row 0.18.0 wrote (the term as withdrawn).
const CAPTURE_CASES = [
  // prompt, the ordinary line, its file, what the new row binds (null: heard only), the guard on the line, the term 0.18.0 wrote
  ["don't use JSON, use YAML for the config", "const cfg = JSON.parse(raw);", "src/a.js", null, 0, "JSON"],
  ["never use HTTP, use HTTPS", "if (res.status !== 200) throw new Error(`HTTP ${res.status}`);", "src/a.js", null, 0, "HTTP"],
  ["never use innerHTML", "el.textContent = name; // not innerHTML here", "src/a.js", null, 0, "innerHTML"],
  ["never use useEffect for data fetching", "import { useEffect, useState } from 'react';", "src/a.tsx", null, 0, "useEffect"],
  ["don't say README, say guide", "See the README for setup.", "docs/p.md", null, 0, "README"],
  ["use pnpm, not npm", "Run `npm test` before you push.", "README.md", null, 0, "npm"],
  ["we say Vitest, not Jest", "Jest is still used by the legacy package.", "README.md", null, 0, "Jest"],
  ["never use moment", "Wait a moment for the build.", "README.md", null, 0, "moment"],
  ["never use Postgres 14; use Postgres 16.", "We run Postgres 16 in production.", "README.md", ["Postgres 14"], 0, null],
  ["no, the cap is 20, not 48", "padding: 48px;", "src/a.css", null, 0, "48"],
  ["never cite $49 in the docs", "| Pro | $49/mo |", "docs/p.md", ["$49"], 2, "$49"],
];
test("the review's capture table: an overheard acronym or camelCase name binds nothing and blocks nothing; a value still binds", () => {
  for (const [prompt, line, file, binds, exit] of CAPTURE_CASES) {
    const { run, rows, write } = mk();
    run(["observe"], JSON.stringify({ prompt }));
    const row = rows().find((e) => e.kind === "correction");
    assert.ok(row, `a row for: ${prompt}`);
    assert.deepEqual(row.withdrawn ?? null, binds, `${prompt} binds ${JSON.stringify(row.withdrawn)}`);
    assert.equal(write(line + "\n", file).status, exit, `${prompt} then: ${line}`);
  }
});
test("the review's capture table over a ledger 0.18.0 wrote: the row that carries the word as withdrawn blocks nothing it did not block then", () => {
  for (const [prompt, line, file, , exit, old] of CAPTURE_CASES) {
    if (!old) continue;
    const { ledger, write, cwd } = mk();
    mkdirSync(join(cwd, ".memory-pulse"), { recursive: true });
    writeFileSync(ledger, JSON.stringify({ t: 1, cause: `user-correction-${old.toLowerCase()}`, effect: `${old.toLowerCase()}-withdrawn`, kind: "correction", withdrawn: [old], tags: ["ambient", "prohibit-never-x"], note: `User prohibited "${old}" — prompt: "${prompt}"` }) + "\n");
    assert.equal(write(line + "\n", file).status, exit, `0.18.0's row for ${JSON.stringify(old)}, then: ${line}`);
  }
});

test("observe: a specific term still binds and still says so", () => {
  const { run, rows, write } = mk();
  const r = run(["observe"], JSON.stringify({ prompt: "never cite $49 in the docs" }));
  assert.deepEqual(rows()[0].withdrawn, ["$49"]);
  assert.match(r.stdout, /correction recorded \(t=1\).*"\$49" withdrawn.*the guard enforces it from now on/);
  assert.equal(write("| Pro | $49/mo |", "docs/pricing.md").status, 2);
});

test("ambient (Stop hook): the same word from the last typed turn is recorded as heard, not as a binding term", () => {
  const transcript = [
    { type: "user", promptSource: "typed", turnOrigin: "human", origin: { kind: "human" }, message: { role: "user", content: "no send, hold the email until the read is in" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Holding the email." }] } },
  ].map((o) => JSON.stringify(o)).join("\n");
  const evs = extractAmbient(transcript).filter((e) => e.kind === "correction");
  assert.equal(evs.length, 1); assert.equal(evs[0].withdrawn, undefined); assert.match(evs[0].note, /^Heard a prohibition of "send"\. Not enforced/);
});

test("the brief lists a heard word as not enforced, and the note it prints leads with what was heard", () => {
  const row = { t: 1, ...correctionEvent(observeDecision("no merge, we build from the ground up"), "no merge, we build from the ground up") };
  const { text } = renderScaffold([row], { section: "corrections" });
  assert.match(text, /Heard a prohibition of "merge"\. Not enforced.*\(t1; not enforced: no withdrawn terms\)/);
});

// ---------------------------------------------------------------- a person's deliberate word ----
test("remember --withdrawn <one word> still binds, and the result carries one caution line with the way to scope it", () => {
  const { run, write } = mk();
  const r = run(["remember", "deliberate-merge", "merge-withdrawn", "--kind", "correction", "--withdrawn", "merge"]);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.json.written, true); assert.deepEqual(r.json.stored.withdrawn, ["merge"]);
  assert.equal(r.json.broad, true);
  assert.equal(r.json.caution, '"merge" is one ordinary word: the guard blocks every edit that contains it. To let it through under one path: memory-pulse guard allow "merge" --path <prefix> "<reason>"');
  assert.equal(r.json.stored.broad, undefined, "the caution is in the result, not in the row");
  const g = write("git merge main");
  assert.equal(g.status, 2, "the command the capture note gives produces a row the guard enforces: " + g.stderr + g.stdout);
  assert.match(g.stderr + g.stdout, /"merge" was withdrawn/);
});

test("remember with a specific term, or with no withdrawn term, carries no caution", () => {
  const { run } = mk();
  const a = run(["remember", "pricing-review", "49-withdrawn-for-29", "--kind", "correction", "--withdrawn", "$49", "--replacement", "$29"]);
  assert.equal(a.json.written, true); assert.equal(a.json.broad, undefined); assert.equal(a.json.caution, undefined);
  const b = run(["remember", "deploy", "shipped"]);
  assert.equal(b.json.written, true); assert.equal(b.json.broad, undefined);
  const c = run(["remember", "naming", "words", "--kind", "correction", "--withdrawn", "users", "--withdrawn", "two words", "--withdrawn", "send"]);
  assert.equal(c.json.broad, true); assert.match(c.json.caution, /^"users" and "send" are each one ordinary word: the guard blocks every edit that contains one\. /);
});

test("MCP remember: the tool result carries broad: true for one ordinary word", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-spec-mcp-")); const ledger = join(dir, "events.jsonl"); writeFileSync(ledger, "");
  const prev = process.env.MEMORY_PULSE_LEDGER; process.env.MEMORY_PULSE_LEDGER = ledger;
  try {
    const { handleCall } = await import("../server.mjs");
    const r = await handleCall("remember", { cause: "naming-review", effect: "users-withdrawn-for-customers", kind: "correction", withdrawn: ["users"], replacement: ["customers"] });
    assert.equal(r.written, true); assert.equal(r.broad, true); assert.match(r.caution, /guard allow "users" --path <prefix> "<reason>"/);
    const s = await handleCall("remember", { cause: "pricing", effect: "x", kind: "correction", withdrawn: ["$49"] });
    assert.equal(s.written, true); assert.equal(s.broad, undefined);
  } finally { if (prev === undefined) delete process.env.MEMORY_PULSE_LEDGER; else process.env.MEMORY_PULSE_LEDGER = prev; }
});

// ---------------------------------------------------------------- typed, or scheduled ----
// The UserPromptSubmit payload names no origin (Claude Code 2.1.330: session, transcript_path, cwd, permission mode, prompt,
// session_title), so a prompt the agent scheduled for itself reads like a typed one there. The transcript does tell them
// apart; the fixture keeps the envelope of a real scheduled wake-up (2026-11-13) with the text replaced.
const FIXTURE = join(HERE, "fixtures", "scheduled-wakeup.jsonl");
const WAKEUP = "Fallback check: has the harvest agent reported? If not, check the board and report, no send to the list until the read is in.";

test("the fixture: a scheduled wake-up prompt is not typed text; the typed prompt beside it is", () => {
  const entries = readFileSync(FIXTURE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const wake = entries.find((o) => o.type === "user" && o.turnOrigin === "scheduled");
  assert.equal(wake.message.content, WAKEUP); assert.equal(wake.promptSource, "system"); assert.equal(wake.wakeupSource, "loop_wakeup");
  assert.equal(typedUserText(wake), "");
  const human = entries.find((o) => o.type === "user" && o.turnOrigin === "human");
  assert.equal(typedUserText(human), "check the harvest in thirty minutes");
});

test("typedUserText: a prompt the harness marks as its own (promptSource system, or a turn origin that is not human) is not typed, with or without isMeta", () => {
  const base = { type: "user", message: { role: "user", content: "status -> done" } };
  assert.equal(typedUserText({ ...base, promptSource: "typed", turnOrigin: "human" }), "status -> done");
  assert.equal(typedUserText({ ...base, promptSource: "queued", turnOrigin: "human" }), "status -> done");
  assert.equal(typedUserText(base), "status -> done", "an older transcript without the fields is read as before");
  assert.equal(typedUserText({ ...base, turnOrigin: "peer" }), "", "measured: peer turns exist with no isMeta and no origin");
  assert.equal(typedUserText({ ...base, promptSource: "system" }), "");
  assert.equal(typedUserText({ ...base, turnOrigin: "scheduled" }), "");
});

test("scheduledPrompt: true when the transcript shows the agent scheduled this prompt, the harness fired it, or its entry is not typed; false for a typed prompt", async () => {
  const { scheduledPrompt } = await typed();
  const text = readFileSync(FIXTURE, "utf8"); const lines = text.trim().split("\n");
  assert.equal(scheduledPrompt(text, WAKEUP, { typedUserText }), true);
  assert.equal(scheduledPrompt(text, "check the harvest in thirty minutes", { typedUserText }), false);
  assert.equal(scheduledPrompt(text, "no send, hold the email", { typedUserText }), false, "a prompt the transcript does not hold yet is treated as typed");
  assert.equal(scheduledPrompt("", WAKEUP, { typedUserText }), false);
  // each marker alone is enough: the entry may not be on disk yet when the hook runs, the tool call that scheduled it is
  const only = (pred) => lines.filter((l) => pred(JSON.parse(l))).join("\n");
  assert.equal(scheduledPrompt(only((o) => o.type === "assistant"), WAKEUP, { typedUserText }), true, "the ScheduleWakeup call that carries the prompt");
  assert.equal(scheduledPrompt(only((o) => o.type === "system"), WAKEUP, { typedUserText }), true, "the scheduled_task_fire entry (its prompt is cut short)");
  assert.equal(scheduledPrompt(only((o) => o.type === "user" && o.turnOrigin === "scheduled"), WAKEUP, { typedUserText }), true, "the user entry marked as scheduled");
  assert.equal(scheduledPrompt(only((o) => o.type === "queue-operation"), WAKEUP, { typedUserText }), false, "a queued prompt may be a person's: the queue entry alone decides nothing");
});

test("observe: a scheduled wake-up prompt records nothing; the same text with no transcript, or typed, is still heard", () => {
  const { run, rows } = mk();
  const r = run(["observe", "--verbose"], JSON.stringify({ prompt: WAKEUP, transcript_path: FIXTURE }));
  assert.equal(r.status, 0); assert.equal(rows().length, 0, "nothing recorded: " + JSON.stringify(rows()));
  assert.match(r.stdout, /not recorded: the transcript shows this prompt was scheduled, not typed/);
  run(["observe"], JSON.stringify({ prompt: WAKEUP }));
  assert.equal(rows().length, 1, "without a transcript the prompt is judged by its text, as before");
  const b = mk();
  b.run(["observe"], JSON.stringify({ prompt: "never cite $49 in the docs", transcript_path: FIXTURE }));
  assert.deepEqual(b.rows()[0]?.withdrawn, ["$49"], "a typed prompt in a session that also holds a wake-up is recorded");
  const c = mk();
  c.run(["observe"], JSON.stringify({ prompt: "never cite $49 in the docs", transcript_path: join(c.cwd, "missing.jsonl") }));
  assert.equal(c.rows().length, 1, "a transcript that cannot be read never stops a capture");
});
