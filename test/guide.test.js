// docs/GUIDE.md is executable. Every fenced block with the info string `sh run` is run, in document order, in
// a scratch project with a scratch HOME and the engine unreachable, and every line of the `text expect`
// block that follows it must appear in the combined output. So what the guide shows is what the tool prints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { prose, BANNED } from "./_helpers.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SERVER = join(ROOT, "server.mjs");
const GUIDE = readFileSync(join(ROOT, "docs", "GUIDE.md"), "utf8");

export function blocks(md) {
  const out = []; let fence = null, buf = [];
  for (const raw of md.split("\n")) {
    const f = /^\s*```\s*(.*)$/.exec(raw);
    if (f && fence === null) { fence = f[1].trim(); buf = []; continue; }
    if (f && fence !== null) { out.push({ info: fence, body: buf.join("\n") }); fence = null; continue; }
    if (fence !== null) buf.push(raw);
  }
  return out;
}
export function steps(md) {
  const all = blocks(md); const s = [];
  for (let i = 0; i < all.length; i++) {
    if (all[i].info !== "sh run") continue;
    const next = all[i + 1];
    assert.ok(next && next.info === "text expect", `a "sh run" block must be followed by a "text expect" block (block ${i + 1}: ${all[i].body.slice(0, 60)})`);
    s.push({ cmd: all[i].body, expect: next.body.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()) });
  }
  return s;
}

function scratch() {
  const base = mkdtempSync(join(tmpdir(), "mp-guide-"));
  const home = join(base, "home"), project = join(base, "project"), bin = join(base, "bin"), settings = join(base, "settings");
  for (const d of [home, project, bin, settings]) mkdirSync(d, { recursive: true });
  // `memory-pulse` and `npx memory-pulse` on PATH resolve to this checkout's server.mjs; nothing is fetched.
  writeFileSync(join(bin, "memory-pulse"), `#!/bin/sh\nexec "${process.execPath}" "${SERVER}" "$@"\n`);
  // `npx -y memory-pulse@0.5.9 …` (the guide pins the version) and `npx memory-pulse …` both resolve here.
  writeFileSync(join(bin, "npx"), `#!/bin/sh\n[ "$1" = "-y" ] && shift\ncase "$1" in memory-pulse|memory-pulse@*) shift;; esac\nexec "${process.execPath}" "${SERVER}" "$@"\n`);
  chmodSync(join(bin, "memory-pulse"), 0o755); chmodSync(join(bin, "npx"), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: base, LANG: "C.UTF-8", NO_COLOR: "1", TERM: "dumb",
    MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_AGENT: join(home, ".memory-pulse", "agent", "events.jsonl"), MEMORY_PULSE_SETTINGS_DIR: settings };
  return { project, env };
}

test("every `sh run` block in the guide prints every line its `text expect` block promises", () => {
  const s = steps(GUIDE);
  assert.ok(s.length >= 10, `the guide has ${s.length} runnable steps; expected at least 10`);
  const { project, env } = scratch();
  for (const [i, step] of s.entries()) {
    const r = spawnSync("bash", ["-c", step.cmd], { cwd: project, env, encoding: "utf8" });
    const out = `${r.stdout}${r.stderr}`;
    for (const line of step.expect) assert.ok(out.includes(line), `step ${i + 1}\n$ ${step.cmd}\nexpected line: ${line}\ngot:\n${out}`);
  }
});

test("blocks that need the engine are marked `sh` only and say so", () => {
  const b = blocks(GUIDE);
  for (const [i, x] of b.entries()) {
    if (x.info !== "sh") continue;
    const before = GUIDE.slice(0, GUIDE.indexOf(x.body)).split("\n").slice(-6).join("\n");
    assert.ok(/engine|not run/i.test(before), `sh-only block ${i + 1} is not introduced as needing the engine or as not run: ${x.body.slice(0, 60)}`);
  }
});

test("guide prose obeys the copy rules", () => {
  const p = prose(GUIDE);
  const hit = BANNED.exec(p); assert.equal(hit, null, `banned word "${hit?.[0]}" near: ${p.slice(Math.max(0, (hit?.index ?? 0) - 60), (hit?.index ?? 0) + 60)}`);
  const dash = p.indexOf("—"); assert.equal(dash, -1, `em dash in prose near: ${p.slice(Math.max(0, dash - 60), dash + 60)}`);
});
