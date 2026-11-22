// First run (2026-11-21): `demo`, `doctor` and `init`. An audit of 0.18.0 found no one command that shows a block, sets the hooks
// up, or confirms the wiring. These three are that path. They run the product's own commands as children instead of restating
// what those commands do:
//   demo    records a correction with `remember` and runs `guard` on three edits, in a temporary folder
//   doctor  reads each host's hook files, then runs the installed hook command itself against a temporary ledger
//   init    runs `install-hook` for each host it finds (first on a scratch copy, to say what would change), then doctor
// What doctor executes (review 2026-11-21, R-1): this copy's own server.mjs, or a memory-pulse copy whose real path is inside the
// pinned data folder or a plugin cache under HOME, started with node and an argument list. A hook file can come with a
// repository, so no command read from one is ever run, through a shell or otherwise; it is shown as text and reported as not run.
// What is restated here is reading only: the shape of a hook command, and the two path rules of install-hook (where it writes,
// where it keeps the pinned copy). The tests hold both to what install-hook writes. Every temporary run gets its environment
// from sandboxEnv(), so it never resolves the caller's ledger, agent ledger, trust store, usage counts or key. Nothing here reads
// or prints a key, and nothing needs the network: the engine check is one GET with no key, reported as information.
// Tests: test/firstrun-*.test.js.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import http from "node:http";
import https from "node:https";
import { matcherCovers } from "./hosts.mjs";
import { foreignLayout, UPGRADE } from "./layout.mjs";
import { DRIVER } from "./gitmerge.mjs";

// ------------------------------------------------------------------ shared ----
const envOf = (ctx) => ctx.env ?? process.env;
const cwdOf = (ctx) => ctx.cwd ?? process.cwd();
const homeOf = (env) => env.HOME || env.USERPROFILE || homedir();
const printer = (ctx) => ctx.out ?? ((s) => process.stdout.write(`${s}\n`));
const fail = (ctx, cmd, msg) => { (ctx.err ?? ((s) => process.stderr.write(`${s}\n`)))(`memory-pulse ${cmd}: ${msg} (run memory-pulse help)`); return 1; };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };
const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
// what a child that threw printed, as its message and not the first line of its stack
const errorLine = (stderr) => (/^(?:[A-Za-z]*Error|Error \[[A-Z_]+\]): (.+)$/m.exec(String(stderr ?? "")) ?? [])[1] ?? firstLine(stderr);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function parseFlags(argv, { bool = [], value = [] }) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(argv[i]);
    if (!m) return { error: `unexpected argument ${argv[i]}` };
    if (bool.includes(m[1]) && m[2] === undefined) { o[m[1]] = true; continue; }
    if (!value.includes(m[1])) return { error: `unknown option --${m[1]}` };
    const v = m[2] ?? argv[++i];
    if (v == null || v === "") return { error: `--${m[1]} needs a value` };
    o[m[1]] = v;
  }
  return { o };
}

// The environment a temporary run gets: the caller's, minus every variable that points memory-pulse or a host at the caller's own
// files, with HOME moved into the temporary folder. The ledger, the agent ledger, the trust store, the usage counts and the saved
// key a child resolves are then all under that folder, and no key is passed on.
function sandboxEnv(env, home) {
  const e = {};
  for (const [k, v] of Object.entries(env)) if (!/^(MEMORY_PULSE_|MP_|XDG_|CLAUDE|CODEX_|CURSOR_)/i.test(k)) e[k] = v;
  Object.assign(e, { HOME: home, NO_COLOR: "1" });
  if (process.platform === "win32") Object.assign(e, { USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local"), APPDATA: join(home, "AppData", "Roaming") });
  return e;
}
// Every temporary folder made here is removed when its work is done, when the command fails, and on Ctrl-C or a termination
// signal: a plan folder holds a copy of the user's settings file, and none of them may stay behind. With a handler in place the
// signal no longer ends this process in the middle of a child; the child that was running reports it (interrupted), or the
// handler runs as soon as the process is waiting, and either way the folders go first. The path is the real one, links followed.
const live = new Set(); let hooked = false;
const dropTemp = (root) => { rmSync(root, { recursive: true, force: true }); live.delete(root); };
const leave = (code) => { for (const d of [...live]) dropTemp(d); process.exit(code); };
function tempDir(name) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `memory-pulse-${name}-`)));
  live.add(root);
  if (!hooked) { hooked = true; for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.once(sig, () => leave(code)); }
  return root;
}
const interrupted = (r) => { if (r.signal === "SIGINT" || r.signal === "SIGTERM" || r.signal === "SIGHUP") leave(r.signal === "SIGINT" ? 130 : r.signal === "SIGTERM" ? 143 : 129); };
// One sentence where a raw stack would print: a temporary folder that cannot be made, a file that cannot be read or written.
async function sentence(ctx, cmd, run) {
  try { return await run(); }
  catch (e) {
    for (const d of [...live]) dropTemp(d);
    const what = e?.syscall === "mkdtemp" ? `cannot make a temporary folder in ${tmpdir()} (${e.code}); set TMPDIR to a folder that can be written` : `${e?.code ? `${e.code}: ` : ""}${firstLine(e?.message ?? e)}`;
    (ctx.err ?? ((s) => process.stderr.write(`${s}\n`)))(`memory-pulse ${cmd}: ${what}`);
    return 1;
  }
}
function sandbox(name) {
  const root = tempDir(name), home = join(root, "home"), project = join(root, "project");
  mkdirSync(home); mkdirSync(project);
  return { root, home, project, remove: () => dropTemp(root) };
}
// This package's own server.mjs, as a child: the same entry point a hook or a shell runs.
function runServer(ctx, args, { cwd, env, input = "" }) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [ctx.server, ...args], { cwd, env, input, encoding: "utf8", timeout: 30000 });
  interrupted(r);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ms: Date.now() - t };
}
// A correction, through the writer: `remember --kind correction`. Returns the row number, or the reason it was refused.
function recordCorrection(ctx, sb, env, { cause, effect, withdrawn, replacement }) {
  const r = runServer(ctx, ["remember", cause, effect, "--kind", "correction", "--withdrawn", withdrawn, "--replacement", replacement], { cwd: sb.project, env });
  let res = null; try { res = JSON.parse(r.stdout); } catch { res = null; }
  return res?.written ? { t: res.t, kept: res.stored?.withdrawn ?? [], hint: res.hint ?? "" } : { t: null, reason: res?.reason ?? (firstLine(r.stderr) || `remember exited ${r.status}`) };
}
// The tool call a host sends its pre-tool hook: Claude Code's shape, and Cursor's (lib/hosts.mjs maps it onto the first).
const toolPayload = (cwd, tool, input, cursor = false) => JSON.stringify(cursor
  ? { hook_event_name: "preToolUse", conversation_id: "memory-pulse-first-run", workspace_roots: [cwd], tool_name: tool, tool_input: input }
  : { hook_event_name: "PreToolUse", session_id: "memory-pulse-first-run", cwd, tool_name: tool, tool_input: input });
const editPayload = (cwd, file, text) => toolPayload(cwd, "Write", { file_path: file, content: text });
const contextOf = (stdout) => { try { return JSON.parse(stdout)?.hookSpecificOutput?.additionalContext ?? ""; } catch { return ""; } };

