// `memory-pulse adopt` (2026-10-21): guard the memory a user already keeps. It reads the corrections they have written down where
// their agents look (Claude Code's auto memory `feedback` notes for this folder, CLAUDE.md, CLAUDE.local.md, AGENTS.md, .claude/rules,
// .cursor/rules, .github/copilot-instructions.md), runs each line through the same detectors the observe hook uses, and shows what it
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
  return out;
}

/** Candidate corrections, one per withdrawn term, skipping instruction-like lines, code blocks and terms the ledger already enforces. */
export function candidates(srcs, { detect, instructionLike, enforced = new Set() }) {
  const seen = new Set(enforced), out = [];
  for (const s of srcs) {
    let fence = false;
    s.text.split("\n").forEach((raw, i) => {
      if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
      const line = raw.replace(/^\s*(?:[-*+]|\d+[.)]|#+)\s+/, "").trim();
      if (fence || !line || instructionLike(line).length) return;
      // one sentence at a time: the detectors' terms can run past a full stop ("0.459. The"); a decimal point is not a full stop
      for (const sentence of line.split(/(?<=[.!?])\s+(?=[A-Z"'`(])/)) {
        const d = detect(sentence); if (!d) continue;
        const key = d.withdrawn[0].toLowerCase(); if (seen.has(key)) continue; seen.add(key);
        out.push({ withdrawn: d.withdrawn, replacement: d.replacement ?? [], cue: d.cue, kind: s.kind, source: s.path, line: s.offset + i + 1, quote: sentence.slice(0, 160) });
      }
    });
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
  const yes = argv.includes("--yes"), asJson = argv.includes("--json");
  const enforced = new Set(core.inForce(core.readEvents().events).filter((e) => e.kind === "correction" && Array.isArray(e.withdrawn)).flatMap((e) => e.withdrawn.map((t) => String(t).toLowerCase())));
  const srcs = sources();
  const found = candidates(srcs, { detect: (l) => core.detectCorrection(l) ?? core.detectProhibition(l), instructionLike: core.instructionLike, enforced });
  let written = 0;
  if (yes) for (const c of found) { const r = core.appendEvent(adoptEvent(c)); if (r.written) written++; }
  if (asJson) { console.log(JSON.stringify({ sources: srcs.map((s) => ({ kind: s.kind, path: s.path })), candidates: found, written }, null, 2)); return 0; }
  const show = (p) => (p.startsWith(process.cwd()) ? relative(process.cwd(), p) : p.replace(homedir(), "~"));
  console.log(`memory-pulse adopt: read ${srcs.length} source${srcs.length === 1 ? "" : "s"} (Claude Code feedback memories for this folder, CLAUDE.md, AGENTS.md, rules files)`);
  if (!found.length) { console.log("no new corrections to enforce (every one found is already on the ledger, or none reads as a correction)"); return 0; }
  for (const c of found) console.log(`  "${c.withdrawn[0]}"${c.replacement[0] ? ` -> "${c.replacement[0]}"` : " (prohibited)"}   ${show(c.source)}:${c.line}  "${c.quote}"`);
  console.log(yes ? `recorded ${written} correction${written === 1 ? "" : "s"}; the guard now blocks an edit that brings a withdrawn term back`
    : `nothing written: run \`memory-pulse adopt --yes\` to enforce these ${found.length} (the guard then blocks an edit that brings the old term back)`);
  return 0;
}
