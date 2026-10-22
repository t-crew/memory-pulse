// `memory-pulse adopt` (2026-10-21): guard the memory a user already keeps. It reads the corrections they have written down where
// their agents look (Claude Code's auto memory `feedback` notes for this folder, CLAUDE.md, CLAUDE.local.md, AGENTS.md, .claude/rules,
// .cursor/rules, .github/copilot-instructions.md, and Muse Code's .agents/AGENTS.md and .agents/memory topic files), runs each line through the same detectors the observe hook uses, and shows what it
// would enforce. With --yes each becomes a correction on the ledger (tagged adopted, with its source), so the guard blocks an edit
// that brings the old term back. Nothing is written without --yes; instruction-like lines and terms already enforced are skipped.
// A `user` memory (a fact about the person) is never adopted, only `feedback`. Tests: test/adopt.test.js.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const RULE_FILES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".github/copilot-instructions.md"];
const RULE_DIRS = [[".claude/rules", /\.md$/], [".cursor/rules", /\.(md|mdc)$/]];

/** Claude Code keeps a folder's auto memory under ~/.claude/projects/<the path with every non-alphanumeric character as "-">/memory */
export const claudeMemoryDir = (cwd = process.cwd()) => join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), "memory");

function frontmatter(text) {
  if (!text.startsWith("---")) return { type: null, body: text, offset: 0 };
  const end = text.indexOf("\n---", 3); if (end < 0) return { type: null, body: text, offset: 0 };
  const fm = text.slice(3, end), rest = text.slice(text.indexOf("\n", end + 1) + 1);
  return { type: (/^\s*type:\s*([\w-]+)/m.exec(fm) ?? [])[1] ?? null, body: rest, offset: text.slice(0, text.length - rest.length).split("\n").length - 1 };
}

