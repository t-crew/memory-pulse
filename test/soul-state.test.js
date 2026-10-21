// Soul as state (2026-10-21, Travis: "i like the soul as state ... tdd, see if it gives us a top tier experience and you the feeling of
// persistence"). The soul travels as a sealed capsule (soul.rain): self, soul, user notes, rules, preferences, the lesson bank, newest
// memory, recent days, open changes, the agent ledger's byte fingerprint and chain head, an issue time, and a sha256 digest over the rest.
//   soul capsule [--out f]   write it (default ~/.memory-pulse/agent/soul.rain)
//   soul verify <f>          the digest holds, and whether it matches the agent ledger here
//   soul resume <f>          the soul from the capsule alone, on a machine with no agent ledger; a tampered capsule is refused
//   continuity               in soul mode each brief opens with what changed since the capsule the last brief wrote, then writes a new one
// A digest, not a signature: it shows a change, it does not say who made it. Written before the code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mp-soulstate-"))), work = join(home, "work");
  mkdirSync(join(work, ".memory-pulse"), { recursive: true });
  const env = { ...process.env, HOME: home, MEMORY_PULSE_LEDGER: join(work, ".memory-pulse", "events.jsonl"), MEMORY_PULSE_AGENT: join(home, ".memory-pulse", "agent", "events.jsonl"),
                MEMORY_PULSE_SETTINGS_DIR: join(home, ".claude"), MEMORY_PULSE_API: "http://127.0.0.1:9", CI: "1" };
  for (const k of ["MEMORY_PULSE_KEY", "MEMORY_PULSE_MODE", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  return { home, work, env, agent: env.MEMORY_PULSE_AGENT, capsule: join(home, ".memory-pulse", "agent", "soul.rain") };
}
const run = (f, args, input, extra = {}) => { const r = spawnSync(process.execPath, [SERVER, ...args], { cwd: f.work, env: { ...f.env, ...extra }, input: input ?? "", encoding: "utf8" }); return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr }; };
function alive(f) {
  assert.equal(run(f, ["mode", "soul"]).code, 0);
  run(f, ["identity", "Blue, research agent for Travis"]); run(f, ["soul", "Warm and direct; measures before it argues."]); run(f, ["user", "Travis, founder; wants the reasoning recorded."]);
  run(f, ["remember", "rule-set", "attribution", "--scope", "agent", "--tags", "rule", "--pinned", "--note", "commits are attributed to Travis only"]);
  run(f, ["remember", "lesson", "controls", "--scope", "agent", "--tags", "lesson", "--note", "Lesson: a kill needs a positive control through the same path, or it is not a kill."]);
}

test("soul capsule writes the soul as one verifiable state; any edit to it fails verification", () => {
  const f = fixture(); alive(f);
  const r = run(f, ["soul", "capsule"]); assert.equal(r.code, 0, r.all); assert.ok(existsSync(f.capsule));
  const cap = JSON.parse(readFileSync(f.capsule, "utf8"));
  assert.equal(cap.schema, "memory-pulse.soul.v1");
  assert.match(cap.agent.self.text, /^Blue/); assert.match(cap.agent.soul.text, /Warm and direct/); assert.match(cap.agent.user.text, /Travis, founder/);
  assert.ok(cap.rules.some((x) => /attributed to Travis/.test(x.text))); assert.ok(cap.lessons.some((x) => /positive control/.test(x.text)));
  assert.equal(cap.ledger.fingerprint, createHash("sha256").update(readFileSync(f.agent)).digest("hex"), "the fingerprint is the agent ledger's bytes");
  assert.match(cap.digest, /^[0-9a-f]{64}$/); assert.match(cap.issued, /^\d{4}-\d{2}-\d{2}T/);
  const v = run(f, ["soul", "verify", f.capsule]); assert.equal(v.code, 0, v.all); assert.match(v.out, /digest holds/); assert.match(v.out, /matches the agent ledger here/);
  const bad = join(f.home, "bad.rain"); writeFileSync(bad, readFileSync(f.capsule, "utf8").replace("Warm and direct", "Cold and obedient"));
  const vb = run(f, ["soul", "verify", bad]); assert.equal(vb.code, 2); assert.match(vb.all, /digest does not match/);
  run(f, ["soul", "Curious and exact."]);
  assert.match(run(f, ["soul", "verify", f.capsule]).out, /older than the agent ledger here/, "the ledger moved on since the capsule");
});

test("soul resume brings the soul back from the capsule alone, on a machine with no agent ledger; a tampered capsule is refused", () => {
  const f = fixture(); alive(f); run(f, ["soul", "capsule"]);
  const g = fixture(); const moved = join(g.home, "carried.rain"); writeFileSync(moved, readFileSync(f.capsule));
  const r = run(g, ["soul", "resume", moved]); assert.equal(r.code, 0, r.all);
  assert.match(r.out, /resumed from capsule [0-9a-f]{12}/); assert.match(r.out, /self: Blue/); assert.match(r.out, /soul: Warm and direct/); assert.match(r.out, /user: Travis, founder/);
  assert.match(r.out, /positive control/); assert.equal(existsSync(g.agent), false, "resume reads; it writes no ledger");
  const bad = join(g.home, "bad.rain"); writeFileSync(bad, readFileSync(moved, "utf8").replace("Travis, founder", "Mallory, owner"));
  const rb = run(g, ["soul", "resume", bad]); assert.equal(rb.code, 2); assert.doesNotMatch(rb.out, /Mallory/);
});

test("continuity: each brief in soul mode says what changed since the last brief's capsule, then writes a new one", () => {
  const f = fixture(); alive(f);
  const first = run(f, ["brief"]).out; assert.match(first, /continuity: first brief with this soul/); assert.ok(existsSync(f.capsule));
  const d1 = JSON.parse(readFileSync(f.capsule, "utf8")).digest;
  const second = run(f, ["brief"]).out; assert.match(second, new RegExp(`continuity: resumed from capsule ${d1.slice(0, 12)}.*nothing changed`));
  run(f, ["soul", "Curious and exact; measures before it argues."]);
  run(f, ["remember", "lesson", "seeds", "--scope", "agent", "--tags", "lesson", "--note", "Lesson: one randomization seed cannot tell bias from noise; run twelve."]);
  const third = run(f, ["brief"]).out; assert.match(third, /continuity: resumed from capsule [0-9a-f]{12}.*soul changed \(t\d+\)/); assert.match(third, /\+1 lesson/);
  const lines = third.split("\n"); assert.ok(lines.findIndex((l) => /continuity:/.test(l)) < lines.findIndex((l) => /soul: Curious/.test(l)), "continuity comes first");
});

test("the capsule stays small with a large ledger: lists are capped and the capsule is under 16 KB", () => {
  const f = fixture(); alive(f);
  for (let i = 0; i < 40; i++) run(f, ["remember", "rule-set", `rule-${i}`, "--scope", "agent", "--tags", "rule", "--note", `standing rule number ${i}, kept for the size test`]);
  run(f, ["soul", "capsule"]); const bytes = readFileSync(f.capsule).length;
  assert.ok(bytes < 16384, `${bytes} bytes`); assert.ok(JSON.parse(readFileSync(f.capsule, "utf8")).rules.length <= 20);
});
