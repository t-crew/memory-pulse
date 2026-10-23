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
// Revised again after the independent review (2026-10-21): a credit row is trusted only as one trial per memory (four non-negative
// integers summing to 1, a canonical integer key), once per (episode, memory), over rows in force; merges carry credit to the memory it
// was earned by. Tests changed by that, stated: the fold test and the ranking test now seed one-trial rows instead of rows of many counts.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";

test("weights fold one-trial credit rows by summing both arms, so any order gives the same weights", async () => {
  const W = await import("../lib/weights.mjs");
  const c = (t, ep, credit) => ({ t, tags: ["credit"], credit, evidence: { episode: ep } });
  const rows = [c(10, "a", { 3: [1, 0, 0, 0], 4: [0, 1, 0, 0] }), c(11, "b", { 3: [0, 0, 0, 1] }), c(12, "c", { 4: [0, 1, 0, 0], 5: [0, 0, 1, 0] }), c(13, "d", { 3: [1, 0, 0, 0] })];
  const a = W.fold(rows), b = W.fold([rows[2], rows[3], rows[0], rows[1]]);
  assert.deepEqual([...a].sort(), [...b].sort());
  assert.deepEqual(a.get(3), { s: 2, f: 0, s0: 0, f0: 1 }); assert.deepEqual(a.get(4), { s: 0, f: 2, s0: 0, f0: 0 });
});

test("review: a credit row is trusted only as one trial: more counts, a non-canonical key, an absurd number or a second trial from the same session add nothing", async () => {
  const W = await import("../lib/weights.mjs");
  const c = (t, ep, credit) => ({ t, tags: ["credit"], credit, ...(ep ? { evidence: { episode: ep } } : {}) });
  const w = W.fold([c(1, null, { 1: [0, 6, 6, 0] }), c(2, null, { "0x1": [1, 0, 0, 0], "1.0": [1, 0, 0, 0], " 1": [1, 0, 0, 0] }), c(3, null, { 1: [1e308, 0, 0, 0] }),
                    c(4, null, { 1: [0.5, 0.5, 0, 0] }), c(5, null, { 1: [-1, 2, 0, 0] }), c(6, "s1", { 1: [0, 1, 0, 0] }), c(7, "s1", { 1: [0, 1, 0, 0] }), c(8, "s2", { 1: [0, 0, 1, 0] })]);
  assert.deepEqual(w.get(1), { s: 0, f: 1, s0: 1, f0: 0 });
  assert.equal(W.retired({ kind: "event" }, W.fold([c(1, null, { 7: [0, 6, 6, 0] })]).get(7)), false, "one forged row retires nothing");
});

