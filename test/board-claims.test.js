// Claims on the board (2026-10-16), after Self-Organizing Agent Teams (arXiv 2609.22682): six of the twenty strategies its teams kept exist to
// stop a correct claim from one member being lost in the team's consensus (final auditor claim recovery, minority evidence adjudication), and
// its judge may reject a candidate only by naming a specific defect. On the board: a claim stays open until another agent gives it a verdict,
// a refutation names its defect, nobody adjudicates their own claim, and a synthesis cannot land silently over an open claim.
// Written before the code.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";

process.env.MEMORY_PULSE_MODE = "deliberate"; process.env.MEMORY_PULSE_AGENT = "/nonexistent/agent/events.jsonl";
process.env.MEMORY_PULSE_API = "http://127.0.0.1:9";
const B = await import("../lib/board.mjs");
const fresh = () => join(mkdtempSync(join(tmpdir(), "mp-claims-")), "board.jsonl");
const run = (board, args) => spawnSync(process.execPath, [SERVER, "board", ...args], { encoding: "utf8",
  env: { ...process.env, NO_COLOR: "1", MEMORY_PULSE_BOARD: board, MEMORY_PULSE_LEDGER: join(board, "..", "project.jsonl") } });
const status = (b, t) => B.claims(b).find((c) => c.t === t)?.status;

test("a claim stays open until another agent gives a verdict; a refutation must name its defect; nobody adjudicates their own claim", () => {
  const b = fresh();
  const root = B.post(b, { from: "coder", to: "all", kind: "request", title: "why does the refund total drift?", body: "One cent off on 3 of 40 orders." }).t;
  const c = B.post(b, { from: "reviewer", to: "all", kind: "claim", title: "rounding happens before the tax split", body: "round() runs on the line total, then tax is split per item.", thread: root });
  assert.equal(c.written, true); assert.equal(status(b, c.t), "open");
  assert.equal(B.verdict(b, c.t, { from: "reviewer", verdict: "upheld" }).written, false, "the author does not uphold its own claim");
  assert.equal(B.verdict(b, c.t, { from: "coder", verdict: "refuted" }).written, false, "a refutation without a defect is refused");
  assert.equal(B.verdict(b, c.t, { from: "coder", verdict: "refuted", defect: "no" }).written, false, "a defect is a sentence, not a word");
  assert.equal(B.verdict(b, c.t, { from: "coder", verdict: "withdrawn" }).written, false, "only the author withdraws a claim");
  const v = B.verdict(b, c.t, { from: "coder", verdict: "refuted", defect: "the tax split runs on unrounded line totals; see refund.js line 88" });
  assert.equal(v.written, true); assert.equal(status(b, c.t), "refuted");
  const m = B.messages(b).find((x) => x.t === v.t); assert.equal(m.reply_to, c.t); assert.equal(m.thread, root); assert.equal(m.to, "reviewer");
  assert.equal(B.verdict(b, root, { from: "reviewer", verdict: "upheld" }).written, false, "a verdict answers a claim, not any message");
  const own = B.post(b, { from: "coder", to: "all", kind: "claim", title: "it is the currency library", thread: root }).t;
  assert.equal(B.verdict(b, own, { from: "coder", verdict: "withdrawn" }).written, true); assert.equal(status(b, own), "withdrawn");
});

test("upheld by one agent and refuted by another is contested, and the claims list shows every verdict with its defect", () => {
  const b = fresh();
  const c = B.post(b, { from: "science", to: "all", kind: "claim", title: "the regression is the new tokenizer", body: "Bisected to the tokenizer bump." }).t;
  B.verdict(b, c, { from: "blue", verdict: "upheld", body: "Reverting the bump restores the score." });
  B.verdict(b, c, { from: "coder", verdict: "refuted", defect: "the bisect skipped the commit that changed the eval split" });
  const cl = B.claims(b).find((x) => x.t === c);
  assert.equal(cl.status, "contested");
  assert.deepEqual(cl.verdicts.map((v) => [v.from, v.verdict]), [["blue", "upheld"], ["coder", "refuted"]]);
  assert.match(cl.verdicts[1].defect, /eval split/);
});

test("a synthesis is refused while a claim in its thread is open; recorded over the open claims only when asked, and flagged with them", () => {
  const b = fresh();
  const root = B.post(b, { from: "lead", to: "all", kind: "request", title: "pick the cache design" }).t;
  const c1 = B.post(b, { from: "coder", to: "all", kind: "claim", title: "a write-through cache is enough", thread: root }).t;
  const c2 = B.post(b, { from: "science", to: "all", kind: "claim", title: "the hit rate will be under 20 percent", body: "Measured on last week's trace.", thread: root }).t;
  B.verdict(b, c1, { from: "lead", verdict: "upheld" });
  const refused = B.post(b, { from: "lead", to: "all", kind: "synthesis", title: "go with write-through", thread: root });
  assert.equal(refused.written, false); assert.match(refused.reason, new RegExp(`open claim.*t${c2} \\(science\\)`));
  const over = B.post(b, { from: "lead", to: "all", kind: "synthesis", title: "go with write-through", thread: root, over_open: true });
  assert.equal(over.written, true);
  assert.deepEqual(B.messages(b).find((m) => m.t === over.t).over_open, [c2]);
  const text = B.renderText(B.messages(b), B.messages(b));
  assert.match(text, new RegExp(`synthesized over 1 open claim: t${c2}`));
  assert.match(text, new RegExp(`claim: open`));
  B.verdict(b, c2, { from: "coder", verdict: "upheld", body: "Same trace, same number." });
  assert.equal(B.post(b, { from: "lead", to: "all", kind: "synthesis", title: "go with a read-through cache", thread: root }).written, true, "every claim answered: clean");
  assert.equal(B.post(b, { from: "lead", to: "all", kind: "synthesis", title: "x", thread: 999 }).written, false, "a synthesis names a thread on this board");
});

