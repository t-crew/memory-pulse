// Verifier-credited memory (2026-10-21): memories carry weights learned from outcomes, kept as sufficient statistics so they merge.
//   exposure   the prompt hook records which memory rows it injected, into the session's episode
//   credit     consolidate credits each injected memory with the next check outcome after it (pass: success, fail: failure), once,
//              as a chained ledger row {credit: {t: [successes, failures]}} with its evidence
//   weight     utility = Beta(1 + successes, 1 + failures): mean, lower and upper bounds; a memory with enough evidence that does not
//              help is retired (left out of what is injected, kept on record); corrections are rules and are never retired
//   rank       the prompt slice orders memories by relevance and utility (MemRL's (1 - λ) z(relevance) + λ z(utility), λ = 0.5)
//   merge      the weights are sums of counts, so credit rows from any machine or teammate combine in any order to the same weights
// Written before the code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";

test("weights fold credit rows by summing, so any order gives the same weights", async () => {
  const W = await import("../lib/weights.mjs");
  const rows = [{ t: 10, tags: ["credit"], credit: { 3: [2, 0], 4: [0, 1] } }, { t: 11, tags: ["credit"], credit: { 3: [1, 1] } }, { t: 12, tags: ["credit"], credit: { 4: [0, 2], 5: [1, 0] } }];
  const a = W.fold(rows), b = W.fold([rows[2], rows[0], rows[1]]);
  assert.deepEqual([...a].sort(), [...b].sort());
  assert.deepEqual(a.get(3), { s: 3, f: 1 }); assert.deepEqual(a.get(4), { s: 0, f: 3 });
});

test("utility is the Beta posterior; more evidence tightens it; retirement needs an evidence floor and never takes a correction", async () => {
  const W = await import("../lib/weights.mjs");
  const u = (s, f) => W.utility({ s, f });
  assert.equal(u(0, 0).mean, 0.5); assert.ok(u(8, 0).lb > u(1, 0).lb); assert.ok(u(0, 8).ub < u(0, 1).ub);
  assert.equal(W.retired({ kind: "event" }, { s: 0, f: 2 }), false, "two failures are not enough evidence");
  assert.equal(W.retired({ kind: "event" }, { s: 0, f: 8 }), true);
  assert.equal(W.retired({ kind: "correction" }, { s: 0, f: 20 }), false, "a correction is a rule, never retired by utility");
});

test("rank: the useful memory overtakes a slightly more relevant one that did not help; with no evidence relevance alone decides", async () => {
  const W = await import("../lib/weights.mjs");
  const items = [{ t: 1, hits: 11 }, { t: 2, hits: 10 }, { t: 3, hits: 4 }];     // without evidence t1 leads by relevance
  const weights = new Map([[2, { s: 6, f: 0 }], [1, { s: 0, f: 3 }]]);
  assert.deepEqual(W.rank(items, weights).map((x) => x.t), [2, 1, 3]);
  assert.deepEqual(W.rank(items, new Map()).map((x) => x.t), [1, 2, 3]);
});

// ---- integration: exposure -> credit -> weights -> ranking, through the real hooks
const fixture = () => { const home = realpathSync(mkdtempSync(join(tmpdir(), "mp-weights-"))), work = join(home, "work"); mkdirSync(join(work, ".memory-pulse"), { recursive: true }); return { home, work }; };
const run = (f, args, stdin) => new Promise((resolve) => {
  const env = { ...process.env, HOME: f.home, MEMORY_PULSE_LEDGER: join(f.work, ".memory-pulse", "events.jsonl"), MEMORY_PULSE_AGENT: join(f.home, "agent.jsonl"), MEMORY_PULSE_API: "http://127.0.0.1:9" };
  delete env.MEMORY_PULSE_KEY;
  const p = spawn(process.execPath, [SERVER, ...args], { cwd: f.work, env });
  let out = "", err = ""; p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c)); p.on("close", (code) => resolve({ code, out, err, all: out + err }));
  p.stdin.end(stdin ?? "");
});
const ledger = (f) => readFileSync(join(f.work, ".memory-pulse", "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const prompt = (f, sid, text) => run(f, ["prompt"], JSON.stringify({ session_id: sid, cwd: f.work, hook_event_name: "UserPromptSubmit", prompt: text }));
const check = (f, sid, ok) => run(f, ["capture"], JSON.stringify({ session_id: sid, cwd: f.work, hook_event_name: ok ? "PostToolUse" : "PostToolUseFailure", tool_name: "Bash", tool_use_id: `${sid}-${Math.random()}`, tool_input: { command: "npm test" }, ...(ok ? { tool_response: { stdout: "ℹ pass 3\nℹ fail 0", stderr: "", interrupted: false } } : { error: "Exit code 1\n✖ totals" }) }));
const stop = (f, sid) => run(f, ["consolidate"], JSON.stringify({ session_id: sid, cwd: f.work, hook_event_name: "Stop" }));

test("the prompt hook records what it injected; consolidate credits it with the next check, once; weights shows it", async () => {
  const f = fixture();
  await run(f, ["remember", "refund rounding decision", "round per line item before tax", "--tags", "decision"]);
  const t = ledger(f)[0].t;
  const r = await prompt(f, "s1", "fix the refund rounding before tax again");
  assert.match(r.out, /round per line item/);
  const ep = readFileSync(join(f.work, ".memory-pulse", "episodes", "s1.jsonl"), "utf8");
  assert.match(ep, /"op":"exposure"/); assert.match(ep, new RegExp(`"ts":\\[${t}\\]`));
  await check(f, "s1", true); await stop(f, "s1"); await stop(f, "s1");
  const credits = ledger(f).filter((e) => (e.tags ?? []).includes("credit"));
  assert.equal(credits.length, 1, "credited once"); assert.deepEqual(credits[0].credit, { [t]: [1, 0] }); assert.equal(credits[0].evidence.episode, "s1");
  const w = await run(f, ["weights"]);
  assert.match(w.out, new RegExp(`t${t}\\b.*1 helped.*0 not`));
});

test("ranking uses the weights: the memory that helped comes first, the one that kept failing is retired from the prompt", async () => {
  const f = fixture();
  await run(f, ["remember", "refund rounding decision A", "round per line item before tax", "--tags", "decision"]);
  await run(f, ["remember", "refund rounding decision B", "round the order total after tax", "--tags", "decision"]);
  const [a, b] = ledger(f).map((e) => e.t);
  const base = await prompt(f, "s0", "refund rounding before tax");
  assert.match(base.out, /line item/); assert.match(base.out, /order total/);
  const credit = (t, s, fails, n) => run(f, ["append", "--json", JSON.stringify({ cause: "credit", effect: `seed-${n}`, tags: ["credit"], credit: { [t]: [s, fails] } })]);
  await credit(b, 5, 0, 1); await credit(a, 0, 8, 2);
  const after = await prompt(f, "s9", "refund rounding before tax");
  assert.match(after.out, /order total/); assert.doesNotMatch(after.out, /line item/, "retired: 0 of 8 helped");
});
