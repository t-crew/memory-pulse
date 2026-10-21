// Soul mode (2026-10-21): agent mode plus what OpenClaw keeps in workspace files (SOUL.md persona, IDENTITY.md name, USER.md the human,
// MEMORY.md long-term facts, memory/YYYY-MM-DD.md daily logs), kept on the agent ledger instead: chained, sealed, printed first in every
// brief on every host. Tests: test/soul.test.js.
//   owner-only  the soul, the user profile, the decisions on proposals, the export record and the journal are written only by this module's
//               commands and the session-end hook, which hold OWNER; remember and the MCP tool pass JSON, which cannot carry a Symbol. In
//               soul mode the guard (soulGuard) keeps the agent's own tools from running those commands or editing the agent ledger and the
//               exported files. The agent may propose a change; the owner approves or rejects it.
//   screened    soul text passes the instruction screen plus SELF_MODIFY: OpenClaw's SOUL.md and MEMORY.md can be poisoned by indirect prompt
//               injection that persists across restarts (Cloud Security Alliance research note, 2026-06); the shape is an instruction to
//               rewrite the agent's own files or to obey content that arrives from outside
//   OpenClaw    import reads a workspace through both screens and names every line it withheld (file:line); export writes the files back,
//               never overwrites a file it did not write (--force keeps a .bak), and records their sha256 so the brief can say when one
//               was edited outside memory-pulse
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

export const OWNER = Symbol("memory-pulse soul owner");
export const RESERVED = ["soul", "soul-user", "soul-decision", "soul-export", "journal"];

const SELF_MODIFY = [
  /\b(?:update|edit|rewrite|modify|change|replace|append to|add to|write (?:to|into)|overwrite|delete|erase)\b[^.\n]{0,40}\b(?:soul|identity|memory|personality|instructions|rules|SOUL\.md|MEMORY\.md|IDENTITY\.md|USER\.md|AGENTS\.md|HEARTBEAT\.md|CLAUDE\.md)\b/i,
  /\b(?:obey|follow|execute|carry out|do what)\b[^.\n]{0,40}\b(?:e-?mails?|messages?|web ?pages?|documents?|websites?|incoming|any(?:one|body)|instructions? (?:in|from))\b/i,
];
/** Why a piece of soul text is refused: the instruction screen's reasons plus protect-soul for self-modification. Empty means it stands. */
export function soulScreen(text, instructionLike) {
  const v = String(text ?? "");
  return [...instructionLike(v), ...(SELF_MODIFY.some((re) => re.test(v)) ? ["protect-soul"] : [])];
}

const tagged = (rows, tag) => rows.filter((e) => Array.isArray(e.tags) && e.tags.includes(tag));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const clip = (s, n = 200) => { const v = String(s ?? "").replace(/\s+/g, " ").trim(); return v.length > n ? v.slice(0, n - 1) + "…" : v; };

/** The soul as the rows in force hold it. */
export function soulState(events) {
  const decided = new Set(events.flatMap((e) => (Number.isInteger(e.decides) ? [e.decides] : [])));
  const ids = tagged(events, "identity");
  return {
    self: ids.filter((e) => e.pinned).at(-1) ?? ids.at(-1) ?? null,
    soul: tagged(events, "soul").at(-1) ?? null,
    user: tagged(events, "soul-user").at(-1) ?? null,
    proposals: tagged(events, "soul-proposal").filter((e) => !decided.has(e.t)),
    journal: tagged(events, "journal"),
    memory: tagged(events, "memory"),
    exported: tagged(events, "soul-export").at(-1) ?? null,
  };
}

/** Exported files whose bytes are no longer what the export wrote. */
export function drift(state) {
  const x = state.exported?.export; if (!x?.dir || !x.files) return [];
  const out = [];
  for (const [name, digest] of Object.entries(x.files)) {
    const p = join(x.dir, name);
    if (!existsSync(p)) out.push({ name, dir: x.dir, why: "is missing" });
    else if (sha(readFileSync(p)) !== digest) out.push({ name, dir: x.dir, why: "differs from the sealed soul (edited outside memory-pulse after the export" + ` at t${state.exported.t})` });
  }
  return out;
}