test("CLI: claim, verdict, claims and synthesis; read shows a claim's status and counts the open claims; the MCP tools take verdicts and report open claims", () => {
  const b = fresh();
  let r = run(b, ["post", "--from", "lead", "--to", "all", "--kind", "request", "--title", "pick the cache design"]); assert.equal(r.status, 0, r.stderr);
  r = run(b, ["post", "--from", "science", "--kind", "claim", "--title", "hit rate under 20 percent", "--body", "last week's trace", "--thread", "1"]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /posted t2/);
  r = run(b, ["read", "--as", "lead"]); assert.match(r.stdout, /claim: open/); assert.match(r.stdout, /1 open claim on the board: t2 \(science\)/);
  r = run(b, ["post", "--from", "lead", "--kind", "synthesis", "--title", "write-through", "--thread", "1"]); assert.equal(r.status, 1); assert.match(r.stderr, /open claim/);
  r = run(b, ["verdict", "2", "refuted", "--as", "coder"]); assert.equal(r.status, 1); assert.match(r.stderr, /names the defect/);
  r = run(b, ["verdict", "2", "refuted", "--as", "coder", "--defect", "the trace excluded the batch jobs that dominate reads"]); assert.equal(r.status, 0, r.stderr);
  r = run(b, ["claims"]); assert.match(r.stdout, /t2 · science · refuted · hit rate under 20 percent/); assert.match(r.stdout, /coder refuted: the trace excluded the batch jobs/);
  r = run(b, ["post", "--from", "lead", "--kind", "synthesis", "--title", "write-through", "--thread", "1"]); assert.equal(r.status, 0, r.stderr);
  const out = join(b, "..", "board.html"); run(b, ["html", "--out", out]); assert.match(readFileSync(out, "utf8"), /refuted/);
  // one process per call: the server runs the calls of one session concurrently, so a verdict could otherwise race its claim
  const mcp = (call) => JSON.parse(JSON.parse(spawnSync(process.execPath, [SERVER], { input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: call }) + "\n",
    encoding: "utf8", env: { ...process.env, MEMORY_PULSE_BOARD: b } }).stdout.split("\n").find((l) => l.includes('"result"'))).result.content[0].text);
  const res = [{ name: "board_post", arguments: { from: "science", kind: "claim", title: "batch reads are cacheable", thread: 1 } },
               { name: "board_post", arguments: { from: "coder", kind: "verdict", reply_to: 5, verdict: "refuted", defect: "batch reads bypass the cache layer entirely" } },
               { name: "board_read", arguments: { as: "lead", all: true } }].map(mcp);
  assert.equal(res[0].written, true); assert.equal(res[1].written, true);
  assert.deepEqual(res[2].open_claims, []); assert.equal(res[2].messages.find((m) => m.t === 5).claim_status, "refuted");
});

test("python and node share claims: a Python claim takes a Node verdict, and Python refuses what Node refuses", () => {
  const b = fresh(); const PY = new URL("../python/memory_pulse.py", import.meta.url).pathname;
  const py = (...a) => spawnSync("python3", [PY, ...a], { encoding: "utf8" });
  let r = py("board-post", b, "science", "all", "claim", "the regression is the tokenizer", "Bisected to the bump.");
  assert.equal(r.status, 0, r.stderr); const c = JSON.parse(r.stdout).t;
  assert.equal(status(b, c), "open");
  r = py("board-verdict", b, String(c), "coder", "refuted"); assert.equal(JSON.parse(r.stdout).written, false, "no defect, refused in Python too");
  r = py("board-verdict", b, String(c), "science", "upheld"); assert.equal(JSON.parse(r.stdout).written, false, "own claim, refused in Python too");
  assert.equal(B.verdict(b, c, { from: "blue", verdict: "refuted", defect: "the bisect skipped the eval split change" }).written, true);
  r = py("board-claims", b); const cl = JSON.parse(r.stdout).claims.find((x) => x.t === c);
  assert.equal(cl.status, "refuted"); assert.match(cl.verdicts[0].defect, /eval split/);
  r = py("board-verdict", b, String(c), "coder", "upheld", ""); assert.equal(JSON.parse(r.stdout).written, true);
  assert.equal(status(b, c), "contested");
  assert.equal(B.integrity(b).ok, true);
});
