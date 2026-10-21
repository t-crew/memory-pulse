// Per-prompt and per-edit slices of the memory (0.7.0): the rows that bear on what the agent is about to read or write,
// injected by the UserPromptSubmit and PreToolUse hooks. Plain code; server helpers arrive through `deps`.
import { correctionLine, terms } from "./scaffold.mjs";
import { rank as rankByWeight, retired as retiredByWeight, withhold } from "./weights.mjs";

const RUN = /[\p{L}\p{N}]+/gu;
const runs = (s) => (String(s).toLowerCase().match(RUN) ?? []);
// slug words too common to say a row bears on anything
const STOP = new Set(["corrected", "correction", "withdrawn", "replaced", "superseded", "measured", "changed", "event", "events", "this", "that", "with", "from", "into", "user", "agent", "memory", "pulse", "note",
  "what", "which", "where", "when", "does", "have", "there", "their", "about", "would", "could", "should", "still", "they", "them", "then", "than", "were", "been", "being", "your", "ours"]);
const slugWords = (e) => runs(`${e.cause ?? ""} ${e.effect ?? ""}`).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
// Rarity only matters for slug words the text actually contains, so document frequency is counted for those words alone:
// the candidates' words that are tokens of the text first, then one pass over the ledger's slugs for just that handful.
function slugIndex(allRows, candidates, tokens) {
  const words = new Map(), wanted = new Set();
  for (const e of candidates) { const ws = [...new Set(slugWords(e))].filter((w) => tokens.has(w)); words.set(e, ws); for (const w of ws) wanted.add(w); }
  const df = new Map([...wanted].map((w) => [w, 0]));
  if (wanted.size) for (const e of allRows) { for (const w of new Set(runs(`${e.cause ?? ""} ${e.effect ?? ""}`))) if (df.has(w)) df.set(w, df.get(w) + 1); }
  // score = sum of ln(max(N, 200) / df) over the matched words; the floor of 200 keeps a young ledger's words from all looking rare
  const base = Math.max(allRows.length, 200);
  return (e) => (words.get(e) ?? []).reduce((acc, w) => acc + Math.log(base / Math.max(1, df.get(w))), 0);
}
// a row bears on the text through its slug words alone when their summed rarity reaches this: one word in under ~0.25% of
// rows, or two in under ~5% each. Measured on the estate ledger 2026-10-12: casmi (17.5% of rows) + read (10.6%) scores 4.0.
const SLUG_SCORE = 6;
const clip = (s, n = 160) => { const v = String(s ?? "").replace(/\s+/g, " ").trim(); return v.length > n ? v.slice(0, n - 1) + "…" : v; };
// a term bears on the text when every word-run of it is a token of the text (cheap set check) and the exact token rule agrees;
// a substring of the lowercased text is necessary for a token match and native indexOf is far cheaper than splitting the term
// (on short text only: over a 100 KB pasted prompt, ten thousand indexOf scans cost more than the word split they save)
const termHit = (term, tokens, texts, containsTerm, lowerHay) => { if (lowerHay !== undefined && lowerHay.length < 4096 && !lowerHay.includes(String(term).toLowerCase())) return false; const r = runs(term); return r.length > 0 && r.every((x) => tokens.has(x)) && texts.some((t) => containsTerm(t, term)); };
// the overflow line names the command that shows every correction (`--section` renders a section without its budget)
const MORE = "memory-pulse scaffold --section corrections";
function fit(header, lines, max) {
  if (!lines.length) return "";
  const out = [header]; let used = header.length;
  for (let i = 0; i < lines.length; i++) {
    const left = lines.length - i - 1, more = left ? `  +${left} more — ${MORE}` : "";
    if (used + 1 + lines[i].length + (left ? more.length + 1 : 0) > max) { out.push(`  +${lines.length - i} more — ${MORE}`); break; }
    out.push(lines[i]); used += 1 + lines[i].length;
  }
  return out.join("\n");
}
// one source = one ledger: its own in-force view, its own superseded set, its own rarity counts, its own citation prefix
const sourcesOf = (primary, agent) => [{ rows: primary ?? [], cite: "" }, { rows: agent ?? [], cite: "agent " }].filter((s) => s.rows.length);

