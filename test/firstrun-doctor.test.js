// `memory-pulse doctor` (2026-11-21): confirms the wiring. One line per check (ok, FAIL with the fixing command, or skipped with
// the reason), exit 1 when any check fails, --json for the same as one object. The checks: the Node version, each host and its
// hooks, the guard answering a synthetic edit against a temporary ledger (through the installed hook command when there is one),
// the project ledger through `verify`, hooks that run through npx, and the engine as information only.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, tree, snapshot, check, line, ROOT, VERSION } from "./_firstrun.mjs";

const guards = (j) => j.checks.filter((c) => c.id.startsWith("guard"));
const json = (r) => { try { return JSON.parse(r.out); } catch { assert.fail(`not JSON (exit ${r.status}): ${r.out}\n${r.err}`); } };

test("doctor: with no host on the machine every host is skipped, the guard still answers, and the exit is 0", () => {
  const f = fixture();
  const r = f.run(["doctor"]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.ok(line(r.out, "ok", "node"), r.out);
  for (const h of ["Claude Code", "Codex", "Cursor"]) assert.match(line(r.out, "skipped", h) ?? "", /\(not found/, `${h}: ${r.out}`);
  const g = line(r.out, "ok", "guard"); assert.ok(g, r.out); assert.match(g, /exit 2/);
  assert.match(line(r.out, "skipped", "ledger") ?? "", /\(none at /, r.out);
  assert.doesNotMatch(r.out, /^FAIL/m);
  // every check is one line that starts with its status
  for (const l of r.out.trim().split("\n").slice(1, -1).filter(Boolean)) assert.match(l, /^(ok|FAIL|skipped)\s/, l);
  // what the guard check wrote went to a temporary folder that is gone; nothing was added to HOME or the project
  assert.deepEqual(tree(f.home), []); assert.deepEqual(tree(f.proj), []); assert.deepEqual(tree(f.tmp), []);
});

test("doctor: a host that is present with no memory-pulse hooks is a FAIL with the command that installs them, exit 1", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude")); mkdirSync(join(f.home, ".cursor"));
  const r = f.run(["doctor"]);
  assert.equal(r.status, 1, r.out);
  assert.match(line(r.out, "FAIL", "Claude Code") ?? "", /Fix: memory-pulse install-hook$/, r.out);
  assert.match(line(r.out, "FAIL", "Cursor") ?? "", /Fix: memory-pulse install-hook --cursor$/, r.out);
  assert.match(line(r.out, "skipped", "Codex") ?? "", /\(not found/);
  assert.match(r.out.trim().split("\n").at(-1), /2 checks failed/);
  // a host is also found by its command on PATH
  const g = fixture(); writeFileSync(join(g.bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  const j = json(g.run(["doctor", "--json"]));
  assert.equal(check(j, "host:codex").status, "fail"); assert.match(check(j, "host:codex").fix, /install-hook --codex/);
});

test("doctor: after install-hook the host is ok and the guard check runs the installed hook command itself", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude"));
  assert.equal(f.run(["install-hook"]).status, 0);
  const r = f.run(["doctor"]);
  assert.equal(r.status, 0, r.out + r.err);
  const h = line(r.out, "ok", "Claude Code"); assert.ok(h, r.out);
  assert.ok(h.includes(join(f.home, ".claude", "settings.json")), h);
  const g = line(r.out, "ok", "guard"); assert.ok(g, r.out);
  assert.match(g, /installed/); assert.match(g, /Claude Code/); assert.match(g, /exit 2/); assert.match(g, /exit 0/, "and a control edit passes");
  assert.match(r.out.trim().split("\n").at(-1), /all checks passed/i);
  const j = json(f.run(["doctor", "--json"]));
  assert.equal(j.ok, true); assert.equal(j.failed, 0); assert.equal(j.version, VERSION);
  const pinned = join(f.home, ".local", "share", "memory-pulse", VERSION, "server.mjs");
  assert.equal(guards(j).length, 1); assert.ok(guards(j)[0].command.includes(pinned), guards(j)[0].command);
  assert.equal(check(j, "runner").status, "ok"); assert.doesNotMatch(check(j, "runner").detail, /npx/);
});

test("doctor: a pinned hook path that no longer exists is a FAIL that names the path and the fix", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude"));
  f.run(["install-hook"]);
  const pinnedDir = join(f.home, ".local", "share", "memory-pulse", VERSION);
  assert.ok(existsSync(join(pinnedDir, "server.mjs")));
  rmSync(pinnedDir, { recursive: true });
  const r = f.run(["doctor"]);
  assert.equal(r.status, 1, r.out);
  const l = line(r.out, "FAIL", "Claude Code"); assert.ok(l, r.out);
  assert.ok(l.includes(join(pinnedDir, "server.mjs")), l); assert.match(l, /does not exist/); assert.match(l, /Fix: memory-pulse install-hook$/);
  // the fix it names works
  assert.equal(f.run(["install-hook"]).status, 0);
  assert.equal(f.run(["doctor"]).status, 0);
});

test("doctor: a hook command that exists but does not block is caught by running it", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude")); mkdirSync(join(f.root, "fake"));
  writeFileSync(join(f.root, "fake", "server.mjs"), "process.exit(0);\n");
  writeFileSync(join(f.home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: `node "${join(f.root, "fake", "server.mjs")}" guard` }] }] } }));
  const r = f.run(["doctor"]);
  assert.equal(r.status, 1, r.out);
  assert.ok(line(r.out, "ok", "Claude Code"), "the file is there, so the host line passes");
  const g = line(r.out, "FAIL", "guard"); assert.ok(g, r.out);
  assert.match(g, /exit 0/); assert.match(g, /expected 2/); assert.match(g, /Fix: memory-pulse install-hook$/);
});