test("review: project weights never move a row from the agent ledger that happens to share a number", async () => {
  const W = await import("../lib/weights.mjs");
  const strong = new Map([[1, { s: 6, f: 0, s0: 0, f0: 6 }]]);
  assert.deepEqual(W.rank([{ t: 1, hits: 10, own: false }, { t: 2, hits: 11, own: true }], strong).map((x) => x.t), [2, 1]);
  assert.deepEqual(W.rank([{ t: 1, hits: 10, own: true }, { t: 2, hits: 11, own: true }], strong).map((x) => x.t), [1, 2]);
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
  const { CLAUDE_PLUGIN_ROOT: _plugin, ...host } = process.env;       // a test run from inside a plugin hook must not leak its root
  const env = { ...host, HOME: f.home, MEMORY_PULSE_LEDGER: join(f.work, ".memory-pulse", "events.jsonl"), MEMORY_PULSE_AGENT: join(f.home, "agent.jsonl"), MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_HOLDOUT: "0", ...extra };
  delete env.MEMORY_PULSE_KEY;
  for (const [k, v] of Object.entries(extra)) if (v === null) delete env[k];          // null: leave the variable unset (the default)
  const p = spawn(process.execPath, [SERVER, ...args], { cwd: f.work, env });
  let out = "", err = ""; p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c)); p.on("close", (code) => resolve({ code, out, err, all: out + err }));
  p.stdin.end(stdin ?? "");
});
const ledger = (f) => readFileSync(join(f.work, ".memory-pulse", "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const prompt = (f, sid, text, extra) => run(f, ["prompt"], JSON.stringify({ session_id: sid, cwd: f.work, hook_event_name: "UserPromptSubmit", prompt: text }), extra);
const check = (f, sid, ok) => run(f, ["capture"], JSON.stringify({ session_id: sid, cwd: f.work, hook_event_name: ok ? "PostToolUse" : "PostToolUseFailure", tool_name: "Bash", tool_use_id: `${sid}-${Math.random()}`, tool_input: { command: "npm test" }, ...(ok ? { tool_response: { stdout: "ℹ pass 3\nℹ fail 0", stderr: "", interrupted: false } } : { error: "Exit code 1\n✖ totals" }) }));
const stop = (f, sid) => run(f, ["consolidate"], JSON.stringify({ session_id: sid, cwd: f.work, hook_event_name: "Stop" }));
// honest one-trial credit rows, one per session: trials(f, t, [[1, 0, 0, 0], 5], ...) = five sessions in which t was shown and the check passed
let seeded = 0;
async function trials(f, t, ...groups) { for (const [c, n] of groups) for (let i = 0; i < n; i++) await run(f, ["append", "--json", JSON.stringify({ cause: "credit", effect: `seed-${++seeded}`, tags: ["credit"], credit: { [t]: c }, evidence: { episode: `seed-${seeded}` } })]); }

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
  await trials(f, b, [[1, 0, 0, 0], 5], [[0, 0, 0, 1], 5]); await trials(f, a, [[0, 1, 0, 0], 8], [[0, 0, 1, 0], 8]);
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

test("review: state merge carries credit to the memory it was earned by, not to whatever row has that number here", async () => {
  const a = fixture(), b = fixture();
  await run(a, ["remember", "shared base", "the base row both sides have", "--tags", "decision"]);
  const cut = join(a.home, "base.rain"); await run(a, ["state", "branch", "bob", "--out", cut]); await run(b, ["state", "import", cut]);
  await run(b, ["remember", "bob refund rounding", "round per line item before tax", "--tags", "decision"]);
  const bt = ledger(b).at(-1).t;
  await trials(b, bt, [[0, 1, 0, 0], 6], [[0, 0, 1, 0], 6]);                         // on Bob's side: clearly harmful, retired
  for (let i = 0; ledger(a).at(-1).t + 1 < bt; i++) await run(a, ["remember", `alice filler ${i}`, `row ${i}`]);   // import wrote a row on Bob's side
  await run(a, ["remember", "alice checkout", "ship the checkout flag on friday", "--tags", "decision"]);
  const at = ledger(a).at(-1).t; assert.equal(at, bt, "Alice's own decision has the number Bob's memory had");
  const capB = join(b.home, "bob.rain"); await run(b, ["state", "export", "--out", capB]);
  const m = await run(a, ["state", "merge", capB]); assert.equal(m.code, 0, m.all);
  const W = await import("../lib/weights.mjs"); const rows = ledger(a), w = W.fold(rows);
  const carried = rows.find((e) => e.cause === "bob refund rounding"); assert.ok(carried && carried.t !== bt);
  assert.equal(w.get(at), undefined, "Alice's decision earned no credit"); assert.deepEqual(w.get(carried.t), { s: 0, f: 6, s0: 6, f0: 0 });
  assert.match((await prompt(a, "m1", "ship the checkout flag on friday")).out, /checkout flag/);
});

test("review: state rollback takes credit rows out of force with everything else", async () => {
  const f = fixture();
  await run(f, ["remember", "refund rounding decision", "round per line item before tax", "--tags", "decision"]);
  const t = ledger(f)[0].t;
  await trials(f, t, [[0, 1, 0, 0], 6], [[0, 0, 1, 0], 6]);
  assert.doesNotMatch((await prompt(f, "r1", "refund rounding before tax")).out, /line item/, "retired");
  const rb = await run(f, ["state", "rollback", "--to", String(t), "credit was seeded by a test"]); assert.equal(rb.code, 0, rb.all);
  assert.match((await prompt(f, "r2", "refund rounding before tax")).out, /line item/, "the credit is rolled back, so the memory is back");
});

test("review: a memory sitting out the session is left out of the session-start brief too; corrections never are", async () => {
  const f = fixture();
  await run(f, ["remember", "refund rounding decision", "round per line item before tax", "--tags", "decision"]);
  await run(f, ["remember", "price", "corrected", "--kind", "correction", "--withdrawn", "$49", "--replacement", "$29"]);
  const start = JSON.stringify({ session_id: "b1", hook_event_name: "SessionStart", source: "startup", cwd: f.work });
  const held = await run(f, ["brief"], start, { MEMORY_PULSE_HOLDOUT: "1", CLAUDE_PROJECT_DIR: f.work });
  assert.doesNotMatch(held.out, /line item/); assert.match(held.out, /\$49/);
  const shown = await run(f, ["brief"], start, { MEMORY_PULSE_HOLDOUT: "0", CLAUDE_PROJECT_DIR: f.work });
  assert.match(shown.out, /line item/);
});

test("review: capture counts as installed only as a hook that can run: not a permission entry, not with every hook disabled", async () => {
  for (const settings of [{ permissions: { allow: ["Bash(npx -y memory-pulse capture)"] } },
                          { disableAllHooks: true, hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "npx -y memory-pulse capture" }] }] } }]) {
    const f = fixture({ capture: false }); mkdirSync(join(f.home, ".claude"), { recursive: true }); writeFileSync(join(f.home, ".claude", "settings.json"), JSON.stringify(settings));
    await run(f, ["remember", "refund rounding decision", "round per line item before tax", "--tags", "decision"]);
    const r = await prompt(f, "c1", "fix the refund rounding before tax", { MEMORY_PULSE_HOLDOUT: "1" });
    assert.match(r.out, /line item/); assert.equal(existsSync(join(f.work, ".memory-pulse", "episodes", "c1.jsonl")), false, JSON.stringify(settings));
  }
});

