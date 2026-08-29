/**
 * Client tests. The bridge is thin, so what is tested is the contract that
 * makes it trustworthy: local writes stay local, reads carry the right
 * payload, errors arrive with their reasons attached, and the tool surface
 * stays inside the token budget that is the product's own pitch.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

// A fake engine so tests never touch the network.
const seen = [];
let respond = (route) => ({ status: 200, body: { ok: true, route } });
const fake = createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const body = data ? JSON.parse(data) : null;
    seen.push({ route: req.url, headers: req.headers, body });
    const r = respond(req.url, body);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
});

let TOOLS, handleCall;
before(async () => {
  await new Promise((ok) => fake.listen(0, ok));
  process.env.MEMORY_PULSE_API = `http://127.0.0.1:${fake.address().port}`;
  process.env.MEMORY_PULSE_KEY = "mp_live_testkey";
  const cwd = mkdtempSync(join(tmpdir(), "mp-client-"));
  process.chdir(cwd);
  ({ TOOLS, handleCall } = await import("../server.mjs"));
});
after(() => fake.close());

test("tool definitions stay inside the token budget that is the pitch", () => {
  const size = JSON.stringify(TOOLS).length;
  assert.ok(size < 4000, `tool definitions are ${size} chars; budget 4000`);
  assert.deepEqual(TOOLS.map((t) => t.name), ["pulse", "recall", "remember", "execute"]);
});

test("remember writes locally and never touches the network", async () => {
  const before = seen.length;
  const out = await handleCall("remember", { cause: "c1", effect: "e1", note: "n" });
  assert.equal(out.written, true);
  assert.equal(seen.length, before, "remember must not make a network call");
  assert.ok(existsSync(out.ledger));
  const dup = await handleCall("remember", { cause: "c1", effect: "e1", note: "n" });
  assert.equal(dup.written, false);
  assert.equal(readFileSync(out.ledger, "utf8").trim().split("\n").length, 1);
});

test("reads ship the local events and the license key", async () => {
  await handleCall("remember", { cause: "c2", effect: "e2" });
  await handleCall("pulse", { tier: "index" });
  const last = seen.at(-1);
  assert.equal(last.route, "/v1/pulse");
  assert.equal(last.headers["x-mp-key"], "mp_live_testkey");
  assert.equal(last.body.events.length, 2);
  assert.equal(last.body.tier, "index");
});

test("an API refusal surfaces its reason and the upgrade path", async () => {
  respond = () => ({ status: 402, body: { error: "free tier covers ledgers up to 500 events", upgrade: "https://x/#pro" } });
  await assert.rejects(() => handleCall("pulse", {}), /up to 500 events.*upgrade: https:\/\/x\/#pro/s);
  respond = (route) => ({ status: 200, body: { ok: true, route } });
});

test("a dead network says what still works instead of a bare stack trace", async () => {
  const saved = process.env.MEMORY_PULSE_API;
  // The module captured API at import; simulate by pointing at a closed port via a fresh import.
  process.env.MEMORY_PULSE_API = "http://127.0.0.1:1";
  const fresh = await import(`../server.mjs?dead=${Date.now()}`);
  await assert.rejects(() => fresh.handleCall("pulse", {}), /remember` still works/);
  process.env.MEMORY_PULSE_API = saved;
});

test("a torn ledger line is skipped, not fatal", async () => {
  const { ledger } = await handleCall("remember", { cause: "c3", effect: "e3" });
  const { appendFileSync } = await import("node:fs");
  appendFileSync(ledger, '{"torn": tr\n');
  const out = await handleCall("remember", { cause: "c4", effect: "e4" });
  assert.equal(out.written, true, "the ledger must survive a torn line");
});
