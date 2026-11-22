// Shared by the team-path tests (test/team-*.test.js). Not a test file (no .test.js suffix), so importing it registers nothing.
// Real git in throwaway repositories: every engineer has a temp HOME, a temp global git config, a temp trust store (writer key and
// anchors) and a temp data dir (the pinned copy the driver runs), and nothing here touches this checkout's own repository or ledger.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SERVER } from "./_helpers.mjs";

// tests never write this machine's trust store (0.16.0): this module is evaluated before the test file's own lines, so it names the temp ones too
process.env.MEMORY_PULSE_TRUST_DIR ??= mkdtempSync(join(tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= mkdtempSync(join(tmpdir(), "mp-data-"));
process.env.MEMORY_PULSE_MODE = "deliberate"; process.env.MEMORY_PULSE_AGENT = "/nonexistent/agent/events.jsonl";
process.env.MEMORY_PULSE_API = "http://127.0.0.1:9";
const mod = await import("../server.mjs?team=" + Date.now());
export const { verifyChainLines, contentHeadHex, setHeadHex, inForce, rowHash, sealDigest, buildCapsule, mergeCapsule } = mod;
export { SERVER };

export const TMP = mkdtempSync(join(tmpdir(), "mp-team-"));
export const LEDGER = ".memory-pulse/events.jsonl", RULES = ".memory-pulse/invariants.jsonl";
// nothing of the caller's git or memory-pulse environment reaches a test repository
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|MEMORY_PULSE_|MP_)/.test(k)));
export const out = (r) => `${r.stdout}${r.stderr}`;
export const ok = (r, what) => { assert.equal(r.status, 0, `${what}: exit ${r.status}\n${out(r)}`); return r; };
export const hook = (content, file = "/tmp/x.md") => JSON.stringify({ tool_name: "Write", tool_input: { file_path: file, content } });
/** Rows for a ledger text, chained after its last row without a process per row (no writer mark, like rows from another machine):
 *  `chars` is the note's length, and every `every`-th row is a correction. Returns the lines to append. */
export function chainedRows(text, prefix, count, { chars = 40, every = 0 } = {}) {
  let prev = null, t = 0;
  for (const l of text.split("\n")) { if (!l.trim()) continue; const r = JSON.parse(l); if (typeof r.hash === "string") prev = r.hash; if (r.t > t) t = r.t; }
  const out = [];
  for (let i = 1; i <= count; i++) {
    const fix = every > 0 && i % every === 0;
    const row = { t: ++t, cause: `${prefix}-${fix ? "fix" : "finding"}-${i}`, effect: `effect-${i}`, kind: fix ? "correction" : "event",
      ...(fix ? { withdrawn: [`${prefix}Old${i}(`], replacement: [`${prefix}New${i}(`] } : { note: `finding ${i} of ${prefix}: ` + "measured value and context. ".repeat(Math.ceil(chars / 28)).slice(0, chars) }), prev };
    if (prev === null) row.legacy_digest = sealDigest([]);
    row.hash = rowHash(row); prev = row.hash; out.push(JSON.stringify(row));
  }
  return out;
}
/** Append `count` such rows to an engineer's ledger. */
export const bulk = (e, prefix, count, opts) => appendFileSync(e.file(), chainedRows(e.text(), prefix, count, opts).join("\n") + "\n");
let seq = 0;

/** One engineer's machine: its own HOME, global git config, trust store (writer key, anchors) and pinned copy of the client. */
export function engineer(name, dir) {
  const home = join(TMP, `home-${name}-${++seq}`); mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "gitconfig"), "");
  const env = { ...CLEAN, HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true",
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@example.invalid`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@example.invalid`,
    MEMORY_PULSE_TRUST_DIR: join(home, "trust"), MEMORY_PULSE_DATA_DIR: join(home, "data"), MEMORY_PULSE_MODE: "deliberate",
    MEMORY_PULSE_AGENT: join(home, "no-agent", "events.jsonl"), MEMORY_PULSE_API: "http://127.0.0.1:9", NO_COLOR: "1", TERM: "dumb" };
  const e = { name, home, env, dir,
    git: (...args) => spawnSync("git", args, { cwd: e.dir, env, encoding: "utf8" }),
    mp: (args, input = "") => spawnSync(process.execPath, [SERVER, ...args], { cwd: e.dir, env, input, encoding: "utf8" }),
    file: (rel = LEDGER) => join(e.dir, rel),
    text: (rel = LEDGER) => readFileSync(join(e.dir, rel), "utf8"),
    lines: (rel = LEDGER) => readFileSync(join(e.dir, rel), "utf8").split("\n").filter((l) => l.trim()),
    rows: (rel = LEDGER) => e.lines(rel).map((l) => JSON.parse(l)),
    remember: (cause, effect, ...rest) => ok(e.mp(["remember", cause, effect, ...rest]), `${name} remember ${cause}`),
    correct: (cause, withdrawn, replacement, note = `${withdrawn} was wrong`) => e.remember(cause, `${cause}-corrected`, "--kind", "correction", "--note", note, "--withdrawn", withdrawn, "--replacement", replacement),
    commit: (msg) => { ok(e.git("add", "-A"), `${name} git add`); return ok(e.git("commit", "-q", "-m", msg), `${name} commit`); },
    blocked: (text, file) => e.mp(["guard"], hook(text, file)).status === 2,
  };
  return e;
}

