// `memory-pulse now` (0.18.0): the machine clock as the two stamps a record uses. It exists because an agent typed
// time stamps from memory into records ("00:3x UTC" when the clock said 00:15; a seal time quoted wrongly). A stamp is
// pasted from this command's output, never typed.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";

// a scratch project and an explicit environment: no MEMORY_PULSE_LEDGER, so nothing here can reach a real ledger
const base = mkdtempSync(join(tmpdir(), "mp-now-")); const project = join(base, "p"); mkdirSync(project);
const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, NO_COLOR: "1", MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_AGENT: join(base, "agent.jsonl"), MEMORY_PULSE_MODE: "deliberate",
  MEMORY_PULSE_TRUST_DIR: join(base, "trust"), MEMORY_PULSE_DATA_DIR: join(base, "data") };
const run = (args) => spawnSync(process.execPath, [SERVER, ...args], { cwd: project, env, encoding: "utf8" });

test("now prints the clock as the two stamps a record uses, then one line saying a stamp is pasted, never typed", () => {
  const before = Math.floor(Date.now() / 1000) * 1000; const r = run(["now"]); const after = Date.now();
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, "");
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 3, r.stdout);
  const [utc, iso, rule] = lines;
  assert.match(utc, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/, utc);
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, iso);
  const t = Date.parse(iso);
  assert.ok(t >= before && t <= after, `the stamp ${iso} is the machine clock (test clock ${new Date(before).toISOString()} .. ${new Date(after).toISOString()})`);
  assert.equal(utc, `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`, "both lines are one reading of the clock");
  assert.match(rule, /pasted/); assert.match(rule, /never typed/);
});

test("now --json parses to {utc, iso}, one reading of the clock", () => {
  const before = Math.floor(Date.now() / 1000) * 1000; const r = run(["now", "--json"]); const after = Date.now();
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(j).sort(), ["iso", "utc"]);
  assert.match(j.utc, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/); assert.match(j.iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Date.parse(j.iso) >= before && Date.parse(j.iso) <= after);
  assert.equal(j.utc, `${j.iso.slice(0, 10)} ${j.iso.slice(11, 16)} UTC`);
});

test("now takes nothing from the caller: an argument that is not --json is refused, and nothing is written", () => {
  for (const args of [["now", "2020-01-01T00:00:00Z"], ["now", "--at", "2020-01-01T00:00:00Z"]]) {
    const r = run(args);
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: memory-pulse now \[--json\]/);
    assert.ok(!r.stdout.includes("2020"), "a time the caller typed is never echoed as a stamp");
  }
  assert.ok(!existsSync(join(project, ".memory-pulse")), "now reads the clock; it writes no ledger");
});

test("stamps(): seconds are kept in the ISO form, minutes in the UTC form, nothing is rounded up", async () => {
  const { stamps } = await import("../lib/prereg.mjs");
  assert.deepEqual(stamps(new Date("2026-11-19T02:15:07.999Z")), { utc: "2026-11-19 02:15 UTC", iso: "2026-11-19T02:15:07Z" });
  assert.deepEqual(stamps(new Date("2026-12-31T23:59:59.500Z")), { utc: "2026-12-31 23:59 UTC", iso: "2026-12-31T23:59:59Z" });
});
