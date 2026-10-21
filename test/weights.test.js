// Verifier-credited memory (2026-10-21): memories carry weights learned from outcomes, kept as sufficient statistics so they merge.
//   exposure   the prompt hook records which memory rows it injected, into the session's episode
//   credit     consolidate credits each injected memory with the next check outcome after it (pass: success, fail: failure), once,
//              as a chained ledger row {credit: {t: [successes, failures]}} with its evidence
//   weight     utility = Beta(1 + successes, 1 + failures): mean, lower and upper bounds; a memory with enough evidence that does not
//              help is retired (left out of what is injected, kept on record); corrections are rules and are never retired
//   rank       the prompt slice orders memories by relevance and utility (MemRL's (1 - λ) z(relevance) + λ z(utility), λ = 0.5)
//   merge      the weights are sums of counts, so credit rows from any machine or teammate combine in any order to the same weights
// Written before the code.
// Revised 2026-10-21 after the replay on 108 real transcripts (engine docs/plans/2026-10-21-verifier-credited-memory.md section 7): the
// outcome after a memory is shown measures which prompts match it, not what it contributed (memories never shown read 0.815 against a
// 0.553 base). So an eligible memory is withheld at random (MEMORY_PULSE_HOLDOUT, default 0.1; corrections never), credit is kept in both
// arms {t: [shown passes, shown failures, withheld passes, withheld failures]}, and only the effect between the arms ranks or retires.
// Tests changed by that revision, stated: the retirement and rank tests below, and the integration credit shape [1, 0] -> [1, 0, 0, 0].
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";

test("weights fold credit rows by summing both arms, so any order gives the same weights; an old two-count row is shown-only", async () => {
  const W = await import("../lib/weights.mjs");
  const rows = [{ t: 10, tags: ["credit"], credit: { 3: [2, 0, 1, 0], 4: [0, 1, 0, 0] } }, { t: 11, tags: ["credit"], credit: { 3: [1, 1, 0, 2] } }, { t: 12, tags: ["credit"], credit: { 4: [0, 2], 5: [1, 0, 0, 1] } }];
  const a = W.fold(rows), b = W.fold([rows[2], rows[0], rows[1]]);
  assert.deepEqual([...a].sort(), [...b].sort());
  assert.deepEqual(a.get(3), { s: 3, f: 1, s0: 1, f0: 2 }); assert.deepEqual(a.get(4), { s: 0, f: 3, s0: 0, f0: 0 });
});

test("utility: the effect is shown minus withheld, shrunk to zero without withheld evidence; only a clearly harmful effect past the floor in both arms retires", async () => {
  const W = await import("../lib/weights.mjs");
  const u = (s, f, s0 = 0, f0 = 0) => W.utility({ s, f, s0, f0 });
  assert.equal(u(0, 0).mean, 0.5); assert.ok(u(8, 0).lb > u(1, 0).lb); assert.ok(u(0, 8).ub < u(0, 1).ub);
  assert.equal(u(30, 0).effect, 0, "shown passes alone are what the prompt selected, not what the memory did");
  assert.ok(u(6, 0, 0, 6).effect > 0.3); assert.ok(u(0, 6, 6, 0).effect < -0.3); assert.ok(u(6, 0, 0, 6).effect < u(6, 0, 0, 6).raw, "shrunk by withheld evidence");
  assert.equal(W.retired({ kind: "event" }, { s: 0, f: 20, s0: 0, f0: 0 }), false, "shown-only failures are the work's phase (a red first run), not evidence");
  assert.equal(W.retired({ kind: "event" }, { s: 0, f: 2, s0: 2, f0: 0 }), false, "under the floor");
  assert.equal(W.retired({ kind: "event" }, { s: 0, f: 8, s0: 8, f0: 0 }), true, "checks fail when it is shown and pass when it is withheld");
  assert.equal(W.retired({ kind: "event" }, { s: 4, f: 4, s0: 4, f0: 4 }), false, "no effect is not harm");
  assert.equal(W.retired({ kind: "correction" }, { s: 0, f: 20, s0: 20, f0: 0 }), false, "a correction is a rule, never retired by utility");
});