// The shared starting point, built once: a repository whose ledger holds two rows, with the team setup committed.
const TEMPLATE = join(TMP, "template");
{
  mkdirSync(TEMPLATE, { recursive: true });
  const s = engineer("seed", TEMPLATE);
  ok(s.git("init", "-q", "-b", "main"), "git init");
  writeFileSync(join(TEMPLATE, ".gitignore"), ".memory-pulse/*\n!.memory-pulse/events.jsonl\n!.memory-pulse/invariants.jsonl\n");
  s.remember("pricing-shipped", "price-set", "--note", "the price went live");
  s.correct("region-review", "eu-west-9", "eu-west-1");
  s.mp(["team", "setup"]);              // not asserted here: before the change this command does not exist, and the merges below conflict
  s.commit("base: ledger and team setup");
}

/** A fresh origin with the template's history, and one clone per engineer. A name in `noSetup` clones and never runs team setup. */
export function world(names = ["alice", "bob"], { noSetup = [] } = {}) {
  const root = mkdtempSync(join(TMP, "world-")), origin = join(root, "origin.git");
  ok(spawnSync("git", ["clone", "-q", "--bare", TEMPLATE, origin], { env: engineer("init", root).env, encoding: "utf8" }), "bare clone");
  const w = { root, origin };
  for (const n of names) {
    const e = engineer(n, join(root, n));
    ok(spawnSync("git", ["clone", "-q", origin, e.dir], { env: e.env, encoding: "utf8" }), `${n} clone`);
    if (!noSetup.includes(n)) e.mp(["team", "setup"]);
    w[n] = e;
  }
  return w;
}
/** Each engineer records on a branch of their own and pushes it. */
export function branchWith(e, branch, record) {
  ok(e.git("checkout", "-q", "-b", branch), `${e.name} branch`);
  record(e);
  e.commit(`${branch}: recorded`);
  ok(e.git("push", "-q", "origin", branch), `${e.name} push`);
}
export const merge = (e, ref, env = {}) => { ok(e.git("fetch", "-q", "origin"), "fetch"); return spawnSync("git", ["merge", "--no-edit", "-m", `merge ${ref}`, ref], { cwd: e.dir, env: { ...e.env, ...env }, encoding: "utf8" }); };
// a PATH as a git client might have it: git's own directory and the system ones, without the directory node lives in (when they differ)
const GIT_DIR = dirname(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/git");
export const BARE_PATH = [...new Set([GIT_DIR, "/usr/bin", "/bin"])].filter((d) => d !== dirname(process.execPath) || d === GIT_DIR).join(":");
export const noMarkers = (e, rel = LEDGER) => assert.ok(!/^(<<<<<<<|=======|>>>>>>>)/m.test(e.text(rel)), `${rel} holds git conflict markers:\n${e.text(rel)}`);
export const findings = (rows) => inForce(rows).filter((r) => !(r.tags ?? []).some((t) => ["state", "merge", "rollback"].includes(t))).map((r) => `${r.cause} -> ${r.effect}`).sort();

// The driver on files, as git calls it: memory-pulse merge-driver <base> <ours> <theirs> <path>.
export function files(name) {
  const dir = mkdtempSync(join(TMP, `files-${name}-`)), e = engineer(name, dir);
  const at = (f) => join(dir, f);
  const write = (f, ...rest) => ok(spawnSync(process.execPath, [SERVER, "remember", ...rest], { cwd: dir, env: { ...e.env, MEMORY_PULSE_LEDGER: at(f) }, encoding: "utf8" }), `remember into ${f}`);
  const driver = (...args) => spawnSync(process.execPath, [SERVER, "merge-driver", ...args], { cwd: dir, env: e.env, encoding: "utf8" });
  return { dir, e, at, write, driver, read: (f) => readFileSync(at(f), "utf8") };
}