test("doctor: Codex and Cursor hooks are read in their own files and shapes; Cursor's guard answers with a deny", () => {
  const f = fixture(); mkdirSync(join(f.home, ".codex")); mkdirSync(join(f.home, ".cursor"));
  assert.equal(f.run(["install-hook", "--codex"]).status, 0); assert.equal(f.run(["install-hook", "--cursor"]).status, 0);
  const r = f.run(["doctor"]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(line(r.out, "ok", "Codex") ?? "", /\/hooks/, "the Codex line says its hooks run only after /hooks trust");
  assert.ok(line(r.out, "ok", "Cursor"), r.out);
  const j = json(f.run(["doctor", "--json"]));
  assert.equal(guards(j).length, 2, "two distinct hook commands, two runs");
  assert.ok(guards(j).every((g) => g.status === "ok"), JSON.stringify(guards(j)));
  assert.match(guards(j).find((g) => /--host cursor/.test(g.command)).detail, /deny/);
});

test("doctor: the Claude Code plugin's hooks count as installed, and a plugin folder that is gone is a FAIL", () => {
  const f = fixture(); const pdir = join(f.home, ".claude", "plugins"); mkdirSync(pdir, { recursive: true });
  writeFileSync(join(f.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "memory-pulse@memory-pulse": true } }));
  const install = (path) => writeFileSync(join(pdir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "memory-pulse@memory-pulse": [{ scope: "user", installPath: path, version: VERSION }] } }));
  install(ROOT);
  const r = f.run(["doctor"]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(line(r.out, "ok", "Claude Code") ?? "", /plugin/, r.out);
  assert.match(line(r.out, "ok", "guard") ?? "", /exit 2/);
  install(join(f.root, "gone"));
  const s = f.run(["doctor"]);
  assert.equal(s.status, 1, s.out);
  assert.match(line(s.out, "FAIL", "Claude Code") ?? "", /does not exist/, s.out);
  // a plugin that is switched off is not installed hooks
  install(ROOT); writeFileSync(join(f.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "memory-pulse@memory-pulse": false } }));
  assert.equal(f.run(["doctor"]).status, 1);
});

