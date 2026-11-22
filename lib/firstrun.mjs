// First run (2026-11-21): `demo`, `doctor` and `init`. An audit of 0.18.0 found no one command that shows a block, sets the hooks
// up, or confirms the wiring. These three are that path. They run the product's own commands as children instead of restating
// what those commands do:
//   demo    records a correction with `remember` and runs `guard` on three edits, in a temporary folder
//   doctor  reads each host's hook files, then runs the installed hook command itself against a temporary ledger
//   init    runs `install-hook` for each host it finds (first on a scratch copy, to say what would change), then doctor
// What is restated here is reading only: the shape of a hook command, and the two path rules of install-hook (where it writes,
// where it keeps the pinned copy). The tests hold both to what install-hook writes. Every temporary run gets its environment
// from sandboxEnv(), so it never resolves the caller's ledger, agent ledger, trust store, usage counts or key. Nothing here reads
// or prints a key, and nothing needs the network: the engine check is one GET with no key, reported as information.
// Tests: test/firstrun-*.test.js.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import http from "node:http";
import https from "node:https";

// ------------------------------------------------------------------ shared ----
const envOf = (ctx) => ctx.env ?? process.env;
const cwdOf = (ctx) => ctx.cwd ?? process.cwd();
const homeOf = (env) => env.HOME || env.USERPROFILE || homedir();
const printer = (ctx) => ctx.out ?? ((s) => process.stdout.write(`${s}\n`));
const fail = (ctx, cmd, msg) => { (ctx.err ?? ((s) => process.stderr.write(`${s}\n`)))(`memory-pulse ${cmd}: ${msg} (run memory-pulse help)`); return 1; };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };
const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
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
function sandbox(name) {
  const root = mkdtempSync(join(tmpdir(), `memory-pulse-${name}-`)), home = join(root, "home"), project = join(root, "project");
  mkdirSync(home); mkdirSync(project);
  return { root, home, project, remove: () => rmSync(root, { recursive: true, force: true }) };
}
// This package's own server.mjs, as a child: the same entry point a hook or a shell runs.
function runServer(ctx, args, { cwd, env, input = "" }) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [ctx.server, ...args], { cwd, env, input, encoding: "utf8", timeout: 30000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ms: Date.now() - t };
}
// A correction, through the writer: `remember --kind correction`. Returns the row number, or the reason it was refused.
function recordCorrection(ctx, sb, env, { cause, effect, withdrawn, replacement }) {
  const r = runServer(ctx, ["remember", cause, effect, "--kind", "correction", "--withdrawn", withdrawn, "--replacement", replacement], { cwd: sb.project, env });
  let res = null; try { res = JSON.parse(r.stdout); } catch { res = null; }
  return res?.written ? { t: res.t, kept: res.stored?.withdrawn ?? [], hint: res.hint ?? "" } : { t: null, reason: res?.reason ?? (firstLine(r.stderr) || `remember exited ${r.status}`) };
}
// The tool call a host sends its PreToolUse hook for one file write: Claude Code's shape, and Cursor's (lib/hosts.mjs maps it).
const editPayload = (cwd, file, text, { cursor = false } = {}) => JSON.stringify(cursor
  ? { hook_event_name: "preToolUse", conversation_id: "memory-pulse-first-run", workspace_roots: [cwd], tool_name: "Write", tool_input: { path: file, contents: text } }
  : { hook_event_name: "PreToolUse", session_id: "memory-pulse-first-run", cwd, tool_name: "Write", tool_input: { file_path: file, content: text } });
const contextOf = (stdout) => { try { return JSON.parse(stdout)?.hookSpecificOutput?.additionalContext ?? ""; } catch { return ""; } };

