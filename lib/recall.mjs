// Recall (2026-10-21): BM25 over a small set of rows, with a floor, for soul mode's prompt recall of the agent's own lessons and memories.
// Chosen by a pre-registered known-item benchmark on 219 real memory notes (engine docs/plans/2026-10-21-soul-as-state.md): BM25 MRR
// 0.971 / 0.907 against 0.864 / 0.774 for word overlap. Plain code. Tests: test/soul-recall.test.js.
const STOP = new Set(("a an and are as at be by can could did do does for from had has have how i if in into is it its just me my no not of on or our " +
  "should so than that the their them then there these they this to too us was we were what when where which who why will with would you your " +
  "again also any about after all am been before being but each get got here into let make more most much now off only other out over same some " +
  "still such take tell there's want what's while yet").split(" "));
// a plural folds to its singular ("kills" finds "kill"); no other stemming
const fold = (t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);
const tokens = (text) => String(text ?? "").normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1).map(fold);
const content = (text) => [...new Set(tokens(text).filter((t) => !STOP.has(t)))];

/**
 * Rows (each with .note or .effect) that bear on the prompt, best first, at most k. A row clears the floor when it shares a word with the
 * prompt that is rare among the rows (in at most a tenth of them), and either a second content word or a prompt of three content words or
 * fewer. Sharing only common words ("push", "test", "mode") is not enough: a spot check on 65 real lessons (2026-10-21, five prompts, not a
 * measurement) showed those matches were noise.
 */
export function recall(rows, prompt, { k = 3, k1 = 1.2, b = 0.75 } = {}) {
  const docs = rows.map((r) => tokens(r.note ?? r.effect ?? "")), q = content(prompt);
  if (!q.length || !docs.length) return [];
  const N = docs.length, avg = docs.reduce((a, d) => a + d.length, 0) / N, df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const scored = docs.map((d, i) => {
    const tf = new Map(); for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0, hits = 0, rare = false;
    for (const t of q) { const f = tf.get(t) ?? 0; if (!f) continue; hits++; const n = df.get(t) ?? 0; if (n <= Math.max(1, Math.floor(N * 0.1))) rare = true;
      s += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / (avg || 1))); }
    return { row: rows[i], s, ok: rare && (hits >= 2 || q.length <= 3) };
  });
  return scored.filter((x) => x.ok && x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.row);
}
