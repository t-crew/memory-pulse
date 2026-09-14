// `memory-pulse help` (also --help, -h, and --help/-h after any subcommand) prints one line per subcommand
// and one per environment variable. The dispatch table in server.mjs is the source of truth for both lists,
// so a subcommand or env var added without a help line fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "..", "server.mjs");
const env = { ...process.env, MEMORY_PULSE_MODE: "deliberate", MEMORY_PULSE_AGENT: "/nonexistent/agent/events.jsonl", NO_COLOR: "1" };
const run = (args, input = "") => spawnSync(process.execPath, [SERVER, ...args], { env, input, encoding: "utf8" });

import { dispatched, envVars } from "./_helpers.mjs";

test("help, --help, -h, and --help/-h after a subcommand all print the same help and exit 0", () => {
  const forms = [["help"], ["--help"], ["-h"], ["brief", "--help"], ["check", "-h"]];
  const outs = forms.map((f) => run(f));
  for (const [i, o] of outs.entries()) {
    assert.equal(o.status, 0, `${forms[i].join(" ")} exit ${o.status}: ${o.stderr}`);
    assert.equal(o.stderr, "", `${forms[i].join(" ")} wrote to stderr`);
    assert.ok(o.stdout.length > 500, `${forms[i].join(" ")} printed ${o.stdout.length} chars`);
    assert.equal(o.stdout, outs[0].stdout, `${forms[i].join(" ")} differs from help`);
  }
});

test("every dispatched subcommand appears exactly once at line start in the help output", () => {
  const out = run(["help"]).stdout;
  const all = dispatched();
  for (const name of all) {
    // "guard" must not count the "guard allow" line.
    const longer = all.filter((o) => o !== name && o.startsWith(name + " ")).map((o) => o.slice(name.length));
    const re = new RegExp(`^  ${name}(?= |$)${longer.length ? `(?!${longer.join("|")})` : ""}`, "gm");
    const n = (out.match(re) ?? []).length;
    assert.equal(n, 1, `"${name}" appears ${n} time(s) at line start in help`);
  }
  assert.match(out, /^  serve\b/m, "the default (MCP stdio) is listed as serve");
  assert.match(out, /^  remember\b/m);
  assert.match(out, /^  help\b/m);
  assert.match(out, /docs\/GUIDE\.md/, "help points at the guide");
});

test("every environment variable the client reads is listed in the Environment block", () => {
  const out = run(["help"]).stdout;
  const block = out.slice(out.indexOf("Environment"));
  assert.ok(block.length > 100, "an Environment block exists");
  for (const v of envVars()) assert.match(block, new RegExp(`^  ${v}\\b`, "m"), `${v} missing from Environment`);
  assert.match(block, /NO_COLOR/); assert.match(block, /^  HOME\b/m);
});

test("an unknown command exits 1 and points at help; the default with stdin closed still serves", () => {
  const bad = run(["bogus"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown command: bogus/);
  assert.match(bad.stderr, /run memory-pulse help/);
  const serve = run([]);
  assert.equal(serve.status, 0);
  assert.match(serve.stderr, /^memory-pulse: ledger /);
});