// -------------------------------------------------------------------- demo ----
// `memory-pulse demo [--withdrawn <old>] [--replacement <new>] [--text "<edit>"] [--json]`
// Exit 0 when the three verdicts were the ones it describes (2, 0, 0); 1 when they were not, or on a usage error.
export async function cliDemo(argv, ctx) {
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
const HOSTS = [
  { id: "claude", name: "Claude Code", dir: ".claude", bin: "claude", file: "settings.json", more: ["settings.local.json"], flag: "" },
  { id: "codex", name: "Codex", dir: ".codex", bin: "codex", file: "hooks.json", more: [], flag: " --codex" },
  { id: "cursor", name: "Cursor", dir: ".cursor", bin: "cursor", file: "hooks.json", more: [], flag: " --cursor" },
];
// A memory-pulse hook command as install-hook, mode, the plugin's hooks.json and earlier releases wrote it, or as a person wrote
// it by hand: npx (with or without a version), node on a server.mjs (the path quoted or not), or the global command; then one of
// the hook verbs. The verbs come from server.mjs (HOOK_VERBS) so that someone else's `node ".../server.mjs" start` is not ours.
const HOOK_VERBS = "brief|guard|prompt|handoff|capture|consolidate|observe|ambient|taint";
const hookRe = (verbs = HOOK_VERBS) => new RegExp(String.raw`^(?:(npx)\s+(?:-y\s+)?memory-pulse(?:@[\w.^~-]+)?|node\s+(?:"([^"]*[\\/]server\.mjs)"|(\S*[\\/]server\.mjs))|(memory-pulse))\s+(${verbs})\b(.*)$`);
// Every memory-pulse hook in a hooks object, in either shape: nested ([{ matcher, hooks: [{ command }] }], Claude Code and Codex)
// or flat ([{ command }], Cursor).
function hookCommands(json, re, sub = (c) => c) {
  const found = [];
  const hooks = json?.hooks && typeof json.hooks === "object" ? json.hooks : {};
  for (const [event, list] of Object.entries(hooks)) for (const e of Array.isArray(list) ? list : []) for (const h of Array.isArray(e?.hooks) ? e.hooks : [e]) {
    if (typeof h?.command !== "string") continue;
    const command = sub(h.command.trim()), m = re.exec(command), path = m ? m[2] ?? m[3] ?? null : null;
    if (m) found.push({ event, command, runner: m[1] ? "npx" : path ? "node" : "bin", path, verb: m[5], cursor: /--host\s+cursor\b/.test(m[6]) });
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
  return { host: h, present: how !== null, how, sources: all, codexPlugin, hooks: all.flatMap((s) => s.hooks.map((k) => ({ ...k, scope: s.scope, file: s.file }))) };
}

function hostCheck(info) {
  const h = info.host, id = `host:${h.id}`, label = h.name, install = `memory-pulse install-hook${h.flag}`;
  if (!info.present) return { id, label, status: "skipped", detail: `not found: no ~/${h.dir} folder, no ${h.bin} command on PATH and no ${h.dir}/${h.file} in this folder` };
  const bad = info.sources.find((s) => !s.valid);
  if (bad) return { id, label, status: "fail", detail: `${bad.file} is not valid JSON, so its hooks cannot be read and install-hook will not touch it`, fix: `repair ${bad.file} by hand, then memory-pulse doctor` };
  const off = info.sources.find((s) => s.json?.disableAllHooks === true);
  if (off) return { id, label, status: "fail", detail: `every hook is switched off by disableAllHooks in ${off.file}`, fix: `remove disableAllHooks from ${off.file}` };
  const gone = info.sources.find((s) => s.scope === "plugin" && s.gone);
  if (gone) return { id, label, status: "fail", detail: `the memory-pulse plugin is recorded at ${gone.root}, which does not exist`, fix: "/plugin install memory-pulse@memory-pulse (typed inside Claude Code)" };
  if (!info.hooks.some((k) => k.verb === "guard")) {
    if (info.codexPlugin) return { id, label, status: "skipped", detail: `no guard hook in ~/${h.dir}/${h.file}; a memory-pulse plugin copy is at ${info.codexPlugin}, and doctor does not read Codex's plugin state: /hooks inside Codex lists what runs` };
    return { id, label, status: "fail", notSetUp: true, detail: `no memory-pulse guard hook is installed for ${h.name}, so its edits are not checked`, fix: install };
  }
  const stale = info.hooks.filter((k) => k.runner === "node" && !existsSync(k.path));
  if (stale.length) {
    const s = stale[0];
    return { id, label, status: "fail", detail: `the ${s.verb} hook in ${s.file} runs ${s.path}, which does not exist${stale.length > 1 ? ` (${stale.length} hooks point at a missing file)` : ""}`,
      fix: s.scope === "plugin" ? "/plugin install memory-pulse@memory-pulse (typed inside Claude Code)" : `${install}${s.scope === "project" ? " --project" : ""}` };
  }
  const where = [...new Set(info.hooks.map((k) => (k.scope === "plugin" ? `the plugin at ${dirname(dirname(k.file))}` : k.file)))];
  const verbs = [...new Set(info.hooks.map((k) => k.verb))];
  const runs = info.hooks.every((k) => k.runner === "npx") ? "they run through npx" : "every hook command points at a file that exists";
  return { id, label, status: "ok", detail: `hooks installed in ${where.join(" and ")} (${verbs.join(", ")}); ${runs}${h.id === "codex" ? "; Codex runs a hook only after you trust it with /hooks inside Codex, which doctor cannot see" : ""}` };
}

// The guard, answering one synthetic edit that writes a withdrawn value back and one control edit that uses the replacement,
// against a ledger in a temporary folder. An installed hook command is run as the host runs it (through the shell, node or the
// global command resolved from PATH), so wiring that is broken shows here. A command that runs through npx is not run: it can
// need the network. When there is nothing to run, this copy's own guard answers, so the check never passes on no evidence.
function guardChecks(ctx, infos) {
  const W = "doctor-withdrawn-7f3a", R = "doctor-replacement-7f3a";
  const targets = [];
  let npx = false, missing = false;
  for (const info of infos) for (const k of info.hooks.filter((x) => x.verb === "guard")) {
    if (k.runner === "npx") { npx = true; continue; }
    if (k.runner === "node" && !existsSync(k.path)) { missing = true; continue; }
    const t = targets.find((x) => x.command === k.command);
    if (t) { if (!t.hosts.includes(info.host)) t.hosts.push(info.host); } else targets.push({ command: k.command, cursor: k.cursor, hosts: [info.host], scope: k.scope });
  }
  const self = !targets.length;
  if (self) targets.push({ command: `node "${ctx.server}" guard`, cursor: false, hosts: [], scope: "self" });
  const sb = sandbox("doctor"); const checks = [];
  try {
    const env = sandboxEnv(envOf(ctx), sb.home);
    const row = recordCorrection(ctx, sb, env, { cause: "doctor-value-shipped", effect: "doctor-value-corrected", withdrawn: W, replacement: R });
    if (row.t === null) return [{ id: "guard", label: "guard", status: "fail", detail: `a correction could not be recorded in a temporary ledger: ${row.reason}`, fix: "memory-pulse demo" }];
    for (const [i, t] of targets.entries()) {
      const call = (text) => {
        const input = editPayload(sb.project, join(sb.project, "doctor.md"), text, { cursor: t.cursor }), start = Date.now();
        const r = self ? spawnSync(process.execPath, [ctx.server, "guard"], { cwd: sb.project, env, input, encoding: "utf8", timeout: 20000 })
          : spawnSync(t.command, { shell: true, cwd: sb.project, env, input, encoding: "utf8", timeout: 20000 });
        let permission = null; if (t.cursor) { try { permission = JSON.parse(r.stdout)?.permission ?? null; } catch { permission = null; } }
        return { status: r.status, stderr: r.stderr ?? "", permission, ms: Date.now() - start };
      };
      const block = call(`value: ${W}`), pass = call(`value: ${R}`);
      const blocked = t.cursor ? block.status === 0 && block.permission === "deny" : block.status === 2 && block.stderr.includes(W);
      const passed = t.cursor ? pass.status === 0 && pass.permission === "allow" : pass.status === 0;
      const names = t.hosts.map((h) => h.name).join(" and ");
      const who = self ? "this copy's guard" : `the installed hook command for ${names}`;
      const id = i ? `guard:${i + 1}` : "guard";
      const said = (r) => (t.cursor ? `exit ${r.status} with permission ${r.permission ?? "none"}` : `exit ${r.status}`);
      if (blocked && passed) {
        const why = !self ? "" : npx ? "; the installed hooks run through npx, which doctor does not run because it can need the network" : missing ? "; the installed hook command's file is missing, see above" : "; no installed hook command to run";
        checks.push({ id, label: "guard", status: "ok", command: t.command, ms: block.ms,
          detail: `${who} ${t.cursor ? `answered a synthetic edit with a deny (${said(block)} in ${block.ms} ms) and a control edit with an allow (${said(pass)})` : `blocked a synthetic edit against a temporary ledger (${said(block)} in ${block.ms} ms) and passed a control edit (${said(pass)})`}${self ? why : `: ${t.command}`}` });
      } else {
        const what = !blocked ? `did not block a synthetic edit that writes a withdrawn value: ${said(block)}, expected ${t.cursor ? "exit 0 with permission deny" : "2"}` : `blocked a control edit that uses the replacement: ${said(pass)}, expected ${t.cursor ? "permission allow" : "0"}`;
        const err = firstLine(!blocked ? block.stderr : pass.stderr).slice(0, 160);
        const h = t.hosts[0];
        checks.push({ id, label: "guard", status: "fail", command: t.command, detail: `${who} ${what}${err ? ` (stderr: ${err})` : ""}: ${t.command}`,
          fix: self ? "reinstall memory-pulse (npm i -g memory-pulse), then memory-pulse doctor" : t.scope === "plugin" ? "/plugin install memory-pulse@memory-pulse (typed inside Claude Code)" : `memory-pulse install-hook${h.flag}${t.scope === "project" ? " --project" : ""}` });
      }
    }
  } finally { sb.remove(); }
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
  const env = envOf(ctx), c = { env, cwd: cwdOf(ctx), home: homeOf(env), re: hookRe(ctx.hookVerbs) };
  const infos = HOSTS.map((h) => inspectHost(h, c));
  // A host with no hooks is a failure only while no host is set up. Once one editor is guarded, another that merely exists on
  // the machine is reported as not set up, with the command that adds it: a second editor is not a broken install.
  const hosts = infos.map(hostCheck);
  const anyOk = hosts.some((k) => k.status === "ok");
  const hostChecks = hosts.map(({ notSetUp, ...k }) => (notSetUp && anyOk ? { id: k.id, label: k.label, status: "skipped", detail: `present, not set up: its edits are not checked. To add it: ${k.fix}` } : k));
  const checks = [nodeCheck(ctx), ...hostChecks, ...guardChecks(ctx, infos), ledgerCheck(ctx), runnerCheck(infos), await engineCheck(ctx, offline)];
  const failed = checks.filter((k) => k.status === "fail").length;
  return { version: ctx.version, ok: failed === 0, failed, checks };
}
function printDoctor(out, res) {
  out(`memory-pulse doctor ${res.version}`);
  for (const k of res.checks) out(k.status === "skipped" ? `skipped  ${k.label} (${k.detail})` : `${k.status === "ok" ? "ok      " : "FAIL    "} ${k.label}: ${k.detail}${k.fix ? `. Fix: ${k.fix}` : ""}`);
  out(res.ok ? "All checks passed." : `${res.failed} check${res.failed === 1 ? "" : "s"} failed. Run each Fix, then memory-pulse doctor again.`);
}
// `memory-pulse doctor [--json] [--offline]`: exit 0 when no check fails, 1 when one does or on a usage error.
export async function cliDoctor(argv, ctx) {
  const { o, error } = parseFlags(argv, { bool: ["json", "offline"] });
  if (error) return fail(ctx, "doctor", error);
  const res = await runDoctor(ctx, { offline: !!o.offline });
  if (o.json) printer(ctx)(JSON.stringify({ ...res, checks: res.checks.map(({ id, status, label, detail, fix, command, info }) => ({ id, status, label, detail, fix: fix ?? null, ...(command ? { command } : {}), ...(info ? { info: true } : {}) })) }));
  else printDoctor(printer(ctx), res);
  return res.ok ? 0 : 1;
}

// -------------------------------------------------------------------- init ----
const installArgs = (h, project) => ["install-hook", ...h.flag.trim().split(" ").filter(Boolean), ...(project ? ["--project"] : [])];

// What `install-hook` would do to a host's file, found by running it: on a scratch copy of the file, with a scratch folder for the
// pinned copy. The result is then read with the scratch folder's path put back to the real one. Nothing of the user's is written.
function planHost(ctx, h, c, project) {
  const target = targetFile(h, c, project), existing = existsSync(target) ? readFileSync(target, "utf8") : null;
  const real = dataDir(c.env, c.home), pinned = join(real, ctx.version, "server.mjs");
  const scratch = mkdtempSync(join(tmpdir(), "memory-pulse-plan-"));
  try {
    const settings = join(scratch, "settings"), data = join(scratch, "data"); mkdirSync(settings);
    if (existing !== null) writeFileSync(join(settings, h.file), existing);
    const r = runServer(ctx, installArgs(h, project), { cwd: scratch, env: { ...c.env, MEMORY_PULSE_SETTINGS_DIR: settings, MEMORY_PULSE_DATA_DIR: data } });
    if (r.status !== 0) return { host: h, target, state: "invalid", why: /not valid JSON/.test(r.stderr) ? `${target} is not valid JSON` : `install-hook could not read it (exit ${r.status} on a scratch copy)` };
    const rebase = (x) => (typeof x === "string" ? x.split(data).join(real) : Array.isArray(x) ? x.map(rebase) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, rebase(v)])) : x);
    const after = rebase(readJson(join(settings, h.file)));
    const same = existing !== null && JSON.stringify(after) === JSON.stringify(readJson(target));
    return { host: h, target, state: !same ? "write" : !project && !existsSync(pinned) ? "repair" : "keep", pinned };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
const askOnTerminal = async (question) => {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close(); return answer;
};

// `memory-pulse init [--yes] [--dry-run] [--project] [--offline]`: exit 0 when nothing was to be done, the plan was declined, or
// it was applied and doctor passed; 1 when a step or a doctor check failed, or on a usage error.
export async function cliInit(argv, ctx) {
  const { o, error } = parseFlags(argv, { bool: ["yes", "dry-run", "project", "offline"] });
  if (error) return fail(ctx, "init", error);
  const out = printer(ctx), env = envOf(ctx), c = { env, cwd: cwdOf(ctx), home: homeOf(env), re: hookRe(ctx.hookVerbs) }, project = !!o.project;
  const infos = HOSTS.map((h) => inspectHost(h, c)), found = infos.filter((i) => i.present);
  // a host whose plugin already runs the hooks is left alone: a second set in its settings file would run every hook twice
  const plans = found.map((i) => {
    const plugin = i.sources.find((s) => s.scope === "plugin" && !s.gone && s.hooks.some((k) => k.verb === "guard"));
    if (plugin) return { host: i.host, target: plugin.root, state: "plugin" };
    if (i.codexPlugin && !i.hooks.length) return { host: i.host, target: i.codexPlugin, state: "codex-plugin" };
    return planHost(ctx, i.host, c, project);
  });
  const ledgerDir = dirname(ctx.ledgerPath()), makeDir = !existsSync(ledgerDir), shownDir = `${ledgerDir}/`;
  const todo = plans.filter((p) => p.state === "write" || p.state === "repair"), invalid = plans.filter((p) => p.state === "invalid");
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
    else if (p.state === "repair") out(`  keep    ${p.target}   ${p.host.name} hooks are installed; the copy they run is missing and is put back`);
    else if (p.state === "keep") out(`  keep    ${p.target}   ${p.host.name} hooks are already installed`);
    else if (p.state === "plugin") out(`  keep    ${p.target}   ${p.host.name} runs the plugin's hooks from here; a second set in ${p.host.file} would run each hook twice`);
    else if (p.state === "codex-plugin") out(`  skip    ${p.target}   a ${p.host.name} plugin copy is here and /hooks inside Codex lists what runs; to write ${p.host.file} as well: memory-pulse install-hook${p.host.flag}`);
    else out(`  cannot  ${p.target}   ${p.why}; repair it by hand, then run init again`);
  }
  if (!project && todo.length) out(`  copy    this package to ${dirname(todo[0].pinned)}   the hooks run node on that copy`);
  if (project && todo.length) out("  note    hooks written with --project run through npx so that they run on every clone, about a second per hook call");
  out(makeDir ? `  create  ${shownDir}   the ledger folder; the first remember writes events.jsonl there` : `  keep    ${shownDir}   the ledger folder is already there`);
  out("  run     memory-pulse doctor");
  out("");

  const nothing = !todo.length && !makeDir;
  if (o["dry-run"]) { out("Dry run: nothing was changed."); return 0; }
  if (nothing) out(invalid.length ? "Nothing can be changed until the file named above is repaired." : `Nothing to change: ${found.length ? "the hooks are installed and " : ""}the ledger folder is there.`);
  else if (!o.yes) {
    const tty = ctx.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!tty) { out(`No terminal and no --yes, so nothing was changed. To apply this plan: ${again}`); return 0; }
    const answer = await (ctx.ask ?? askOnTerminal)("Apply this plan? [y/N] ");
    if (!/^y(es)?$/i.test(String(answer).trim())) { out("Nothing was changed."); return 0; }
  }
  let broken = invalid.length > 0, wrote = false;
  for (const p of todo) {
    const before = existsSync(p.target) ? readFileSync(p.target, "utf8") : null;
    const r = runServer(ctx, installArgs(p.host, project), { cwd: c.cwd, env });
    const after = existsSync(p.target) ? readFileSync(p.target, "utf8") : null;
    if (r.status !== 0) { broken = true; out(`could not install the ${p.host.name} hooks: ${firstLine(r.stderr) || `install-hook exited ${r.status}`}`); continue; }
    if (after !== before) { wrote = true; out(firstLine(r.stdout)); } else out(`put back the copy the ${p.host.name} hooks run: ${dirname(p.pinned)}`);
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
  out("Next: record a first correction, then test it. The second command answers BLOCKED and exits 2, and an agent's edit that writes $49 in this folder is blocked the same way.");
  out("  npx -y memory-pulse remember pricing-shipped price-corrected --kind correction --withdrawn '$49' --replacement '$29' --note 'measured willingness to pay is $29'");
  out("  npx -y memory-pulse check --text 'the plan costs $49 a month'");
  return res.ok && !broken ? 0 : 1;
}
