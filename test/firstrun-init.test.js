// `memory-pulse init` (2026-11-21): one command in a repository. It prints its plan (hosts found, files it will write), asks
// once on a terminal (--yes skips the question; with no terminal and no --yes nothing is changed), installs the hooks by running
// install-hook, creates .memory-pulse/, runs doctor, and ends with the two commands that record a first correction and test it.
// A second run changes nothing and says so. The usage-count question install-hook asks is asked once, not once per host.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, tree, snapshot, line, SERVER, VERSION } from "./_firstrun.mjs";

const guardCommands = (file) => (JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse ?? []).flatMap((e) => (e.hooks ?? [e]).map((h) => h.command)).filter((c) => /\bguard\b/.test(c));

test("init --dry-run prints the plan (hosts found, files it would write) and changes nothing", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude")); mkdirSync(join(f.home, ".codex"));
  const before = snapshot(f.root);
  const r = f.run(["init", "--dry-run"]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /Hosts found: Claude Code[^\n]*, Codex/);
  assert.match(r.out, /Not found: Cursor/);
  assert.ok(r.out.includes(join(f.home, ".claude", "settings.json")), r.out);
  assert.ok(r.out.includes(join(f.home, ".codex", "hooks.json")), r.out);
  assert.ok(r.out.includes(join(f.proj, ".memory-pulse")), r.out);
  assert.match(r.out, /nothing was changed/i);
  assert.deepEqual(snapshot(f.root), before, "no file was written anywhere under the fixture");
  assert.ok(!existsSync(join(f.proj, ".memory-pulse")));
});

test("init with no terminal and no --yes prints the plan, changes nothing and says how to apply it", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude"));
  const before = snapshot(f.root);
  const r = f.run(["init"]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.ok(r.out.includes(join(f.home, ".claude", "settings.json")));
  assert.match(r.out, /nothing was changed/i); assert.match(r.out, /memory-pulse init --yes/);
  assert.deepEqual(snapshot(f.root), before);
});

test("init --yes installs the hooks through install-hook, creates .memory-pulse/, runs doctor and ends with the two first commands", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude"));
  // a settings file with the user's own entries: they are kept
  const settings = join(f.home, ".claude", "settings.json");
  writeFileSync(settings, JSON.stringify({ model: "kept", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2));
  const r = f.run(["init", "--yes"]);
  assert.equal(r.status, 0, r.out + r.err);
  const s = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(s.model, "kept"); assert.equal(s.hooks.PreToolUse[0].hooks[0].command, "echo mine");
  // the hook is what install-hook writes: node on the pinned copy, and the copy is there
  const pinned = join(f.home, ".local", "share", "memory-pulse", VERSION, "server.mjs");
  assert.deepEqual(guardCommands(settings), [`node "${pinned}" guard`]); assert.ok(existsSync(pinned));
  assert.equal(Object.keys(s.hooks).length, 8, "the eight events install-hook writes");
  assert.ok(statSync(join(f.proj, ".memory-pulse")).isDirectory());
  // order: plan, then what was done, then doctor, then the two commands
  const iPlan = r.out.indexOf("Plan"), iDone = r.out.indexOf(`installed 8 hook(s) in ${settings}`), iDoc = r.out.indexOf(`memory-pulse doctor ${VERSION}`), iNext = r.out.lastIndexOf("memory-pulse remember ");
  assert.ok(iPlan >= 0 && iDone > iPlan && iDoc > iDone && iNext > iDoc, `${iPlan} ${iDone} ${iDoc} ${iNext}\n${r.out}`);
  assert.ok(line(r.out, "ok", "Claude Code"), r.out); assert.ok(line(r.out, "ok", "guard"), r.out);
  assert.doesNotMatch(r.out, /^FAIL/m);
  // the two commands it ends with are runnable as printed and the second one is blocked
  const cmds = r.out.trimEnd().split("\n").filter((l) => /^\s+npx -y memory-pulse (remember|check) /.test(l)).map((l) => l.trim());
  assert.equal(cmds.length, 2, r.out);
  const sh = (c) => spawnSync("/bin/sh", ["-c", c.replace(/^npx -y memory-pulse/, `"${process.execPath}" "${SERVER}"`)], { cwd: f.proj, env: f.env, encoding: "utf8" });
  const a = sh(cmds[0]); assert.equal(a.status, 0, a.stderr); assert.equal(JSON.parse(a.stdout).written, true);
  const b = sh(cmds[1]); assert.equal(b.status, 2, b.stdout + b.stderr); assert.match(b.stdout, /BLOCKED/);
});

