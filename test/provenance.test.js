// Two precision defects measured on the estate on 2026-10-12, written red-first.
//
// 1. The guard matched a withdrawn term as a raw substring. Replayed over 25,166 files on this machine with
//    every withdrawn term the estate ledger ever held, substring matching flagged 14,049 files and a
//    token-boundary rule flagged 2,345. Every hit only substring matching found was a false block: a
//    withdrawn qubit count "ten" inside tenant/written/content (four guard overrides), "$79" inside "$790M",
//    "0.030" inside "0.0309", "capture" inside "nocapture".
// 2. Ambient capture read harness text as something the user typed. Replayed over 107 transcripts (1,473
//    user entries): 18 corrections recorded, 0 real. 11 came from skill bodies (isMeta), 6 from compaction
//    summaries (isCompactSummary), 1 from the typed question "why are we not iterating this", read as
//    "use 'we', not 'iterating'".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const load = async (tag) => {
  const dir = mkdtempSync(join(tmpdir(), "mpp-")); const ledger = join(dir, "events.jsonl"); writeFileSync(ledger, "");
  delete process.env.MEMORY_PULSE_MODE; process.env.MEMORY_PULSE_LEDGER = ledger; process.env.MEMORY_PULSE_AGENT = join(dir, "agent", "events.jsonl");
  return import("../server.mjs?" + tag + "=" + Date.now());
};
const corr = (t, withdrawn, replacement = []) => ({ t, cause: `c${t}`, effect: `e${t}`, kind: "correction", withdrawn, replacement });

test("guard: a withdrawn term matches as a token, not inside another word or a longer number", async () => {
  const { findViolations, localCheck, containsTerm } = await load("tok");
  const hit = (term, text) => findViolations([corr(1, [term])], text).length === 1;
  // short words never run on into a longer word
  assert.equal(hit("ten", "the tenant written content needs attention"), false);
  assert.equal(hit("ten", "ran on ten qubits"), true);
  assert.equal(hit("ten", "ten-qubit register"), true);
  // numbers never run on into more digits or a decimal tail, but may carry a unit
  assert.equal(hit("$79", "15 datasets, $285M-$790M"), false);
  assert.equal(hit("$79", "$799/month revenue"), false);
  assert.equal(hit("$79", "Pro is $79/mo"), true);
  assert.equal(hit("$79", "it costs $79."), true);
  assert.equal(hit("0.030", "mpf('0.0307203994')"), false);
  assert.equal(hit("0.030", "score 10.030 on the board"), false);
  assert.equal(hit("0.030", "read 0.030, then 0.041"), true);
  assert.equal(hit("6144", "2561445.079"), false);
  assert.equal(hit("6144", "1.6144 seconds"), false);
  assert.equal(hit("6144", "width 6144px"), true);
  assert.equal(hit("cap 48", "needs cap 480"), false);
  assert.equal(hit("cap 48", "cap 48-qubit chart"), true);
  // an underscore separates words: a snake_case name that restates the value is a reintroduction
  assert.equal(hit("cap 48", "needs 49 > max_cluster_cap 48"), true);
  // a word of five letters or more keeps its inflections; a prefix makes it another word
  assert.equal(hit("capture", "two captures per turn"), true);
  assert.equal(hit("capture", "'nobuiltin', 'nocapture'"), false);
  assert.equal(hit("capture", "pytest_capture plugin"), true);
  assert.equal(hit("exact isometric embedding", "an exact isometric embeddings claim"), true);
  // terms that start or end with punctuation bound themselves on that side
  assert.equal(hit("-corrected-to-", "x-corrected-to-y"), true);
  // the block decision and the full check agree
  const v = (text) => localCheck([corr(2, ["ten"], ["8 qubits"])], { text, path: "src/a.js" }, [], { blockOnly: true }).verdict;
  assert.equal(v("tenant isolation"), "not_blocked");
  assert.equal(v("we ran ten qubits"), "blocked");
  assert.equal(containsTerm("abc ten", "ten"), true);
  assert.equal(containsTerm("", "ten"), false);
  assert.equal(containsTerm("ten", ""), false);
});

