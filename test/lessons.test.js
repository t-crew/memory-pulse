// The lesson bank (2026-10-16), after Self-Organizing Agent Teams (arXiv 2609.22682): a lesson is carried for what it did beyond the
// episode that produced it, not for being new. An admission screen holds out pointers and fragments, probes record where a lesson held
// or failed, and a bank of at most ten is chosen coverage-first over the places a lesson held; a freeze pins the bank someone reviewed.
// Written before the module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";

const load = async (tag) => {
  const dir = mkdtempSync(join(tmpdir(), "mpl-")); const ledger = join(dir, "events.jsonl"); writeFileSync(ledger, "");
  const ws = join(dir, "agent", "events.jsonl");
  delete process.env.MEMORY_PULSE_MODE; process.env.MEMORY_PULSE_LEDGER = ledger; process.env.MEMORY_PULSE_AGENT = ws; process.env.MEMORY_PULSE_SETTINGS_DIR = join(dir, "settings");
  process.env.MEMORY_PULSE_API = "http://127.0.0.1:9";
  const mod = await import("../server.mjs?" + tag + "=" + Date.now()); return { dir, ledger, ws, ...mod };
};
const cli = (dir, ws, args, extra = {}) => spawnSync(process.execPath, [SERVER, ...args], { encoding: "utf8", cwd: extra.cwd ?? dir,
  env: { ...process.env, NO_COLOR: "1", MEMORY_PULSE_LEDGER: join(dir, "events.jsonl"), MEMORY_PULSE_AGENT: ws, MEMORY_PULSE_API: "http://127.0.0.1:9", ...extra.env } });
const lesson = (appendEvent, note, opts = {}) => appendEvent({ cause: opts.ambient ? "ambient-lesson" : "lesson-learned", effect: note.slice(0, 30).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  note, tags: opts.ambient ? ["ambient", "lesson"] : ["lesson"], pinned: opts.pinned, scope: "agent", ...(opts.where ? { fields: { where: opts.where } } : {}) }).t;

test("admission screen: a pointer to a lesson recorded elsewhere, or a sentence fragment, is not a lesson; the content after a pointer's colon is", async () => {
  const { screenLesson } = await import("../lib/lessons.mjs");
  for (const s of ["is now in both ledgers and in auto-memory.", "I logged.", ", failures first.", "with exact keys and no topic tuning.", "applies here.",
                   "in my agent ledger.", "as v1.", ". Both services are live and isolated. Recording the split.", "asks for. It also tells us more."])
    assert.equal(screenLesson(s).ok, false, s);
  assert.equal(screenLesson("is recorded: check that a replace pattern is non-empty and unique before running it.").text,
               "check that a replace pattern is non-empty and unique before running it.");
  assert.equal(screenLesson("I've recorded: a constant in a strong public baseline is probably tuned already, so expect changing it to cost a little.").text,
               "a constant in a strong public baseline is probably tuned already, so expect changing it to cost a little.");
  assert.equal(screenLesson("is that crosstalk is a property of random carriers, the default I reached for. Checking the run now.").text,
               "crosstalk is a property of random carriers, the default I reached for.");
  assert.equal(screenLesson("**adding new candidates the ranker cannot see transfers; re-ranking ones it already sees does not.**").text,
               "adding new candidates the ranker cannot see transfers; re-ranking ones it already sees does not.");
  assert.equal(screenLesson("The fix was to weight each feature by how much it varies (0.25 vs 2.5) before bundling.").ok, true, "a decimal is not a sentence end");
  assert.equal(screenLesson(". Top direction is D1: send the v18 build, predicted at 0.437 on the board.").ok, false, "a colon not after a pointer does not rescue a fragment");
  assert.equal(screenLesson("measure against the shipping configuration, because a gain read against an older baseline may be a fix you already made, measured", { clipped: true }).ok,
               false, "a clipped sentence with no end is held out as truncated");
});