// ---- re-review of the fixes (2026-10-21)
test("re-review: a fix sitting out the session still closes the thread it closed", async () => {
  const f = fixture();
  await check(f, "s1", false); await run(f, ["consolidate", "--final"], JSON.stringify({ session_id: "s1", cwd: f.work, hook_event_name: "SessionEnd" }));
  await check(f, "s2", false);
  await run(f, ["capture"], JSON.stringify({ session_id: "s2", cwd: f.work, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "s2-edit", tool_input: { file_path: join(f.work, "tax.js"), old_string: "a", new_string: "b" }, tool_response: {} }));
  await check(f, "s2", true); await stop(f, "s2");
  assert.ok(ledger(f).some((e) => (e.tags ?? []).includes("fix") && e.resolves?.length));
  const r = await run(f, ["brief"], JSON.stringify({ session_id: "s3", hook_event_name: "SessionStart", cwd: f.work }), { MEMORY_PULSE_HOLDOUT: "1", CLAUDE_PROJECT_DIR: f.work });
  assert.doesNotMatch(r.out, /passed after editing tax\.js/, "the fix itself sits out this session");
  assert.doesNotMatch(r.out, /still failing/, "and the thread it closed stays closed");
});

test("re-review: the brief reads a SessionStart payload that arrives late on stdin", async () => {
  const f = fixture();
  await run(f, ["remember", "refund rounding decision", "round per line item before tax", "--tags", "decision"]);
  const env = { ...process.env, HOME: f.home, MEMORY_PULSE_LEDGER: join(f.work, ".memory-pulse", "events.jsonl"), MEMORY_PULSE_AGENT: join(f.home, "agent.jsonl"), MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_HOLDOUT: "1", CLAUDE_PROJECT_DIR: f.work };
  delete env.MEMORY_PULSE_KEY;
  const out = await new Promise((resolve) => { const p = spawn(process.execPath, [SERVER, "brief"], { cwd: f.work, env }); let o = ""; p.stdout.on("data", (c) => (o += c)); p.on("close", () => resolve(o));
    setTimeout(() => p.stdin.end(JSON.stringify({ session_id: "late", hook_event_name: "SessionStart" })), 150); });
  assert.doesNotMatch(out, /line item/, "withheld: the payload came 150 ms after the start");
});

