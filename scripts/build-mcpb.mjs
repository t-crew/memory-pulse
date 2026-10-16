#!/usr/bin/env node
// Build the Claude Desktop extension: stage exactly what the server runs beside mcpb/manifest.json, then pack it with the
// official CLI into dist/memory-pulse-<version>.mcpb. `--stage-only` stops after staging and prints the stage path (the test
// uses it; packing needs the network for npx). The manifest's version is held to package.json by test/mcpb.test.js.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "mcpb", "manifest.json"), "utf8"));
const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
if (manifest.version !== version) { console.error(`mcpb/manifest.json is ${manifest.version}, package.json is ${version}`); process.exit(1); }

const stage = mkdtempSync(join(tmpdir(), "mp-mcpb-stage-"));
cpSync(join(ROOT, "mcpb", "manifest.json"), join(stage, "manifest.json"));
cpSync(join(ROOT, "mcpb", manifest.icon), join(stage, manifest.icon));
for (const f of ["server.mjs", "package.json", "LICENSE", "README.md"]) cpSync(join(ROOT, f), join(stage, f));
mkdirSync(join(stage, "lib"));
for (const f of readdirSync(join(ROOT, "lib")).filter((f) => f.endsWith(".mjs"))) cpSync(join(ROOT, "lib", f), join(stage, "lib", f));
if (process.argv.includes("--stage-only")) { console.log(JSON.stringify({ stage })); process.exit(0); }

const out = join(ROOT, "dist", `memory-pulse-${version}.mcpb`);
mkdirSync(join(ROOT, "dist"), { recursive: true });
const npx = (args) => spawnSync("npx", ["-y", "@anthropic-ai/mcpb@2.1.2", ...args], { stdio: "inherit" });
if (npx(["validate", join(stage, "manifest.json")]).status !== 0) process.exit(1);
if (npx(["pack", stage, out]).status !== 0) process.exit(1);
console.log(`built ${out}`);