// -------------------------------------------------------------------- demo ----
// `memory-pulse demo [--withdrawn <old>] [--replacement <new>] [--text "<edit>"] [--json]`
// Exit 0 when the three verdicts were the ones it describes (2, 0, 0); 1 when they were not, or on a usage error.
export const cliDemo = (argv, ctx) => sentence(ctx, "demo", () => demo(argv, ctx));
async function demo(argv, ctx) {
  const { o, error } = parseFlags(argv, { bool: ["json"], value: ["withdrawn", "replacement", "text"] });
  if (error) return fail(ctx, "demo", error);
  const out = printer(ctx), withdrawn = o.withdrawn ?? "$49", replacement = o.replacement ?? "$29";
  if (withdrawn === replacement) return fail(ctx, "demo", "--withdrawn and --replacement must differ");
  const priced = /^\$\d/.test(withdrawn) && /^\$\d/.test(replacement);
  const file = priced ? "pricing.md" : "notes.md";
  const [cause, effect] = priced ? ["pricing-shipped", "price-corrected"] : ["first-value-shipped", "value-corrected"];
  const edits = (priced
    ? [["The edit writes the withdrawn value back", `Pro plan: ${withdrawn} a month`, 2], ["The edit uses the replacement", `Pro plan: ${replacement} a month`, 0], ["The edit names both values, as a comparison", `Pro plan: ${replacement} a month (was ${withdrawn})`, 0]]
    : [["The edit writes the withdrawn value back", `Use ${withdrawn}.`, 2], ["The edit uses the replacement", `Use ${replacement}.`, 0], ["The edit names both values, as a comparison", `Use ${replacement}, not ${withdrawn}.`, 0]]
  ).map(([label, text, expected]) => ({ label, text, expected }));
  if (o.text !== undefined) edits.push({ label: "Your edit", text: o.text, expected: null });
  const command = `memory-pulse remember ${cause} ${effect} --kind correction --withdrawn ${shq(withdrawn)} --replacement ${shq(replacement)}`;

  const sb = sandbox("demo"); let row;
  try {
    const env = sandboxEnv(envOf(ctx), sb.home);
    row = recordCorrection(ctx, sb, env, { cause, effect, withdrawn, replacement });
    if (row.t !== null && row.kept.length) for (const e of edits) {
      const r = runServer(ctx, ["guard"], { cwd: sb.project, env, input: editPayload(sb.project, file, e.text) });
      Object.assign(e, { file, exit: r.status, blocked: r.status === 2, stderr: r.stderr, context: contextOf(r.stdout), ms: r.ms });
    }
  } finally { sb.remove(); }
  const bound = row.t !== null && row.kept.length > 0;   // the writer drops a term it will not enforce (under 2 characters)
  const wrong = bound ? edits.filter((e) => e.expected !== null && e.exit !== e.expected) : [];
  const described = bound && !wrong.length;

  if (o.json) {
    out(JSON.stringify({ version: ctx.version, correction: { cause, effect, withdrawn, replacement, command, row: row.t, ...(row.reason ? { refused: row.reason } : {}), ...(row.t !== null && !bound ? { enforced: false } : {}) },
      edits: !bound ? [] : edits.map((e, i) => ({ n: i + 1, label: e.label, file: e.file, text: e.text, exit: e.exit, blocked: e.blocked, stderr: e.stderr, context: e.context, ms: e.ms })),
      as_described: described, removed: !existsSync(sb.root) }, null, 2));
    return described ? 0 : 1;
  }
  out(`memory-pulse ${ctx.version} demo: one correction, ${edits.length === 3 ? "three" : "four"} edits, and the guard's verdict on each.`);
  out("Nothing is installed and nothing leaves this machine. The demo works in a temporary folder and removes it.");
  out("");
  out("A correction is a value you withdrew and the value that replaced it. The demo records one:");
  out(`  $ ${command}`);
  if (row.t === null) { out(`  the writer refused it: ${row.reason}`); out("The demo did not behave as described: no correction was recorded, so no edit was checked."); return 1; }
  out(`  recorded as row t${row.t} of .memory-pulse/events.jsonl`);
  if (!bound) {
    out(`The demo did not behave as described: the writer did not keep "${withdrawn}" as a withdrawn term, so the guard has nothing to enforce and no edit was checked.`);
    if (row.hint) out(`     | ${row.hint}`);
    return 1;
  }
  out("");
  out(`Before an agent's edit is applied, its host runs \`memory-pulse guard\` with the edit on stdin. ${edits.length === 3 ? "Three" : "Four"} edits to ${file}:`);
  out("");
  const quote = (text) => { for (const l of text.trimEnd().split("\n")) out(`     | ${l}`); };
  let lastContext = null;   // the text form carries no timings, so it reads the same on every run (the guide quotes it); --json has them
  for (const [i, e] of edits.entries()) {
    out(`${i + 1}. ${e.label}: ${e.text}`);
    if (e.exit === 2) { out("   exit status 2. The host cancels the edit and the agent reads:"); quote(e.stderr); }
    else if (e.exit === 0 && e.context && e.context === lastContext) out("   exit status 0. The edit goes through with the same note.");
    else if (e.exit === 0 && e.context) { out("   exit status 0. The edit goes through, and Claude Code hands the agent this note:"); quote(e.context); lastContext = e.context; }
    else if (e.exit === 0) out("   exit status 0. The edit goes through.");
    else { out(`   exit status ${e.exit}. The guard did not answer:`); quote(e.stderr || "(nothing on stderr)"); }
  }
  out("");
  if (!described) {
    out(`The demo did not behave as described: ${wrong.map((e) => `edit ${edits.indexOf(e) + 1} was expected to exit ${e.expected} and exited ${e.exit}`).join("; ")}.`);
    // the guard reads a withdrawn value beside its replacement as a comparison, and looks for the replacement anywhere in the text
    if (withdrawn.includes(replacement)) out(`"${replacement}" is part of "${withdrawn}", and the guard passes a withdrawn value that appears beside its replacement, so this pair is not enforced.`);
    return 1;
  }
  out("Each verdict is what the guard command returned for that edit, read from the ledger the demo wrote.");
  out("The temporary folder is removed. Next, in your repository: npx -y memory-pulse init");
  return 0;
}

