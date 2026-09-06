/**
 * The one plugin repo is consumed by four readers — npm, the MCP registry,
 * Claude Code and Codex — each through its own manifest. They drift silently:
 * 0.2.2 was tagged while plugin.json and server.json still said 0.2.1, which
 * would have republished stale registry metadata under a fresh npm release.
 * This pins every manifest to package.json so a tag can only ever mean one
 * version, and checks the hook/MCP files both plugin hosts share.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

test("every manifest carries the package.json version — one tag, one version", () => {
  const { version, name } = read("package.json");
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const claude = read(".claude-plugin/plugin.json");
  const codex = read(".codex-plugin/plugin.json");
  const server = read("server.json");
  assert.equal(claude.version, version, ".claude-plugin/plugin.json");
  assert.equal(codex.version, version, ".codex-plugin/plugin.json");
  assert.equal(server.version, version, "server.json");
  assert.equal(server.packages[0].version, version, "server.json packages[0]");
  assert.equal(server.packages[0].identifier, name);
  assert.equal(claude.name, name); assert.equal(codex.name, name);
});

test("both marketplaces list the plugin by its manifest name and point at this repo root", () => {
  const { name } = read("package.json");
  const cc = read(".claude-plugin/marketplace.json");
  assert.equal(cc.name, name, "install string is memory-pulse@memory-pulse");
  assert.ok(cc.owner?.name && cc.description, "owner + description (validate warns without one)");
  assert.deepEqual(cc.plugins.map((p) => [p.name, p.source]), [[name, "./"]]);
  const cx = read(".agents/plugins/marketplace.json");
  assert.equal(cx.name, name);
  assert.deepEqual(cx.plugins.map((p) => [p.name, p.source.source, p.source.path]), [[name, "local", "./"]]);
});

test("the Codex manifest points at the same skill, MCP and hook files Claude Code auto-discovers", () => {
  const codex = read(".codex-plugin/plugin.json");
  for (const [key, rel] of [["skills", "skills/"], ["mcpServers", ".mcp.json"], ["hooks", "hooks/hooks.json"]]) {
    assert.equal(codex[key], `./${rel}`, key);
    assert.ok(existsSync(join(ROOT, rel)), `${rel} exists`);
  }
  assert.ok(existsSync(join(ROOT, "skills", "memory-pulse", "SKILL.md")));
  assert.ok(codex.interface?.displayName && codex.interface?.category, "Codex plugin picker needs interface.displayName/category");
});

test("hooks.json: one SessionStart brief and one guarded PreToolUse edit matcher, both run from the plugin root", () => {
  const h = read("hooks/hooks.json").hooks;
  assert.deepEqual(Object.keys(h).sort(), ["PreToolUse", "SessionStart"]);
  const cmds = (ev) => h[ev].flatMap((g) => g.hooks.map((x) => [g.matcher, x.type, x.command]));
  assert.deepEqual(cmds("SessionStart"), [[undefined, "command", 'node "${CLAUDE_PLUGIN_ROOT}/server.mjs" brief']]);
  assert.deepEqual(cmds("PreToolUse"), [["Edit|Write|MultiEdit|apply_patch", "command", 'node "${CLAUDE_PLUGIN_ROOT}/server.mjs" guard']]);
});

test(".mcp.json launches this repo's server through the plugin-root variable both hosts expand", () => {
  const m = read(".mcp.json").mcpServers["memory-pulse"];
  assert.equal(m.command, "node");
  assert.deepEqual(m.args, ["${CLAUDE_PLUGIN_ROOT}/server.mjs"]);
});

// The description is the pitch a developer reads in npm search, the MCP
// registry, Claude Code's plugin browser, Codex and the marketplace. All five
// had drifted into five different sentences, each opening on the architecture
// ("Causal project memory") instead of what the tool does. Versions were
// pinned here; the sentence was not, so it drifted freely. Now it cannot.
test("every manifest opens the pitch with the same sentence, in the product voice", () => {
  const LEAD = "Corrections that outlive the session.";
  // Each registry enforces its own ceiling. The MCP registry rejects a publish
  // with 422 "expected length <= 100" on body.description, which failed the
  // v0.5.2 release after npm had already published. The others truncate in the
  // UI rather than refusing, so 260 is the practical limit there.
  const surfaces = {
    "package.json": [(d) => d.description, 260],
    "server.json": [(d) => d.description, 100],
    ".claude-plugin/plugin.json": [(d) => d.description, 260],
    ".codex-plugin/plugin.json": [(d) => d.description, 260],
    ".claude-plugin/marketplace.json": [(d) => d.plugins[0].description, 260],
  };
  for (const [file, [pick, cap]] of Object.entries(surfaces)) {
    const text = pick(read(file));
    assert.ok(text, `${file} has no description`);
    assert.ok(text.startsWith(LEAD), `${file} does not open with the shared lead: ${text.slice(0, 60)}`);
    // Tells we removed from every public surface. A semicolon or an em-dash in
    // a one-line pitch reads as generated; "Causal project memory" sells the
    // mechanism before the outcome.
    for (const tell of ["Causal project memory", ";", "—", ", not "]) {
      assert.ok(!text.includes(tell), `${file} description carries "${tell}"`);
    }
    assert.ok(text.length <= cap, `${file} description is ${text.length} chars, over its ${cap} limit`);
  }
});