/** The lines soul mode adds to the identity section, after the self line. Every line is screened again at render. */
export function soulLines(state, { instructionLike, held }) {
  // every line in the soul block passes the soul screen, not only the instruction screen: long-term memory rows can come from remember
  const g = (line, t) => (soulScreen(line, instructionLike).length ? `  ${held} (agent t${t})` : line);
  const lines = [];
  if (state.soul) lines.push(g(`  soul: ${clip(state.soul.note, 600)} (agent t${state.soul.t})`, state.soul.t));
  if (state.user) lines.push(g(`  user: ${clip(state.user.note, 400)} (agent t${state.user.t})`, state.user.t));
  if (state.memory.length) {
    lines.push(`  long-term memory (${state.memory.length}${state.memory.length > 8 ? ", newest 8" : ""}):`);
    for (const m of state.memory.slice(-8)) lines.push(g(`    ${clip(m.note ?? m.effect, 160)} (agent t${m.t})`, m.t));
  }
  if (state.journal.length) {
    const dates = [...new Set(state.journal.map((j) => j.journal?.date).filter(Boolean))].sort().slice(-3);
    const recent = state.journal.filter((j) => dates.includes(j.journal?.date)).slice(-6);
    lines.push(`  recent days (${dates.join(", ")}):`);
    for (const j of recent) lines.push(g(`    ${j.journal.date} ${j.journal.project ?? ""}: ${clip(j.note, 160)} (agent t${j.t})`, j.t));
  }
  for (const p of state.proposals) lines.push(g(`  ${p.proposal?.section === "user" ? "user profile" : "soul"} change proposed (t${p.t}): "${clip(p.note, 160)}" — memory-pulse soul approve ${p.t}, or memory-pulse soul reject ${p.t}`, p.t));
  for (const d of drift(state)) lines.push(`  ⚠ ${d.name} in ${d.dir} ${d.why}`);
  return lines;
}

// ---- the guard (soul mode only): the agent's own tools never change the soul
// at a command position only (start, or after ; & | ( ` or a newline, or after sh -c / env / sudo): a commit message or a grep that
// mentions "memory-pulse soul" is not a soul command
const SOUL_CMD = /(?:^|[;&|(`\n]|\b(?:sh|bash|zsh|env|exec|sudo|time)\s+(?:-c\s+)?["']?)\s*(?:npx\s+(?:-y\s+)?)?(?:node\s+)?(?:memory-pulse(?:@[\w.^~-]+)?|[\w./~-]*server\.mjs["']?)\s+(soul|user|identity)\b([^|;&\n]*)/g;
// code that loads the soul module holds the owner token; no tool call needs to
const SOUL_MODULE = /lib\/soul\.mjs\b/;
const WRITE_OP = /(?:>>?|\btee\b|\bsed\s+-i|\bcp\b|\bmv\b|\brm\b|\btruncate\b|\bdd\b|\bln\b|\bchmod\b|\bperl\s+-[a-z]*i)/;
export function soulGuard(payload, { agentDir, protectedFiles = [] }) {
  const name = payload?.tool_name, input = payload?.tool_input ?? {};
  const inside = (p) => { if (!p) return false; const a = resolve(String(p)); return a === agentDir || a.startsWith(agentDir + "/") || protectedFiles.includes(a); };
  if (name === "Bash" && typeof input.command === "string") {
    const cmd = input.command;
    for (const m of cmd.matchAll(SOUL_CMD)) {
      const sub = m[1], rest = m[2].trim();
      const allowed = !rest || /^(?:propose\b|--json\b|show\b)/.test(rest);
      if (!allowed) return `the ${sub === "user" ? "user profile" : sub} is changed by its owner, not by the agent's tools; propose it instead: memory-pulse ${sub === "user" ? "user" : "soul"} propose "<text>"`;
    }
    if (SOUL_MODULE.test(cmd)) return "code that loads memory-pulse's soul module can write the soul; the agent's tools do not load it";
    // the same paths as the shell may spell them: absolute, ~/..., $HOME/..., ${HOME}/...
    const home = homedir(), spell = (p) => { const out = [p]; if (p.startsWith(home + "/")) { const rel = p.slice(home.length); out.push(`~${rel}`, `$HOME${rel}`, `\${HOME}${rel}`); } return out; };
    if (WRITE_OP.test(cmd) && [agentDir, ...protectedFiles].flatMap(spell).some((p) => cmd.includes(p))) return "the agent ledger and the exported soul files are written by memory-pulse only";
  }
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name) && inside(input.file_path ?? input.notebook_path)) return "the agent ledger and the exported soul files are written by memory-pulse only";
  if (name === "apply_patch" && typeof (input.patch ?? input.input ?? input.command) === "string") {
    const text = String(input.patch ?? input.input ?? input.command);
    for (const m of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) if (inside(m[1].trim())) return "the agent ledger and the exported soul files are written by memory-pulse only";
  }
  return null;
}
export const protectedFilesOf = (state) => { const x = state.exported?.export; return x?.dir && x.files ? Object.keys(x.files).map((n) => resolve(join(x.dir, n))) : []; };