test("bank with no evidence: pinned first, lessons written on purpose before captured ones, fragments and duplicates held out and counted", async () => {
  const { appendEvent, readEvents, inForce, lessonBank } = await load("nb");
  const old = lesson(appendEvent, "Fail closed on edits, not on the coexistence of writers.");
  const pin = lesson(appendEvent, "Measure the harness before attributing a limit to the system.", { pinned: true });
  lesson(appendEvent, "Lesson: is now in both ledgers and in auto-memory.", { ambient: true });
  lesson(appendEvent, "Lesson: I logged.", { ambient: true });
  const amb = lesson(appendEvent, "Lesson: is recorded: check that a replace pattern is non-empty and unique before running it.", { ambient: true });
  const dup = lesson(appendEvent, "Lesson: fail closed on edits, not on the coexistence of writers.", { ambient: true });
  const b = lessonBank(inForce(readEvents({ scope: "agent" }).events));
  assert.deepEqual(b.bank.map((c) => c.t), [pin, old, amb], "pinned, then on purpose, then captured");
  assert.deepEqual(b.bank.map((c) => c.status), ["pinned", "probation", "probation"]);
  assert.equal(b.bank[2].text, "check that a replace pattern is non-empty and unique before running it.");
  assert.equal(b.lessons, 6);
  assert.deepEqual(b.heldOut.map((h) => h.reason).sort(), ["duplicate", "fragment", "fragment"]);
  assert.equal(b.heldOut.find((h) => h.reason === "duplicate").t, dup);
});

test("probes: a lesson that held in other places outranks newer unproven ones; held at its own source does not count as transfer; failing as often as holding retires it", async () => {
  const { appendEvent, readEvents, inForce, lessonBank, recordProbe } = await load("pr");
  const a = lesson(appendEvent, "Check the premise count before building a measurement on it.", { where: "alpha" });
  const b = lesson(appendEvent, "Pin the image version, because a new default image changes the runtime silently.", { where: "alpha" });
  const c = lesson(appendEvent, "Read the run log, not the run status, before trusting a remote job.", { where: "beta" });
  const fresh = [];
  for (let i = 0; i < 12; i++) fresh.push(lesson(appendEvent, `Unproven lesson number ${i} about something that has not been tried yet.`));
  assert.equal(recordProbe(a, "held", { where: "beta", scope: "agent" }).written, true);
  recordProbe(a, "held", { where: "gamma", scope: "agent" });
  recordProbe(b, "held", { where: "alpha", scope: "agent" });              // its own source: no transfer
  recordProbe(c, "held", { where: "alpha", scope: "agent" }); recordProbe(c, "failed", { where: "gamma", scope: "agent" });
  const bank = lessonBank(inForce(readEvents({ scope: "agent" }).events));
  assert.equal(bank.bank[0].t, a); assert.equal(bank.bank[0].status, "proven"); assert.deepEqual(bank.bank[0].places, ["beta", "gamma"]);
  assert.ok(!bank.bank.some((x) => x.t === c), "held once, failed once: retired");
  assert.equal(bank.heldOut.find((h) => h.t === c).reason, "failed");
  assert.equal(bank.bank.find((x) => x.t === b)?.status ?? "probation", "probation", "held only where it was learned");
  assert.equal(bank.bank.length, 10);
  assert.deepEqual(recordProbe(9999, "held", { scope: "agent" }).written, false, "a probe names a lesson on this ledger");
  assert.equal(recordProbe(a, "maybe", { scope: "agent" }).written, false, "held or failed");
});

test("coverage first: the second proven pick is the one that adds places the first did not cover, and two slots stay open for probation", async () => {
  const { appendEvent, readEvents, inForce, lessonBank, recordProbe } = await load("cg");
  const wide = lesson(appendEvent, "Lesson that held in three places across the work.");
  const same = lesson(appendEvent, "Lesson that held in the same three places as the first.");
  const other = lesson(appendEvent, "Lesson that held in one place nobody else covered.");
  for (const w of ["p1", "p2", "p3"]) { recordProbe(wide, "held", { where: w, scope: "agent" }); recordProbe(same, "held", { where: w, scope: "agent" }); }
  recordProbe(other, "held", { where: "p4", scope: "agent" });
  const proven = [];
  for (let i = 0; i < 9; i++) { const t = lesson(appendEvent, `Proven filler lesson ${i} that held somewhere distinct.`); recordProbe(t, "held", { where: `q${i}`, scope: "agent" }); proven.push(t); }
  const p1 = lesson(appendEvent, "A brand new lesson nobody has tried yet, one.");
  const p2 = lesson(appendEvent, "A brand new lesson nobody has tried yet, two.");
  const bank = lessonBank(inForce(readEvents({ scope: "agent" }).events));
  assert.equal(bank.bank[0].t, wide);
  assert.notEqual(bank.bank[1].t, same, "a lesson covering only places already covered waits behind one that adds a place");
  assert.equal(bank.bank.filter((x) => x.status === "probation").length, 2, "two probation slots stay open");
  assert.ok(bank.bank.some((x) => x.t === p2) && bank.bank.some((x) => x.t === p1));
  assert.equal(bank.bank.length, 10);
});