// ---- 0.13.1 (2026-10-21, Travis: "do what's best"): withhold only where the evidence can reach a decision
//   default   off when this ledger's credit comes from one machine (replay: at 1 in 10 one person's 105 sessions never reached the
//             floor, so a solo user paid in missing memories and learned nothing); 1 in 10 once credit from two machines is pooled here
//             (teammates committing the ledger, state merge, hosted memory); MEMORY_PULSE_HOLDOUT always overrides
//   decided   a memory whose effect is settled stops sitting out: past the floor in both arms and a 99% interval excluding zero, or a
//             95% interval narrower than +/-0.1
//   machine   each credit row names the machine that earned it (a random id in ~/.config/memory-pulse/machine-id), which is how pooling
//             is seen
// Written before the code.
const credRow = (t, c, ep, machine) => ({ t, tags: ["credit"], credit: c, evidence: { episode: ep, ...(machine ? { machine } : {}) } });
test("0.13.1: pooled is credit from two machines; the default rate is 0 alone and 0.1 pooled; MEMORY_PULSE_HOLDOUT overrides", async () => {
  const W = await import("../lib/weights.mjs");
  const solo = [credRow(1, { 5: [1, 0, 0, 0] }, "a", "m1"), credRow(2, { 5: [0, 1, 0, 0] }, "b", "m1"), credRow(3, { 5: [1, 0, 0, 0] }, "c")];
  const team = [...solo, credRow(4, { 5: [1, 0, 0, 0] }, "d", "m2")];
  assert.equal(W.pooled(solo), false); assert.equal(W.pooled(team), true); assert.equal(W.pooled([]), false);
  assert.equal(W.holdoutRate({}, solo), 0); assert.equal(W.holdoutRate({}, team), 0.1);
  assert.equal(W.holdoutRate({ MEMORY_PULSE_HOLDOUT: "0.3" }, solo), 0.3); assert.equal(W.holdoutRate({ MEMORY_PULSE_HOLDOUT: "0" }, team), 0);
});

test("0.13.1: a memory whose effect is decided stops sitting out", async () => {
  const W = await import("../lib/weights.mjs");
  assert.equal(W.decided({ s: 3, f: 3, s0: 3, f0: 3 }), false, "past the floor, effect unknown");
  assert.equal(W.decided({ s: 12, f: 0, s0: 0, f0: 12 }), true, "clearly helps");
  assert.equal(W.decided({ s: 0, f: 2, s0: 2, f0: 0 }), false, "under the floor");
  assert.equal(W.decided({ s: 200, f: 200, s0: 200, f0: 200 }), true, "no effect, measured to within 0.1");
});