// ------------------------------------------------------------------ doctor ----
// Each host, and what its guard hook has to look like to stop an edit: the event it sits under and the tools its matcher has to
// cover. These are what install-hook writes for the host (server.mjs); test/firstrun-review.test.js holds the two together.
const HOSTS = [
  { id: "claude", name: "Claude Code", dir: ".claude", bin: "claude", file: "settings.json", more: ["settings.local.json"], flag: "", event: "PreToolUse", tools: ["Edit", "Write", "MultiEdit", "Bash"] },
  { id: "codex", name: "Codex", dir: ".codex", bin: "codex", file: "hooks.json", more: [], flag: " --codex", event: "PreToolUse", tools: ["Edit", "Write", "apply_patch"] },
  { id: "cursor", name: "Cursor", dir: ".cursor", bin: "cursor", file: "hooks.json", more: [], flag: " --cursor", event: "preToolUse", tools: ["Write", "Shell"] },
];
const PLUGIN_FIX = "/plugin install memory-pulse@memory-pulse (typed inside Claude Code)";
// A memory-pulse hook command as install-hook, mode, the plugin's hooks.json and earlier releases wrote it, or as a person wrote
// it by hand: npx (with or without a version), node on a server.mjs (the path quoted or not), or the global command; then one of
// the hook verbs. The verbs come from server.mjs (HOOK_VERBS) so that someone else's `node ".../server.mjs" start` is not ours.
// This pattern only reads. Nothing it matches is ever handed to a shell (see guardChecks).
const HOOK_VERBS = "brief|guard|prompt|handoff|capture|consolidate|observe|ambient|taint";
const hookRe = (verbs = HOOK_VERBS) => new RegExp(String.raw`^(?:(npx)\s+(?:-y\s+)?memory-pulse(?:@([\w.^~-]+))?|node\s+(?:"([^"]*[\\/]server\.mjs)"|(\S*[\\/]server\.mjs))|(memory-pulse))\s+(${verbs})\b(.*)$`);
// The whole of a hook call as install-hook writes it: after the verb, nothing but the host flag (and --verbose, which a person may add).
const PLAIN_TAIL = /^(?:\s+--host\s+cursor|\s+--verbose)*\s*$/;
// Every memory-pulse hook in a hooks object, in either shape: nested ([{ matcher, hooks: [{ type, command }] }], Claude Code and
// Codex) or flat ([{ command, matcher }], Cursor), with the event, matcher and type it was found under.
function hookCommands(json, re, sub = (c) => c) {
  const found = [];
  const hooks = json?.hooks && typeof json.hooks === "object" ? json.hooks : {};
  for (const [event, list] of Object.entries(hooks)) for (const e of Array.isArray(list) ? list : []) for (const h of Array.isArray(e?.hooks) ? e.hooks : [e]) {
    if (typeof h?.command !== "string") continue;
    const command = sub(h.command.trim()), m = re.exec(command), path = m ? m[3] ?? m[4] ?? null : null;
    if (m) found.push({ event, matcher: e?.matcher, type: h.type, flat: h === e, command, runner: m[1] ? "npx" : path ? "node" : "bin", npx: m[2] ?? null, path, verb: m[6],
      plain: PLAIN_TAIL.test(m[7]), cursor: /--host\s+cursor\b/.test(m[7]),
      // install-hook rewrites a hook it wrote: npx or a quoted path, then the verb and at most the host flag. Any other spelling it leaves alone.
      managed: Boolean(m[1] || m[3]) && /^(?:\s+--host\s+cursor)?\s*$/.test(m[7]) });
  }
  return found;
}
function onPath(env, name) {
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT || ".EXE;.CMD;.BAT").split(";")] : [""];
  return String(env.PATH ?? "").split(delimiter).filter(Boolean).some((d) => exts.some((x) => existsSync(join(d, name + x))));
}
// Where install-hook writes for a host: the same rule it uses (MEMORY_PULSE_SETTINGS_DIR, else the project folder, else HOME).
const targetFile = (h, { env, cwd, home }, project) => join(env.MEMORY_PULSE_SETTINGS_DIR || (project ? join(cwd, h.dir) : join(home, h.dir)), h.file);
// The folder install-hook keeps the pinned copy in, by the rule pinnedRunner (server.mjs) uses.
const dataDir = (env, home) => env.MEMORY_PULSE_DATA_DIR || join(env.XDG_DATA_HOME || join(home, ".local", "share"), "memory-pulse");
const realOf = (p) => { try { return realpathSync(p); } catch { return null; } };
const within = (root, p) => { if (!root) return false; const rel = relative(root, p); return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel); };
const listOf = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const cmpVersion = (a, b) => { const n = (v) => String(v).split(/[.+-]/).slice(0, 3).map((x) => Number(x) || 0); const x = n(a), y = n(b); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1; return 0; };

// What one run of doctor or init knows about the machine: the folders it reads, this copy, and the only places a memory-pulse
// copy may be run from besides this one (the pinned data folder and the plugin caches under HOME), each with links followed.
function context(ctx) {
  const env = envOf(ctx), home = homeOf(env);
  return { env, cwd: cwdOf(ctx), home, re: hookRe(ctx.hookVerbs), version: ctx.version, own: realOf(ctx.server), data: dataDir(env, home), dataReal: realOf(dataDir(env, home)),
    caches: [join(home, ".claude", "plugins", "cache"), join(home, ".codex", "plugins", "cache")].map(realOf).filter(Boolean), digests: new Map() };
}
// What a hook's server.mjs really is: where its path leads once every link is followed, and the package.json beside it there.
// `runnable` is the whole rule for what doctor will execute: this copy's own server.mjs, or a memory-pulse copy whose real path is
// inside the pinned data folder or a plugin cache under HOME. A path in a repository is never runnable, whatever it is named.
function copyOf(path, c) {
  const real = realOf(resolve(c.cwd, path));
  if (!real) return { exists: false };
  const pkg = readJson(join(dirname(real), "package.json"));
  const own = real === c.own, isCopy = basename(real) === "server.mjs" && pkg?.name === "memory-pulse";
  const pinned = within(c.dataReal, real), cached = c.caches.some((r) => within(r, real));
  return { exists: true, real, dir: dirname(real), own, isCopy, version: typeof pkg?.version === "string" ? pkg.version : null, pinned, cached, runnable: own || (isCopy && (pinned || cached)) };
}
// The files a copy runs: server.mjs and lib/*.mjs, as one digest. Two copies of one version with different digests are not one build.
function digestOf(dir, c) {
  if (c.digests.has(dir)) return c.digests.get(dir);
  let d = null;
  try {
    const h = createHash("sha256");
    for (const f of ["server.mjs", ...readdirSync(join(dir, "lib")).filter((x) => x.endsWith(".mjs")).sort().map((x) => join("lib", x))]) { h.update(`${f}\0`); h.update(readFileSync(join(dir, f))); h.update("\0"); }
    d = h.digest("hex");
  } catch { d = null; }
  c.digests.set(dir, d); return d;
}

// The Claude Code plugin, from Claude Code's own record of it, as captureInstalled (server.mjs) reads it: an installed
// memory-pulse plugin that is not switched off. A directory marketplace runs its source folder, otherwise the install path.
function claudePluginRoots(home, settings) {
  const pdir = join(home, ".claude", "plugins");
  const installed = readJson(join(pdir, "installed_plugins.json"))?.plugins ?? {}, markets = readJson(join(pdir, "known_marketplaces.json")) ?? {};
  const enabled = Object.assign({}, ...settings.map((j) => j?.enabledPlugins ?? {}));
  const roots = [];
  for (const [id, list] of Object.entries(installed)) {
    if (!/^memory-pulse@/.test(id) || enabled[id] === false) continue;
    const market = markets[id.split("@")[1]]?.source;
    const root = market?.source === "directory" && typeof market.path === "string" ? market.path : (Array.isArray(list) ? list : []).map((x) => x?.installPath).find((p) => typeof p === "string" && p);
    if (root) roots.push(root);
  }
  return roots;
}