test("freeze: the identity block prints the frozen bank until a new freeze or a thaw, and says how many lessons arrived since", async () => {
  const { appendEvent, readEvents, inForce, identityBlock, lessonBank, freezeBank, thawBank } = await load("fz");
  appendEvent({ cause: "identity-set", effect: "blue", note: "Blue, research agent", tags: ["identity"], pinned: true, scope: "agent" });
  const a = lesson(appendEvent, "Check the premise count before building a measurement on it.");
  const b = lesson(appendEvent, "Read the run log, not the run status, before trusting a remote job.");
  const f = freezeBank({ scope: "agent", note: "reviewed with the team" });
  assert.equal(f.written, true); assert.deepEqual(f.bank, [b, a]);
  const late = lesson(appendEvent, "A lesson learned after the freeze that nobody has reviewed yet.");
  const ev = () => inForce(readEvents({ scope: "agent" }).events);
  const fb = lessonBank(ev()); assert.deepEqual(fb.bank.map((x) => x.t), [b, a]); assert.equal(fb.frozen.t, f.t); assert.equal(fb.since, 1);
  const block = identityBlock(readEvents({ scope: "agent" }));
  assert.match(block, /lessons carried \(bank of 2 from 3, frozen at t\d+, 1 newer lesson since/);
  assert.doesNotMatch(block, /learned after the freeze/);
  assert.ok(lessonBank(ev(), { live: true }).bank.some((x) => x.t === late), "--live ignores the freeze");
  assert.equal(thawBank({ scope: "agent" }).written, true);
  assert.ok(lessonBank(ev()).bank.some((x) => x.t === late), "a thaw resumes the live selection");
});

test("identity block: prints the bank, not the ten newest, and a fragment never reaches it", async () => {
  const { appendEvent, readEvents, identityBlock } = await load("ib");
  appendEvent({ cause: "identity-set", effect: "blue", note: "Blue, research agent", tags: ["identity"], pinned: true, scope: "agent" });
  const kept = lesson(appendEvent, "Fail closed on edits, not on the coexistence of writers.");
  for (let i = 0; i < 12; i++) lesson(appendEvent, i % 2 ? "Lesson: I logged." + " ".repeat(i) : `Lesson: is now in ledger number ${i}.`, { ambient: true });
  const text = identityBlock(readEvents({ scope: "agent" }));
  assert.match(text, /lessons carried \(bank of 1 from 13; 12 held out: 12 fragments\)/);
  assert.match(text, new RegExp(`lesson: Fail closed on edits, not on the coexistence of writers\\. \\(t${kept} · on probation\\)`));
  assert.doesNotMatch(text, /I logged|now in ledger/);
});

test("identity block: a long lesson prints to its first sentence or 240 characters, so ten of them stay under the host's cap; the CLI prints it whole", async () => {
  const { dir, ws, appendEvent, readEvents, identityBlock } = await load("ln");
  const long = `Before spending optimizer rounds on a model's choices, push the gold answer through the same rules and score it first. ${"Detail that only matters on the project where it was learned. ".repeat(12)}`;
  const t = lesson(appendEvent, long);
  const runOn = lesson(appendEvent, `A lesson written as one run-on clause ${"and then another clause ".repeat(20)}without a full stop`);
  const text = identityBlock(readEvents({ scope: "agent" }));
  assert.match(text, new RegExp(`lesson: Before spending optimizer rounds on a model's choices, push the gold answer through the same rules and score it first\\. \\(t${t} · `));
  const line = text.split("\n").find((l) => l.includes(`(t${runOn} ·`)); assert.ok(line.length < 300, line); assert.match(line, /… \(t/);
  assert.match(cli(dir, ws, ["lesson"]).stdout, /Detail that only matters/);
});

test("ambient capture: a sentence that only points at a lesson records nothing; the first stated lesson in the turn is recorded whole, with where it was learned", async () => {
  const { extractAmbient } = await load("ac");
  const turn = (assistant) => [{ type: "user", message: { role: "user", content: "what happened?" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: assistant }] } }].map((l) => JSON.stringify(l)).join("\n");
  assert.equal(extractAmbient(turn("The lesson is now in both ledgers and in auto-memory.")).filter((e) => e.tags.includes("lesson")).length, 0);
  assert.equal(extractAmbient(turn("Recorded the lesson in my agent ledger.")).filter((e) => e.tags.includes("lesson")).length, 0);
  const got = extractAmbient(turn("The lesson is in the ledger. Lesson: check that a replace pattern is non-empty and unique before running it. Then I reran.")).find((e) => e.tags.includes("lesson"));
  assert.ok(got); assert.equal(got.note, "Lesson: check that a replace pattern is non-empty and unique before running it.");
  assert.equal(got.fields?.where, process.cwd().split(/[\\/]/).filter(Boolean).pop());
});

