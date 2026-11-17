// Drift check (0.17.0): the rows that bear on what you are about to do, with the ones that record a closed or failed
// direction marked. Local, no engine, no model. It exists because `before` passed in silence when the engine was away:
// the exact rung fires only on a withdrawn term, and a direction that was tried and closed is rarely recorded as one.
// Tests: test/drift.test.js.
import { content } from "./recall.mjs";

// a whole word that records an ending; "skills" and "disclosed" are not one
const CLOSURE = /(?<![\p{L}\p{N}])(kill(?:ed|s)?|closed?|rejected|shelved|falsified|refuted|abandoned|withdrawn|retracted|reverted|dropped|drop|failure|failed|dead[ -]end|no gain|not useful|not adopted|inconclusive|stop building)(?![\p{L}\p{N}])/iu;
const CANON = { killed: "kill", kills: "kill", close: "closed", dropped: "drop", failed: "failure", "dead-end": "dead end" };

/** The word in a text that records a closed or failed direction, lower-cased and folded; null when there is none. */
export function closureOf(text) {
  const m = CLOSURE.exec(String(text ?? "")); if (!m) return null;
  const w = m[1].toLowerCase().replace(/\s+/g, " "); return CANON[w] ?? w;
}

const textOf = (r) => [r?.cause, r?.effect, r?.note].filter((x) => typeof x === "string" && x).join(". ");
const sentences = (text) => String(text).split(/(?<=[.;!?])\s+|\n+/).filter(Boolean);

/**
 * [{ row, closed, cover, passage }] best first, at most k: the rows that bear on the operation.
 *
 * A ledger row can be a page long, and a page shares a few words with anything, so the match is made on one SENTENCE of a row,
 * never on the row as a bag. Each of the operation's content words is weighed by how rare it is among the rows (BM25's idf; a
 * word no row carries weighs the most). A sentence bears on the operation when the words it shares carry at least `floor` of
 * that weight and there are two or more of them. So "propose", "new" and the project's own name count for little, the words
 * that name the idea decide, and an idea whose words the ledger has never seen matches nothing, which is what new means.
 * The row is marked closed when that sentence, or the one after it, carries a closing word. Ties go to the newer row.
 */
export function drift(rows, operation, { k = 5, floor = 0.35 } = {}) {
  const docs = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === "object" && Number.isInteger(r.t))
    .map((r) => { const sents = sentences(textOf(r)).map((text) => ({ text, words: new Set(content(text)) })); return { row: r, sents, words: new Set(sents.flatMap((x) => [...x.words])) }; })
    .filter((d) => d.words.size);
  const q = content(operation), N = docs.length;
  if (q.length < 2 || !N) return [];
  const idf = new Map(q.map((t) => { let n = 0; for (const d of docs) if (d.words.has(t)) n++; return [t, Math.log(1 + (N - n + 0.5) / (n + 0.5))]; }));
  const total = q.reduce((a, t) => a + idf.get(t), 0);
  const out = [];
  for (const d of docs) {
    if (!q.some((t) => d.words.has(t))) continue;
    let best = null;
    d.sents.forEach((x, i) => {
      let w = 0, hits = 0; for (const t of q) if (x.words.has(t)) { w += idf.get(t); hits++; }
      const cover = w / total; if (hits >= 2 && cover >= floor && (!best || cover > best.cover)) best = { cover, i };
    });
    if (best) out.push({ row: d.row, cover: best.cover, passage: d.sents[best.i].text, closed: closureOf(d.sents[best.i].text) ?? closureOf(d.sents[best.i + 1]?.text ?? "") });
  }
  return out.sort((a, b) => b.cover - a.cover || b.row.t - a.row.t).slice(0, k);
}
