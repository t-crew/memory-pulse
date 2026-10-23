// The Claude Desktop extension (2026-10-16): mcpb/manifest.json packs server.mjs into a one-click .mcpb (MCPB manifest 0.3,
// github.com/modelcontextprotocol/mcpb MANIFEST.md read 2026-10-16). Desktop passes an optional setting the user left blank as
// an empty string, so a blank key, ledger or board must behave exactly like an unset one. Written before the manifest.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER } from "./_helpers.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const listTools = (env) => {
  const r = spawnSync(process.execPath, [SERVER], { input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n", encoding: "utf8",
    cwd: mkdtempSync(join(tmpdir(), "mp-mcpb-")), env: { ...process.env, MEMORY_PULSE_API: "http://127.0.0.1:9", ...env } });
  return JSON.parse(r.stdout.split("\n").find((l) => l.includes('"tools"'))).result.tools.map((t) => t.name);
};

test("the desktop manifest carries the package version, a node entry point that exists, and the server's own tools", () => {
  const m = read("mcpb/manifest.json"), pkg = read("package.json");
  assert.equal(m.manifest_version, "0.3"); assert.equal(m.name, pkg.name); assert.equal(m.version, pkg.version);
  for (const k of ["display_name", "description", "author", "server", "user_config", "license", "repository"]) assert.ok(m[k], `manifest lacks ${k}`);
  assert.equal(m.server.type, "node"); assert.equal(m.server.entry_point, "server.mjs");
  assert.deepEqual(m.server.mcp_config.args, ["${__dirname}/server.mjs"]);
  assert.ok(existsSync(join(ROOT, "mcpb", m.icon)), "icon file missing");
  assert.deepEqual(m.tools.map((t) => t.name), listTools({}));
  assert.equal(m.tools_generated, true, "the board tools appear only when a board is configured");
});

test("every env var the manifest sets is one the server documents, and every user_config key it references exists", () => {
  const m = read("mcpb/manifest.json"); const help = readFileSync(SERVER, "utf8");
  for (const [k, v] of Object.entries(m.server.mcp_config.env)) {
    assert.match(help, new RegExp(`^\\s+${k}\\s`, "m"), `${k} is not in the server's help`);
    for (const ref of String(v).matchAll(/\$\{user_config\.(\w+)\}/g)) assert.ok(m.user_config[ref[1]], `${k} references missing user_config.${ref[1]}`);
  }
  assert.equal(m.user_config.license_key.sensitive, true);
});

test("a setting left blank behaves as unset: no board tools, no empty licence header, the default ledger", () => {
  assert.deepEqual(listTools({ MEMORY_PULSE_BOARD: "", MEMORY_PULSE_KEY: "" }), listTools({}));
  const src = readFileSync(SERVER, "utf8");
  // 0.12.0: the saved login key is the fallback; an empty MEMORY_PULSE_KEY still falls through (|| never keeps "") (2026-10-21)
  assert.match(src, /const KEY = process\.env\.MEMORY_PULSE_KEY \|\| savedKey\(\) \|\| null;/, "an empty key must not be sent as x-mp-key");
});

test("the build stages exactly the files the extension runs, and release.sh and release.yml keep its version in step", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "build-mcpb.mjs"), "--stage-only"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const stage = JSON.parse(r.stdout).stage;
  for (const f of ["manifest.json", "server.mjs", "package.json", "LICENSE", "README.md", "lib/board.mjs", read("mcpb/manifest.json").icon]) assert.ok(existsSync(join(stage, f)), `stage lacks ${f}`);
  assert.equal(existsSync(join(stage, "test")), false); assert.equal(existsSync(join(stage, "python")), false);
  assert.match(readFileSync(join(ROOT, "scripts", "release.sh"), "utf8"), /mcpb\/manifest\.json/);
  assert.match(readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"), /mcpb\/manifest\.json/);
});