test("doctor: the project ledger is checked through verify and never written; a changed row is a FAIL", () => {
  const f = fixture();
  assert.equal(f.run(["remember", "pricing-shipped", "price-corrected", "--kind", "correction", "--withdrawn", "$49", "--replacement", "$29"]).status, 0);
  const ledger = join(f.proj, ".memory-pulse", "events.jsonl"); const before = readFileSync(ledger, "utf8");
  const r = f.run(["doctor"]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(line(r.out, "ok", "ledger") ?? "", /verifies/, r.out);
  assert.equal(readFileSync(ledger, "utf8"), before, "the ledger's bytes are the same after doctor");
  assert.ok(!existsSync(join(f.proj, ".memory-pulse", "violations.jsonl")), "the synthetic block is not recorded in the project");
  // change one character of the row: the chain no longer verifies
  writeFileSync(ledger, before.replace("price-corrected", "price-corrected2"));
  const changed = readFileSync(ledger, "utf8");
  const s = f.run(["doctor"]);
  assert.equal(s.status, 1, s.out);
  assert.match(line(s.out, "FAIL", "ledger") ?? "", /Fix: memory-pulse verify$/, s.out);
  assert.equal(readFileSync(ledger, "utf8"), changed, "doctor does not repair or move anything");
  // a ledger named in the environment is the one checked
  const g = fixture(); mkdirSync(join(g.root, "led"));
  const extra = { MEMORY_PULSE_LEDGER: join(g.root, "led", "events.jsonl") };
  g.run(["remember", "a", "b"], { extra });
  assert.ok(line(g.run(["doctor"], { extra }).out, "ok", "ledger").includes(join(g.root, "led", "events.jsonl")));
});

test("doctor: project hooks that run through npx are named with the measured cost and how to pin; npx is not run", () => {
  const f = fixture();
  assert.equal(f.run(["install-hook", "--project"]).status, 0);
  const r = f.run(["doctor"]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.ok(line(r.out, "ok", "Claude Code").includes(join(f.proj, ".claude", "settings.json")), "a project file makes the host present");
  const j = json(f.run(["doctor", "--json"]));
  const run = check(j, "runner");
  assert.equal(run.status, "ok", "information, not a failure");
  assert.match(run.detail, /npx/); assert.match(run.detail, /0\.98 to 1\.54 s/); assert.match(run.detail, /0\.06 s/); assert.match(run.detail, /memory-pulse install-hook\b/);
  assert.ok(run.detail.includes(join(".claude", "settings.json")));
  // the guard check says it ran this copy, because an npx command can need the network
  assert.equal(guards(j).length, 1); assert.equal(guards(j)[0].status, "ok");
  assert.match(guards(j)[0].detail, /npx/); assert.match(guards(j)[0].detail, /this copy/);
});

test("doctor --json: one object with the same checks; ok is false and the exit is 1 when one fails", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude"));
  const r = f.run(["doctor", "--json"]);
  assert.equal(r.status, 1);
  const j = json(r);
  assert.equal(j.ok, false); assert.equal(j.failed, 1);
  assert.deepEqual(j.checks.map((c) => c.id), ["node", "host:claude", "host:codex", "host:cursor", "guard", "ledger", "runner", "engine"]);
  for (const c of j.checks) { assert.ok(["ok", "fail", "skipped"].includes(c.status), c.status); assert.equal(typeof c.detail, "string"); }
  assert.equal(check(j, "host:claude").fix, "memory-pulse install-hook");
  assert.equal(r.out.trim().split("\n").length, 1, "one line, so it pipes");
});

test("doctor: no key is read into the output, from the environment or from a settings file", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude"));
  const envKey = "mp_live_" + "a1".repeat(16), fileKey = "mp_live_" + "b2".repeat(16);
  f.run(["install-hook"]);
  const settings = join(f.home, ".claude", "settings.json");
  writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), env: { MEMORY_PULSE_KEY: fileKey } }));
  for (const args of [["doctor"], ["doctor", "--json"]]) {
    const r = f.run(args, { extra: { MEMORY_PULSE_KEY: envKey } });
    assert.equal(r.status, 0, r.out + r.err);
    for (const k of [envKey, fileKey, "a1a1a1", "b2b2b2"]) assert.ok(!(r.out + r.err).includes(k), `${args.join(" ")} printed ${k}`);
  }
});

