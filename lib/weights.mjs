// Verifier-credited memory (2026-10-21): memories carry weights learned from outcomes, outside the model. Tests: test/weights.test.js.
//   credit rows   {tags: ["credit"], credit: {t: [shown passes, shown failures, withheld passes, withheld failures]}} on the ledger, chained
//                 like every row (tamper-evident), written by consolidate from capture's check outcomes after a memory was shown or
//                 withheld (a verifier, never a model's judgement: Ratchet 2605.22148 shows an LLM judge with a high false-pass rate
//                 retires nothing). An old two-count row is read as shown-only
//   withhold      an eligible memory sits out a whole session at random, at rate HOLDOUT (env MEMORY_PULSE_HOLDOUT; corrections never):
//                 the outcome after a memory is shown measures which prompts match it, not what it did (replay of 108 real transcripts:
//                 memories never shown read 0.815 against a 0.553 base), so only the difference between the two arms is its effect. The
//                 draw is per (session, memory), not per prompt: with a per-prompt draw a memory counts as withheld only if it lost every
//                 draw before a check, which tied the arm to how many prompts came before it (placebo replay read +0.10 at rate 0.3)
//   fold          the weights are SUMS of those counts: sufficient statistics, so credit from any machine or teammate merges in any order
//                 to the same weights (MemRL 2601.03192 keeps an order-dependent moving average that cannot be merged)
//   utility       per arm Beta(1 + passes, 1 + failures); effect = shown mean - withheld mean with a normal-approximation 95% interval
//                 (at 90%, 3 of 27 placebo memories past both floors fell wholly below zero across 12 replay seeds; at 95%, none), shrunk
//                 toward zero by n0 / (n0 + FLOOR) for ranking, so a memory never withheld has no effect
//   retired       at least FLOOR outcomes (sessions: capture credits each memory once per session) in each arm and an effect interval wholly below zero: left out of what is injected, kept on
//                 record; a correction is a rule and is never retired by utility
//   rank          (1 - λ) z(relevance) + λ effect / SCALE for memories with FLOOR outcomes in both arms; relevance alone otherwise
//                 (below the floor, one or two withheld outcomes moved what was shown on 38% of prompts in the placebo replay). The effect
//                 is not z-scored: a 0.1 rise in the pass rate is worth one standard deviation of relevance
import { createHash } from "node:crypto";

export const FLOOR = 6, LAMBDA = 0.5, SCALE = 0.1, HOLDOUT = 0.1;

// A credit entry is trusted only as what consolidate writes: one trial, four non-negative integers summing to 1, under a canonical row
// number, and once per (episode, memory). One forged or merged row claiming [0, 6, 6, 0] retired a memory outright (review 2026-10-21);
// now retiring takes FLOOR separate sessions in each arm, each a chained row anyone can see. Callers fold the rows in force, so a
// rollback takes credit out with everything else.
const trial = (v) => Array.isArray(v) && v.length === 4 && v.every((x) => Number.isInteger(x) && x >= 0) && v[0] + v[1] + v[2] + v[3] === 1;
export function fold(rows) {
  const w = new Map(), seen = new Set();
  for (const e of rows) {
    if (!e || !Array.isArray(e.tags) || !e.tags.includes("credit") || !e.credit || typeof e.credit !== "object" || Array.isArray(e.credit)) continue;
    const ep = typeof e.evidence?.episode === "string" && e.evidence.episode ? e.evidence.episode : null;
    for (const [k, v] of Object.entries(e.credit)) {
      if (!/^[1-9]\d{0,15}$/.test(k) || !trial(v)) continue;
      const t = Number(k);
      if (ep) { const key = `${ep}\u0000${t}`; if (seen.has(key)) continue; seen.add(key); }
      const cur = w.get(t) ?? { s: 0, f: 0, s0: 0, f0: 0 };
      w.set(t, { s: cur.s + v[0], f: cur.f + v[1], s0: cur.s0 + v[2], f0: cur.f0 + v[3] });
    }
  }
  return w;
}

const beta = (s, f) => { const a = 1 + s, b = 1 + f, n = a + b; return { mean: a / n, v: (a * b) / (n * n * (n + 1)) }; };
export function utility({ s = 0, f = 0, s0 = 0, f0 = 0 } = {}) {
  const on = beta(s, f), off = beta(s0, f0), sd = Math.sqrt(on.v), n0 = s0 + f0;
  const raw = on.mean - off.mean, esd = Math.sqrt(on.v + off.v), effect = n0 ? raw * (n0 / (n0 + FLOOR)) : 0;
  return { mean: on.mean, lb: Math.max(0, on.mean - 1.645 * sd), ub: Math.min(1, on.mean + 1.645 * sd), n: s + f, n0,
           withheldMean: off.mean, raw, effect, effectLb: Math.max(-1, raw - 1.96 * esd), effectUb: Math.min(1, raw + 1.96 * esd) };
}

export function retired(row, w) {
  if (!w || row?.kind === "correction") return false;
  const u = utility(w); return u.n >= FLOOR && u.n0 >= FLOOR && u.effectUb < 0;
}

/** A reproducible draw: the same key (session and memory) always gives the same answer; true with probability eps. */
export function withhold(key, eps) {
  if (!(eps > 0)) return false; if (eps >= 1) return true;
  return parseInt(createHash("sha256").update(String(key)).digest("hex").slice(0, 8), 16) / 0x100000000 < eps;
}
export const holdoutRate = (env = process.env) => { const x = Number(env.MEMORY_PULSE_HOLDOUT ?? HOLDOUT); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : HOLDOUT; };

const z = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / (xs.length || 1), sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1)) || 1; return xs.map((x) => (x - m) / sd); };
/** items: [{ t, hits, own? }] -> sorted copy; ties keep the newer row first. Weights belong to this project's ledger: an item with
 *  own === false (a row from the agent ledger) is ranked by relevance alone even when its number has credit here. */
export function rank(items, weights, { lambda = LAMBDA } = {}) {
  const effect = (x) => { const u = x.own !== false && weights.has(x.t) ? utility(weights.get(x.t)) : null; return u && u.n >= FLOOR && u.n0 >= FLOOR ? u.effect : 0; };
  if (!items.some((x) => effect(x) !== 0)) return [...items].sort((a, b) => b.hits - a.hits || b.t - a.t);
  const zh = z(items.map((x) => x.hits));
  return items.map((x, i) => ({ x, s: (1 - lambda) * zh[i] + lambda * effect(x) / SCALE })).sort((a, b) => b.s - a.s || b.x.t - a.x.t).map((y) => y.x);
}
