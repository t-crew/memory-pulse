// The README is byte-identical to the npm readme and is the first thing most users read. It must name every
// subcommand and environment variable the client has, carry the strings the 2026-09-09 review found missing,
// state the tool-size number the size test measures, and obey the copy rules in its prose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { dispatched, envVars, prose, BANNED } from "./_helpers.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");

test("the Commands block names every dispatched subcommand", () => {
  const start = README.indexOf("### Commands"); assert.ok(start > 0, "a Commands section exists");
  const block = README.slice(start, README.indexOf("\n## ", start));
  for (const name of dispatched()) assert.match(block, new RegExp(`memory-pulse ${name}\\b`), `Commands block lacks "${name}"`);
  assert.match(block, /memory-pulse help/);
});

test("the Environment section names every variable the client reads", () => {
  const start = README.indexOf("## Environment"); assert.ok(start > 0, "an Environment section exists");
  const block = README.slice(start, README.indexOf("\n## ", start + 1));
  for (const v of envVars()) assert.match(block, new RegExp(`\`${v}\``), `Environment section lacks ${v}`);
  assert.match(block, /NO_COLOR/);
});

test("the strings the fresh-user run and the review found missing are present", () => {
  for (const s of ["$79", "fetch-depth: 0", '"command": "npx"', "supersedes", "MEMORY_PULSE_BRIEF_BUDGET", "docs/GUIDE.md", "install.sh", "three hooks", "memory-pulse seal accept", "memory-pulse remember", "memory-pulse help", "--verbose", "250,000", "Node 18"]) {
    assert.ok(README.includes(s), `README lacks "${s}"`);
  }
});

test("the tool-size sentence states the number the size test measures", async () => {
  process.env.MEMORY_PULSE_MODE = "deliberate";
  const { TOOLS } = await import("../server.mjs");
  const size = JSON.stringify(TOOLS).length;
  assert.ok(README.includes(`${size.toLocaleString("en-US")} chars`), `README must say "${size.toLocaleString("en-US")} chars" (measured now)`);
});

test("prose obeys the copy rules: no banned words, no em dashes", () => {
  const p = prose(README);
  const hit = BANNED.exec(p); assert.equal(hit, null, `banned word "${hit?.[0]}" near: ${p.slice(Math.max(0, (hit?.index ?? 0) - 60), (hit?.index ?? 0) + 60)}`);
  const dash = p.indexOf("—"); assert.equal(dash, -1, `em dash in prose near: ${p.slice(Math.max(0, dash - 60), dash + 60)}`);
});
