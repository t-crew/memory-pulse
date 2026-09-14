// Pins the four accuracy blocks the 2026-09-09 review raised against the docs, each to the code it describes:
//   1. the shell `remember`/`help` first run is pinned to the version that has them (npm served 0.5.8 without
//      them on 2026-09-09), in the README, at the top of the guide, and in every fenced guide command;
//   2. the local brief render opens with the "engine unreachable" line and carries no sha256, and the docs say so;
//   3. SKILL.md, README and GUIDE agree that a Codex shell write is unmeasured, never "same, after trust";
//   4. the fetch-depth note quotes the string action/run.mjs logs, and the comment is not said to mention it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, SERVER, dispatched } from "./_helpers.mjs";

const README = readFileSync(join(ROOT, "README.md"), "utf8");
const GUIDE = readFileSync(join(ROOT, "docs", "GUIDE.md"), "utf8");
const SKILL = readFileSync(join(ROOT, "skills", "memory-pulse", "SKILL.md"), "utf8");
const RUN = readFileSync(join(ROOT, "action", "run.mjs"), "utf8");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const semver = (v) => v.split(".").map(Number);
const gte = (a, b) => { const [x, y] = [semver(a), semver(b)]; for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return true; };

test("the first-run pin: README and GUIDE name one version, not below package.json, that has remember and help", () => {
  const pins = [...README.matchAll(/npx -y memory-pulse@(\d+\.\d+\.\d+)/g), ...GUIDE.matchAll(/npx -y memory-pulse@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  assert.ok(pins.length >= 3, "README and GUIDE carry the pinned npx form");
  const pin = pins[0];
  assert.ok(pins.every((p) => p === pin), `every pin is ${pin}: ${[...new Set(pins)].join(", ")}`);
  assert.ok(gte(pin, PKG.version), `pin ${pin} is not below package.json ${PKG.version}`);
  for (const sub of ["remember", "help"]) assert.ok(dispatched().includes(sub) || sub === "help", `${sub} is dispatched`);
  assert.match(README, /`remember` and `help` from the shell arrive in \d+\.\d+\.\d+/, "README Install says which version brought them");
  assert.ok(README.indexOf("from the shell arrive in") < README.indexOf("**One line, any shell.**"), "the note sits under Install before the routes");
  assert.match(GUIDE.split("\n## ")[0], /`remember` and `help` from the shell arrive in \d+\.\d+\.\d+/, "the guide says so before section 1");
  assert.ok(README.includes("trust the two memory-pulse entries` while writing three hooks"), "the 0.5.8 install-hook --codex count is called out");
});

test("every fenced `npx memory-pulse` command in the guide carries the pin", () => {
  let fence = null; const bare = [];
  for (const [i, l] of GUIDE.split("\n").entries()) {
    const f = /^\s*```\s*(.*)$/.exec(l);
    if (f) { fence = fence === null ? f[1].trim() : null; continue; }
    if (fence !== null && /^sh/.test(fence) && /(?:^|\|\s*)npx\s+(?:-y\s+)?memory-pulse(\s|$)/.test(l)) bare.push(`${i + 1}: ${l}`);
  }
  assert.deepEqual(bare, [], "unpinned npx lines in guide command blocks");
  const first = /```\n(npx -y memory-pulse@\d+\.\d+\.\d+ remember [^\n]*)\n/.exec(README);
  assert.ok(first, "the README first-run remember command is pinned");
});

// 2026-09-09 re-review: the pin alone 404s until 0.5.9 is on npm (`npm error notarget`), so the First run
// block carries a second, runnable line from a checkout, and the guide's pin note carries the same one.
const firstRunBlock = () => {
  const m = /### First run[\s\S]*?```\n([\s\S]*?)```/.exec(README);
  assert.ok(m, "README has a fenced First run block");
  return m[1].split("\n").filter(Boolean);
};

test("the README first-run block has a checkout fallback that runs today with the same arguments as the pin", () => {
  const lines = firstRunBlock();
  assert.equal(lines.length, 3, `three lines: pin, comment, fallback\n${lines.join("\n")}`);
  const pin = /^npx -y memory-pulse@\d+\.\d+\.\d+ remember (.*)$/.exec(lines[0]);
  assert.ok(pin, "line 1 is the pinned npx command");
  assert.match(lines[1], /^# before \d+\.\d+\.\d+ is on npm/, "line 2 says when the fallback applies");
  const fb = /^git clone https:\/\/github\.com\/t-crew\/memory-pulse\.git && node memory-pulse\/server\.mjs remember (.*)$/.exec(lines[2]);
  assert.ok(fb, "line 3 clones the repository and runs remember from the checkout");
  assert.equal(fb[1], pin[1], "the fallback passes the same arguments as the pinned line");
  assert.ok(GUIDE.split("\n## ")[0].includes(lines[2]), "the guide's pin note carries the same fallback one-liner");
  // Run the fallback's remember half against this checkout in a scratch project: it must be first value, not a 404.
  const base = mkdtempSync(join(tmpdir(), "mp-fallback-")); const project = join(base, "p"); mkdirSync(project);
  const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, NO_COLOR: "1", MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_AGENT: join(base, "agent.jsonl"), MEMORY_PULSE_MODE: "deliberate" };
  const r = spawnSync("sh", ["-c", `"${process.execPath}" "${SERVER}" remember ${fb[1]}`], { cwd: project, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.written, true); assert.equal(out.t, 1);
  assert.deepEqual(out.stored.withdrawn, ["$49"]); assert.deepEqual(out.stored.replacement, ["$29"]);
  const g = spawnSync(process.execPath, [SERVER, "check", "--text", "the price is $49"], { cwd: project, env, encoding: "utf8" });
  assert.equal(g.status, 2, "the correction the fallback wrote is enforced");
});

test("the README Install note names every 0.5.9-only behaviour the docs describe, and the guide's piped lines are pinned", () => {
  const note = README.slice(README.indexOf("from the shell arrive in"), README.indexOf("**One line, any shell.**"));
  for (const s of ["`guard --verbose` names non-JSON stdin", "`handoff` with no transcript writes nothing", "handoff skipped (no transcript)", "`boundFromEffect`", "replacement term under 2 characters"]) {
    assert.ok(note.includes(s), `the Install note says: ${s}`);
  }
  const head = GUIDE.split("\n## ")[0];
  assert.match(head, /`guard --verbose` \(section 1\) and `handoff` \(section 8\)/, "the guide's pin note names the two piped blocks that differ on 0.5.8");
  // Each `| npx … guard` / `| npx … handoff` inside an `sh` fence carries the pin; the count is what the guide has today.
  let fence = null; const piped = [];
  for (const l of GUIDE.split("\n")) {
    const f = /^\s*```\s*(.*)$/.exec(l);
    if (f) { fence = fence === null ? f[1].trim() : null; continue; }
    if (fence !== null && /^sh/.test(fence) && /\|\s*npx\b/.test(l)) piped.push(l);
  }
  assert.ok(piped.length >= 6, `six piped npx lines in the guide, found ${piped.length}`);
  for (const l of piped) assert.match(l, /\|\s*npx -y memory-pulse@\d+\.\d+\.\d+ (guard|handoff)\b/, `pinned: ${l}`);
});

test("the local brief render opens with the engine-unreachable line, no sha256, and the docs say exactly that", () => {
  const base = mkdtempSync(join(tmpdir(), "mp-offline-"));
  const project = join(base, "p"); mkdirSync(join(project, ".memory-pulse"), { recursive: true });
  writeFileSync(join(project, ".memory-pulse", "events.jsonl"), JSON.stringify({ t: 1, cause: "a", effect: "b", kind: "correction", withdrawn: ["$49"], replacement: ["$29"], at: "2026-09-01T00:00:00Z" }) + "\n");
  const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, NO_COLOR: "1", MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_AGENT: join(base, "agent.jsonl"), MEMORY_PULSE_MODE: "deliberate" };
  const brief = spawnSync(process.execPath, [SERVER, "brief", "--offline"], { cwd: project, env, encoding: "utf8" });
  const first = brief.stdout.split("\n")[0];
  assert.match(first, /^memory-pulse: engine unreachable — local render from 1 events/, first);
  assert.ok(!/sha256/.test(brief.stdout), "the local render carries no sha256");
  assert.ok(!/binding correction/.test(brief.stdout), "the local render carries no binding count");
  // Measured 2026-09-09: `lint` prints loadedLine() offline; `verify` prints chain and seal only.
  const lint = spawnSync(process.execPath, [SERVER, "lint"], { cwd: project, env, encoding: "utf8" });
  assert.match(lint.stdout, /memory-pulse: loaded 1 events from .* · sha256 [0-9a-f]{12} · 1 binding correction/, "lint prints the provenance line offline");
  const verify = spawnSync(process.execPath, [SERVER, "verify"], { cwd: project, env, encoding: "utf8" });
  assert.ok(!/sha256/.test(verify.stdout), "verify does not print it (so the docs must not say verify)");
  for (const doc of [README, GUIDE]) {
    assert.ok(doc.includes("engine unreachable — local render from N events"), "the docs quote the local render's first line");
    assert.ok(doc.includes("`lint` prints the provenance line offline"), "the docs send the reader to lint for it");
    assert.ok(!doc.includes("first line of either render"), "no longer claims both renders carry it");
  }
  assert.ok(README.includes("Every engine-backed brief opens with one line of provenance"), "README scopes the provenance line to the engine path");
  assert.ok(!README.includes("Every brief opens with one line"), "README no longer says every brief");
});

test("Codex shell writes: SKILL.md, README and GUIDE agree that `Bash` is in the plugin matcher and unmeasured in Codex", () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
  assert.equal(hooks.hooks.PreToolUse[0].matcher, "Edit|Write|MultiEdit|apply_patch|Bash", "the plugin matcher the docs describe");
  assert.ok(SKILL.includes("the plugin matcher lists `Bash`, but whether Codex") && SKILL.includes("unmeasured (2026-09-09)"), "SKILL.md states the unmeasured Bash matcher");
  assert.ok(SKILL.includes("Treat a Codex shell write as\n  unguarded and rely on `check --ci`") || SKILL.includes("Treat a Codex shell write as unguarded and rely on `check --ci`"), "SKILL.md tells the model what to assume");
  assert.ok(!SKILL.includes("Shell writes are not matched by the Codex hook"), "the old sentence is gone");
  for (const [name, doc] of [["README", README], ["GUIDE", GUIDE]]) {
    assert.ok(!doc.includes("same, after trust"), `${name} host table no longer says "same, after trust"`);
    assert.ok(doc.includes("`apply_patch` measured, after trust; `Bash` is in the matcher, unmeasured in Codex (2026-09-09)"), `${name} host table carries the measured/unmeasured split`);
  }
});

test("the fetch-depth note quotes the job-log string from action/run.mjs and does not credit the comment with it", () => {
  assert.ok(RUN.includes("could not compute the diff (") && RUN.includes("); checking the working tree instead"), "run.mjs logs the fallback");
  assert.ok(!/renderComment[\s\S]*working tree/.test(RUN.slice(RUN.indexOf("export function renderComment"), RUN.indexOf("export const findSticky"))), "renderComment never mentions the fallback");
  assert.ok(README.includes("the job log says `could not compute the diff ... checking the working\n  tree instead`") || README.includes("the job log says `could not compute the diff ... checking the working tree instead`"), "README quotes the job-log string");
  assert.ok(!README.includes("the comment says so"), "README no longer says the comment says so");
  assert.ok(README.includes("the comment reports no evidence on an empty diff"), "README says what the comment does show");
});
