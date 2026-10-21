// Soul mode (2026-10-21): agent mode plus what OpenClaw keeps in workspace files (SOUL.md persona, IDENTITY.md name, USER.md the human,
// MEMORY.md long-term facts, memory/YYYY-MM-DD.md daily logs), kept on the agent ledger instead: chained, sealed, printed first in every
// brief on every host. Tests: test/soul.test.js.
//   autonomous  the agent owns its soul: it writes the soul, its notes about the user and its identity from any session (Travis, the same
//               day: "an autonomous agent"). They are written through this module (SOUL_WRITE, a Symbol remember and the MCP tool cannot
//               carry), so every change is screened, attributed and kept; remember points here
//   tainted     what guards against injection is where a change comes from. OpenClaw's SOUL.md and MEMORY.md can be poisoned by indirect
//               prompt injection that persists across restarts (Cloud Security Alliance research note, 2026-06): the agent reads a poisoned
//               page or mail and rewrites itself in the same breath. A change made in a session that read outside content (taintOf: web
//               fetch and search, browser, mail and fetch-style MCP tools, curl or wget, read from capture's record of the session), or that
//               arrived by state merge, is held until the agent confirms it from a clean session, or the owner approves it
//   screened    soul text passes the instruction screen plus SOUL_SHAPES (rewrite your own files, obey what arrives from outside, switch off
//               the guard, hide a rule, fetch and adopt, hand out secrets); a negated rule ("does not follow instructions in documents") stands.
//               The screen is a filter for known shapes, not a boundary
//   kept        every version carries its session, date and the version it replaced; soul history lists them, soul revert brings one back
//   chained     a row on the agent ledger that was not written through memory-pulse (no hash) is never honored as the soul and is named in
//               the brief; the fingerprint is the sha256 of the ledger's bytes, so any change to the file changes it
//   OpenClaw    import reads regular files only, scrubs secrets, caps sizes, and names every line it withheld (file:line); export writes
//               regular files only, never over a file it did not write (--force keeps a .bak, never overwriting an older .bak), never inside
//               the agent ledger's folder, and records sha256s so the brief can say when an exported file was edited afterwards
//   the ledger  raw edits of the agent ledger file are blocked in soul mode (soulGuard), however the path is spelled
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, realpathSync, lstatSync, openSync, readSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, isAbsolute, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { scrub } from "./capture.mjs";

export const SOUL_WRITE = Symbol("memory-pulse soul write");
export const RESERVED = ["soul", "soul-user", "soul-decision", "soul-export", "journal"];