// ---- OpenClaw workspace files
const DEFAULT_WS = () => join(homedir(), ".openclaw", "workspace");
/** Read a workspace: content lines (headings and blank lines skipped), each screened; what was withheld, with file and line. */
export function readOpenClaw(dir, screen) {
  const out = { soul: null, identity: null, user: null, memory: [], journal: [], withheld: [] };
  const body = (rel) => {
    const p = join(dir, rel); if (!existsSync(p)) return null;
    const keep = [];
    readFileSync(p, "utf8").split("\n").forEach((l, i) => {
      const t = l.trim(); if (!t || t.startsWith("#") || /^(?:---|```)/.test(t)) return;
      const why = screen(t); if (why.length) { out.withheld.push({ file: rel, line: i + 1, why, text: clip(t, 80) }); return; }
      keep.push(t.replace(/^[-*+]\s+/, ""));
    });
    return keep;
  };
  const soul = body("SOUL.md"); if (soul?.length) out.soul = soul.join(" ");
  const id = body("IDENTITY.md");
  if (id?.length) { const nameLine = id.find((l) => /^name\s*:/i.test(l)); const name = nameLine ? nameLine.replace(/^name\s*:\s*/i, "") : id[0]; const rest = id.filter((l) => l !== nameLine && l !== name); out.identity = [name, ...rest].join("; "); }
  const user = body("USER.md"); if (user?.length) out.user = user.join(" ");
  out.memory = body("MEMORY.md") ?? [];
  const mdir = join(dir, "memory");
  if (existsSync(mdir)) for (const f of readdirSync(mdir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort()) {
    const lines = body(join("memory", f)); if (lines?.length) out.journal.push({ date: f.slice(0, 10), text: clip(lines.join(" "), 300) });
  }
  return out;
}
export function renderOpenClaw(state) {
  const para = (h, e) => `# ${h}\n\n${e ? String(e.note ?? e.effect).trim() : ""}\n`;
  return {
    "SOUL.md": para("Soul", state.soul), "IDENTITY.md": para("Identity", state.self), "USER.md": para("User", state.user),
    "MEMORY.md": `# Memory\n\n${state.memory.map((m) => `- ${String(m.note ?? m.effect).trim()}`).join("\n")}${state.memory.length ? "\n" : ""}`,
  };
}

// ---- commands. core: { appendEvent, agentEvents(), inForce, instructionLike, slug, agentPath, soulMode(), identityBlock() }
const usage = `usage: memory-pulse soul                         show the soul, the user profile, recent days and what waits for approval
       memory-pulse soul "<persona, voice, values>"  set the soul (the owner, from a terminal)
       memory-pulse soul propose "<text>"            propose a change (the agent may); memory-pulse soul approve|reject <t>
       memory-pulse soul import --openclaw [dir]    read an OpenClaw workspace (default ~/.openclaw/workspace) through the screens
       memory-pulse soul export --openclaw [dir] [--force]   write SOUL.md, IDENTITY.md, USER.md, MEMORY.md back
       memory-pulse user "<who the human is>"         set the user profile; memory-pulse user propose "<text>"`;
const refuse = (why) => { console.error(`memory-pulse soul: refused (${why.join(", ")}): soul text may describe the agent, never tell it to rewrite itself or to obey what arrives from outside`); return 1; };
function writeSection(core, section, text, fields = {}) {
  const why = soulScreen(text, core.instructionLike); if (why.length) return { refused: why };
  const tag = section === "user" ? "soul-user" : "soul";
  return core.appendEvent({ cause: section === "user" ? "user-profile-set" : "soul-set", effect: core.slug(text).slice(0, 60), note: text, tags: [tag], pinned: true, scope: "agent", owner: OWNER, fields });
}
function report(r, what) {
  if (r.refused) return refuse(r.refused);
  if (!r.written && r.reason === "duplicate") { console.log(`${what} unchanged: the same text is already recorded (t${r.t})`); return 0; }
  if (!r.written) { console.error(`memory-pulse soul: ${what} not recorded (${r.reason})`); return 1; }
  console.log(`${what} recorded on the agent ledger (t${r.t}); every brief now starts with it`); return 0;
}
export function cliUser(argv, core) {
  const args = argv.filter((a) => !a.startsWith("--"));
  if (args[0] === "propose") return propose(core, "user", args.slice(1).join(" ").trim());
  const text = args.join(" ").trim();
  if (!text) { const s = soulState(core.inForce(core.agentEvents())); console.log(s.user ? `user: ${s.user.note} (agent t${s.user.t})` : 'no user profile yet: memory-pulse user "<who the human is>"'); return 0; }
  return report(writeSection(core, "user", text), "user profile");
}
function propose(core, section, text) {
  if (!text) { console.error(usage); return 1; }
  const why = soulScreen(text, core.instructionLike); if (why.length) return refuse(why);
  const r = core.appendEvent({ cause: "soul-proposed", effect: core.slug(text).slice(0, 60), note: text, tags: ["soul-proposal"], scope: "agent", fields: { proposal: { section } } });
  if (!r.written) { console.error(`memory-pulse soul: proposal not recorded (${r.reason})`); return 1; }
  console.log(`proposed (t${r.t}); the owner approves with memory-pulse soul approve ${r.t}, or rejects with memory-pulse soul reject ${r.t}`); return 0;
}
function decide(core, verb, t) {
  const s = soulState(core.inForce(core.agentEvents())), p = s.proposals.find((x) => x.t === Number(t));
  if (!p) { console.error(`memory-pulse soul: no open proposal t${t}`); return 1; }
  if (verb === "reject") { const r = core.appendEvent({ cause: "soul-rejected", effect: `t${p.t}`, tags: ["soul-decision"], scope: "agent", owner: OWNER, fields: { decides: p.t } }); console.log(r.written ? `rejected t${p.t}` : `not recorded (${r.reason})`); return r.written ? 0 : 1; }
  const section = p.proposal?.section === "user" ? "user" : "soul";
  return report(writeSection(core, section, p.note, { decides: p.t }), section === "user" ? "user profile" : "soul");
}
export function cliSoul(argv, core) {
  const args = argv.filter((a) => !a.startsWith("--")), flags = new Set(argv.filter((a) => a.startsWith("--")));
  const verb = args[0];
  if (!verb) {
    if (!core.soulMode()) console.log("soul mode is off: memory-pulse mode soul prints this first in every brief");
    const block = core.identityBlock(); console.log(block || 'no soul yet: memory-pulse soul "<persona, voice, values>"'); return 0;
  }
  if (verb === "propose") return propose(core, "soul", args.slice(1).join(" ").trim());
  if (verb === "approve" || verb === "reject") return decide(core, verb, args[1]);
  if (verb === "import" || verb === "export") {
    if (!flags.has("--openclaw")) { console.error(usage); return 1; }
    const dirArg = args[1]; const dir = dirArg ? (isAbsolute(dirArg) ? dirArg : resolve(dirArg)) : DEFAULT_WS();
    return verb === "import" ? importOpenClaw(core, dir) : exportOpenClaw(core, dir, flags.has("--force"));
  }
  if (["help", "-h"].includes(verb)) { console.log(usage); return 0; }
  return report(writeSection(core, "soul", args.join(" ").trim()), "soul");
}
function importOpenClaw(core, dir) {
  if (!existsSync(dir)) { console.error(`memory-pulse soul: no OpenClaw workspace at ${dir}`); return 1; }
  const ws = readOpenClaw(dir, (t) => soulScreen(t, core.instructionLike));
  let n = 0; const add = (r) => { if (r?.written) n++; };
  if (ws.soul) add(writeSection(core, "soul", ws.soul));
  if (ws.user) add(writeSection(core, "user", ws.user));
  if (ws.identity) add(core.appendEvent({ cause: "identity-set", effect: core.slug(ws.identity.split(/[;,]/)[0]), note: ws.identity, tags: ["identity", "openclaw"], pinned: true, scope: "agent", owner: OWNER }));
  for (const m of ws.memory) add(core.appendEvent({ cause: "memory", effect: core.slug(m).slice(0, 60), note: m, tags: ["memory", "openclaw"], scope: "agent" }));
  for (const j of ws.journal) add(core.appendEvent({ cause: "journal", effect: `${j.date}-openclaw`, note: j.text, tags: ["journal", "openclaw"], scope: "agent", owner: OWNER, fields: { journal: { date: j.date, project: "openclaw" } } }));
  console.log(`memory-pulse soul import: ${n} row(s) from ${dir} (soul ${ws.soul ? "yes" : "no"}, identity ${ws.identity ? "yes" : "no"}, user ${ws.user ? "yes" : "no"}, ${ws.memory.length} memory item(s), ${ws.journal.length} day(s))`);
  if (ws.withheld.length) { console.log(`withheld ${ws.withheld.length} line(s) that read like an instruction to the agent:`); for (const w of ws.withheld) console.log(`  ${w.file}:${w.line} (${w.why.join(", ")}) "${w.text}"`); }
  return 0;
}
function exportOpenClaw(core, dir, force) {
  const state = soulState(core.inForce(core.agentEvents())), files = renderOpenClaw(state);
  const prior = state.exported?.export && resolve(state.exported.export.dir) === resolve(dir) ? state.exported.export.files : {};
  const conflicts = Object.keys(files).filter((name) => { const p = join(dir, name); if (!existsSync(p)) return false; const cur = readFileSync(p); return sha(cur) !== prior[name] && cur.toString("utf8") !== files[name]; });
  if (conflicts.length && !force) { console.error(`memory-pulse soul export: ${conflicts.join(", ")} in ${dir} were not written by memory-pulse; nothing written. --force keeps each as <name>.bak and writes the soul`); return 1; }
  mkdirSync(dir, { recursive: true });
  for (const name of conflicts) copyFileSync(join(dir, name), join(dir, `${name}.bak`));
  const digests = {}; for (const [name, text] of Object.entries(files)) { writeFileSync(join(dir, name), text); digests[name] = sha(text); }
  const real = (() => { try { return realpathSync(dir); } catch { return resolve(dir); } })();
  const manifest = sha(JSON.stringify(digests)).slice(0, 12);
  const r = core.appendEvent({ cause: "soul-exported", effect: `openclaw-${manifest}`, tags: ["soul-export"], scope: "agent", owner: OWNER, fields: { export: { dir: real, files: digests } } });
  console.log(`memory-pulse soul export: ${Object.keys(files).join(", ")} → ${real}${conflicts.length ? ` (${conflicts.map((c) => `${c}.bak`).join(", ")} kept)` : ""}${r.written ? `; recorded at t${r.t}` : ""}`);
  return 0;
}
export const journalEntry = ({ cwdName, session, summary, fixes }) => ({ date: new Date().toISOString().slice(0, 10), project: cwdName, session, note: `${summary}${fixes ? `; ${fixes} fix${fixes === 1 ? "" : "es"}` : ""}` });
