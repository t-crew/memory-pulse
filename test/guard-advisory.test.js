/**
 * Ambient single words are advisory (0.17.1). Ambient capture turns a prompt shaped like "no X" or "X not Y" into a
 * correction with X withdrawn, and the guard then blocks every edit that contains X. When X is one ordinary word that is a
 * disaster: on one real ledger (2026-11-16) all nine ambient single-word terms were accidental ("send", "merge", "just",
 * "only", "capture", "trigger", "upgrades", "ten", "TO"), "merge" alone had blocked 84 edits, and "send" blocked every file
 * that called an API method of that name. The guard no longer blocks on such a term; it says so and how to enforce it on
 * purpose. A term a person recorded with `remember`, a phrase, and a value with a digit or a symbol in it block as before.
 */
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
for (const k of ["MEMORY_PULSE_LEDGER", "MEMORY_PULSE_PROJECT", "MEMORY_PULSE_KEY", "MEMORY_PULSE_BOARD"]) delete process.env[k];
process.env.MEMORY_PULSE_MODE = "deliberate"; process.env.MEMORY_PULSE_AGENT = "/nonexistent/agent/events.jsonl";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localCheck, findViolations, advisoryTerm } from "../server.mjs";

const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "..", "server.mjs");
const ambient = (t, term, extra = {}) => ({ t, kind: "correction", cause: `user-correction-${term.toLowerCase()}`, effect: `${term.toLowerCase()}-withdrawn`, withdrawn: [term], replacement: [], tags: ["ambient", "prohibit-no-x"], note: `User prohibited "${term}"`, ...extra });
const LEDGER = [
  ambient(1, "send"),
  ambient(2, "merge"),
  ambient(3, "ten qubits", { replacement: ["8 qubits"] }),
  ambient(4, "us-east-1"),
  ambient(5, "$49"),
  { t: 6, kind: "correction", cause: "naming-review", effect: "users-withdrawn-for-customers", withdrawn: ["users"], replacement: ["customers"], note: "recorded on purpose" },
];

test("advisoryTerm: one ordinary word from ambient capture, and nothing else", () => {
  assert.equal(advisoryTerm(LEDGER[0], "send"), true);
  assert.equal(advisoryTerm(LEDGER[2], "ten qubits"), false, "a phrase is specific enough to enforce");
  assert.equal(advisoryTerm(LEDGER[3], "us-east-1"), false, "a value with a digit or a hyphen is not an ordinary word");
  assert.equal(advisoryTerm(LEDGER[4], "$49"), false);
  assert.equal(advisoryTerm(LEDGER[5], "users"), false, "a word a person recorded on purpose is enforced");
  // the guard's cached rows carry no tags; the cause ambient capture writes still identifies the row
  assert.equal(advisoryTerm({ kind: "correction", cause: "user-correction-send", withdrawn: ["send"] }, "send"), true);
  assert.equal(advisoryTerm({ kind: "correction", cause: "user-correction-send", withdrawn: ["send"], tags: ["reviewed"] }, "send"), false, "tags present and not ambient: a person's row");
});

test("localCheck: an ambient single word does not block and the reason says how to enforce it; everything else blocks as before", () => {
  const api = localCheck(LEDGER, { text: "await env.EMAIL.send(message); git merge main", path: "/repo/src/mail.js" }, [], { blockOnly: true });
  assert.equal(api.verdict, "not_blocked", JSON.stringify(api.reasons));
  assert.equal(api.corrections.length, 0);
  assert.ok(api.reasons.some((r) => /"send" is advisory.*t1 /.test(r) && /remember/.test(r)), api.reasons.join(" | "));
  assert.ok(api.reasons.some((r) => /"merge" is advisory/.test(r)));
  for (const [text, term] of [["scale to ten qubits", "ten qubits"], ["region us-east-1", "us-east-1"], ["price $49 per seat", "$49"], ["our users love it", "users"]]) {
    const r = localCheck(LEDGER, { text, path: "/repo/a.md" }, [], { blockOnly: true });
    assert.equal(r.verdict, "blocked", term); assert.equal(r.corrections[0].term, term);
  }
});

test("findViolations (the brief's guard-coverage count) agrees with the guard", () => {
  assert.deepEqual(findViolations(LEDGER, "send and merge").map((h) => h.term), []);
  assert.deepEqual(findViolations(LEDGER, "our users pay $49").map((h) => h.term).sort(), ["$49", "users"]);
});

test("the guard hook: exit 0 on an ambient single word, exit 2 on a deliberate one", () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-adv-")); mkdirSync(join(dir, ".memory-pulse"));
  writeFileSync(join(dir, ".memory-pulse", "events.jsonl"), LEDGER.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const hook = (content) => spawnSync(process.execPath, [SERVER, "guard"], { cwd: dir, input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(dir, "src", "mail.js"), content } }), encoding: "utf8" });
  const ok = hook("await env.EMAIL.send(message)");
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  const no = hook("our users love it");
  assert.equal(no.status, 2, no.stderr + no.stdout); assert.match(no.stderr + no.stdout, /users/);
});

// ---- 0.17.2: an advisory word is not enforced, so it is not what the memory leads with. Measured on one real ledger
// (2026-11-17): the session brief's first two correction lines were two of these words with their old block counts, and a
// prompt that merely contained one of them had its row injected.
import { promptSlice, editSlice, renderScaffold } from "../server.mjs";

test("a prompt or an edit that merely contains an advisory word gets no line about it; an enforced term still does", () => {
  const p = promptSlice(LEDGER, "please send the report and merge the branch"); assert.equal(p, "", p);
  assert.match(promptSlice(LEDGER, "what do our users think of the price $49"), /"users" was withdrawn/);
  assert.match(promptSlice(LEDGER, "scale it to ten qubits"), /"ten qubits" was withdrawn/, "a phrase from ambient capture is still enforced and still shown");
  assert.equal(editSlice(LEDGER, [], { text: "await api.send(x); git merge", path: "src/a.js" }), "");
  assert.match(editSlice(LEDGER, [], { text: "our users", path: "docs/a.md" }), /"users" was withdrawn/);
});

test("the brief lists enforced corrections first and marks an advisory word as not blocked, after them, without a block count", () => {
  const { text } = renderScaffold(LEDGER, { section: "corrections", blocks: [{ hits: [{ t: 1, term: "send" }] }, { hits: [{ t: 1, term: "send" }] }, { hits: [{ t: 6, term: "users" }] }] });
  const lines = text.split("\n").filter((l) => /was withdrawn|were withdrawn/.test(l));
  assert.match(lines[0], /"users" was withdrawn; use customers \(t6; blocked 1 time\)/);
  const send = lines.find((l) => l.includes('"send"')); assert.match(send, /advisory: not blocked/); assert.ok(!/blocked 2 times/.test(send));
  assert.ok(lines.indexOf(send) > lines.findIndex((l) => l.includes("ten qubits")), "advisory words come after every enforced correction");
});