function inspectHost(h, c) {
  const { env, cwd, home } = c;
  const seen = new Set(), sources = [];
  const candidates = [["user", targetFile(h, c, false)], ["project", join(cwd, h.dir, h.file)], ...h.more.map((f) => ["project", join(cwd, h.dir, f)])];
  for (const [scope, file] of candidates) {
    if (seen.has(resolve(file)) || !existsSync(file)) continue;
    seen.add(resolve(file));
    const json = readJson(file);
    sources.push({ scope, file, valid: json !== undefined, json, hooks: json === undefined ? [] : hookCommands(json, c.re) });
  }
  const plugins = [];
  if (h.id === "claude") for (const root of claudePluginRoots(home, sources.map((s) => s.json))) {
    const file = join(root, "hooks", "hooks.json"), json = readJson(file);
    plugins.push({ scope: "plugin", file, root, valid: true, json, gone: !existsSync(root), hooks: hookCommands(json, c.re, (cmd) => cmd.split("${CLAUDE_PLUGIN_ROOT}").join(root)) });
  }
  let codexPlugin = null;
  if (h.id === "codex") { try { const cache = join(home, ".codex", "plugins", "cache"); codexPlugin = readdirSync(cache).map((m) => join(cache, m, "memory-pulse")).find((p) => existsSync(p)) ?? null; } catch { codexPlugin = null; } }
  const all = [...sources, ...plugins];
  // a host is here when its folder is in HOME, its command is on PATH, or a file install-hook writes for it already carries our hooks
  const wired = all.find((s) => s.hooks.length || s.scope === "plugin") ?? (env.MEMORY_PULSE_SETTINGS_DIR ? sources.find((s) => s.scope === "user") : undefined);
  const how = existsSync(join(home, h.dir)) ? join(home, h.dir) : onPath(env, h.bin) ? `${h.bin} on PATH` : wired ? wired.file : null;
  const hooks = all.flatMap((s) => s.hooks.map((k) => ({ ...k, scope: s.scope, file: s.file, copy: k.runner === "node" ? copyOf(k.path, c) : null })));
  return { host: h, present: how !== null, how, sources: all, codexPlugin, hooks };
}

// R-2 (review 2026-11-21): a guard hook stops an edit only under the host's pre-tool event, as a command, with a matcher that
// reaches every tool the host's guard covers. Releases before 0.10.0 wrote the matcher Edit|Write, which left MultiEdit and
// Bash unchecked; a hook moved under another event, or given another type, checks nothing. Returns what is wrong, or null.
function wiringDefect(h, k) {
  if (k.event !== h.event) return `is under ${k.event}, where it cannot stop an edit; it belongs under ${h.event}`;
  if (!k.flat && k.type !== "command") return `has ${k.type === undefined ? "no type" : `type "${k.type}"`}, so the host does not run it as a command; it must be type "command"`;
  const missed = h.tools.filter((t) => !matcherCovers(k.matcher, [t]));
  return missed.length ? `has matcher "${k.matcher}", which leaves ${listOf(missed)} unchecked` : null;
}
// R-3 (review 2026-11-21): install-hook pins the hooks to a copy of the package, and upgrading the package changes neither that
// copy nor the settings file. A hook that runs an older version, or a pinned copy of this version whose files are not this
// package's, runs none of what this copy checks. Returns what is wrong, or null. A newer copy is not a fault of the hooks.
function versionDefect(k, c) {
  if (k.runner === "npx") return k.npx && /^\d+\.\d+\.\d+$/.test(k.npx) && cmpVersion(k.npx, c.version) < 0 ? `runs memory-pulse@${k.npx} through npx, older than this ${c.version}` : null;
  if (k.runner !== "node" || !k.copy.exists || k.copy.own) return null;
  const v = k.copy.version;
  if (v && cmpVersion(v, c.version) < 0) return `runs memory-pulse ${v} (${k.copy.dir}), older than this ${c.version}`;
  if (k.copy.pinned && v === c.version && digestOf(k.copy.dir, c) !== digestOf(dirname(c.own), c)) return `runs a copy of ${v} whose files differ from this package (${k.copy.dir})`;
  return null;
}

function hostCheck(info, c) {
  const h = info.host, id = `host:${h.id}`, label = h.name, install = `memory-pulse install-hook${h.flag}`;
  // the fix is install-hook where install-hook rewrites the hook; a command it does not manage (written by hand, or with more after the verb) is the reader's to change
  const fixFor = (k) => (k.scope === "plugin" ? PLUGIN_FIX : !k.managed ? `take that hook out of ${k.file} by hand (install-hook does not rewrite a command spelled this way), then ${install}${k.scope === "project" ? " --project" : ""}` : `${install}${k.scope === "project" ? " --project" : ""}`);
  if (!info.present) return { id, label, status: "skipped", detail: `not found: no ~/${h.dir} folder, no ${h.bin} command on PATH and no ${h.dir}/${h.file} in this folder` };
  const bad = info.sources.find((s) => !s.valid);
  if (bad) return { id, label, status: "fail", detail: `${bad.file} is not valid JSON, so its hooks cannot be read and install-hook will not touch it`, fix: `repair ${bad.file} by hand, then memory-pulse doctor` };
  const off = info.sources.find((s) => s.json?.disableAllHooks === true);
  if (off) return { id, label, status: "fail", detail: `every hook is switched off by disableAllHooks in ${off.file}`, fix: `remove disableAllHooks from ${off.file}` };
  const gone = info.sources.find((s) => s.scope === "plugin" && s.gone);
  if (gone) return { id, label, status: "fail", detail: `the memory-pulse plugin is recorded at ${gone.root}, which does not exist`, fix: PLUGIN_FIX };
  const guard = info.hooks.filter((k) => k.verb === "guard");
  if (!guard.length) {
    if (info.codexPlugin) return { id, label, status: "skipped", detail: `no guard hook in ~/${h.dir}/${h.file}; a memory-pulse plugin copy is at ${info.codexPlugin}, and doctor does not read Codex's plugin state: /hooks inside Codex lists what runs` };
    return { id, label, status: "fail", notSetUp: true, detail: `no memory-pulse guard hook is installed for ${h.name}, so its edits are not checked`, fix: install };
  }
  const stale = info.hooks.filter((k) => k.runner === "node" && !k.copy.exists);
  if (stale.length) {
    const s = stale[0];
    return { id, label, status: "fail", detail: `the ${s.verb} hook in ${s.file} runs ${s.path}, which does not exist${stale.length > 1 ? ` (${stale.length} hooks point at a missing file)` : ""}`, fix: fixFor(s) };
  }
  // a hook that names the global command is not run by doctor (R-1), so what a run used to show is looked for: is there such a command
  const adrift = info.hooks.find((k) => k.runner === "bin" && !onPath(c.env, "memory-pulse"));
  if (adrift) return { id, label, status: "fail", detail: `the ${adrift.verb} hook in ${adrift.file} runs the memory-pulse command, which is not on PATH`, fix: fixFor(adrift) };
  const foreign = info.hooks.find((k) => k.runner === "node" && !k.copy.own && !k.copy.isCopy);
  if (foreign) return { id, label, status: "fail", detail: `the ${foreign.verb} hook in ${foreign.file} runs ${foreign.path}, which is not a memory-pulse copy: no package.json beside it says so`, fix: fixFor(foreign) };
  const wired = guard.map((k) => ({ k, defect: wiringDefect(h, k) }));
  if (wired.every((w) => w.defect)) {
    const w = wired.find((x) => x.k.event === h.event) ?? wired[0];
    return { id, label, status: "fail", detail: `the guard hook in ${w.k.file} ${w.defect}`, fix: fixFor(w.k) };
  }
  // a guard hook left under another event is not one install-hook manages, so its copy is not held to this version
  const managed = info.hooks.filter((k) => k.verb !== "guard" || !wiringDefect(h, k));
  for (const k of managed) { const d = versionDefect(k, c); if (d) return { id, label, status: "fail", detail: `the ${k.verb} hook in ${k.file} ${d}`, fix: fixFor(k) }; }
  const where = [...new Set(info.hooks.map((k) => (k.scope === "plugin" ? `the plugin at ${dirname(dirname(k.file))}` : k.file)))];
  const verbs = [...new Set(info.hooks.map((k) => k.verb))];
  const newer = [...new Set(managed.filter((k) => k.copy?.version && cmpVersion(k.copy.version, c.version) > 0).map((k) => k.copy.version))];
  const runs = info.hooks.every((k) => k.runner === "npx") ? "they run through npx" : "every hook command points at a file that exists";
  return { id, label, status: "ok", detail: `hooks installed in ${where.join(" and ")} (${verbs.join(", ")}); the guard is under ${h.event} and its matcher covers ${listOf(h.tools)}; ${runs}${newer.length ? `; they run ${listOf(newer)}, newer than this ${c.version}` : ""}${h.id === "codex" ? "; Codex runs a hook only after you trust it with /hooks inside Codex, which doctor cannot see" : ""}` };
}