const line = (o) => JSON.stringify(o);
const typed = (text) => line({ type: "user", origin: { kind: "human" }, message: { role: "user", content: text } });
const said = (text) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

test("ambient: only text a person typed can become a correction; skill bodies, summaries and notifications cannot", async () => {
  const { extractAmbient } = await load("prov");
  const corrections = (lines) => extractAmbient(lines.join("\n")).filter((e) => e.kind === "correction");
  const skill = line({ type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /x\n\nUse a decision envelope, not human approval. capture -> narrate" }] } });
  const summary = line({ type: "user", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: "This session is being continued from a previous conversation. Read 0.030 -> board." } });
  const note = line({ type: "user", origin: { kind: "task-notification" }, message: { role: "user", content: "the price is $29 not $49" } });
  const legacySkill = line({ type: "user", message: { role: "user", content: "Base directory for this skill: /y\n\nthe price is $29 not $49" } });
  assert.deepEqual(corrections([skill, said("ok")]), [], "skill body");
  assert.deepEqual(corrections([summary, said("ok")]), [], "compaction summary");
  assert.deepEqual(corrections([note, said("ok")]), [], "task notification");
  assert.deepEqual(corrections([legacySkill, said("ok")]), [], "skill body in a transcript older than the isMeta flag");
  // a typed correction still lands, even when a skill body or a notification arrived after it in the same turn
  const c = corrections([typed("the price is $29 not $49"), said("loading the skill"), skill, said("done"), note, said("noted")]);
  assert.equal(c.length, 1); assert.deepEqual(c[0].withdrawn, ["$49"]); assert.deepEqual(c[0].replacement, ["$29"]);
  // a transcript without origin flags: a plain user line is still typed
  assert.equal(corrections([line({ type: "user", message: { role: "user", content: "the price is $29 not $49" } }), said("ok")]).length, 1);
});

test("ambient: a question about what we are not doing is not a correction", async () => {
  const { detectCorrection } = await load("q");
  assert.equal(detectCorrection("what about our .290 score why are we not iterating this to top scoring levels, what are the bottlenecks"), null);
  assert.equal(detectCorrection("they are not shipping it, you are"), null);
  assert.deepEqual(detectCorrection("the cap is 20, not 48")?.withdrawn, ["48"]);
});

test("handoff: the asks are what the person typed, not skill bodies or summaries", async () => {
  const { extractHandoff } = await load("ho");
  const skill = line({ type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /x" }] } });
  const summary = line({ type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation." } });
  const h = extractHandoff([typed("find memory-pulse and upgrade it"), skill, summary, said("on it")].join("\n"));
  assert.deepEqual(h.asks, ["find memory-pulse and upgrade it"]);
});

test("observe: a prompt that is harness text or a pasted document records nothing; a typed correction still does", async () => {
  const { detectCorrection, observeDecision } = await load("obs");
  assert.equal(observeDecision("Base directory for this skill: /x\n\ncapture -> narrate"), null);
  assert.equal(observeDecision("This session is being continued from a previous conversation. 0.4 -> board"), null);
  assert.equal(detectCorrection("# Design\nfield_a -> field_b\nline\nline\nline"), null, "a pasted document is not a correction");
  assert.deepEqual(observeDecision("no, the cap is 20, not 48")?.withdrawn, ["48"]);
});

test("ambient: a request is not a preference; a stated preference still is", async () => {
  const { extractAmbient } = await load("pref");
  const prefs = (u) => extractAmbient([typed(u), said("ok")].join("\n")).filter((e) => e.tags.includes("preference")).map((e) => e.note);
  // ten of the eleven preferences on the estate's agent ledger were requests of this shape
  assert.deepEqual(prefs("i want you to find memory-pulse and upgrade it"), []);
  assert.deepEqual(prefs("i want you to setup my OBS with perfect settings for streaming"), []);
  assert.deepEqual(prefs("I want the story seed read out loud once the game starts"), []);
  assert.equal(prefs("I prefer short answers with the number first").length, 1);
  assert.equal(prefs("I always want the measured number, never the claim").length, 1);
  assert.equal(prefs("I don't want vendor hype words on public pages").length, 1);
});