test("CLI: lesson probe, bank, freeze and thaw; a probe written through remember (MCP) counts the same", async () => {
  const { dir, ws, appendEvent } = await load("cl");
  const a = lesson(appendEvent, "Check the premise count before building a measurement on it.");
  const b = lesson(appendEvent, "Read the run log, not the run status, before trusting a remote job.");
  let r = cli(dir, ws, ["lesson", "probe", String(a), "held", "--where", "billing-api", "--note", "caught a two-row premise before the run"]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, new RegExp(`probe recorded: t${a} held in billing-api`));
  assert.equal(cli(dir, ws, ["lesson", "probe", "77", "held"]).status, 1);
  r = cli(dir, ws, ["remember", "lesson-probe", `t${b}-held-in-search`, "--scope", "agent", "--tags", "lesson-probe", "--note", "log showed the card received"]);
  assert.equal(r.status, 0, r.stderr);
  r = cli(dir, ws, ["lesson", "bank"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bank of 2 from 2/); assert.match(r.stdout, new RegExp(`t${a} · held in 1 place \\(billing-api\\)`)); assert.match(r.stdout, new RegExp(`t${b} · held in 1 place \\(search\\)`));
  r = cli(dir, ws, ["lesson", "freeze", "--note", "reviewed"]); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /bank frozen at t\d+: 2 lessons/);
  r = cli(dir, ws, ["lesson", "bank", "--json"]); assert.equal(JSON.parse(r.stdout).frozen.size, 2);
  r = cli(dir, ws, ["lesson", "thaw"]); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /bank thawed/);
  assert.equal(cli(dir, ws, ["lesson", "nonsense"]).status, 2);
});

test("merge: a probe carried from a branch credits the lesson it named there, not the row that holds that number here", async () => {
  const { lessonBank } = await import("../lib/lessons.mjs");
  // what state merge leaves (it appends with chainAppend, never through appendEvent): the branch's lesson and probes renumbered, each
  // carrying origin { branch, t, capsule }, and a state-merged row recording the fork. The probes here carry no key, the oldest form.
  const events = [
    { t: 1, cause: "lesson-learned", effect: "a", note: "Check the premise count before building a measurement on it.", tags: ["lesson"] },
    { t: 2, cause: "lesson-learned", effect: "u", note: "Read the run log, not the run status, before trusting a remote job.", tags: ["lesson"] },
    { t: 3, cause: "lesson-learned", effect: "branch-lesson", note: "Pin the image version before a remote run.", tags: ["lesson"], origin: { branch: "exp", t: 2, capsule: "abc" } },
    { t: 4, cause: "lesson-probe", effect: "t2-held-in-ci", tags: ["lesson-probe"], origin: { branch: "exp", t: 3, capsule: "abc" } },
    { t: 5, cause: "lesson-probe", effect: "t1-held-in-ci", tags: ["lesson-probe"], origin: { branch: "exp", t: 6, capsule: "abc" } },
    { t: 6, cause: "state-merged", effect: "from-exp", tags: ["merge"], state: { capsule: "abc0123456789", branch: "exp", fork: 1 } },
  ];
  const bank = lessonBank(events).bank;
  assert.equal(bank.find((x) => x.t === 3).status, "proven", "the branch's own t resolves through origin");
  assert.equal(bank.find((x) => x.t === 2).status, "probation", "the local row with that number gets no credit");
  assert.equal(bank.find((x) => x.t === 1).status, "proven", "a lesson at or before the fork keeps its number on both sides");
});