// The guard, answering synthetic edits against a ledger in a temporary folder: three that write a withdrawn value back (a file
// write, an edit, a shell write) and two that do not (one uses the replacement, one names neither value).
//
// R-1 (review 2026-11-21, security): a hook file can come with a repository, and doctor is run inside repositories. So nothing
// read from a hook file is executed. A hook command is parsed, never passed to a shell, and the only programs run are this
// copy's own server.mjs and a memory-pulse copy that copyOf() finds inside the pinned data folder or a plugin cache under HOME,
// started as `node <real path> guard` with an argument list. Every other guard command is listed as not run, with the reason
// and the command as text. When nothing can be run, this copy's own guard answers, so the check never passes on no evidence.
function guardChecks(ctx, infos, c) {
  const W = "doctor-withdrawn-7f3a", R = "doctor-replacement-7f3a";
  const targets = [], notRun = [];
  for (const info of infos) for (const k of info.hooks.filter((x) => x.verb === "guard")) {
    const why = !k.plain ? "the command carries more than the guard call, and doctor hands no command to a shell"
      : k.runner === "npx" ? "it runs through npx, which can need the network"
      : k.runner === "bin" ? "it runs whichever memory-pulse command is first on PATH"
      : !k.copy.exists ? "its file does not exist"
      : !k.copy.own && !k.copy.isCopy ? "its program is not a memory-pulse copy"
      : !k.copy.runnable ? "its program is outside the folders doctor runs from (this copy, the pinned data folder and the plugin cache under your home)"
      : null;
    if (why) { if (!notRun.some((n) => n.command === k.command)) notRun.push({ command: k.command, why }); continue; }
    const t = targets.find((x) => x.real === k.copy.real && x.cursor === k.cursor);
    if (t) { if (!t.hosts.includes(info.host)) t.hosts.push(info.host); } else targets.push({ real: k.copy.real, cursor: k.cursor, command: k.command, hosts: [info.host], scope: k.scope });
  }
  const self = !targets.length;
  if (self) targets.push({ real: ctx.server, cursor: false, command: `node "${ctx.server}" guard`, hosts: [], scope: "self" });
  const sb = sandbox("doctor"); const checks = [];
  try {
    const env = sandboxEnv(envOf(ctx), sb.home);
    const row = recordCorrection(ctx, sb, env, { cause: "doctor-value-shipped", effect: "doctor-value-corrected", withdrawn: W, replacement: R });
    if (row.t === null) return [{ id: "guard", label: "guard", status: "fail", detail: `a correction could not be recorded in a temporary ledger: ${row.reason}`, fix: "memory-pulse demo" }];
    const file = join(sb.project, "doctor.md"), heredoc = (text) => `cat > doctor.md <<'EOF'\n${text}\nEOF`;
    for (const [i, t] of targets.entries()) {
      // [what the edit is, the tool call, whether the guard has to block it]
      const probes = t.cursor
        ? [["a file write of the withdrawn value", toolPayload(sb.project, "Write", { path: file, contents: `value: ${W}` }, true), true], ["a shell write of the withdrawn value", toolPayload(sb.project, "Shell", { command: heredoc(`value: ${W}`) }, true), true],
           ["an edit that uses the replacement", toolPayload(sb.project, "Write", { path: file, contents: `value: ${R}` }, true), false], ["an edit that names neither value", toolPayload(sb.project, "Write", { path: file, contents: "value: unrelated" }, true), false]]
        : [["a file write of the withdrawn value", toolPayload(sb.project, "Write", { file_path: file, content: `value: ${W}` }), true], ["an edit to the withdrawn value", toolPayload(sb.project, "Edit", { file_path: file, old_string: "value: unrelated", new_string: `value: ${W}` }), true],
           ["a shell write of the withdrawn value", toolPayload(sb.project, "Bash", { command: heredoc(`value: ${W}`) }), true],
           ["an edit that uses the replacement", toolPayload(sb.project, "Write", { file_path: file, content: `value: ${R}` }), false], ["an edit that names neither value", toolPayload(sb.project, "Write", { file_path: file, content: "value: unrelated" }), false]];
      const said = (r) => (t.cursor ? `exit ${r.status} with permission ${r.permission ?? "none"}` : `exit ${r.status}`);
      let wrong = null, ms = 0;
      for (const [what, input, mustBlock] of probes) {
        const start = Date.now();
        const r = spawnSync(process.execPath, [t.real, "guard", ...(t.cursor ? ["--host", "cursor"] : [])], { cwd: sb.project, env, input, encoding: "utf8", timeout: 20000 });
        interrupted(r); ms = Math.max(ms, Date.now() - start);
        let permission = null; if (t.cursor) { try { permission = JSON.parse(r.stdout)?.permission ?? null; } catch { permission = null; } }
        const res = { status: r.status, permission, stderr: r.stderr ?? "" };
        const blocked = t.cursor ? res.status === 0 && permission === "deny" : res.status === 2 && res.stderr.includes(W);
        const passed = t.cursor ? res.status === 0 && permission === "allow" : res.status === 0;
        if (mustBlock ? !blocked : !passed) { wrong = { what, mustBlock, res }; break; }
      }
      const who = self ? "this copy's guard" : `the installed hook command for ${t.hosts.map((h) => h.name).join(" and ")}`;
      const id = i ? `guard:${i + 1}` : "guard", n = probes.filter((p) => p[2]).length, m = probes.length - n;
      if (!wrong) {
        const why = !self ? `: ${t.command}` : notRun.length ? "; the installed hook commands are listed below as not run" : "; no installed hook command to run";
        checks.push({ id, label: "guard", status: "ok", command: t.command, ms,
          detail: `${who} ${t.cursor ? `answered ${n} synthetic edits that write a withdrawn value back with a deny (exit 0 with permission deny) and ${m} that do not with an allow` : `blocked ${n} synthetic edits that write a withdrawn value back, against a temporary ledger (exit 2, ${ms} ms at most), and passed ${m} that do not (exit 0)`}${why}` });
      } else {
        const what = wrong.mustBlock ? `did not block ${wrong.what}: ${said(wrong.res)}, expected ${t.cursor ? "exit 0 with permission deny" : "2"}` : `blocked ${wrong.what}: ${said(wrong.res)}, expected ${t.cursor ? "permission allow" : "0"}`;
        const err = firstLine(wrong.res.stderr).slice(0, 160), h = t.hosts[0];
        checks.push({ id, label: "guard", status: "fail", command: t.command, detail: `${who} ${what}${err ? ` (stderr: ${err})` : ""}: ${t.command}`,
          fix: self ? "reinstall memory-pulse (npm i -g memory-pulse), then memory-pulse doctor" : t.scope === "plugin" ? PLUGIN_FIX : `memory-pulse install-hook${h.flag}${t.scope === "project" ? " --project" : ""}` });
      }
    }
  } finally { sb.remove(); }
  for (const [i, n] of notRun.entries()) checks.push({ id: i ? `guard:not-run:${i + 1}` : "guard:not-run", label: "guard", status: "skipped", command: n.command, detail: `not run: ${n.why}: ${n.command}` });
  return checks;
}

