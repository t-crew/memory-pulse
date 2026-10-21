// Verifier-credited memory (2026-10-21): memories carry weights learned from outcomes, outside the model. Tests: test/weights.test.js.
//   credit rows   {tags: ["credit"], credit: {t: [successes, failures]}} on the ledger, chained like every row (tamper-evident), written by
//                 consolidate from capture's check outcomes after a memory was injected (a verifier, never a model's judgement:
//                 Ratchet 2605.22148 shows an LLM judge with a high false-pass rate retires nothing)
//   fold          the weights are SUMS of those counts: sufficient statistics, so credit from any machine or teammate merges in any order
//                 to the same weights (MemRL 2601.03192 keeps an order-dependent moving average that cannot be merged)
//   utility       Beta(1 + successes, 1 + failures): mean and a normal-approximation 90% interval
//   retired       evidence floor (at least FLOOR outcomes) and an upper bound under BAR: left out of what is injected, kept on record;
//                 a correction is a rule and is never retired by utility
//   rank          MemRL's (1 - λ) z(relevance) + λ z(utility lower bound) when any candidate has evidence; relevance alone otherwise
export const FLOOR = 6, BAR = 0.35, LAMBDA = 0.5;

export function fold(rows) {
  const w = new Map();
  for (const e of rows) {
    if (!e || !Array.isArray(e.tags) || !e.tags.includes("credit") || !e.credit || typeof e.credit !== "object") continue;
    for (const [k, v] of Object.entries(e.credit)) {
      const t = Number(k); if (!Number.isInteger(t) || !Array.isArray(v)) continue;
      const s = Math.max(0, Number(v[0]) || 0), f = Math.max(0, Number(v[1]) || 0), cur = w.get(t) ?? { s: 0, f: 0 };
      w.set(t, { s: cur.s + s, f: cur.f + f });
    }
  }
  return w;
}

export function utility({ s = 0, f = 0 } = {}) {
  const a = 1 + s, b = 1 + f, n = a + b, mean = a / n, sd = Math.sqrt((a * b) / (n * n * (n + 1)));
  return { mean, lb: Math.max(0, mean - 1.645 * sd), ub: Math.min(1, mean + 1.645 * sd), n: s + f };
}

export function retired(row, w) {
  if (!w || row?.kind === "correction") return false;
  const u = utility(w); return u.n >= FLOOR && u.ub < BAR;
}

const z = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / (xs.length || 1), sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1)) || 1; return xs.map((x) => (x - m) / sd); };
/** items: [{ t, hits, ... }] -> sorted copy; ties keep the newer row first */
export function rank(items, weights, { lambda = LAMBDA } = {}) {
  const evidence = items.some((x) => weights.has(x.t));
  if (!evidence) return [...items].sort((a, b) => b.hits - a.hits || b.t - a.t);
  const zh = z(items.map((x) => x.hits)), zu = z(items.map((x) => utility(weights.get(x.t)).lb));
  return items.map((x, i) => ({ x, s: (1 - lambda) * zh[i] + lambda * zu[i] })).sort((a, b) => b.s - a.s || b.x.t - a.x.t).map((y) => y.x);
}