test("doctor: the engine is information only: unreachable is skipped with exit 0, --offline makes no request, reachable is ok and sends no key", async () => {
  const f = fixture();
  const down = f.run(["doctor"]);
  assert.equal(down.status, 0);
  assert.match(line(down.out, "skipped", "engine") ?? "", /not reachable/, down.out);
  const seen = [];
  const srv = createServer((req, res) => { seen.push(req.headers); res.end("ok"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const extra = { MEMORY_PULSE_API: `http://127.0.0.1:${srv.address().port}`, MEMORY_PULSE_KEY: "mp_live_" + "c3".repeat(16) };
    const off = await f.runAsync(["doctor", "--offline"], { extra });
    assert.equal(off.status, 0); assert.match(line(off.out, "skipped", "engine") ?? "", /--offline/); assert.equal(seen.length, 0, "--offline makes no request");
    const up = await f.runAsync(["doctor"], { extra });
    assert.equal(up.status, 0, up.out + up.err);
    assert.match(line(up.out, "ok", "engine") ?? "", /reachable/, up.out);
    assert.equal(seen.length, 1); assert.equal(seen[0]["x-mp-key"], undefined, "no key is sent"); assert.ok(!JSON.stringify(seen[0]).includes("c3c3"));
  } finally { srv.close(); }
});

test("doctor: a settings file that is not valid JSON is a FAIL, and the file is left as it is", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude"));
  writeFileSync(join(f.home, ".claude", "settings.json"), "{ not json");
  const before = snapshot(f.home);
  const r = f.run(["doctor"]);
  assert.equal(r.status, 1);
  assert.match(line(r.out, "FAIL", "Claude Code") ?? "", /not valid JSON/, r.out);
  assert.deepEqual(snapshot(f.home), before);
});

test("doctor: only memory-pulse's own hook verbs count as its hooks; a path written without quotes is read too", () => {
  // someone else's hook that happens to run a server.mjs is not ours: its missing file is not our FAIL
  const f = fixture(); mkdirSync(join(f.home, ".claude"));
  assert.equal(f.run(["install-hook"]).status, 0);
  const file = join(f.home, ".claude", "settings.json"), s = JSON.parse(readFileSync(file, "utf8"));
  s.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: `node "${join(f.root, "theirs", "server.mjs")}" start` }] });
  writeFileSync(file, JSON.stringify(s));
  const r = f.run(["doctor"]);
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /theirs/);
  // a hand-written hook without quotes round the path: read, run, and a missing file is a FAIL
  const g = fixture(); mkdirSync(join(g.home, ".claude"));
  const write = (path) => writeFileSync(join(g.home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: `node ${path} guard` }] }] } }));
  write(join(ROOT, "server.mjs"));
  const ok = json(g.run(["doctor", "--json"]));
  assert.equal(ok.ok, true, JSON.stringify(ok.checks)); assert.equal(guards(ok)[0].command, `node ${join(ROOT, "server.mjs")} guard`); assert.match(guards(ok)[0].detail, /installed hook command/);
  write(join(g.root, "gone", "server.mjs"));
  const bad = g.run(["doctor"]);
  assert.equal(bad.status, 1); assert.match(line(bad.out, "FAIL", "Claude Code") ?? "", /does not exist/, bad.out);
});
