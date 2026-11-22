// Output that reaches a pipe whole. Found on 2026-11-22 by running the suite on macOS with Node 20: a command that printed and then
// exited lost everything past the first 8,192 bytes when another program captured its output (every host runs a hook that way, and
// so does an agent's shell tool). Measured on macOS: cut at 8,192 bytes on Node 18 and 20, at 65,536 bytes on Node 22 to 26; nothing
// is cut on Linux. `help` was 18 KB, and `scaffold --section corrections` on a ledger of 120 corrections 11 KB: an agent read a list
// of corrections that stopped in the middle with nothing to say so.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "server.mjs");
const HOME = mkdtempSync(join(tmpdir(), "mp-whole-home-"));
const clean = (extra = {}) => { const e = { ...process.env, HOME, ...extra }; for (const k of ["MEMORY_PULSE_KEY", "MP_LEDGER", "MEMORY_PULSE_PROJECT", "MEMORY_PULSE_BOARD", "NODE_TEST_CONTEXT"]) delete e[k]; if (!("MEMORY_PULSE_LEDGER" in extra)) delete e.MEMORY_PULSE_LEDGER; return e; };

// A project whose ledger holds n corrections, written in one process through the product's own writer.
function project(n) {
  const dir = mkdtempSync(join(tmpdir(), "mp-whole-")); mkdirSync(join(dir, ".memory-pulse"));
  const led = join(dir, ".memory-pulse", "events.jsonl");
  const seed = `import { appendEvent } from ${JSON.stringify(pathToFileURL(CLI).href)};
    for (let i = 0; i < ${n}; i++) appendEvent({ cause: "setting-" + i + "-shipped", effect: "setting-" + i + "-corrected", kind: "correction", withdrawn: ["old-value-" + i + "-of-the-deployment-region"], replacement: ["new-value-" + i + "-for-the-region"], note: "setting " + i + " was wrong in the first release" });`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", seed], { cwd: dir, encoding: "utf8", env: clean({ MEMORY_PULSE_LEDGER: led }) });
  assert.equal(r.status, 0, r.stderr);
  return { dir, env: clean({ MEMORY_PULSE_LEDGER: led }) };
}
// The same command twice: captured through a pipe, and written to a file (a file is always written whole).
function both(args, p) {
  const piped = spawnSync(process.execPath, [CLI, ...args], { cwd: p.dir, env: p.env, maxBuffer: 1 << 27 });
  const out = join(p.dir, `out-${args[0]}.txt`), fd = openSync(out, "w");
  const filed = spawnSync(process.execPath, [CLI, ...args], { cwd: p.dir, env: p.env, stdio: ["ignore", fd, "ignore"] }); closeSync(fd);
  return { piped: piped.stdout.length, whole: readFileSync(out).length, status: [piped.status, filed.status] };
}

test("help reaches a pipe whole: as many bytes as reach a file", () => {
  const p = project(1), r = both(["help"], p);
  assert.ok(r.whole > 9000, `help is ${r.whole} bytes`);
  assert.equal(r.piped, r.whole);
});

test("a list of corrections longer than 64 KB reaches a pipe whole, with the same exit status", () => {
  const p = project(900), r = both(["scaffold", "--section", "corrections"], p);
  assert.ok(r.whole > 70000, `the list is ${r.whole} bytes; the test needs more than 65,536`);
  assert.equal(r.piped, r.whole);
  assert.deepEqual(r.status, [0, 0]);
});

test("the stdio server answers every request of a scripted session before it exits", () => {
  const p = project(1);
  const session = Array.from({ length: 60 }, (_, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/list" })).join("\n") + "\n";
  const r = spawnSync(process.execPath, [CLI], { cwd: p.dir, env: p.env, input: session, encoding: "utf8", maxBuffer: 1 << 27 });
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.ok(Buffer.byteLength(r.stdout) > 70000 || lines.length === 60, `only ${Buffer.byteLength(r.stdout)} bytes came back`);
  assert.equal(lines.length, 60, `${lines.length} of 60 answers arrived`);
  for (const l of lines) JSON.parse(l);
});

test("a reader that stops reading early does not hang the command or change its exit status", async () => {
  const p = project(900);
  const r = await new Promise((done) => {
    const c = spawn(process.execPath, [CLI, "scaffold", "--section", "corrections"], { cwd: p.dir, env: p.env, stdio: ["ignore", "pipe", "pipe"] });
    let err = ""; c.stderr.on("data", (d) => { err += d; });
    c.stdout.once("data", () => c.stdout.destroy());
    const t = setTimeout(() => { c.kill("SIGKILL"); }, 10000);
    c.on("close", (code, signal) => { clearTimeout(t); done({ code, signal, err }); });
  });
  assert.equal(r.signal, null, "it ended by itself");
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /EPIPE|at node:|Error:/, "no stack trace for a closed pipe");
});