// The project ledger, through `verify --json`: the row chain, the engine's last seal, this machine's anchor and writer marks.
function ledgerCheck(ctx) {
  const ledger = ctx.ledgerPath();
  if (!existsSync(ledger)) return { id: "ledger", label: "ledger", status: "skipped", detail: `none at ${ledger}; the first remember creates it` };
  const env = { ...envOf(ctx) }; delete env.MEMORY_PULSE_KEY;
  const r = runServer(ctx, ["verify", "--json"], { cwd: cwdOf(ctx), env });
  let v = null; try { v = JSON.parse(r.stdout); } catch { v = null; }
  if (r.status === 0 && v) return { id: "ledger", label: "ledger", status: "ok", detail: `${ledger} verifies (${v.chain?.chained ?? 0} chained row(s))` };
  const why = !v ? `verify exited ${r.status}` : v.chain?.ok === false ? `chain broken: ${v.chain.reason}` : v.seal?.ok === false ? `seal mismatch: ${v.seal.reason}` : v.anchor?.ok === false ? `anchor: ${v.anchor.reason}` : "this machine's writer marks do not hold";
  return { id: "ledger", label: "ledger", status: "fail", detail: `${ledger} does not verify (${String(why).slice(0, 200)})`, fix: "memory-pulse verify" };
}

// Which hooks pay for npx on every call. Measured on a clean machine on 2026-10-23 (server.mjs, above pinnedRunner): the npx form
// took 0.98 to 1.54 s per hook call, node on the same server.mjs 0.06 s. Information, not a failure: a committed file keeps npx.
function runnerCheck(infos) {
  const hooks = infos.flatMap((i) => i.hooks);
  if (!hooks.length) return { id: "runner", label: "runner", status: "skipped", detail: "no memory-pulse hooks are installed" };
  const files = [...new Set(hooks.filter((k) => k.runner === "npx").map((k) => k.file))];
  if (!files.length) return { id: "runner", label: "runner", status: "ok", detail: "every memory-pulse hook runs a file on this machine, about 0.06 s per call" };
  const project = hooks.some((k) => k.runner === "npx" && k.scope === "project");
  return { id: "runner", label: "runner", status: "ok", info: true,
    detail: `${files.join(" and ")} ${files.length > 1 ? "run" : "runs"} its hooks through npx, which resolves the package on every call: 0.98 to 1.54 s per hook call against 0.06 s for node on a pinned copy (measured 2026-10-23)${project ? "; a file written with --project keeps npx so that it runs on every clone" : ""}; for the pinned form on this machine: memory-pulse install-hook` };
}

// One GET to the engine's address with no key and no body. Never a failure: the checks above need no network.
function engineCheck(ctx, offline) {
  if (offline) return Promise.resolve({ id: "engine", label: "engine", status: "skipped", info: true, detail: "--offline" });
  return new Promise((done) => {
    let u; try { u = new URL(ctx.api); } catch { return done({ id: "engine", label: "engine", status: "skipped", info: true, detail: "MEMORY_PULSE_API is not a URL; the checks above do not use the engine" }); }
    const start = Date.now(); let settled = false;
    const finish = (res) => { if (settled) return; settled = true; clearTimeout(timer); done(res
      ? { id: "engine", label: "engine", status: "ok", info: true, detail: `reachable at ${u.origin} (HTTP ${res}, ${Date.now() - start} ms); information only, the checks above do not use it` }
      : { id: "engine", label: "engine", status: "skipped", info: true, detail: `not reachable at ${u.origin}; the guard, the ledger and the checks above work without it` }); };
    const req = (u.protocol === "http:" ? http : https).request(u, { method: "GET", agent: false, headers: { connection: "close" } }, (res) => { res.resume(); finish(res.statusCode); });
    const timer = setTimeout(() => { req.destroy(); finish(null); }, 2500);
    req.on("error", () => finish(null)); req.end();
  });
}

function nodeCheck(ctx) {
  const wants = Number(/(\d+)/.exec(readJson(join(dirname(ctx.server), "package.json"))?.engines?.node ?? "18")?.[1] ?? 18), has = Number(process.versions.node.split(".")[0]);
  return has >= wants ? { id: "node", label: "node", status: "ok", detail: `v${process.versions.node} (${wants} or newer is supported)` }
    : { id: "node", label: "node", status: "fail", detail: `v${process.versions.node} is older than ${wants}`, fix: `install Node ${wants} or newer` };
}

export async function runDoctor(ctx, { offline = false } = {}) {
  const c = context(ctx);
  const infos = HOSTS.map((h) => inspectHost(h, c));
  // A host with no hooks is a failure only while no host is set up. Once one editor is guarded, another that merely exists on
  // the machine is reported as not set up, with the command that adds it: a second editor is not a broken install.
  const hosts = infos.map((i) => hostCheck(i, c));
  const anyOk = hosts.some((k) => k.status === "ok");
  const hostChecks = hosts.map(({ notSetUp, ...k }) => (notSetUp && anyOk ? { id: k.id, label: k.label, status: "skipped", detail: `present, not set up: its edits are not checked. To add it: ${k.fix}` } : k));
  // a ledger layout this client cannot read (lib/layout.mjs): nothing in it is enforced here, which is a failure, not a skip
  const alien = foreignLayout(ctx.ledgerPath());
  const layoutCheck = alien ? [{ id: "layout", label: "ledger layout", status: "fail", detail: `${alien.file} says layout "${alien.layout}", which this client does not know, so nothing in the ledger is enforced on this machine`, fix: UPGRADE }] : [];
  const checks = [nodeCheck(ctx), ...layoutCheck, ...hostChecks, ...guardChecks(ctx, infos, c), ledgerCheck(ctx), runnerCheck(infos), await engineCheck(ctx, offline)];
  const failed = checks.filter((k) => k.status === "fail").length;
  return { version: ctx.version, ok: failed === 0, failed, guarded: anyOk, untested: checks.filter((k) => String(k.id).startsWith("guard:not-run")).length, checks };
}
function printDoctor(out, res) {
  out(`memory-pulse doctor ${res.version}`);
  for (const k of res.checks) out(k.status === "skipped" ? `skipped  ${k.label} (${k.detail})` : `${k.status === "ok" ? "ok      " : "FAIL    "} ${k.label}: ${k.detail}${k.fix ? `. Fix: ${k.fix}` : ""}`);
  // An installed guard hook that doctor did not run is not a pass: say so in the last line (second review, 2026-11-22, F-1).
  const untested = res.untested ?? 0;
  out(!res.ok ? `${res.failed} check${res.failed === 1 ? "" : "s"} failed. Run each Fix, then memory-pulse doctor again.`
    : untested ? `No check failed. ${untested} installed guard hook${untested === 1 ? " was" : "s were"} not tested: doctor runs only this copy, the pinned copy and a plugin under your home folder, so it cannot vouch for ${untested === 1 ? "that one" : "those"}.`
    : "All checks passed.");
}
// `memory-pulse doctor [--json] [--offline]`: exit 0 when no check fails, 1 when one does or on a usage error.
export const cliDoctor = (argv, ctx) => sentence(ctx, "doctor", async () => {
  const { o, error } = parseFlags(argv, { bool: ["json", "offline"] });
  if (error) return fail(ctx, "doctor", error);
  const res = await runDoctor(ctx, { offline: !!o.offline });
  if (o.json) printer(ctx)(JSON.stringify({ version: res.version, ok: res.ok, failed: res.failed, untested: res.untested ?? 0, checks: res.checks.map(({ id, status, label, detail, fix, command, info }) => ({ id, status, label, detail, fix: fix ?? null, ...(command ? { command } : {}), ...(info ? { info: true } : {}) })) }));
  else printDoctor(printer(ctx), res);
  return res.ok ? 0 : 1;
});

