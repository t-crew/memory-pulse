// 0.7.0: opt-in usage counts (plan Task 5). Nothing is counted before consent; with it, counts are kept in
// ~/.memory-pulse/usage.rain and leave the machine at most once per UTC day, as eight integers plus a random install id, the
// version and the host. Never asked in CI or without a terminal; DO_NOT_TRACK and MEMORY_PULSE_TELEMETRY=0 win over a yes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const SERVER = new URL("../server.mjs", import.meta.url).pathname;
const U = await import("../lib/usage.mjs");
const fresh = () => mkdtempSync(join(tmpdir(), "mpu-"));
const env0 = { DO_NOT_TRACK: undefined, MEMORY_PULSE_TELEMETRY: undefined, MEMORY_PULSE_TELEMETRY_DEBUG: undefined };
const spy = () => { const calls = []; const post = async (body) => { calls.push(body); return { status: 200, body: { capsule: { schema: "catalyst.rain.usage.v1", sig: "s", counters: body.counts } } }; }; return { calls, post }; };

test("no consent file: nothing is counted and no request is ever made", async () => {
  const dir = fresh(); const { calls, post } = spy();
  U.recordUsage("guard_check", { dir, env: env0 }); U.recordUsage("guard_block", { dir, env: env0 });
  assert.equal(existsSync(join(dir, "usage.rain")), false, "opt-in: nothing is collected before a yes");
  assert.equal(U.consentState({ dir, env: env0 }).enabled, false);
  await U.maybeSendUsage({ dir, post, env: env0, version: "0.7.0", now: Date.parse("2026-10-12T10:00:00Z") });
  assert.equal(calls.length, 0);
  assert.equal(U.usagePayload({ dir, env: env0, version: "0.7.0" }), null);
});

test("DO_NOT_TRACK=1 and MEMORY_PULSE_TELEMETRY=0 override a yes", () => {
  const dir = fresh(); U.setConsent(true, { dir });
  assert.equal(U.consentState({ dir, env: env0 }).enabled, true);
  assert.equal(U.consentState({ dir, env: { DO_NOT_TRACK: "1" } }).enabled, false);
  assert.equal(U.consentState({ dir, env: { MEMORY_PULSE_TELEMETRY: "0" } }).enabled, false);
  assert.match(U.consentState({ dir, env: { DO_NOT_TRACK: "1" } }).reason, /DO_NOT_TRACK/);
});

test("telemetry show prints exactly the object maybeSendUsage posts, and the install id is 32 hex", async () => {
  const dir = fresh(); U.setConsent(true, { dir }); U.recordUsage("scaffold", { dir, env: env0 }); U.recordUsage("prompt_slice", { dir, env: env0 }); U.recordUsage("prompt_slice", { dir, env: env0 });
  const shown = U.usagePayload({ dir, env: env0, version: "0.7.0", host: "claude" });
  assert.match(shown.install, /^[0-9a-f]{32}$/);
  assert.deepEqual(shown.counts, { scaffold: 1, prompt_slice: 2 });
  const { calls, post } = spy();
  await U.maybeSendUsage({ dir, post, env: env0, version: "0.7.0", host: "claude", now: Date.parse("2026-10-12T10:00:00Z") });
  assert.deepEqual(calls[0], shown);
});

test("property: no ledger text, path, term, prompt or secret can reach the payload", () => {
  const dir = fresh(); U.setConsent(true, { dir });
  const secrets = Array.from({ length: 200 }, () => `sk_live_${randomBytes(8).toString("hex")} /Users/x/${randomBytes(4).toString("hex")} "$${randomBytes(2).readUInt16BE()}"`);
  for (const s of secrets) { U.recordUsage(s, { dir, env: env0 }); U.recordUsage("guard_check", { dir, note: s }); }
  const flat = JSON.stringify(U.usagePayload({ dir, env: env0, version: "0.7.0", host: "codex" }));
  for (const s of secrets) assert.ok(!flat.includes(s.slice(0, 16)), `leaked ${s}`);
  assert.deepEqual(Object.keys(JSON.parse(flat)).sort(), ["capsule", "counts", "host", "install", "version"]);
});