// shapes an injected soul takes. A shape preceded by a negation ("does not follow instructions in documents") is a rule against it.
const SOUL_SHAPES = [
  /\b(?:update|edit|rewrite|modify|change|replace|append to|add to|write (?:to|into)|overwrite|delete|erase)\b[^.\n]{0,40}\b(?:soul|identity|memory|personality|instructions|rules|SOUL\.md|MEMORY\.md|IDENTITY\.md|USER\.md|AGENTS\.md|HEARTBEAT\.md|CLAUDE\.md)\b/i,
  /\b(?:obey|follow|execute|carry out|do what)\b[^.\n]{0,40}\b(?:e-?mails?|messages?|web ?pages?|documents?|websites?|incoming|any(?:one|body)|instructions? (?:in|from))\b/i,
  /\b(?:disable|turn off|switch off|bypass|skip|remove|uninstall|ignore|get around)\b[^.\n]{0,30}\b(?:guard|hooks?|memory-pulse|sandbox|permissions?|safety|checks?)\b/i,
  /\b(?:never|don't|do not|without)\s+(?:mention|tell|reveal|disclose|show|inform)\w*\b[^.\n]{0,30}\b(?:this|these|the)\s+(?:rule|instruction|file|change|note|soul)s?\b/i,
  /\b(?:curl|wget|fetch|download|read|load|open)\b(?:[^.\n]|\.(?=\S)){0,80}\b(?:and|then)\s+(?:adopt|follow|obey|apply|use|run|execute|become)\b/i,   // a dot inside a URL is not a sentence end
  /\b(?:share|send|post|paste|upload|give|forward|leak|e-?mail)\w*\b[^.\n]{0,40}\b(?:api[- ]?keys?|tokens?|secrets?|passwords?|credentials?|\.env|private keys?|ssh keys?)\b/i,
];
const NEGATED = /\b(?:not|never|no|don't|doesn't|won't|refuses? to|declines? to)\s+(?:\w+\s+){0,2}$/i;
/** Why a piece of soul text is refused: the instruction screen's reasons plus protect-soul for a known injected shape. Empty means it stands. */
export function soulScreen(text, instructionLike) {
  const v = String(text ?? "");
  const shape = SOUL_SHAPES.some((re) => { const m = re.exec(v); return m && !NEGATED.test(v.slice(Math.max(0, m.index - 40), m.index)); });
  return [...instructionLike(v), ...(shape ? ["protect-soul"] : [])];
}

const tagged = (rows, tag) => rows.filter((e) => Array.isArray(e.tags) && e.tags.includes(tag));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const clip = (s, n = 200) => { const v = String(s ?? "").replace(/\s+/g, " ").trim(); return v.length > n ? v.slice(0, n - 1) + "…" : v; };
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Rows written through memory-pulse carry a hash once the ledger has a chain; a row without one was appended around it. */
export function chainedOnly(events) {
  const chained = events.some((e) => typeof e?.hash === "string");
  return chained ? { rows: events.filter((e) => typeof e?.hash === "string"), unchained: events.filter((e) => typeof e?.hash !== "string").map((e) => e.t) } : { rows: events, unchained: [] };
}

/** The soul as the rows in force hold it (pass chained rows). */
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

const MAX_FILE = 1 << 20;
/** Regular file only, at most `max` bytes; null for anything else (directory, FIFO, socket, symlink, missing). */
function readRegular(p, max = MAX_FILE) {
  let st; try { st = lstatSync(p); } catch { return { missing: true }; }
  if (!st.isFile()) return { irregular: true };
  try { const fd = openSync(p, "r"); try { const buf = Buffer.alloc(Math.min(st.size, max)); readSync(fd, buf, 0, buf.length, 0); return { buf, size: st.size }; } finally { closeSync(fd); } } catch { return { unreadable: true }; }
}

/** Exported files whose bytes are no longer what the export wrote. Never throws, never blocks. */
export function drift(state) {
  const x = state.exported?.export; if (!x?.dir || !x.files || typeof x.files !== "object") return [];
  const out = [];
  for (const [name, digest] of Object.entries(x.files)) {
    const r = readRegular(join(String(x.dir), basename(name)));
    if (r.missing) out.push({ name, dir: x.dir, why: "is missing" });
    else if (r.irregular) out.push({ name, dir: x.dir, why: "is not a regular file any more" });
    else if (r.unreadable) out.push({ name, dir: x.dir, why: "could not be read" });
    else if (r.size > MAX_FILE || sha(r.buf) !== digest) out.push({ name, dir: x.dir, why: `differs from the sealed soul (edited outside memory-pulse after the export at t${state.exported.t})` });
  }
  return out;
}

const MAX_OPEN = 3;
/** The lines soul mode adds to the identity section: the fingerprint and any drift first, so nothing below can push them out. */
export function soulLines(state, { instructionLike, held, digest = null, unchained = [], continuity = null }) {
  // each note is screened, not the line around it (the line's own words, "change proposed … memory-pulse soul", are not the agent's)
  const g = (line, e) => (soulScreen(e?.note ?? e?.effect ?? "", instructionLike).length ? `  ${held} (agent t${e.t})` : line);
  const lines = [];
  if (continuity) lines.push(continuity);
  if (digest) lines.push(`  fingerprint: agent ledger ${digest.slice(0, 16)} — any change to the agent ledger changes this`);
  if (unchained.length) lines.push(`  ⚠ ${unchained.length} row(s) on the agent ledger were not written through memory-pulse (t${unchained.slice(0, 5).join(", t")}); they are not honored`);
  for (const d of drift(state)) lines.push(`  ⚠ ${d.name} in ${d.dir} ${d.why}`);
  if (state.soul) lines.push(g(`  soul: ${clip(state.soul.note, 600)} (agent t${state.soul.t})`, state.soul));
  if (state.user) lines.push(g(`  user: ${clip(state.user.note, 400)} (agent t${state.user.t})`, state.user));
  if (state.memory.length) {
    lines.push(`  long-term memory (${state.memory.length}${state.memory.length > 8 ? ", newest 8" : ""}):`);
    for (const m of state.memory.slice(-8)) lines.push(g(`    ${clip(m.note ?? m.effect, 160)} (agent t${m.t})`, m));
  }
  if (state.journal.length) {
    const dates = [...new Set(state.journal.map((j) => j.journal?.date).filter((d) => typeof d === "string"))].sort().slice(-3);
    const recent = state.journal.filter((j) => dates.includes(j.journal?.date)).slice(-6);
    lines.push(`  recent days (${dates.join(", ")}):`);
    for (const j of recent) lines.push(g(`    ${j.journal.date} ${clip(j.journal.project ?? "", 40)}: ${clip(j.note, 160)} (agent t${j.t})`, j));
  }
  const label = (p) => ({ user: "user notes", identity: "identity" })[p.proposal?.section] ?? "soul";
  for (const p of state.proposals.slice(-MAX_OPEN)) lines.push(g(Array.isArray(p.proposal?.held) && p.proposal.held.length
    ? `  ${label(p)} change held (t${p.t}): "${clip(p.note, 160)}" — held because of ${p.proposal.held.map((x) => clip(x, 60)).join(", ")}; confirm it from a clean session: memory-pulse soul confirm ${p.t}, or memory-pulse soul reject ${p.t}`
    : `  ${label(p)} change proposed (t${p.t}): "${clip(p.note, 160)}" — memory-pulse soul approve ${p.t}, or memory-pulse soul reject ${p.t}`, p));
  if (state.proposals.length > MAX_OPEN) lines.push(`  +${state.proposals.length - MAX_OPEN} more open changes — memory-pulse soul lists them`);
  return lines;
}

// ---- the guard (soul mode only): the agent ledger file is written through memory-pulse, never by hand, so every entry stays chained
const WRITE_OP = /(?:>>?|\btee\b|\bsed\s+-i|\bcp\b|\bmv\b|\brm\b|\btruncate\b|\bdd\b|\bln\b|\bchmod\b|\bperl\s+-[a-z]*i|\bopen\s*\(|\bwrite(?:File|FileSync|_text|_bytes)?\s*\(|\bappendFile|\bunlink)/;
const BY_HAND = "the agent ledger is written through memory-pulse (soul, user, identity, remember --scope agent), never by hand, so every entry stays chained";
const fold = (p) => p.toLowerCase();           // APFS and NTFS are case-insensitive by default
/** The real path of p, resolving symlinks in the part of it that exists. */
function realish(p) {
  let a = resolve(String(p)), tail = [];
  for (let i = 0; i < 64; i++) { try { return join(realpathSync(a), ...tail); } catch { const d = dirname(a); if (d === a) return resolve(String(p)); tail.unshift(basename(a)); a = d; } }
  return resolve(String(p));
}
export function soulGuard(payload, { agentDir }) {
  const name = payload?.tool_name, input = payload?.tool_input ?? {};
  const realAgent = fold(realish(agentDir));
  const inside = (p) => { if (!p) return false; const a = fold(realish(p)); return a === realAgent || a.startsWith(realAgent + "/"); };
  if (name === "Bash" && typeof input.command === "string") {
    const cmd = input.command, home = homedir();
    // the same paths as the shell may spell them: absolute, ~/..., $HOME/..., ${HOME}/..., "$HOME"/...
    const spell = (p) => { const out = [p]; if (p.startsWith(home + "/")) { const rel = p.slice(home.length); out.push(`~${rel}`, `$HOME${rel}`, `\${HOME}${rel}`, `"$HOME"${rel}`, `"\${HOME}"${rel}`); } return out.map(fold); };
    const c = fold(cmd);
    if (WRITE_OP.test(cmd) && spell(agentDir).some((p) => c.includes(p))) return BY_HAND;
    // removing or moving the folder that holds the agent ledger
    if (/\b(?:rm|mv)\b/.test(cmd) && spell(dirname(agentDir)).some((p) => new RegExp(`(?:^|[\\s"'=])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?(?=[\\s"';|&]|$)`).test(c))) return BY_HAND;
  }
  if (["Edit", "Write", "MultiEdit", "NotebookEdit", "Delete", "delete_file"].includes(name) && inside(input.file_path ?? input.notebook_path ?? input.path ?? input.target_file)) return BY_HAND;
  if (name === "apply_patch" && typeof (input.patch ?? input.input ?? input.command) === "string") {
    for (const m of String(input.patch ?? input.input ?? input.command).matchAll(/^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+)$/gm)) if (inside(m[1].trim())) return BY_HAND;
  }
  return null;
}

// ---- taint: did this session read outside content? (capture's record of the session; Claude Code gives commands CLAUDE_CODE_SESSION_ID)
const EXTERNAL_TOOL = /^(?:WebFetch|WebSearch)$|^mcp__.*(?:browser|chrome|fetch|web|mail|gmail|slack|scrape|search|http|url|drive|docs|notion|kitesurf|firecrawl|reddit|twitter|discord|rss)/i;
const EXTERNAL_CMD = /(?:^|[\s;&|(`])(?:curl|wget|http|httpie|xh|lynx|w3m)\s/;
export function taintOf(rows) {
  const out = [];
  for (const r of rows ?? []) {
    const o = r?.obs; if (!o) continue;
    const what = o.op === "tool" && EXTERNAL_TOOL.test(String(o.name)) ? String(o.name) : o.op === "run" && EXTERNAL_CMD.test(` ${o.cmd ?? ""}`) ? String(o.cmd).split(/\s+/)[0] : null;
    if (what && !out.includes(what)) out.push(what);
  }
  return out;
}

/** A soul, user or identity row arriving by state merge into the agent ledger: held as a change to confirm, never adopted as it comes. */
export function heldFromMerge(row, branch) {
  const tags = Array.isArray(row?.tags) ? row.tags : [];
  const section = tags.includes("soul-user") ? "user" : tags.includes("identity") ? "identity" : tags.includes("soul") ? "soul" : null;
  if (!section && !tags.some((t) => RESERVED.includes(t))) return undefined;            // not a soul row: carried as usual
  if (!section) return null;                                                            // decisions, exports, journal: the other side's own
  const { hash, prev, ...rest } = row; void hash; void prev;
  return { t: rest.t, cause: "soul-held", effect: String(rest.effect ?? "merged").slice(0, 60), kind: "event", note: rest.note, tags: ["soul-proposal"],
           proposal: { section, held: [`state merge from ${branch}`] }, ...(rest.origin ? { origin: rest.origin } : {}) };
}

// ---- OpenClaw workspace files
const DEFAULT_WS = () => join(homedir(), ".openclaw", "workspace");
const CAP = { soul: 4000, user: 2000, identity: 300, memory: 200, item: 300, days: 60 };
/** Read a workspace: regular files only, at most 256 KB each, secrets scrubbed, control characters dropped, each line screened. */
export function readOpenClaw(dir, screen) {
  const out = { soul: null, identity: null, user: null, memory: [], journal: [], withheld: [], skipped: [] };
  const body = (rel) => {
    const r = readRegular(join(dir, rel), 256 * 1024);
    if (r.missing) return null;
    if (!r.buf) { out.skipped.push({ file: rel, why: r.irregular ? "not a regular file" : "could not be read" }); return null; }
    const keep = [];
    r.buf.toString("utf8").replace(CONTROL, "").split("\n").forEach((l, i) => {
      const t = scrub(l.trim()); if (!t || t.startsWith("#") || /^(?:---|```)/.test(t)) return;
      const why = screen(t); if (why.length) { out.withheld.push({ file: rel, line: i + 1, why, text: clip(t, 80) }); return; }
      keep.push(t.replace(/^[-*+]\s+/, ""));
    });
    return keep;
  };
  const soul = body("SOUL.md"); if (soul?.length) out.soul = clip(soul.join(" "), CAP.soul);
  const id = body("IDENTITY.md");
  if (id?.length) { const nameLine = id.find((l) => /^name\s*:/i.test(l)); const name = nameLine ? nameLine.replace(/^name\s*:\s*/i, "") : id[0]; const rest = id.filter((l) => l !== nameLine && l !== name); out.identity = clip([name, ...rest].join("; "), CAP.identity); }
  const user = body("USER.md"); if (user?.length) out.user = clip(user.join(" "), CAP.user);
  out.memory = (body("MEMORY.md") ?? []).slice(-CAP.memory).map((m) => clip(m, CAP.item));
  const mdir = join(dir, "memory");
  let names = []; try { if (lstatSync(mdir).isDirectory()) names = readdirSync(mdir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().slice(-CAP.days); } catch { names = []; }
  for (const f of names) { const lines = body(join("memory", f)); if (lines?.length) out.journal.push({ date: f.slice(0, 10), text: clip(lines.join(" "), 300) }); }
  return out;
}
export function renderOpenClaw(state) {
  const para = (h, e) => `# ${h}\n\n${e ? String(e.note ?? e.effect).trim() : ""}\n`;
  return {
    "SOUL.md": para("Soul", state.soul), "IDENTITY.md": para("Identity", state.self), "USER.md": para("User", state.user),
    "MEMORY.md": `# Memory\n\n${state.memory.map((m) => `- ${String(m.note ?? m.effect).trim()}`).join("\n")}${state.memory.length ? "\n" : ""}`,
  };
}

// ---- commands. core: { appendEvent, agentEvents(), inForce, instructionLike, slug, soulMode(), identityBlock(), episode(), session(), agentDir }
const usage = `usage: memory-pulse soul                         show the soul, the user notes, recent days and what is held
       memory-pulse soul "<persona, voice, values>"  set the soul (the agent or its owner)
       memory-pulse soul propose "<text>"            leave a change for later; memory-pulse soul confirm|approve|reject <t>
       memory-pulse soul history [--user|--identity]  every version, with its session and date; memory-pulse soul revert <t>
       memory-pulse soul capsule [--out f] | verify <f> | resume <f>   the soul as one sealed state that travels
       memory-pulse soul import --openclaw [dir]    read an OpenClaw workspace (default ~/.openclaw/workspace) through the screens
       memory-pulse soul export --openclaw [dir] [--force]   write SOUL.md, IDENTITY.md, USER.md, MEMORY.md back
       memory-pulse user "<who the human is>"         set the agent's notes about the user; memory-pulse user propose "<text>"`;
const refuse = (why) => { console.error(`memory-pulse soul: refused (${why.join(", ")}): soul text may describe the agent, never tell it to rewrite itself or to obey what arrives from outside`); return 1; };
const TAG = { soul: "soul", user: "soul-user", identity: "identity" };
const NOUN = { soul: "soul", user: "user notes", identity: "identity" };
const current = (s, section) => (section === "user" ? s.user : section === "identity" ? s.self : s.soul);
const live = (core) => soulState(chainedOnly(core.inForce(core.agentEvents())).rows);
/** Write one section: screened, then held if this session read outside content, else recorded with where it came from. */
export function setSection(core, section, text, { decides, reverts, force } = {}) {
  if (!text) { console.error(usage); return 1; }
  const why = soulScreen(text, core.instructionLike); if (why.length) return refuse(why);
  const taint = force ? [] : taintOf(core.episode());
  if (taint.length) {
    const r = core.appendEvent({ cause: "soul-held", effect: core.slug(text).slice(0, 60), note: text, tags: ["soul-proposal"], scope: "agent", fields: { proposal: { section, held: taint.map((x) => `${x} in this session`), session: core.session() } } });
    if (!r.written) { console.error(`memory-pulse soul: not recorded (${r.reason})`); return 1; }
    console.log(`${NOUN[section]} change held (t${r.t}): this session read outside content (${taint.join(", ")}). Confirm it from a clean session with memory-pulse soul confirm ${r.t}, or let the owner approve it.`);
    return 0;
  }
  const prev = current(live(core), section);
  if (prev && String(prev.note).trim() === String(text).trim()) { console.log(`${NOUN[section]} unchanged: that is already the current version (t${prev.t})`); return 0; }
  const provenance = { session: core.session(), date: new Date().toISOString().slice(0, 10), previous: prev?.t ?? null, ...(reverts ? { reverts } : {}) };
  const r = core.appendEvent({ cause: `${section === "user" ? "user-notes" : section}-set`, effect: `${core.slug(text).slice(0, 48)}-after-t${prev?.t ?? 0}`, note: text, tags: [TAG[section]], pinned: true, scope: "agent", owner: SOUL_WRITE,
                               fields: { provenance, ...(decides ? { decides } : {}) } });
  if (!r.written) { console.error(`memory-pulse soul: ${NOUN[section]} not recorded (${r.reason})`); return 1; }
  console.log(`${NOUN[section]} recorded on the agent ledger (t${r.t}); every brief now starts with it`); return 0;
}
export function cliUser(argv, core) {
  const args = argv.filter((a) => !a.startsWith("--"));
  if (args[0] === "propose") return propose(core, "user", args.slice(1).join(" ").trim());
  const text = args.join(" ").trim();
  if (!text) { const s = live(core); console.log(s.user ? `user: ${s.user.note} (agent t${s.user.t})` : 'no notes about the user yet: memory-pulse user "<who the human is>"'); return 0; }
  return setSection(core, "user", text);
}
function propose(core, section, text) {
  if (!text) { console.error(usage); return 1; }
  const why = soulScreen(text, core.instructionLike); if (why.length) return refuse(why);
  const r = core.appendEvent({ cause: "soul-proposed", effect: core.slug(text).slice(0, 60), note: text, tags: ["soul-proposal"], scope: "agent", fields: { proposal: { section, session: core.session() } } });
  if (!r.written) { console.error(`memory-pulse soul: proposal not recorded (${r.reason})`); return 1; }
  console.log(`proposed (t${r.t}); memory-pulse soul approve ${r.t} applies it, memory-pulse soul reject ${r.t} drops it`); return 0;
}
function decide(core, verb, t) {
  const s = live(core), p = s.proposals.find((x) => x.t === Number(t));
  if (!p) { console.error(`memory-pulse soul: no open change t${t}`); return 1; }
  if (verb === "reject") { const r = core.appendEvent({ cause: "soul-rejected", effect: `t${p.t}`, tags: ["soul-decision"], scope: "agent", owner: SOUL_WRITE, fields: { decides: p.t } }); console.log(r.written ? `rejected t${p.t}` : `not recorded (${r.reason})`); return r.written ? 0 : 1; }
  const taint = taintOf(core.episode());
  if (taint.length) { console.error(`memory-pulse soul: not from this session: it read outside content too (${taint.join(", ")}). Confirm t${p.t} from a session that did not.`); return 1; }
  if (Array.isArray(p.proposal?.held) && p.proposal.held.length && p.proposal?.session && core.session() && p.proposal.session === core.session()) { console.error(`memory-pulse soul: t${p.t} was held in this same session; confirm it from another one.`); return 1; }
  const why = soulScreen(p.note, core.instructionLike); if (why.length) return refuse(why);
  return setSection(core, ["soul", "user", "identity"].includes(p.proposal?.section) ? p.proposal.section : "soul", p.note, { decides: p.t, force: true });
}
function history(core, section) {
  const rows = chainedOnly(core.inForce(core.agentEvents())).rows.filter((e) => Array.isArray(e.tags) && e.tags.includes(TAG[section]));
  if (!rows.length) { console.log(`no ${NOUN[section]} recorded yet`); return 0; }
  for (const e of rows) console.log(`  t${e.t}  ${e.provenance?.date ?? "?"}  ${e.provenance?.session ? `session ${String(e.provenance.session).slice(0, 12)}` : "terminal"}${e.provenance?.reverts ? `  (reverts to t${e.provenance.reverts})` : ""}  ${clip(e.note, 140)}`);
  return 0;
}
function revert(core, t) {
  const e = chainedOnly(core.inForce(core.agentEvents())).rows.find((x) => x.t === Number(t) && Array.isArray(x.tags) && ["soul", "soul-user", "identity"].some((g) => x.tags.includes(g)));
  if (!e) { console.error(`memory-pulse soul: no soul, user or identity version t${t}`); return 1; }
  const section = e.tags.includes("soul-user") ? "user" : e.tags.includes("identity") ? "identity" : "soul";
  return setSection(core, section, e.note, { reverts: e.t });
}
export function cliSoul(argv, core) {
  const args = argv.filter((a) => !a.startsWith("--")), flags = new Set(argv.filter((a) => a.startsWith("--")));
  const verb = args[0];
  if (!verb) {
    if (!core.soulMode()) console.log("soul mode is off: memory-pulse mode soul prints this first in every brief");
    const block = core.identityBlock(); console.log(block || 'no soul yet: memory-pulse soul "<persona, voice, values>"'); return 0;
  }
  if (verb === "propose") return propose(core, "soul", args.slice(1).join(" ").trim());
  if (verb === "approve" || verb === "confirm" || verb === "reject") return decide(core, verb, args[1]);
  if (verb === "history") return history(core, flags.has("--user") ? "user" : flags.has("--identity") ? "identity" : "soul");
  if (verb === "capsule") {
    const oi = argv.indexOf("--out"), out = oi >= 0 && argv[oi + 1] ? resolve(argv[oi + 1]) : core.capsulePath();
    const cap = core.capsuleNow(); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(cap, null, 2) + "\n");
    console.log(`soul capsule ${cap.digest.slice(0, 12)} → ${out} (agent ledger ${String(cap.ledger.fingerprint ?? "none").slice(0, 16)}, ${cap.ledger.rows} rows)`); return 0;
  }
  if (verb === "verify" || verb === "resume") {
    const file = args[1]; if (!file) { console.error(usage); return 1; }
    let cap; try { cap = JSON.parse(readFileSync(resolve(file), "utf8")); } catch (e) { console.error(`memory-pulse soul ${verb}: cannot read ${file} (${String(e?.message ?? e).split("\n")[0]})`); return 2; }
    const v = verifySoulCapsule(cap); if (!v.ok) { console.error(`memory-pulse soul ${verb}: refused, ${v.why}`); return 2; }
    const here = core.ledgerFingerprint();
    const rel = !here ? "no agent ledger here" : here === cap.ledger?.fingerprint ? "it matches the agent ledger here" : "it is older than the agent ledger here (or from another one)";
    if (verb === "verify") { console.log(`soul capsule ${cap.digest.slice(0, 12)}: digest holds; issued ${cap.issued}; ${rel.replace(/^it /, "")}`); return 0; }
    const name = String(cap.agent?.self?.text ?? "unnamed agent").split(/[;.,\n]/)[0].trim();
    console.log(`SOUL — ${name} (resumed from capsule ${cap.digest.slice(0, 12)}, issued ${String(cap.issued).slice(0, 10)}; agent ledger ${String(cap.ledger?.fingerprint ?? "none").slice(0, 16)}; ${rel})`);
    for (const l of capsuleLines(cap, { instructionLike: core.instructionLike, held: "[held back: reads like an instruction]" })) console.log(l);
    return 0;
  }
  if (verb === "revert") return revert(core, args[1]);
  if (verb === "import" || verb === "export") {
    if (!flags.has("--openclaw")) { console.error(usage); return 1; }
    const dirArg = args[1]; const dir = dirArg ? (isAbsolute(dirArg) ? dirArg : resolve(dirArg)) : DEFAULT_WS();
    return verb === "import" ? importOpenClaw(core, dir) : exportOpenClaw(core, dir, flags.has("--force"));
  }
  if (["help", "-h"].includes(verb)) { console.log(usage); return 0; }
  return setSection(core, "soul", args.join(" ").trim());
}
function importOpenClaw(core, dir) {
  if (!existsSync(dir)) { console.error(`memory-pulse soul: no OpenClaw workspace at ${dir}`); return 1; }
  const ws = readOpenClaw(dir, (t) => soulScreen(t, core.instructionLike));
  let n = 0; const add = (r) => { if (r?.written) n++; };
  const quiet = (section, text) => { const log = console.log; let code; console.log = () => {}; try { code = setSection(core, section, text); } finally { console.log = log; } return { written: code === 0 }; };
  if (ws.soul) add(quiet("soul", ws.soul));
  if (ws.user) add(quiet("user", ws.user));
  if (ws.identity) add(quiet("identity", ws.identity));
  for (const m of ws.memory) add(core.appendEvent({ cause: "memory", effect: core.slug(m).slice(0, 60), note: m, tags: ["memory", "openclaw"], scope: "agent" }));
  for (const j of ws.journal) add(core.appendEvent({ cause: "journal", effect: `${j.date}-openclaw`, note: j.text, tags: ["journal", "openclaw"], scope: "agent", owner: SOUL_WRITE, fields: { journal: { date: j.date, project: "openclaw" } } }));
  console.log(`memory-pulse soul import: ${n} row(s) from ${dir} (soul ${ws.soul ? "yes" : "no"}, identity ${ws.identity ? "yes" : "no"}, user ${ws.user ? "yes" : "no"}, ${ws.memory.length} memory item(s), ${ws.journal.length} day(s))`);
  for (const s of ws.skipped) console.log(`  ${s.file} (${s.why}, not read)`);
  if (ws.withheld.length) { console.log(`withheld ${ws.withheld.length} line(s) that read like an instruction to the agent:`); for (const w of ws.withheld) console.log(`  ${w.file}:${w.line} (${w.why.join(", ")}) "${w.text}"`); }
  return 0;
}
function exportOpenClaw(core, dir, force) {
  const realDir = realish(dir);
  if (core.agentDir && (fold(realDir) === fold(realish(core.agentDir)) || fold(realDir).startsWith(fold(realish(core.agentDir)) + "/"))) { console.error("memory-pulse soul export: not into the agent ledger's own folder"); return 1; }
  const state = live(core), files = renderOpenClaw(state);
  const prior = state.exported?.export && realish(state.exported.export.dir) === realDir ? state.exported.export.files : {};
  const irregular = [], conflicts = [];
  for (const name of Object.keys(files)) {
    const p = join(dir, name); let st = null; try { st = lstatSync(p); } catch { continue; }
    if (!st.isFile()) { irregular.push(name); continue; }
    const cur = readRegular(p); if (!cur.buf || (sha(cur.buf) !== prior[name] && cur.buf.toString("utf8") !== files[name])) conflicts.push(name);
  }
  if (irregular.length) { console.error(`memory-pulse soul export: ${irregular.join(", ")} in ${dir} ${irregular.length === 1 ? "is" : "are"} not a regular file (a link, a folder or a device); nothing written`); return 1; }
  if (conflicts.length && !force) { console.error(`memory-pulse soul export: ${conflicts.join(", ")} in ${dir} were not written by memory-pulse; nothing written. --force keeps each as <name>.bak and writes the soul`); return 1; }
  mkdirSync(dir, { recursive: true });
  const kept = [];
  for (const name of conflicts) { let b = `${name}.bak`; for (let i = 1; existsSync(join(dir, b)); i++) b = `${name}.bak.${i}`; copyFileSync(join(dir, name), join(dir, b)); kept.push(b); }
  const digests = {}; for (const [name, text] of Object.entries(files)) { writeFileSync(join(dir, name), text); digests[name] = sha(text); }
  const manifest = sha(realDir + "\n" + JSON.stringify(digests)).slice(0, 12);
  const r = core.appendEvent({ cause: "soul-exported", effect: `openclaw-${manifest}`, tags: ["soul-export"], scope: "agent", owner: SOUL_WRITE, fields: { export: { dir: realDir, files: digests } } });
  console.log(`memory-pulse soul export: ${Object.keys(files).join(", ")} → ${realDir}${kept.length ? ` (${kept.join(", ")} kept)` : ""}${r.written ? `; recorded at t${r.t}` : ""}`);
  return 0;
}