test("rank: a memory with a measured effect overtakes a slightly more relevant one; shown-only passes (the placebo) and effects under the floor move nothing", async () => {
  const W = await import("../lib/weights.mjs");
  const items = [{ t: 1, hits: 11 }, { t: 2, hits: 10 }, { t: 3, hits: 4 }];     // without evidence t1 leads by relevance
  assert.deepEqual(W.rank(items, new Map([[2, { s: 6, f: 0, s0: 0, f0: 6 }]])).map((x) => x.t), [2, 1, 3]);
  assert.deepEqual(W.rank(items, new Map([[2, { s: 6, f: 0, s0: 0, f0: 2 }]])).map((x) => x.t), [1, 2, 3], "two withheld outcomes are under the floor");
  assert.deepEqual(W.rank(items, new Map([[2, { s: 30, f: 0, s0: 0, f0: 0 }]])).map((x) => x.t), [1, 2, 3]);
  assert.deepEqual(W.rank(items, new Map()).map((x) => x.t), [1, 2, 3]);
});

test("withholding is a reproducible draw per (session, memory) at rate ε, the same at every prompt of the session; 0 never withholds, 1 always", async () => {
  const W = await import("../lib/weights.mjs");
  assert.equal(W.withhold("s1|5", 0.3), W.withhold("s1|5", 0.3));
  assert.equal(W.withhold("s1|5", 0), false); assert.equal(W.withhold("s1|5", 1), true);
  const n = Array.from({ length: 400 }, (_, i) => W.withhold(`s1|${i}|p`, 0.5)).filter(Boolean).length;
  assert.ok(n > 150 && n < 250, `${n} of 400 at 0.5`);
});

test("both arms use one definition of 'would have been shown': a memory in a slot another one freed is recorded whichever way its own draw goes", async () => {
  const { promptSlice } = await import("../server.mjs"); const W = await import("../lib/weights.mjs");
  const rows = [{ t: 1, kind: "event", tags: ["decision"], cause: "refund rounding A", effect: "round per line item before tax, then sum the rounded lines, because the auditors reconcile per line" },
                { t: 2, kind: "event", tags: ["decision"], cause: "refund rounding B", effect: "round the order total once after tax, because the payment processor settles the total" }];
  const q = "refund rounding before tax line item order total";
  const shown = (max, key, eps) => { const picked = [], withheld = []; promptSlice(rows, q, { max, picked, withheld, holdout: eps, holdoutKey: key }); return { picked, withheld }; };
  let max = 60; while (shown(max, "", 0).picked.length < 1) max++;                       // room for exactly one memory
  assert.equal(shown(max, "", 0).picked.length, 1); const [top] = shown(max, "", 0).picked, other = 3 - top;
  const keyWhere = (wantTop, wantOther) => { for (let i = 0; i < 500; i++) { const k = `k${i}`; if (W.withhold(`${k}|${top}`, 0.5) === wantTop && W.withhold(`${k}|${other}`, 0.5) === wantOther) return k; } throw new Error("no key"); };
  const a = shown(max, keyWhere(true, false), 0.5);
  assert.deepEqual(a.picked, [other], "the top memory sat out; the other fills its slot and is shown"); assert.deepEqual(a.withheld, [top]);
  const b = shown(max, keyWhere(true, true), 0.5);
  assert.deepEqual(b.picked, []); assert.deepEqual(b.withheld.sort(), [1, 2], "the other would have been shown in the freed slot, so it is recorded as sat out");
  const c = shown(max, keyWhere(false, true), 0.5);
  assert.deepEqual(c.picked, [top]); assert.deepEqual(c.withheld, [], "the other would not have been shown: nothing to record");
});

// ---- integration: exposure -> credit -> weights -> ranking, through the real hooks
// capture installed the way install-hook writes it: exposures and withholding only happen when something will credit them
const fixture = ({ capture = true } = {}) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mp-weights-"))), work = join(home, "work"); mkdirSync(join(work, ".memory-pulse"), { recursive: true });
  if (capture) { mkdirSync(join(home, ".claude"), { recursive: true }); writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "npx -y memory-pulse capture", async: true }] }] } })); }
  return { home, work };
};
const run = (f, args, stdin, extra = {}) => new Promise((resolve) => {
  const env = { ...process.env, HOME: f.home, MEMORY_PULSE_LEDGER: join(f.work, ".memory-pulse", "events.jsonl"), MEMORY_PULSE_AGENT: join(f.home, "agent.jsonl"), MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_HOLDOUT: "0", ...extra };
  delete env.MEMORY_PULSE_KEY;
  const p = spawn(process.execPath, [SERVER, ...args], { cwd: f.work, env });
  let out = "", err = ""; p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c)); p.on("close", (code) => resolve({ code, out, err, all: out + err }));
  p.stdin.end(stdin ?? "");
});
const ledger = (f) => readFileSync(join(f.work, ".memory-pulse", "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const prompt = (f, sid, text, extra) => run(f, ["prompt"], JSON.stringify({ session_id: sid, cwd: f.work, hook_event_name: "UserPromptSubmit", prompt: text }), extra);
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
  assert.equal(credits.length, 1, "credited once"); assert.deepEqual(credits[0].credit, { [t]: [1, 0, 0, 0] }); assert.equal(credits[0].evidence.episode, "s1");
  const w = await run(f, ["weights"]);
  assert.match(w.out, new RegExp(`t${t}\\b.*1 helped.*0 not`));
});

