// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
// 0.16.1 (clean-machine install test, 2026-10-23): hooks written by install-hook, mode soul and the one-line installer ran
// `npx -y memory-pulse <verb>`, 0.98-1.54 s per call against 0.06 s for node on the same server.mjs, so about 2 s on every tool
// call. Hooks now run node on a pinned copy of the package outside the npx cache; a --project hook keeps npx, because a committed
// file has to run on every clone. Plus three small findings from the same test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "..", "server.mjs");
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function mk(label) {
  const cwd = mkdtempSync(join(tmpdir(), `mp-fasthooks-${label}-`));
  const settings = join(cwd, "settings"), data = join(cwd, "data");
  const env = { ...process.env, HOME: join(cwd, "home"), MEMORY_PULSE_SETTINGS_DIR: settings, MEMORY_PULSE_DATA_DIR: data, MEMORY_PULSE_LEDGER: join(cwd, ".memory-pulse", "events.jsonl"), MEMORY_PULSE_AGENT: join(cwd, "home", ".memory-pulse", "agent", "events.jsonl"), MEMORY_PULSE_API: "http://127.0.0.1:9", NO_COLOR: "1", CI: "1" };
  const run = (args, input = "") => spawnSync(process.execPath, [SERVER, ...args], { cwd, env, input, encoding: "utf8" });
  return { cwd, settings, data, env, run };
}
const commandsIn = (file) => { const out = []; const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") { if (typeof v.command === "string") out.push(v.command); Object.values(v).forEach(walk); } }; walk(JSON.parse(readFileSync(file, "utf8")).hooks ?? {}); return out.filter((c) => /memory-pulse|server\.mjs"/.test(c)); };
const NODE_FORM = /^node "([^"]+[\\/]server\.mjs)" /;

test("install-hook writes node on a pinned copy, never npx, and the copy is complete", () => {
  const { settings, data, run } = mk("user");
  const r = run(["install-hook"]); assert.equal(r.status, 0, r.stderr + r.stdout);
  const cmds = commandsIn(join(settings, "settings.json"));
  assert.ok(cmds.length >= 7, cmds.join("\n"));
  for (const c of cmds) assert.match(c, NODE_FORM, `not the node form: ${c}`);
  const server = NODE_FORM.exec(cmds[0])[1];
  assert.ok(server.startsWith(join(data, VERSION)), `copy not under the data dir at ${VERSION}: ${server}`);
  assert.ok(existsSync(server) && existsSync(join(server, "..", "lib", "scaffold.mjs")), "server.mjs and lib/ copied");
  assert.equal(JSON.parse(readFileSync(join(server, "..", "package.json"), "utf8")).version, VERSION);
});

test("the installed guard command runs and blocks a withdrawn value", () => {
  const { cwd, settings, env, run } = mk("guardruns");
  assert.equal(run(["install-hook"]).status, 0);
  assert.equal(run(["remember", "api-base", "v2", "--kind", "correction", "--withdrawn", "/v1/", "--replacement", "/v2/", "--note", "v1 retired"]).status, 0);
  const guard = commandsIn(join(settings, "settings.json")).find((c) => /\sguard$/.test(c));
  const hook = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(cwd, "a.js"), content: "fetch('/v1/x')" } });
  const g = spawnSync("sh", ["-c", guard], { cwd, env, input: hook, encoding: "utf8" });
  assert.equal(g.status, 2, `the installed guard must block: ${g.stderr}`);
  assert.match(g.stderr, /\/v1\/" was withdrawn/);
});