// ---- soul as state: the capsule (soul.rain). The whole soul in one small object that travels: a new machine, another host, a subagent
// resumes from it alone. A sha256 digest over the canonical rest shows any edit; it is a digest, not a signature (it does not say who).
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));
const item = (e, n) => (e ? { t: e.t, text: clip(e.note ?? e.effect, n) } : null);
/** Build the capsule from chained rows in force. `lessons`: the lesson bank ([{t, text}]); `fingerprint`: sha256 of the ledger's bytes. */
export function soulCapsule(events, { lessons = [], fingerprint = null, head = null, issued = new Date().toISOString() } = {}) {
  const s = soulState(events);
  const dates = [...new Set(s.journal.map((j) => j.journal?.date).filter((d) => typeof d === "string"))].sort().slice(-3);
  const body = {
    schema: "memory-pulse.soul.v1", issued,
    agent: { self: item(s.self, 400), soul: item(s.soul, 1200), user: item(s.user, 800) },
    rules: tagged(events, "rule").slice(-20).map((e) => item(e, 300)),
    preferences: tagged(events, "preference").slice(-10).map((e) => item(e, 300)),
    lessons: lessons.slice(0, 10).map((l) => ({ t: l.t, text: clip(l.text, 300) })),
    memory: s.memory.slice(-8).map((e) => item(e, 300)),
    journal: s.journal.filter((j) => dates.includes(j.journal?.date)).slice(-6).map((j) => ({ t: j.t, date: j.journal.date, project: clip(j.journal.project ?? "", 40), text: clip(j.note, 200) })),
    open: s.proposals.slice(-5).map((p) => ({ t: p.t, section: p.proposal?.section ?? "soul", held: Array.isArray(p.proposal?.held) && p.proposal.held.length > 0, text: clip(p.note, 200) })),
    ledger: { fingerprint, head, rows: events.length },
  };
  return { ...body, digest: sha(canon(body)) };
}
export function verifySoulCapsule(cap) {
  if (!cap || typeof cap !== "object" || cap.schema !== "memory-pulse.soul.v1" || typeof cap.digest !== "string") return { ok: false, why: "not a soul capsule" };
  const { digest, ...rest } = cap;
  return sha(canon(rest)) === digest ? { ok: true } : { ok: false, why: "digest does not match: the capsule was edited after it was written" };
}
/** The soul block from a capsule alone; every text is screened again, as at render from the ledger. */
export function capsuleLines(cap, { instructionLike, held }) {
  const g = (label, x) => (x?.text ? (soulScreen(x.text, instructionLike).length ? `  ${held} (agent t${x.t})` : `  ${label}: ${x.text} (agent t${x.t})`) : null);
  const lines = [g("self", cap.agent?.self), g("soul", cap.agent?.soul), g("user", cap.agent?.user)].filter(Boolean);
  for (const [name, list] of [["rule", cap.rules], ["preference", cap.preferences], ["lesson", cap.lessons], ["memory", cap.memory]]) for (const x of Array.isArray(list) ? list : []) { const l = g(name, x); if (l) lines.push(`  ${l.trim()}`); }
  for (const j of Array.isArray(cap.journal) ? cap.journal : []) { const l = g(`${j.date} ${j.project}`, j); if (l) lines.push(`  ${l.trim()}`); }
  return lines;
}
/** What changed between the capsule the last brief wrote and the one this brief writes. */
export function continuityLine(prev, next) {
  if (!prev) return `  continuity: first brief with this soul (capsule ${next.digest.slice(0, 12)})`;
  const changed = [];
  for (const [k, noun] of [["self", "identity"], ["soul", "soul"], ["user", "user notes"]]) if ((prev.agent?.[k]?.t ?? null) !== (next.agent?.[k]?.t ?? null)) changed.push(`${noun} changed (t${next.agent?.[k]?.t ?? "-"})`);
  const added = (k, one, many) => { const was = new Set((prev[k] ?? []).map((x) => x.t)); const n = (next[k] ?? []).filter((x) => !was.has(x.t)).length; if (n) changed.push(`+${n} ${n === 1 ? one : many}`); };
  added("lessons", "lesson", "lessons"); added("rules", "rule", "rules"); added("preferences", "preference", "preferences"); added("memory", "memory", "memories"); added("journal", "journal entry", "journal entries");
  const open = (next.open ?? []).length; if (open) changed.push(`${open} open change${open === 1 ? "" : "s"}`);
  return `  continuity: resumed from capsule ${String(prev.digest).slice(0, 12)} (${String(prev.issued).slice(0, 10)}); since then: ${changed.length ? changed.join(", ") : "nothing changed"} · capsule now ${next.digest.slice(0, 12)}`;
}