test("each session is one trial per memory: later checks in the same session, in this consolidation or the next, add nothing", async () => {
  const f = fixture();
  await run(f, ["remember", "refund rounding decision", "round per line item before tax", "--tags", "decision"]);
  const t = ledger(f)[0].t;
  await prompt(f, "o1", "fix the refund rounding before tax"); await check(f, "o1", true);
  await prompt(f, "o1", "the refund rounding before tax again"); await check(f, "o1", false); await stop(f, "o1");
  await prompt(f, "o1", "refund rounding before tax, third time"); await check(f, "o1", false); await stop(f, "o1");
  const sum = ledger(f).filter((e) => (e.tags ?? []).includes("credit")).reduce((a, e) => a.map((x, i) => x + (e.credit[t]?.[i] ?? 0)), [0, 0, 0, 0]);
  assert.deepEqual(sum, [1, 0, 0, 0], "the first check after the memory was first shown is the session's outcome");
});

test("ranking uses the weights: the memory that helped comes first, the one that kept failing is retired from the prompt", async () => {
  const f = fixture();
  await run(f, ["remember", "refund rounding decision A", "round per line item before tax", "--tags", "decision"]);
  await run(f, ["remember", "refund rounding decision B", "round the order total after tax", "--tags", "decision"]);
  const [a, b] = ledger(f).map((e) => e.t);
  const base = await prompt(f, "s0", "refund rounding before tax");
  assert.match(base.out, /line item/); assert.match(base.out, /order total/);
  const credit = (t, c, n) => run(f, ["append", "--json", JSON.stringify({ cause: "credit", effect: `seed-${n}`, tags: ["credit"], credit: { [t]: c } })]);
  await credit(b, [5, 0, 0, 5], 1); await credit(a, [0, 8, 8, 0], 2);
  const after = await prompt(f, "s9", "refund rounding before tax");
  assert.match(after.out, /order total/); assert.doesNotMatch(after.out, /line item/, "retired: failed 8 of 8 shown, passed 8 of 8 withheld");
});

test("without the capture hook the prompt hook records nothing and withholds nothing (the plugin installs no capture)", async () => {
  const f = fixture({ capture: false });
  await run(f, ["remember", "refund rounding decision", "round per line item before tax", "--tags", "decision"]);
  const r = await prompt(f, "n1", "fix the refund rounding before tax", { MEMORY_PULSE_HOLDOUT: "1" });
  assert.match(r.out, /line item/, "shown: nothing would learn from withholding it");
  assert.equal(existsSync(join(f.work, ".memory-pulse", "episodes", "n1.jsonl")), false);
});

test("a withheld memory is left out of the prompt, recorded as withheld, and credited in the withheld arm; a correction is never withheld", async () => {
  const f = fixture();
  await run(f, ["remember", "refund rounding decision", "round per line item before tax", "--tags", "decision"]);
  await run(f, ["remember", "price", "corrected", "--kind", "correction", "--withdrawn", "$49", "--replacement", "$29"]);
  const [t] = ledger(f).map((e) => e.t);
  const r = await prompt(f, "h1", "fix the refund rounding before tax, price $49", { MEMORY_PULSE_HOLDOUT: "1" });
  assert.doesNotMatch(r.out, /line item/); assert.match(r.out, /\$49/, "the correction is shown");
  const ep = readFileSync(join(f.work, ".memory-pulse", "episodes", "h1.jsonl"), "utf8");
  assert.match(ep, new RegExp(`"held":\\[${t}\\]`));
  await check(f, "h1", true); await stop(f, "h1");
  const c = ledger(f).filter((e) => (e.tags ?? []).includes("credit"));
  assert.equal(c.length, 1); assert.deepEqual(c[0].credit[t], [0, 0, 1, 0]);
  const w = await run(f, ["weights"]);
  assert.match(w.out, /withheld: 1 passed, 0 failed/);
});