/** promptSlice(allEvents, prompt, { max, blocks, agentEvents, deps }) -> string ("" when nothing bears on the prompt) */
export function promptSlice(allEvents, prompt, { max = 1200, blocks = [], agentEvents = [], weights = new Map(), picked = null, withheld = null, holdout = 0, holdoutKey = "", deps } = {}) {
  const { inForce, supersededSet, instructionLike, containsTerm, held } = deps;
  if (typeof prompt !== "string" || !prompt.trim()) return "";
  const tokens = new Set(runs(prompt)); const lowerHay = prompt.toLowerCase();
  const blockCount = new Map(); for (const b of blocks) for (const h of b.hits ?? []) blockCount.set(Number(h.t), (blockCount.get(Number(h.t)) ?? 0) + 1);
  const guard = (line, cite) => (instructionLike(line).length ? `  ${held} (${cite})` : line);
  const scored = [];
  for (const { rows, cite } of sourcesOf(allEvents, agentEvents)) {
    const events = inForce(rows), retired = supersededSet(events);
    const isCorr = (e) => e.kind === "correction" && terms(e.withdrawn).length && !retired.has(e.t);
    // decisions, state and captured fixes (2026-10-21); a memory retired by its weight is left out (lib/weights.mjs)
    const isDecision = (e) => e.kind !== "correction" && Array.isArray(e.tags) && e.tags.some((x) => x === "decision" || x === "state" || x === "fix");
    const candidates = events.filter((e) => (isCorr(e) || isDecision(e)) && !(cite === "" && retiredByWeight(e, weights.get(e.t))));
    const rareHits = slugIndex(events, candidates, tokens);
    for (const e of candidates) {
      const corrRow = isCorr(e);
      const ts = corrRow ? [...terms(e.withdrawn), ...terms(e.replacement)] : [];
      const termHits = ts.filter((t) => termHit(t, tokens, [prompt], containsTerm, lowerHay)).length, slug = rareHits(e);
      if (!termHits && slug < SLUG_SCORE) continue;
      const n = cite ? 0 : blockCount.get(e.t) ?? 0;
      const line = corrRow ? correctionLine(e, { cite, blocked: n }) : `  ${clip(e.note ?? `${e.cause} -> ${e.effect}`)} (${cite}t${e.t})`;
      scored.push({ t: e.t, hits: termHits + slug, n, own: cite === "", corr: corrRow, line: guard(line, `${cite}t${e.t}`) });
    }
  }
  // blocked corrections first; then relevance mixed with learned utility (only this project's rows carry weights)
  const blockedFirst = [...new Set(scored.map((s) => s.n))].sort((a, b) => b - a);
  const ordered = blockedFirst.flatMap((n) => rankByWeight(scored.filter((s) => s.n === n), weights));
  const header = "memory-pulse: recorded corrections and decisions that bear on this prompt:";
  const shownOf = (text) => (text ? text.split("\n").length - 1 - (/\n\s*\+\d+ more/.test(text) ? 1 : 0) : 0);
  // randomized withholding (2026-10-21): an own memory that would be shown, other than a correction, sits out the session (holdoutKey is
  // the session) at rate `holdout` and is
  // reported in `withheld`, so the next check outcome credits its withheld arm (lib/weights.mjs); what fills the freed space is shown as usual
  // Both arms use one definition of "would have been shown": in the slice with every OTHER sitting-out memory left out. A memory that
  // fills a slot another one freed is then recorded whichever way its own draw goes (recording a sat-out memory only if it was in the
  // original top slots read +0.09 to +0.14 in the placebo replay, growing with the rate).
  let list = ordered;
  if (holdout > 0) {
    const out0 = new Set(ordered.filter((s) => s.own && !s.corr && withhold(`${holdoutKey}|${s.t}`, holdout)).map((s) => s.t));
    if (out0.size) {
      const without = (keep) => ordered.filter((s) => !(s.own && out0.has(s.t) && s.t !== keep));
      list = without(null);
      if (withheld) for (const t of out0) { const l = without(t); if (l.slice(0, shownOf(fit(header, l.map((s) => s.line), max))).some((s) => s.own && s.t === t)) withheld.push(t); }
    }
  }
  const out = fit(header, list.map((s) => s.line), max);
  if (picked && out) for (const s of list.slice(0, shownOf(out))) if (s.own) picked.push(s.t);
  return out;
}

/** editSlice(rows, invariants, { path, text }, { max, agentRows, deps }) -> string ("" when nothing bears on the edit) */
export function editSlice(rows, invariants, { path = "", text = "" } = {}, { max = 600, agentRows = [], deps } = {}) {
  const { supersededSet, instructionLike, containsTerm, held } = deps;
  const guard = (line, cite) => (instructionLike(line).length ? `  ${held} (${cite})` : line);
  const tokens = new Set([...runs(text), ...runs(path)]); const lowerHay = `${text}\n${path}`.toLowerCase();
  const lines = [];
  for (const { rows: src, cite } of sourcesOf(rows, agentRows)) {
    const retired = supersededSet(src);
    const candidates = src.filter((e) => e.kind === "correction" && terms(e.withdrawn).length && !retired.has(e.t));
    const rareHits = slugIndex(src, candidates, tokens);
    for (const e of candidates) {
      const ts = [...terms(e.withdrawn), ...terms(e.replacement)];
      if (ts.some((t) => termHit(t, tokens, [text, path], containsTerm, lowerHay)) || rareHits(e) >= SLUG_SCORE) lines.push({ t: e.t, line: guard(correctionLine(e, { cite }), `${cite}t${e.t}`) });
    }
  }
  lines.sort((a, b) => b.t - a.t);
  // only invariants scoped to a path prefix are injected: an unscoped one would ride along on every edit
  for (const inv of invariants ?? []) {
    const scope = Array.isArray(inv?.paths) ? inv.paths.filter((p) => typeof p === "string" && p) : [];
    if (!scope.length || !scope.some((p) => path.startsWith(p))) continue;
    const st = inv.statement && !instructionLike(inv.statement).length ? `: ${clip(inv.statement, 120)}` : "";
    lines.push({ t: -1, line: `  invariant ${inv.id}${st}` });
  }
  return fit(`memory-pulse: recorded corrections and rules that bear on ${path || "this edit"}:`, lines.map((x) => x.line), max);
}
