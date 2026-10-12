// Per-prompt and per-edit slices of the memory (0.7.0): the rows that bear on what the agent is about to read or write,
// injected by the UserPromptSubmit and PreToolUse hooks. Plain code; server helpers arrive through `deps`.

const RUN = /[\p{L}\p{N}]+/gu;
const runs = (s) => (String(s).toLowerCase().match(RUN) ?? []);
// slug words too common to say a row bears on anything
const STOP = new Set(["corrected", "correction", "withdrawn", "replaced", "superseded", "measured", "changed", "event", "events", "this", "that", "with", "from", "into", "user", "agent", "memory", "pulse", "note",
  "what", "which", "where", "when", "does", "have", "there", "their", "about", "would", "could", "should", "still", "they", "them", "then", "than", "were", "been", "being", "your", "ours", "this"]);
const slugWords = (e) => runs(`${e.cause ?? ""} ${e.effect ?? ""}`).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
// a slug word says a row bears on the text only when it is rare in this ledger: at most 2% of rows (or 3, for small ledgers)
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

function correctionLine(e, blocked = 0) {
  const w = e.withdrawn.map((x) => `"${x}"`).join(", "), r = (e.replacement ?? []).join(" / ");
  return `  ${w} ${e.withdrawn.length > 1 ? "were" : "was"} withdrawn${r ? `; use ${r}` : ""} (t${e.t}${blocked ? `; blocked ${blocked} time${blocked === 1 ? "" : "s"}` : ""})`;
}
// a term bears on the text when every word-run of it is a token of the text (cheap set check) and the exact token rule agrees
// a substring of the lowercased text is necessary for a token match, and native indexOf is far cheaper than splitting the term
// (on short text only: over a 100 KB pasted prompt, ten thousand indexOf scans cost more than the word split they save)
const termHit = (term, tokens, texts, containsTerm, lowerHay) => { if (lowerHay !== undefined && lowerHay.length < 4096 && !lowerHay.includes(String(term).toLowerCase())) return false; const r = runs(term); return r.length > 0 && r.every((x) => tokens.has(x)) && texts.some((t) => containsTerm(t, term)); };
function fit(header, lines, max) {
  if (!lines.length) return "";
  const out = [header]; let used = header.length;
  for (let i = 0; i < lines.length; i++) {
    const left = lines.length - i - 1, more = left ? `  +${left} more — memory-pulse scaffold` : "";
    if (used + 1 + lines[i].length + (left ? more.length + 1 : 0) > max) { out.push(`  +${lines.length - i} more — memory-pulse scaffold`); break; }
    out.push(lines[i]); used += 1 + lines[i].length;
  }
  return out.join("\n");
}

/** promptSlice(allEvents, prompt, { max, blocks, deps }) -> string ("" when nothing bears on the prompt) */
export function promptSlice(allEvents, prompt, { max = 1200, blocks = [], deps } = {}) {
  const { inForce, supersededSet, instructionLike, containsTerm, held } = deps;
  if (typeof prompt !== "string" || !prompt.trim() || !allEvents?.length) return "";
  const events = inForce(allEvents), retired = supersededSet(events);
  const tokens = new Set(runs(prompt)); const lowerHay = prompt.toLowerCase();
  const blockCount = new Map(); for (const b of blocks) for (const h of b.hits ?? []) blockCount.set(Number(h.t), (blockCount.get(Number(h.t)) ?? 0) + 1);
  const isCorr = (e) => e.kind === "correction" && Array.isArray(e.withdrawn) && e.withdrawn.length && !retired.has(e.t);
  const isDecision = (e) => e.kind !== "correction" && Array.isArray(e.tags) && e.tags.some((x) => x === "decision" || x === "state");
  const candidates = events.filter((e) => isCorr(e) || isDecision(e));
  const rareHits = slugIndex(events, candidates, tokens);
  const scored = [];
  for (const e of candidates) {
    const corrRow = isCorr(e);
    const terms = corrRow ? [...e.withdrawn, ...(e.replacement ?? [])] : [];
    const termHits = terms.filter((t) => termHit(t, tokens, [prompt], containsTerm, lowerHay)).length, slug = rareHits(e);
    const hits = termHits + slug, n = blockCount.get(e.t) ?? 0;
    if (!termHits && slug < SLUG_SCORE) continue;
    scored.push({ e, hits, n, line: corrRow ? correctionLine(e, n) : `  ${instructionLike(e.note ?? "").length ? held : clip(e.note ?? `${e.cause} -> ${e.effect}`)} (t${e.t})` });
  }
  scored.sort((a, b) => b.n - a.n || b.hits - a.hits || b.e.t - a.e.t);
  return fit("memory-pulse: recorded corrections and decisions that bear on this prompt:", scored.map((s) => s.line), max);
}

/** editSlice(rows, invariants, { path, text }, { max, deps }) -> string ("" when nothing bears on the edit) */
export function editSlice(rows, invariants, { path = "", text = "" } = {}, { max = 600, deps } = {}) {
  const { supersededSet, instructionLike, containsTerm } = deps;
  if (!rows?.length && !invariants?.length) return "";
  const retired = supersededSet(rows ?? []);
  const tokens = new Set([...runs(text), ...runs(path)]); const lowerHay = `${text}\n${path}`.toLowerCase();
  const candidates = (rows ?? []).filter((e) => e.kind === "correction" && Array.isArray(e.withdrawn) && e.withdrawn.length && !retired.has(e.t));
  const rareHits = slugIndex(rows ?? [], candidates, tokens);
  const lines = [];
  for (const e of candidates) {
    const terms = [...e.withdrawn, ...(e.replacement ?? [])];
    if (terms.some((t) => termHit(t, tokens, [text, path], containsTerm, lowerHay)) || rareHits(e) >= SLUG_SCORE) lines.push({ t: e.t, line: correctionLine(e) });
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