// -------------------------------------------------------------------- init ----
const installArgs = (h, project) => ["install-hook", ...h.flag.trim().split(" ").filter(Boolean), ...(project ? ["--project"] : [])];

// What `install-hook` would do to a host's file, found by running it: on a scratch copy of the file, with a scratch folder for the
// pinned copy. The result is then read with the scratch folder's path put back to the real one. Nothing of the user's is written,
// and nothing in the copied file is run: install-hook parses it as JSON. The scratch folder is not a git work tree, so a
// --project run does no team setup there; planTeam finds that part.
function planHost(ctx, h, c, project) {
  const target = targetFile(h, c, project), existing = existsSync(target) ? readFileSync(target, "utf8") : null;
  const pinnedDir = join(c.data, ctx.version), pinned = join(pinnedDir, "server.mjs");
  const scratch = tempDir("plan");
  try {
    const settings = join(scratch, "settings"), data = join(scratch, "data"); mkdirSync(settings);
    if (existing !== null) writeFileSync(join(settings, h.file), existing);
    const r = runServer(ctx, installArgs(h, project), { cwd: scratch, env: { ...c.env, MEMORY_PULSE_SETTINGS_DIR: settings, MEMORY_PULSE_DATA_DIR: data } });
    if (r.status !== 0) return { host: h, target, state: "invalid", why: /not valid JSON/.test(r.stderr) ? `${target} is not valid JSON` : `install-hook could not read it (exit ${r.status} on a scratch copy)` };
    const rebase = (x) => (typeof x === "string" ? x.split(data).join(c.data) : Array.isArray(x) ? x.map(rebase) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, rebase(v)])) : x);
    const after = rebase(readJson(join(settings, h.file)));
    const same = existing !== null && JSON.stringify(after) === JSON.stringify(readJson(target));
    // R-3: the settings can be right while the copy they name is gone, or is a copy of this version whose files are not this package's
    const stale = !project && (!existsSync(pinned) || digestOf(realOf(pinnedDir) ?? pinnedDir, c) !== digestOf(dirname(c.own), c));
    return { host: h, target, state: !same ? "write" : stale ? "repair" : "keep", pinnedDir };
  } finally { dropTemp(scratch); }
}

// R-4 (review 2026-11-21): `install-hook --project` inside a git work tree also does the team setup (lib/gitmerge.mjs): it writes
// .gitattributes, sets the merge driver in this clone's git config and pins a copy of the package for the driver to run. What
// that would write here is found the way planHost finds it: by running `team setup` in a scratch repository that starts with
// this folder's .gitattributes and this clone's merge.memory-pulse.* settings, and comparing before with after.
const git = (c, cwd, args) => { const r = spawnSync("git", args, { cwd, env: c.env, encoding: "utf8" }); return { ok: r.status === 0, out: String(r.stdout ?? "") }; };
function planTeam(ctx, c) {
  if (!git(c, c.cwd, ["rev-parse", "--show-toplevel"]).ok) return { applies: false };   // no git, or not a work tree: team setup is silent
  const rel = relative(c.cwd, ctx.ledgerPath());
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { applies: false };         // a ledger outside this folder is not shared through it
  const key = String.raw`^merge\.${DRIVER}\.`, attrs = join(c.cwd, ".gitattributes");
  const scratch = tempDir("plan");
  try {
    const repo = join(scratch, "repo"), data = join(scratch, "data"); mkdirSync(repo);
    if (!git(c, repo, ["init", "-q"]).ok) return { applies: false };
    const had = existsSync(attrs) ? readFileSync(attrs, "utf8") : null;
    if (had !== null) writeFileSync(join(repo, ".gitattributes"), had);
    // name, a line break, value, a NUL: the form `--null` prints, so a value with spaces or quotes is carried whole
    for (const pair of git(c, c.cwd, ["config", "--local", "--null", "--get-regexp", key]).out.split("\0").filter(Boolean)) {
      const at = pair.indexOf("\n"); if (at < 0) continue;
      git(c, repo, ["config", "--local", pair.slice(0, at), pair.slice(at + 1).split(c.data).join(data)]);
    }
    const seeded = git(c, repo, ["config", "--local", "--null", "--get-regexp", key]).out;
    const r = runServer(ctx, ["team", "setup"], { cwd: repo, env: { ...c.env, MEMORY_PULSE_DATA_DIR: data, MEMORY_PULSE_LEDGER: join(repo, rel) } });
    if (r.status !== 0) return { applies: false };
    const now = existsSync(join(repo, ".gitattributes")) ? readFileSync(join(repo, ".gitattributes"), "utf8") : null;
    const config = resolve(c.cwd, git(c, c.cwd, ["rev-parse", "--git-path", "config"]).out.trim() || join(".git", "config"));
    return { applies: true, attrs: { file: attrs, change: now !== had }, config: { file: config, change: git(c, repo, ["config", "--local", "--null", "--get-regexp", key]).out !== seeded } };
  } finally { dropTemp(scratch); }
}

const askOnTerminal = async (question) => {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // the end of input (Ctrl-D) before an answer is a no, not a silent exit
  const answer = await new Promise((r) => { rl.question(question, r); rl.once("close", () => r("")); });
  rl.close(); return answer;
};