test("sends at most once per UTC day; a failed send keeps the counts for the next day", async () => {
  const dir = fresh(); U.setConsent(true, { dir }); U.recordUsage("lint", { dir, env: env0 });
  let calls = 0; const fail = async () => { calls++; return { status: 503, body: {} }; };
  await U.maybeSendUsage({ dir, post: fail, env: env0, version: "0.7.0", now: Date.parse("2026-10-12T10:00:00Z") });
  assert.equal(calls, 1); assert.deepEqual(U.usagePayload({ dir, env: env0, version: "0.7.0" }).counts, { lint: 1 }, "kept after a failure");
  const ok = spy();
  await U.maybeSendUsage({ dir, post: ok.post, env: env0, version: "0.7.0", now: Date.parse("2026-10-12T11:00:00Z") });
  assert.equal(ok.calls.length, 0, "one attempt per UTC day, even after a failure (review fix)");
  await U.maybeSendUsage({ dir, post: ok.post, env: env0, version: "0.7.0", now: Date.parse("2026-10-12T23:59:00Z") });
  assert.equal(ok.calls.length, 0);
  await U.maybeSendUsage({ dir, post: ok.post, env: env0, version: "0.7.0", now: Date.parse("2026-10-13T00:01:00Z") });
  assert.equal(ok.calls.length, 1, "the next day sends what was kept");
  U.recordUsage("lint", { dir, env: env0 });
  await U.maybeSendUsage({ dir, post: ok.post, env: env0, version: "0.7.0", now: Date.parse("2026-10-13T23:00:00Z") });
  assert.equal(ok.calls.length, 1, "already sent today");
  await U.maybeSendUsage({ dir, post: ok.post, env: env0, version: "0.7.0", now: Date.parse("2026-10-14T00:05:00Z") });
  assert.equal(ok.calls.length, 2); assert.deepEqual(ok.calls[1].counts, { lint: 1 });
});

test("MEMORY_PULSE_TELEMETRY_DEBUG=1 prints the payload and sends nothing", async () => {
  const dir = fresh(); U.setConsent(true, { dir }); U.recordUsage("remember", { dir, env: env0 });
  const { calls, post } = spy(); const printed = [];
  await U.maybeSendUsage({ dir, post, env: { MEMORY_PULSE_TELEMETRY_DEBUG: "1" }, version: "0.7.0", now: Date.now(), print: (s) => printed.push(s) });
  assert.equal(calls.length, 0); assert.match(printed.join("\n"), /"remember": 1/);
});

test("install-hook never asks without a terminal or in CI, and writes no consent", () => {
  for (const extra of [{ CI: "1" }, {}]) {
    const home = fresh();
    const r = spawnSync(process.execPath, [SERVER, "install-hook"], { env: { ...process.env, HOME: home, MEMORY_PULSE_SETTINGS_DIR: join(home, "s"), ...extra }, input: "", encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /usage counts\?/);
    assert.equal(existsSync(join(home, ".memory-pulse", "consent.json")), false);
  }
});

test("the telemetry command: show says off and why; on, then show prints the payload; reset mints a new install id", () => {
  const home = fresh(); const env = { ...process.env, HOME: home }; delete env.DO_NOT_TRACK; delete env.MEMORY_PULSE_TELEMETRY;
  const run = (...a) => spawnSync(process.execPath, [SERVER, "telemetry", ...a], { env, encoding: "utf8" });
  assert.match(run("show").stdout, /off: no consent recorded/);
  assert.equal(run("on").status, 0);
  const shown = JSON.parse(run("show").stdout); const id = shown.install;
  assert.match(id, /^[0-9a-f]{32}$/);
  run("reset"); assert.notEqual(JSON.parse(run("show").stdout).install, id);
  run("off"); assert.match(run("show").stdout, /off: consent is no/);
  assert.ok(existsSync(join(home, ".memory-pulse", "consent.json")));
  assert.equal(JSON.parse(readFileSync(join(home, ".memory-pulse", "consent.json"), "utf8")).consent, false);
});
