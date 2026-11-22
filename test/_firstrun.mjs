// Shared by the first-run tests (demo, doctor, init). Not a test file (no .test.js suffix), so importing it registers nothing.
// Every run gets its own HOME, project folder, temp folder and PATH. The PATH holds node and nothing else, so a host's command
// (claude, codex, cursor) on the machine running the suite is never seen, and the environment is built from nothing, so a
// MEMORY_PULSE_* variable set on that machine never reaches the command under test. The engine address is a closed local port.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ROOT, SERVER } from "./_helpers.mjs";

export { ROOT, SERVER };
export const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

// The machine's git, for the tests of the team path (a project install inside a git work tree); null where there is none.
export const GIT = String(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "git")).find((p) => existsSync(p)) ?? null;

export function fixture({ git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mp-firstrun-"));
  const home = join(root, "home"), proj = join(root, "proj"), bin = join(root, "bin"), tmp = join(root, "tmp");
  for (const d of [home, proj, bin, tmp]) mkdirSync(d);
  symlinkSync(process.execPath, join(bin, "node"));
  const env = { PATH: bin, HOME: home, TMPDIR: tmp, NO_COLOR: "1", MEMORY_PULSE_API: "http://127.0.0.1:9" };
  // git on the PATH, with no system or user configuration, and the project folder made a repository
  if (git) {
    symlinkSync(GIT, join(bin, "git")); Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig") });
    const r = spawnSync(GIT, ["init", "-q", proj], { env, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git init: ${r.stderr}`);
  }
  const run = (args, { input = "", extra = {}, cwd = proj } = {}) => {
    const t = Date.now();
    const r = spawnSync(process.execPath, [SERVER, ...args], { cwd, env: { ...env, ...extra }, input, encoding: "utf8", timeout: 60000 });
    return { status: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t };
  };
  // the same, without blocking this process: a test that answers the command over HTTP needs its own event loop free
  const runAsync = (args, { extra = {}, cwd = proj } = {}) => new Promise((resolve) => {
    const c = spawn(process.execPath, [SERVER, ...args], { cwd, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { err += d; });
    c.on("close", (status) => resolve({ status, out, err }));
  });
  return { root, home, proj, bin, tmp, env, run, runAsync };
}

/** Every file under a folder, as sorted relative paths. */
export const tree = (dir, prefix = "") => readdirSync(dir).sort().flatMap((f) => { const s = lstatSync(join(dir, f)); return s.isDirectory() ? tree(join(dir, f), `${prefix}${f}/`) : [`${prefix}${f}`]; });
/** Every file under a folder with its bytes (a link with where it points), to compare a folder before and after a command. */
export const snapshot = (dir) => Object.fromEntries(tree(dir).map((f) => { const p = join(dir, f); return [f, lstatSync(p).isSymbolicLink() ? `-> ${readlinkSync(p)}` : readFileSync(p, "latin1")]; }));
/** Replace a file install-hook copied. The copy keeps the mode of the package's file, which is read-only when the checkout is. */
export const rewrite = (file, content) => { rmSync(file, { force: true }); writeFileSync(file, content); };
/** The paths that differ between two snapshots: added, removed or changed. */
export const changed = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
export const check = (json, id) => json.checks.find((c) => c.id === id);
export const line = (text, status, label) => text.split("\n").find((l) => l.startsWith(status) && l.slice(status.length).trimStart().startsWith(label));
