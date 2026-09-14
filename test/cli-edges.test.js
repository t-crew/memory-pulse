// CLI edges found by the 2026-09-09 fresh-user run and the daily-use review: a hand-edited ledger blocks every
// edit with a hint that cannot fix it; malformed hook stdin is indistinguishable from no evidence; an effect
// slug binds a word the caller never saw; a duplicate is refused after the product's own hint; a dropped term
// reports success; report and brief disagree on superseded rows; three commands print stack traces, "undefined"
// or a phantom row. No fake engine is needed, so this file runs inside the sandbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "..", "server.mjs");
const mk = () => {
  const cwd = mkdtempSync(join(tmpdir(), "mp-edge-"));
  const env = { ...process.env, MEMORY_PULSE_MODE: "deliberate", MEMORY_PULSE_AGENT: join(cwd, "agent", "events.jsonl"), MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_SETTINGS_DIR: join(cwd, "settings"), NO_COLOR: "1" };
  delete env.MEMORY_PULSE_LEDGER;
  const run = (args, input = "") => { const r = spawnSync(process.execPath, [SERVER, ...args], { cwd, env, input, encoding: "utf8" }); let json = null; try { json = JSON.parse(r.stdout); } catch { /* not JSON */ } return { ...r, json }; };
  const ledger = join(cwd, ".memory-pulse", "events.jsonl");
  return { cwd, env, run, ledger };
};
const write = (content) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "docs/pricing.md", content } });

test("guard on a broken chain says restore from a copy you trust, never git checkout or delete, not guard allow", () => {
  const { run, ledger } = mk();
  for (let i = 1; i <= 4; i++) run(["remember", `c${i}`, `e${i}`, "--kind", "correction", "--withdrawn", `old${i}`]);
  const rows = readFileSync(ledger, "utf8").split("\n").filter(Boolean);
  writeFileSync(ledger, [rows[0], rows[2], rows[3]].join("\n") + "\n");
  const r = run(["guard"], write("nothing withdrawn here"));
  assert.equal(r.status, 2, "a broken chain blocks every edit");
  assert.match(r.stderr, /ledger chain broken/);
  assert.match(r.stderr, /copy you trust/); assert.doesNotMatch(r.stderr, /git checkout|delete the \.memory-pulse|seal accept/);
  assert.match(r.stderr, /memory-pulse verify/);
  assert.doesNotMatch(r.stderr, /guard allow/);
});

test("guard --verbose says when stdin was not hook JSON; without it the pass stays silent", () => {
  const { run } = mk();
  run(["remember", "a", "b"]);
  const v = run(["guard", "--verbose"], "not json {");
  assert.equal(v.status, 0); assert.match(v.stderr, /was not hook JSON/);
  const q = run(["guard"], "not json {");
  assert.equal(q.status, 0); assert.equal(q.stderr, "");
});

test("a correction bound from its effect slug says so: price-corrected-to-29 binds the word price", () => {
  const { run } = mk();
  const r = run(["remember", "pricing-page-shipped", "price-corrected-to-29", "--kind", "correction"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.boundFromEffect, { withdrawn: ["price"], replacement: ["29"] });
  assert.deepEqual(r.json.stored.withdrawn, ["price"]);
});

test("withdrawn terms under 2 chars are dropped and the correction is reported as unenforceable", () => {
  const { run } = mk();
  const r = run(["remember", "a", "b", "--kind", "correction", "--withdrawn", "9"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.written, true); assert.equal(r.json.enforceable, false);
  assert.deepEqual(r.json.dropped, ["9"]); assert.equal(r.json.stored.withdrawn, undefined);
});

test("a replacement under 2 chars is dropped and reported", () => {
  const { run } = mk();
  const r = run(["remember", "a", "b", "--kind", "correction", "--withdrawn", "old", "--replacement", "8"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.dropped, ["8"]); assert.equal(r.json.stored.replacement, undefined);
});

test("the duplicate rule compares terms, and its hint says what a duplicate is", () => {
  const { run } = mk();
  run(["remember", "a", "b", "--kind", "correction", "--note", "n"]);
  const d = run(["remember", "a", "b", "--kind", "correction", "--note", "n"]);
  assert.equal(d.json.written, false); assert.equal(d.json.reason, "duplicate"); assert.match(d.json.hint, /same cause, effect, note and terms/);
  const ok = run(["remember", "a", "b", "--kind", "correction", "--note", "n", "--withdrawn", "old"]);
  assert.equal(ok.json.written, true, "the same row with withdrawn terms added is not a duplicate");
});

test("report counts a superseded correction out of the enforceable set, as the brief does", () => {
  const { run } = mk();
  run(["remember", "c1", "e1", "--kind", "correction", "--withdrawn", "$29"]);
  run(["remember", "c2", "e2", "--kind", "correction", "--withdrawn", "$19", "--supersedes", "1"]);
  const r = run(["report"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /2 corrections recorded, 1 with enforceable withdrawn terms/);
  assert.match(r.stdout, /1 superseded/);
});

test("mode <bad> prints one line and exits 1, with no stack trace", () => {
  const { run } = mk();
  const r = run(["mode", "bogus"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /mode must be agent or deliberate/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test("observe on a prohibition prints the withdrawn term and no replacement clause", () => {
  const { run } = mk();
  const r = run(["observe", "--verbose"], JSON.stringify({ prompt: "never cite blockchain in the docs" }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /"blockchain" withdrawn/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test("handoff with empty stdin or no transcript writes nothing", () => {
  const { run, ledger } = mk();
  run(["remember", "a", "b"]);
  const before = readFileSync(ledger, "utf8");
  const r = run(["handoff"], "");
  assert.equal(r.status, 0); assert.match(r.stdout, /handoff skipped \(no transcript\)/);
  const r2 = run(["handoff"], JSON.stringify({ trigger: "auto", session_id: "abc" }));
  assert.equal(r2.status, 0); assert.match(r2.stdout, /handoff skipped \(no transcript\)/);
  assert.equal(readFileSync(ledger, "utf8"), before);
});

test("install-hook --codex tells the user to trust as many entries as it wrote", () => {
  const { run } = mk();
  const r = run(["install-hook", "--codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /installed 3 hook\(s\)/);
  assert.match(r.stdout, /trust the 3 memory-pulse entries/);
});
