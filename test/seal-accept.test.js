// seal accept (2026-09-14): the recorded way out of a stale seal. A seal that no longer folds over rows whose
// chain verifies blocks every edit; the block names the way out and never `git checkout`; accept appends a
// row, sets the seal aside (kept, not deleted), and the guard passes again. A broken chain is refused: accept
// is not a repair. Driven through the CLI as a hook would run it, with the ledger named by MEMORY_PULSE_LEDGER.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";

const run = (ledger, args, input) => spawnSync(process.execPath, [SERVER, ...args], { input: input ?? "", encoding: "utf8", env: { ...process.env, MEMORY_PULSE_LEDGER: ledger, NO_COLOR: "1" } });
const hook = JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/tmp/x.md", content: "harmless text" } });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("a stale seal over an intact chain blocks with a recorded way out, never git checkout; accept restores the guard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-seal-accept-")); const ledger = join(dir, "events.jsonl"); writeFileSync(ledger, "");
  process.env.MEMORY_PULSE_LEDGER = ledger;
  const { appendEvent, readEvents, setHeadHex } = await import("../server.mjs?sealaccept=" + Date.now());
  appendEvent({ cause: "a", effect: "b", note: "one" }); appendEvent({ cause: "b", effect: "c", note: "two" });
  const rows = readEvents().events;
  // a well-formed seal whose head is the fold of a different view of the same rows — what a sealer that
  // redacts a note before folding produces (the 2026-09-14 estate case)
  const wrong = setHeadHex([rows[0], { ...rows[1], note: "a different view of row two" }]);
  writeFileSync(join(dir, "seal.rain"), JSON.stringify({ schema: "catalyst.rain.seal.v1", events: 2, through: 2, head: wrong, tag: "not-checked-locally" }));

  const blocked = run(ledger, ["guard"], hook);
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /sealed head mismatch/);
  assert.match(blocked.stderr, /chain OK/, "the block says the rows themselves verify");
  assert.match(blocked.stderr, /seal accept "<why>"/, "and names the way out");
  assert.match(blocked.stderr, new RegExp(`MEMORY_PULSE_LEDGER=${esc(ledger)} memory-pulse seal accept`), "with the ledger the hook targets");
  assert.doesNotMatch(blocked.stderr, /git checkout|delete the \.memory-pulse/);

  assert.equal(run(ledger, ["seal", "accept"]).status, 1, "a reason is required");
  const ok = run(ledger, ["seal", "accept", "the engine sealed a different view; the rows are ours"]);
  assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /accepted at t3/);
  assert.ok(!existsSync(join(dir, "seal.rain")), "the stale seal is set aside");
  assert.ok(readdirSync(dir).some((f) => /^seal\.rain\..*\.stale$/.test(f)), "and kept, not deleted");
  const last = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.equal(last.cause, "seal-accepted"); assert.equal(last.t, 3); assert.match(last.note, /different view/); assert.deepEqual(last.tags, ["seal"]);
  assert.match(last.effect, /through-t2/);

  const pass = run(ledger, ["guard"], hook); assert.equal(pass.status, 0, pass.stderr);
  const again = run(ledger, ["seal", "accept", "nothing stale now"]); assert.equal(again.status, 0); assert.match(again.stdout, /nothing to accept/);
  assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 3, "a no-op accept appends nothing");
});

test("a broken chain is refused by seal accept, and the block says restore from a trusted copy, not delete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-seal-broken-")); const ledger = join(dir, "events.jsonl"); writeFileSync(ledger, "");
  process.env.MEMORY_PULSE_LEDGER = ledger;
  const { appendEvent } = await import("../server.mjs?sealbroken=" + Date.now());
  appendEvent({ cause: "a", effect: "b", note: "one" }); appendEvent({ cause: "b", effect: "c", note: "two" });
  writeFileSync(ledger, readFileSync(ledger, "utf8").replace('"note":"one"', '"note":"ONE"'));
  const blocked = run(ledger, ["guard"], hook);
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /ledger chain broken/); assert.match(blocked.stderr, /copy you trust/);
  assert.doesNotMatch(blocked.stderr, /git checkout|seal accept/);
  const refused = run(ledger, ["seal", "accept", "please"]);
  assert.equal(refused.status, 1); assert.match(refused.stderr, /refused: the row chain itself is broken/);
  assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 2, "nothing appended to an edited ledger");
});