test("re-running install-hook replaces old npx hooks instead of adding a second set", () => {
  const { settings, run } = mk("upgrade");
  mkdirSync(settings, { recursive: true });
  const old = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "npx -y memory-pulse brief" }] }], PreToolUse: [{ matcher: "Edit|Write|MultiEdit|Bash", hooks: [{ type: "command", command: "npx -y memory-pulse guard" }] }, { matcher: "Bash", hooks: [{ type: "command", command: "my-own-linter" }] }], Stop: [{ hooks: [{ type: "command", command: "npx -y memory-pulse consolidate", async: true }] }], SessionEnd: [{ hooks: [{ type: "command", command: "npx -y memory-pulse consolidate --final", timeout: 10 }] }] } };
  writeFileSync(join(settings, "settings.json"), JSON.stringify(old));
  assert.equal(run(["install-hook"]).status, 0);
  const cmds = commandsIn(join(settings, "settings.json"));
  assert.equal(cmds.filter((c) => /npx/.test(c)).length, 0, cmds.join("\n"));
  for (const verb of ["brief", "guard", "consolidate", "consolidate --final"]) assert.equal(cmds.filter((c) => c.endsWith(` ${verb}`)).length, 1, `${verb}: ${cmds.join("\n")}`);
  assert.ok(JSON.stringify(JSON.parse(readFileSync(join(settings, "settings.json"), "utf8"))).includes("my-own-linter"), "other hooks are kept");
});

test("--project keeps npx: a committed file has to run on every clone", () => {
  const { settings, run } = mk("project");
  assert.equal(run(["install-hook", "--project"]).status, 0);
  for (const c of commandsIn(join(settings, "settings.json"))) assert.match(c, /^npx -y memory-pulse /, c);
});

test("--codex and --cursor at user scope use the node form too", () => {
  for (const [flag, file] of [["--codex", "hooks.json"], ["--cursor", "hooks.json"]]) {
    const { settings, run } = mk(flag.slice(2));
    const r = run(["install-hook", flag]); assert.equal(r.status, 0, r.stderr + r.stdout);
    const cmds = commandsIn(join(settings, file));
    assert.ok(cmds.length > 0, `${flag}: no hooks`);
    for (const c of cmds) assert.match(c, NODE_FORM, `${flag}: ${c}`);
  }
});

test("mode soul writes node-form hooks, and mode deliberate removes old and new forms", () => {
  const { settings, run } = mk("soul");
  mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "npx -y memory-pulse ambient" }] }] } }));
  let r = run(["mode", "soul"]); assert.equal(r.status, 0, r.stderr + r.stdout);
  const cmds = commandsIn(join(settings, "settings.json"));
  for (const verb of ["ambient", "observe", "taint"]) assert.equal(cmds.filter((c) => c.endsWith(` ${verb}`) && NODE_FORM.test(c)).length, 1, `${verb}: ${cmds.join("\n")}`);
  assert.equal(cmds.filter((c) => /npx/.test(c)).length, 0, cmds.join("\n"));
  r = run(["mode", "deliberate"]); assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(commandsIn(join(settings, "settings.json")).filter((c) => / (ambient|observe)$/.test(c)).length, 0);
});

test("the install docs name the desktop extension of this release", () => {
  const install = readFileSync(new URL("../docs/INSTALL.md", import.meta.url), "utf8");
  const named = [...install.matchAll(/memory-pulse-(\d+\.\d+\.\d+)\.mcpb/g)].map((m) => m[1]);
  assert.ok(named.length > 0, "INSTALL.md names no .mcpb file");
  assert.deepEqual([...new Set(named)], [VERSION]);
  assert.match(readFileSync(new URL("../scripts/release.sh", import.meta.url), "utf8"), /mcpb/, "release.sh bumps the .mcpb name with the version");
});

test("help prints the board description under board, not under adopt", () => {
  const { run } = mk("help");
  const lines = run(["--help"]).stdout.split("\n");
  const b = lines.findIndex((l) => /^\s+board post\|read/.test(l));
  assert.ok(b >= 0);
  assert.match(lines[b + 1], /shared agent message board/, `line after board: ${lines[b + 1]}`);
  const a = lines.findIndex((l) => /^\s+adopt \[--yes\]/.test(l));
  assert.doesNotMatch(lines[a + 1] ?? "", /shared agent message board/);
});

test("verify says how many rows the writer wrote, in plain words", () => {
  const { run } = mk("verifywords");
  assert.equal(run(["remember", "a", "b", "--note", "one"]).status, 0);
  assert.equal(run(["verify"]).status, 0);
  assert.equal(run(["remember", "c", "d", "--note", "two"]).status, 0);
  const v = run(["verify"]).stdout;
  assert.doesNotMatch(v, /row\(s\) in\)/, v);
  assert.match(v, /writer marks: OK/);
});