test("init is idempotent: a second run changes nothing and says so", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude")); mkdirSync(join(f.home, ".cursor"));
  assert.equal(f.run(["init", "--yes"]).status, 0);
  const before = snapshot(f.root);
  const r = f.run(["init", "--yes"]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /Nothing to change/); assert.doesNotMatch(r.out, /installed \d+ hook/);
  assert.deepEqual(snapshot(f.root), before, "every file under the fixture is byte-identical after the second run");
  assert.ok(line(r.out, "ok", "Claude Code") && line(r.out, "ok", "Cursor"), "doctor still runs");
  // and without --yes, with no terminal, it says the same rather than asking to apply a plan
  const s = f.run(["init"]);
  assert.equal(s.status, 0); assert.match(s.out, /Nothing to change/); assert.doesNotMatch(s.out, /init --yes/);
  assert.deepEqual(snapshot(f.root), before);
});

test("init --yes writes one file per host found, each in the host's own shape", () => {
  const f = fixture(); for (const d of [".claude", ".codex", ".cursor"]) mkdirSync(join(f.home, d));
  const r = f.run(["init", "--yes"]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.equal(guardCommands(join(f.home, ".claude", "settings.json")).length, 1);
  assert.equal(guardCommands(join(f.home, ".codex", "hooks.json")).length, 1);
  const cursor = JSON.parse(readFileSync(join(f.home, ".cursor", "hooks.json"), "utf8"));
  assert.match(cursor.hooks.preToolUse[0].command, /guard --host cursor$/); assert.equal(cursor.hooks.preToolUse[0].failClosed, true);
  for (const h of ["Claude Code", "Codex", "Cursor"]) assert.ok(line(r.out, "ok", h), `${h}\n${r.out}`);
  assert.match(r.out, /Codex[^\n]*\/hooks/, "the Codex trust step is named");
});

test("init --yes --project writes the hooks into the repository with npx and leaves HOME's settings alone", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude"));
  const r = f.run(["init", "--yes", "--project"]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.deepEqual(guardCommands(join(f.proj, ".claude", "settings.json")), ["npx -y memory-pulse guard"]);
  assert.ok(!existsSync(join(f.home, ".claude", "settings.json")));
  assert.ok(!existsSync(join(f.home, ".local", "share", "memory-pulse")), "no pinned copy is made for a project install");
  assert.match(line(r.out, "ok", "runner") ?? "", /npx/, r.out);
});

test("init with no host found says so, still creates .memory-pulse/ and exits 0", () => {
  const f = fixture();
  const dry = f.run(["init", "--dry-run"]);
  assert.match(dry.out, /No host found/); assert.match(dry.out, /memory-pulse install-hook/);
  const r = f.run(["init", "--yes"]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.ok(statSync(join(f.proj, ".memory-pulse")).isDirectory());
  assert.deepEqual(tree(f.home), []);
});

test("init --yes: a settings file that is not valid JSON is left as it is, named in the plan, and the exit is 1", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude"));
  writeFileSync(join(f.home, ".claude", "settings.json"), "{ not json");
  const r = f.run(["init", "--yes"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not valid JSON/);
  assert.equal(readFileSync(join(f.home, ".claude", "settings.json"), "utf8"), "{ not json");
});

// The terminal path, in process: the question is asked once, a no changes nothing, and the usage-count question is asked once
// when hooks were written, however many hosts there are.
async function inProcess(f, argv, { answer = "y" } = {}) {
  const { cliInit } = await import("../lib/firstrun.mjs");
  const lines = [], asked = []; let consent = 0;
  const status = await cliInit(argv, {
    server: SERVER, version: VERSION, api: f.env.MEMORY_PULSE_API, env: f.env, cwd: f.proj, tty: true,
    ledgerPath: () => join(f.proj, ".memory-pulse", "events.jsonl"),
    out: (s) => lines.push(s), ask: async (q) => { asked.push(q); return answer; }, askUsageConsent: async () => { consent++; },
  });
  return { status, out: lines.join("\n"), asked, consent };
}

test("init on a terminal asks once before changing anything; a no changes nothing", async () => {
  const f = fixture(); for (const d of [".claude", ".codex", ".cursor"]) mkdirSync(join(f.home, d));
  const before = snapshot(f.root);
  const no = await inProcess(f, [], { answer: "n" });
  assert.equal(no.status, 0); assert.equal(no.asked.length, 1); assert.match(no.asked[0], /\[y\/N\]/);
  assert.match(no.out, /nothing was changed/i); assert.equal(no.consent, 0);
  assert.deepEqual(snapshot(f.root), before);
  // an empty answer is a no
  const empty = await inProcess(f, [], { answer: "" });
  assert.equal(empty.status, 0); assert.match(empty.out, /nothing was changed/i);
  assert.deepEqual(snapshot(f.root), before);
});

test("init on a terminal: a yes applies the plan, and the usage-count question is asked exactly once for three hosts", async () => {
  const f = fixture(); for (const d of [".claude", ".codex", ".cursor"]) mkdirSync(join(f.home, d));
  const yes = await inProcess(f, [], { answer: "y" });
  assert.equal(yes.status, 0, yes.out); assert.equal(yes.asked.length, 1, "one question for the whole plan");
  assert.equal(yes.consent, 1, "the usage-count question once, not once per host");
  for (const [d, file] of [[".claude", "settings.json"], [".codex", "hooks.json"], [".cursor", "hooks.json"]]) assert.ok(existsSync(join(f.home, d, file)), d);
  // a second run has nothing to apply: no question, and no usage-count question
  const again = await inProcess(f, [], { answer: "y" });
  assert.equal(again.status, 0); assert.equal(again.asked.length, 0); assert.equal(again.consent, 0); assert.match(again.out, /Nothing to change/);
  // --yes on a terminal skips the plan question and keeps the usage-count question
  const g = fixture(); mkdirSync(join(g.home, ".claude"));
  const y = await inProcess(g, ["--yes"]);
  assert.equal(y.asked.length, 0); assert.equal(y.consent, 1);
});

test("install-hook asks the usage-count question itself and init does not let it ask per host", () => {
  // install-hook's question is on a terminal only; the installs init runs have no terminal, so the one question is init's
  const src = readFileSync(SERVER, "utf8");
  assert.match(src, /async function cliInstallHook\(\)[\s\S]*?await askUsageConsent\(\);\n\}/, "install-hook still ends by asking");
  assert.match(src, /async function askUsageConsent\(\) \{\n  if \(!process\.stdin\.isTTY \|\| process\.env\.CI \|\| hasConsentAnswer\(\)\) return;/, "and only on a terminal, outside CI, when not yet answered");
  assert.match(src, /askUsageConsent\b[^\n]*firstrun|firstrun[^\n]*askUsageConsent/, "init is handed the same function");
});

test("init does not add a second set of hooks where a plugin already runs them", () => {
  // Claude Code: the plugin is installed and on, so its hooks.json runs the guard; a settings.json copy would run every hook twice
  const f = fixture(); const pdir = join(f.home, ".claude", "plugins"); mkdirSync(pdir, { recursive: true });
  const settings = join(f.home, ".claude", "settings.json");
  writeFileSync(settings, JSON.stringify({ enabledPlugins: { "memory-pulse@memory-pulse": true } }));
  writeFileSync(join(pdir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "memory-pulse@memory-pulse": [{ scope: "user", installPath: join(SERVER, ".."), version: VERSION }] } }));
  // Codex: a plugin copy is in its cache; whether it is on is Codex's to say, so init leaves Codex alone and names the command
  mkdirSync(join(f.home, ".codex", "plugins", "cache", "memory-pulse", "memory-pulse", VERSION), { recursive: true });
  const before = readFileSync(settings, "utf8");
  const r = f.run(["init", "--yes"]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.equal(readFileSync(settings, "utf8"), before, "settings.json is not given a second set of hooks");
  assert.ok(!existsSync(join(f.home, ".codex", "hooks.json")), "no hooks.json is written beside a Codex plugin");
  const plan = r.out.slice(r.out.indexOf("Plan"), r.out.indexOf(`memory-pulse doctor ${VERSION}`));
  assert.match(plan, /keep[^\n]*Claude Code[^\n]*plugin/); assert.match(plan, /skip[^\n]*Codex[^\n]*memory-pulse install-hook --codex/);
  assert.doesNotMatch(r.out, /installed \d+ hook/);
  assert.ok(line(r.out, "ok", "Claude Code"), r.out);
});

test("demo, doctor and init refuse an option they do not have: exit 1, the option named, nothing changed", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude"));
  const before = snapshot(f.root);
  for (const args of [["demo", "--bogus"], ["doctor", "extra"], ["init", "--bogus"], ["demo", "--text"], ["init", "--yes=1"]]) {
    const r = f.run(args);
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.out}`);
    assert.equal(r.out, "", "nothing on stdout");
    assert.match(r.err, new RegExp(`^memory-pulse ${args[0]}: .*\\(run memory-pulse help\\)\\n$`), r.err);
  }
  assert.deepEqual(snapshot(f.root), before);
});