export function sources(cwd = process.cwd()) {
  const out = [], mem = claudeMemoryDir(cwd);
  if (existsSync(mem)) for (const f of readdirSync(mem).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").sort()) {
    const fm = frontmatter(readFileSync(join(mem, f), "utf8"));
    if (fm.type === "feedback") out.push({ kind: "claude-memory", path: join(mem, f), text: fm.body, offset: fm.offset });
  }
  for (const rel of RULE_FILES) { const p = join(cwd, rel); if (existsSync(p) && statSync(p).isFile()) out.push({ kind: rel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-md$/, ""), path: p, text: readFileSync(p, "utf8"), offset: 0 }); }
  for (const [rel, re] of RULE_DIRS) { const d = join(cwd, rel); if (existsSync(d)) for (const f of readdirSync(d).filter((f) => re.test(f)).sort()) out.push({ kind: rel.replace(/^\./, "").replace(/\//g, "-"), path: join(d, f), text: readFileSync(join(d, f), "utf8"), offset: 0 }); }
  // Muse Code (2026-10-22): .agents/AGENTS.md is an instruction file; .agents/memory/ is committed project memory, a MEMORY.md index
  // (skipped, as for Claude Code: it repeats the topic files in one line each) plus topic files. Their format names no note types, so
  // every topic file is read, except one that says `type: user` (a fact about the person, never adopted).
  const agents = join(cwd, ".agents", "AGENTS.md");
  if (existsSync(agents) && statSync(agents).isFile()) out.push({ kind: "muse-agents", path: agents, text: readFileSync(agents, "utf8"), offset: 0 });
  const muse = join(cwd, ".agents", "memory");
  if (existsSync(muse)) for (const f of readdirSync(muse).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").sort()) {
    const fm = frontmatter(readFileSync(join(muse, f), "utf8"));
    if (fm.type !== "user") out.push({ kind: "muse-memory", path: join(muse, f), text: fm.body, offset: fm.offset });
  }
  return out;
}

// Files are prose, not prompts: measured on Travis's own memory and CLAUDE.md (2026-10-21), the prompt detectors read pipeline arrows,
// descriptive "No ..." sentences and measured changes ("14 -> 22") as corrections, 13 of 16 wrong. In a file a correction must be an
// instruction: no arrows, a ban only in imperative form, a rename only as an imperative, no term under 3 characters or ending in a
// function word (a fragment such as "hue roughly").
const IMPERATIVE_BAN = /^\s*(?:never|don't|do not|avoid|stop)\b/i;
const IMPERATIVE_CHANGE = /^\s*(?:change|rename|replace|update|switch|correct)\b/i;
const FRAGMENT_END = /\b(?:a|an|the|of|to|in|on|at|for|by|with|from|around|roughly|about|and|or|as)$/i;
export function documentWorthy(d, sentence) {
  const w = String(d.withdrawn[0] ?? "").trim();
  if (d.cue === "arrow" || /→|->|=>/.test(sentence)) return false;
  if (String(d.cue).startsWith("prohibit") && !IMPERATIVE_BAN.test(sentence)) return false;
  if (d.cue === "change-to" && !IMPERATIVE_CHANGE.test(sentence)) return false;
  return w.length >= 3 && !FRAGMENT_END.test(w) && !PRONOUN_START.test(w);
}
const PRONOUN_START = /^(?:its|it|their|his|her|my|our|your|this|that|these|those)\b/i;

// Lines are joined into units first: a bullet or a heading starts one, a blank line or a fence ends one, and a wrapped line continues
// the unit above it (CLAUDE.md files are hard-wrapped). Each unit keeps the line it starts on.
function units(text) {
  const out = []; let cur = null, fence = false;
  text.split("\n").forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; cur = null; return; }
    if (fence) return;
    if (!raw.trim()) { cur = null; return; }
    const head = /^\s*(?:[-*+]|\d+[.)]|#+)\s+/.test(raw);
    const text1 = raw.replace(/^\s*(?:[-*+]|\d+[.)]|#+)\s+/, "").trim();
    if (head || !cur) { cur = { line: i + 1, text: text1 }; out.push(cur); } else cur.text += " " + text1;
  });
  return out;
}

// A single plain lowercase word of five letters or more ("requests", "react") reads as English, and the guard matches terms in prose
// too: adopting "Never use `requests` here" blocked "Handles incoming HTTP requests" (review 2026-10-21). Such a term is listed as not
// enforced; `memory-pulse remember --kind correction --withdrawn` still records it on purpose.
const PLAIN_WORD = /^[a-z]{5,}$/;
/** Candidate corrections, one per withdrawn term, skipping instruction-like lines, code blocks and terms the ledger already enforces.
 *  `skipped` (when given) receives the plain-word terms left out. */
export function candidates(srcs, { detect, instructionLike, enforced = new Set(), skipped = null }) {
  const seen = new Set(enforced), out = [];
  for (const s of srcs) {
    for (const u of units(s.text)) {
      const line = u.text, i = u.line - 1;
      if (!line || instructionLike(line).length) continue;
      // one sentence at a time: the detectors' terms can run past a full stop ("0.459. The"); a decimal point is not a full stop
      for (const sentence of line.split(/(?<=[.!?])\s+(?=[A-Z"'`(])/)) {
        const d = detect(sentence); if (!d || !documentWorthy(d, sentence)) continue;
        const key = d.withdrawn[0].toLowerCase(); if (seen.has(key)) continue; seen.add(key);
        if (PLAIN_WORD.test(String(d.withdrawn[0]).trim())) { skipped?.push({ withdrawn: d.withdrawn, replacement: d.replacement ?? [], reason: "a plain word: the guard would block it in ordinary prose", source: s.path, line: s.offset + i + 1, quote: sentence.slice(0, 160) }); continue; }
        out.push({ withdrawn: d.withdrawn, replacement: d.replacement ?? [], cue: d.cue, kind: s.kind, source: s.path, line: s.offset + i + 1, quote: sentence.slice(0, 160) });
      }
    }
  }
  return out;
}

export function adoptEvent(c, cwd = process.cwd()) {
  const w = c.withdrawn[0], r = c.replacement[0] ?? null, where = c.source.startsWith(cwd) ? relative(cwd, c.source) : c.source.replace(homedir(), "~");
  const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "term";
  return { cause: `adopted-correction-${slug(w)}`, effect: r ? `${slug(w)}-withdrawn-for-${slug(r)}` : `${slug(w)}-withdrawn`, kind: "correction",
           withdrawn: c.withdrawn, replacement: c.replacement, tags: ["adopted", c.kind, c.cue],
           note: `Adopted from ${where}:${c.line}: "${c.quote}"` };
}

export function cliAdopt(argv, core) {
  const asJson = argv.includes("--json"), pi = argv.indexOf("--pick");
  const pick = pi >= 0 ? new Set(String(argv[pi + 1] ?? "").split(",").map((n) => Number(n.trim())).filter((n) => Number.isInteger(n) && n > 0)) : null;
  const yes = argv.includes("--yes") || !!pick;
  const enforced = new Set(core.inForce(core.readEvents().events).filter((e) => e.kind === "correction" && Array.isArray(e.withdrawn)).flatMap((e) => e.withdrawn.map((t) => String(t).toLowerCase())));
  const srcs = sources();
  const skipped = [], found = candidates(srcs, { detect: (l) => core.detectCorrection(l) ?? core.detectProhibition(l), instructionLike: core.instructionLike, enforced, skipped });
  let written = 0;
  if (yes) found.forEach((c, i) => { if (pick && !pick.has(i + 1)) return; const r = core.appendEvent(adoptEvent(c)); if (r.written) written++; });
  if (asJson) { console.log(JSON.stringify({ sources: srcs.map((s) => ({ kind: s.kind, path: s.path })), candidates: found, skipped, written }, null, 2)); return 0; }
  const show = (p) => (p.startsWith(process.cwd()) ? relative(process.cwd(), p) : p.replace(homedir(), "~"));
  console.log(`memory-pulse adopt: read ${srcs.length} source${srcs.length === 1 ? "" : "s"} (Claude Code feedback memories for this folder, CLAUDE.md, AGENTS.md, rules files, Muse Code memory)`);
  for (const c of skipped) console.log(`  not enforced: "${c.withdrawn[0]}" is ${c.reason}   ${show(c.source)}:${c.line}`);
  if (!found.length) { console.log("no new corrections to enforce (every one found is already on the ledger, or none reads as a correction)"); return 0; }
  found.forEach((c, i) => console.log(`  ${i + 1}. "${c.withdrawn[0]}"${c.replacement[0] ? ` -> "${c.replacement[0]}"` : " (prohibited)"}   ${show(c.source)}:${c.line}  "${c.quote}"`));
  console.log(yes ? `recorded ${written} correction${written === 1 ? "" : "s"}; the guard now blocks an edit that brings a withdrawn term back`
    : `nothing written: \`memory-pulse adopt --yes\` enforces all ${found.length}, \`--pick 1,3\` only those (the guard then blocks an edit that brings the old term back)`);
  return 0;
}