test("0.13.1: alone, nothing sits out by default; with credit from a second machine, 1 in 10 does", async () => {
  const W = await import("../lib/weights.mjs");
  const f = fixture();
  await run(f, ["remember", "refund rounding decision", "round per line item before tax", "--tags", "decision"]);
  const t = ledger(f)[0].t;
  let sid = ""; for (let i = 0; i < 2000 && !sid; i++) if (W.withhold(`d${i}|${t}`, 0.1)) sid = `d${i}`;   // a session whose draw at 0.1 is "sit out"
  const solo = await prompt(f, sid, "fix the refund rounding before tax", { MEMORY_PULSE_HOLDOUT: null });
  assert.match(solo.out, /line item/, "one machine: shown");
  for (const m of ["m1", "m2"]) await run(f, ["append", "--json", JSON.stringify({ cause: "credit", effect: `seed-${m}`, tags: ["credit"], credit: { 999: [1, 0, 0, 0] }, evidence: { episode: `e-${m}`, machine: m } })]);
  const team = await prompt(f, `${sid}`, "the refund rounding before tax again", { MEMORY_PULSE_HOLDOUT: null });
  assert.doesNotMatch(team.out, /line item/, "two machines: this session's draw sits it out");
});

test("0.13.1: a decided memory is shown even at MEMORY_PULSE_HOLDOUT=1, in the prompt and the brief", async () => {
  const f = fixture();
  await run(f, ["remember", "refund rounding decision", "round per line item before tax", "--tags", "decision"]);
  const t = ledger(f)[0].t;
  await trials(f, t, [[1, 0, 0, 0], 12], [[0, 0, 0, 1], 12]);
  assert.match((await prompt(f, "x1", "fix the refund rounding before tax", { MEMORY_PULSE_HOLDOUT: "1" })).out, /line item/);
  const b = await run(f, ["brief"], JSON.stringify({ session_id: "x2", hook_event_name: "SessionStart" }), { MEMORY_PULSE_HOLDOUT: "1", CLAUDE_PROJECT_DIR: f.work });
  assert.match(b.out, /line item/);
});

test("0.13.1: every credit row names this machine, the same id each time", async () => {
  const f = fixture();
  await run(f, ["remember", "refund rounding decision", "round per line item before tax", "--tags", "decision"]);
  for (const sid of ["k1", "k2"]) { await prompt(f, sid, "fix the refund rounding before tax"); await check(f, sid, true); await stop(f, sid); }
  const ids = ledger(f).filter((e) => (e.tags ?? []).includes("credit")).map((e) => e.evidence?.machine);
  assert.equal(ids.length, 2); assert.match(ids[0], /^[0-9a-f]{12}$/); assert.equal(ids[0], ids[1]);
  assert.equal(readFileSync(join(f.home, ".config", "memory-pulse", "machine-id"), "utf8").trim(), ids[0]);
});

test("0.13.1: the plugin's own capture hook counts as installed when the hook runs from the plugin", async () => {
  const f = fixture({ capture: false }), root = join(SERVER, "..");
  await run(f, ["remember", "refund rounding decision", "round per line item before tax", "--tags", "decision"]);
  await prompt(f, "pl1", "fix the refund rounding before tax", { CLAUDE_PLUGIN_ROOT: root });
  assert.ok(existsSync(join(f.work, ".memory-pulse", "episodes", "pl1.jsonl")), "exposure recorded: the plugin installs capture");
  await prompt(f, "pl2", "fix the refund rounding before tax", { CLAUDE_PLUGIN_ROOT: f.home });
  assert.equal(existsSync(join(f.work, ".memory-pulse", "episodes", "pl2.jsonl")), false, "a plugin root that is not this server's");
});

test("0.13.1: retirement needs the 99% interval below zero, because it is checked every session and freezes the memory once it fires", async () => {
  const W = await import("../lib/weights.mjs");
  const borderline = { s: 2, f: 6, s0: 6, f0: 2 };               // 95% interval below zero, 99% interval not (placebo replay: 2 false retirements at 95%)
  const u = W.utility(borderline); assert.ok(u.raw + 1.96 * u.esd < 0 && u.raw + 2.576 * u.esd > 0, "fixture is borderline");
  assert.equal(W.retired({ kind: "event" }, borderline), false);
  assert.equal(W.retired({ kind: "event" }, { s: 0, f: 8, s0: 8, f0: 0 }), true);
});