// `memory-pulse init [--yes] [--dry-run] [--project] [--offline]`: exit 0 when nothing was to be done, the plan was declined, or
// it was applied and doctor passed; 1 when a step or a doctor check failed, or on a usage error.
// Every file or folder init writes has a `write`, `create` or `copy` line in the plan (test/firstrun-review.test.js compares the
// plan with what changed on disk), and what each child command printed is shown line for line behind a bar.
export const cliInit = (argv, ctx) => sentence(ctx, "init", async () => {
  const { o, error } = parseFlags(argv, { bool: ["yes", "dry-run", "project", "offline"] });
  if (error) return fail(ctx, "init", error);
  const out = printer(ctx), c = context(ctx), env = c.env, project = !!o.project;
  const infos = HOSTS.map((h) => inspectHost(h, c)), found = infos.filter((i) => i.present);
  // a host whose plugin already runs the hooks is left alone: a second set in its settings file would run every hook twice
  const plans = found.map((i) => {
    const plugin = i.sources.find((s) => s.scope === "plugin" && !s.gone && s.hooks.some((k) => k.verb === "guard"));
    if (plugin) return { host: i.host, target: plugin.root, state: "plugin" };
    if (i.codexPlugin && !i.hooks.length) return { host: i.host, target: i.codexPlugin, state: "codex-plugin" };
    return planHost(ctx, i.host, c, project);
  });
  const team = project ? planTeam(ctx, c) : { applies: false }, teamTodo = team.applies && (team.attrs.change || team.config.change);
  const ledgerDir = dirname(ctx.ledgerPath()), makeDir = !existsSync(ledgerDir), shownDir = `${ledgerDir}/`;
  const todo = plans.filter((p) => p.state === "write" || p.state === "repair"), invalid = plans.filter((p) => p.state === "invalid");
  // the pinned copy is written by a user-scope install-hook, and by team setup (alone or inside install-hook --project) for the merge driver
  const copies = project ? team.applies && (teamTodo || todo.length > 0) : todo.length > 0;
  const again = `memory-pulse init --yes${project ? " --project" : ""}`;

  out(`memory-pulse init ${ctx.version}`);
  out("");
  if (found.length) {
    out(`Hosts found: ${found.map((i) => `${i.host.name} (${i.how})`).join(", ")}`);
    const absent = infos.filter((i) => !i.present); if (absent.length) out(`Not found: ${absent.map((i) => i.host.name).join(", ")}`);
  } else out("No host found: looked for ~/.claude, ~/.codex and ~/.cursor, and for claude, codex and cursor on PATH. Once one is installed: memory-pulse install-hook (Claude Code), memory-pulse install-hook --codex, memory-pulse install-hook --cursor.");
  out("");
  out("Plan");
  for (const p of plans) {
    if (p.state === "write") out(`  write   ${p.target}   memory-pulse hooks for ${p.host.name}, added or updated; every other entry is kept`);
    else if (p.state === "repair") out(`  keep    ${p.target}   ${p.host.name} hooks are installed; the copy they run is missing or is not this package, and is put back`);
    else if (p.state === "keep") out(`  keep    ${p.target}   ${p.host.name} hooks are already installed`);
    else if (p.state === "plugin") out(`  keep    ${p.target}   ${p.host.name} runs the plugin's hooks from here; a second set in ${p.host.file} would run each hook twice`);
    else if (p.state === "codex-plugin") out(`  skip    ${p.target}   a ${p.host.name} plugin copy is here and /hooks inside Codex lists what runs; to write ${p.host.file} as well: memory-pulse install-hook${p.host.flag}`);
    else out(`  cannot  ${p.target}   ${p.why}; repair it by hand, then run init again`);
  }
  if (team.applies) {
    out(team.attrs.change ? `  write   ${team.attrs.file}   names the memory-pulse merge driver for the committed ledger and rules file; commit it` : `  keep    ${team.attrs.file}   already names the merge driver`);
    out(team.config.change ? `  write   ${team.config.file}   defines that merge driver for this clone (git does not share this file, so every clone sets it once)` : `  keep    ${team.config.file}   already defines the merge driver for this clone`);
  }
  if (copies) out(`  copy    ${join(c.data, ctx.version)}   a copy of this package; ${project ? "this clone's merge driver runs" : "the hooks run"} node on it`);
  if (project && todo.length) out("  note    hooks written with --project run through npx so that they run on every clone, about a second per hook call");
  out(makeDir ? `  create  ${shownDir}   the ledger folder; the first remember writes events.jsonl there` : `  keep    ${shownDir}   the ledger folder is already there`);
  out("  run     memory-pulse doctor");
  out("");

  const nothing = !todo.length && !makeDir && !teamTodo;
  if (o["dry-run"]) { out("Dry run: nothing was changed."); return 0; }
  if (nothing) out(invalid.length ? "Nothing can be changed until the file named above is repaired." : `Nothing to change: ${found.length ? "the hooks are installed and " : ""}the ledger folder is there.`);
  else if (!o.yes) {
    const tty = ctx.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!tty) { out(`No terminal and no --yes, so nothing was changed. To apply this plan: ${again}`); return 0; }
    const answer = await (ctx.ask ?? askOnTerminal)("Apply this plan? [y/N] ");
    if (!/^y(es)?$/i.test(String(answer).trim())) { out("Nothing was changed."); return 0; }
  }
  const said = (text) => { for (const l of String(text).split("\n").map((x) => x.trimEnd()).filter(Boolean)) out(`  | ${l}`); };
  let broken = invalid.length > 0, wrote = false;
  if (teamTodo) {
    out("memory-pulse team setup");
    const r = runServer(ctx, ["team", "setup"], { cwd: c.cwd, env }); said(r.stdout);
    if (r.status !== 0) { broken = true; out(`team setup did not finish: ${errorLine(r.stderr) || `exit ${r.status}`}`); }
  }
  for (const p of todo) {
    const before = existsSync(p.target) ? readFileSync(p.target, "utf8") : null;
    out(`memory-pulse ${installArgs(p.host, project).join(" ")}`);
    const r = runServer(ctx, installArgs(p.host, project), { cwd: c.cwd, env }); said(r.stdout);
    if (r.status !== 0) { broken = true; out(`could not install the ${p.host.name} hooks: ${errorLine(r.stderr) || `install-hook exited ${r.status}`}`); continue; }
    if ((existsSync(p.target) ? readFileSync(p.target, "utf8") : null) !== before) wrote = true; else if (p.state === "repair") out(`put back the copy the ${p.host.name} hooks run: ${p.pinnedDir}`);
  }
  if (makeDir) { mkdirSync(ledgerDir, { recursive: true }); out(`created ${shownDir}`); }
  // install-hook asks about usage counts once, on a terminal, after it writes hooks. The installs above had no terminal, so the
  // one question is asked here, by the same function, when hooks were written.
  if (wrote && ctx.askUsageConsent) await ctx.askUsageConsent();
  if (todo.some((p) => p.host.id === "codex")) out("Codex runs no hook it has not been shown: open Codex, run /hooks and trust the memory-pulse entries.");
  out("");
  const res = await runDoctor(ctx, { offline: !!o.offline });
  printDoctor(out, res);
  out("");
  // the closing lines say what holds: an agent's edit is blocked only where a host's guard hook is set up
  out(`Next: record a first correction, then test it. The second command answers BLOCKED and exits 2${res.guarded ? ", and an agent's edit that writes $49 in this folder is blocked the same way." : ". No editor is set up yet, so no agent's edit is checked: the check command and the pull-request check are what enforce it until one is."}`);
  out("  npx -y memory-pulse remember pricing-shipped price-corrected --kind correction --withdrawn '$49' --replacement '$29' --note 'measured willingness to pay is $29'");
  out("  npx -y memory-pulse check --text 'the plan costs $49 a month'");
  return res.ok && !broken ? 0 : 1;
});
