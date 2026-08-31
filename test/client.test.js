/**
 * Client tests. The bridge is thin, so what is tested is the contract that
 * makes it trustworthy: local writes stay local, reads carry the right
 * payload, errors arrive with their reasons attached, and the tool surface
 * stays inside the token budget that is the product's own pitch.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "..", "server.mjs");
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

test("the transport starts when invoked through a bin-style symlink, like npm does", async () => {
  // The 0.1.0 regression: a basename comparison decided "not the main module"
  // when argv[1] was the .bin/memory-pulse symlink, so the published server
  // installed fine and served nothing. This runs the real invocation shape.
  const { mkdtempSync, symlinkSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mp-bin-"));
  const real = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
  const shim = join(dir, "memory-pulse");
  symlinkSync(real, shim);
  const out = spawnSync(process.execPath, [shim], {
    input: '{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
    encoding: "utf8", timeout: 10000, cwd: dir,
  });
  assert.match(out.stdout, /"id":1/, `expected a ping reply through the symlink, got stdout=${JSON.stringify(out.stdout)} stderr=${JSON.stringify(out.stderr?.slice(0, 200))}`);
});

test("remember echoes the canonical stored event back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-echo-"));
  process.env.MEMORY_PULSE_LEDGER = join(dir, "events.jsonl");
  const r = await handleCall("remember", { cause: "a", effect: "b", note: "the exact note" });
  assert.equal(r.written, true);
  assert.equal(r.stored.note, "the exact note");
  assert.equal(r.stored.t, 1);
  delete process.env.MEMORY_PULSE_LEDGER;
});

test("install-hook is idempotent and merges instead of clobbering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-hook-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo existing" }] }] }, model: "keep-me" }));
  const run = () => execFileSync(process.execPath, [SERVER, "install-hook"], { env: { ...process.env, MEMORY_PULSE_SETTINGS_DIR: dir }, encoding: "utf8" });
  run(); const second = run();
  assert.match(second, /already installed/);
  const s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.equal(s.model, "keep-me", "unrelated settings must survive");
  assert.equal(s.hooks.SessionStart.length, 2, "existing hook must survive, ours added once");
});

test("brief with no ledger is a silent no-op (hook must not spam non-users)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-brief-"));
  const out = execFileSync(process.execPath, [SERVER, "brief"], { cwd: dir, encoding: "utf8" });
  assert.equal(out, "");
});

test("telemetry capsule is persisted beside the ledger and sent back on the next call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-tel-"));
  process.env.MEMORY_PULSE_LEDGER = join(dir, ".memory-pulse", "events.jsonl");
  await handleCall("remember", { cause: "a", effect: "b" });
  seen.length = 0;
  respond = (route, body) => ({ status: 200, body: { text: "brief", telemetry: { schema: "catalyst.rain.telemetry.v1", project: body.project, counters: { calls: (body.telemetry?.counters?.calls ?? 0) + 1, pulse: 1, correctionsSurfaced: 0, tokensSavedEst: 12 }, sig: "x" } } });
  await handleCall("pulse", {});
  const capsulePath = join(dir, ".memory-pulse", "telemetry.rain");
  assert.ok(existsSync(capsulePath), "capsule written beside the ledger");
  const stored = JSON.parse(readFileSync(capsulePath, "utf8"));
  assert.equal(stored.schema, "catalyst.rain.telemetry.v1");
  await handleCall("pulse", {});
  const second = seen[seen.length - 1];
  assert.equal(second.body.telemetry.schema, "catalyst.rain.telemetry.v1", "prior capsule rides in the next request");
  assert.ok(second.body.project, "project name travels with the request");
  delete process.env.MEMORY_PULSE_LEDGER;
});

test("guard: an edit that writes back a withdrawn term is blocked (exit 2) and explained", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-guard-"));
  const ledger = join(dir, ".memory-pulse", "events.jsonl");
  process.env.MEMORY_PULSE_LEDGER = ledger;
  await handleCall("remember", { cause: "bench", effect: "throughput-withdrawn", kind: "correction", note: "warm cache", withdrawn: ["1480 rps"] });
  delete process.env.MEMORY_PULSE_LEDGER;
  const payload = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "docs/perf.md", old_string: "x", new_string: "we sustain 1480 rps in prod" } });
  let code = 0, stderr = "";
  try { execFileSync(process.execPath, [SERVER, "guard"], { input: payload, env: { ...process.env, MEMORY_PULSE_LEDGER: ledger }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); }
  catch (e) { code = e.status; stderr = String(e.stderr); }
  assert.equal(code, 2, "blocked");
  assert.match(stderr, /1480 rps/);
  assert.match(stderr, /withdrawn at ledger t1/);
  assert.ok(existsSync(join(dir, ".memory-pulse", "violations.jsonl")), "violation recorded for the report");
  const clean = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "docs/perf.md", new_string: "we sustain 610 rps cold" } });
  const out = execFileSync(process.execPath, [SERVER, "guard"], { input: clean, env: { ...process.env, MEMORY_PULSE_LEDGER: ledger }, encoding: "utf8" });
  assert.equal(out, "", "clean edit passes silently");
});

test("guard allows everything when the input is not a hook payload or no terms are enforceable", () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-guard2-"));
  const out = execFileSync(process.execPath, [SERVER, "guard"], { input: "not json", cwd: dir, encoding: "utf8" });
  assert.equal(out, "");
});

test("findViolations only matches explicit withdrawn terms on corrections", async () => {
  const { findViolations } = await import("../server.mjs");
  const events = [
    { t: 1, cause: "a", effect: "b", kind: "event", note: "$49 everywhere" },
    { t: 2, cause: "b", effect: "c", kind: "correction", withdrawn: ["$49"] },
  ];
  assert.equal(findViolations(events, "price is $49").length, 1);
  assert.equal(findViolations(events, "price is $29").length, 0);
  assert.equal(findViolations([events[0]], "$49").length, 0, "plain events never enforce");
});

test("install-hook installs both hooks and stays idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-hook2-"));
  const run = () => execFileSync(process.execPath, [SERVER, "install-hook"], { env: { ...process.env, MEMORY_PULSE_SETTINGS_DIR: dir }, encoding: "utf8" });
  assert.match(run(), /installed 2 hook/);
  assert.match(run(), /already installed/);
  const s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.equal(s.hooks.PreToolUse[0].matcher, "Edit|Write|MultiEdit");
});
