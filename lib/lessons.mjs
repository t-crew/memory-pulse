// The lesson bank (2026-10-16). After Self-Organizing Agent Teams (Pappu, Suzgun, Kwon, Bianchi, El, Kochenderfer, Cao, Zou; arXiv
// 2609.22682): a reusable artifact earns its place by what it did beyond the episode that produced it, not by being new. Their teams keep
// a strategy only if it survives a leakage screen and validation probes on other problems, then freeze a coverage-greedy bank of at most
// ten. The same three steps, deterministic here:
//   screen  a pointer to a lesson recorded elsewhere ("is now in both ledgers"), a sentence fragment or a clipped sentence is not a lesson;
//   probe   a row saying a carried lesson held or failed, and where (`memory-pulse lesson probe`, or remember with effect t<N>-held-in-<place>);
//   bank    pinned lessons, then proven ones chosen coverage-first over the places they held (their source does not count), then two
//           probation slots so a new lesson can earn evidence; a freeze pins the bank someone reviewed until a new freeze or a thaw.
// Measured on the estate's agent ledger before this module (2026-10-16): 7 of the 10 lessons the identity block printed were fragments of
// ambient capture, and 16 of the 17 lessons written on purpose never printed. Tests: test/lessons.test.js.
import { createHash } from "node:crypto";

export const BANK_MAX = 10, PROBATION_SLOTS = 2;
const tagged = (e, t) => Array.isArray(e?.tags) && e.tags.includes(t);
export const isLesson = (e) => tagged(e, "lesson") && !tagged(e, "lesson-probe") && !tagged(e, "lesson-bank");
const isAmbient = (e) => e?.cause === "ambient-lesson" || tagged(e, "ambient");
const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
/** A lesson's identity across renumbering: state merge copies cause, effect, kind and note verbatim and changes only t. */
export const lessonKey = (e) => createHash("sha256").update(JSON.stringify([e.cause, e.effect, e.kind ?? "event", e.note ?? ""])).digest("hex").slice(0, 16);

// A clause cannot start with these if it is the lesson itself: it is the tail of a sentence about a lesson ("is now in both ledgers",
// "applies here", "with exact keys"), a question, or narration ("I logged", "I'll load").
const CONTINUATION = /^(?:is|was|are|were|be|been|with|as|and|or|but|so|to|in|on|of|for|from|by|at|about|than|that|which|applies|apply|asks|demands|does|do|did|doesn't|wasn't|isn't|exactly|also|now|here|there|then|this|it|its|i|i'm|i've|i'll|i'd|we|we've|we'll|let|let's|me|my)\b/i;
// What comes before a colon when what follows it is the lesson: where it was recorded, or what it applies to.
const POINTER = /\b(?:record(?:s|ed)?|logged|saved|noted|ledger|memory|log|notes?|runbook|applies|apply|demands|asks|from t?\d+|is that|was that|lesson|in this|here)\b/i;
// A sentence that says a lesson was put somewhere is a pointer even when it starts like a statement ("about rounding ... has been added").
const POINTER_SENTENCE = /\b(?:has|have) been (?:added|recorded|saved|logged|noted|written)\b/i;
// Only a leading "Lesson:" is a prefix; "Lessons from the run" and "Lesson plans" are the lesson's own words (review 4, 2026-10-16).
const PREFIX = /^\s*lesson\s*:\s*/i;
const SENTENCE_END = /(?<!\b(?:e\.g|i\.e|vs|etc|cf))[.!?](?=\s|$)/i;

/** The admission screen: { ok, text } for a lesson that stands on its own, { ok: false, reason } for a fragment or a clipped sentence. */
export function screenLesson(raw, { clipped = false } = {}) {
  let s = String(raw ?? "").replace(PREFIX, "").replace(/\*\*/g, "").trim();
  const colon = s.indexOf(":");
  if (colon > 0 && colon <= 60 && POINTER.test(s.slice(0, colon))) s = s.slice(colon + 1).trim();
  s = s.replace(/^(?:(?:learned|here)\s+)?(?:is|was) that\s+/i, "");
  if (!s || /^[^\p{L}]/u.test(s) || CONTINUATION.test(s) || POINTER_SENTENCE.test(s)) return { ok: false, reason: "fragment" };
  const end = SENTENCE_END.exec(s);
  if (end) s = s.slice(0, end.index + 1); else if (clipped) return { ok: false, reason: "truncated" };
  if (s.split(/\s+/).filter(Boolean).length < 6) return { ok: false, reason: "fragment" };
  return { ok: true, text: s };
}

// tN-held-in-PLACE, as remember writes it; the CLI adds -at-<UTC stamp> so a repeat observation is a new row, not a duplicate.
export const PROBE_EFFECT = /^t(\d+)-(held|failed)(?:-in-(.+?))?(?:-at-\d{8}t\d{6,9}z?)?$/;
/** A probe row, from its `probe` field or its effect slug (what remember writes): { t, lesson, key, outcome, where }. */
export function probeOf(e) {
  if (!tagged(e, "lesson-probe")) return null;
  const p = e.probe && typeof e.probe === "object" ? e.probe : {};
  const m = PROBE_EFFECT.exec(String(e.effect ?? ""));
  const lesson = Number(p.lesson ?? m?.[1]); const outcome = p.outcome ?? m?.[2];
  if (!Number.isInteger(lesson) || !["held", "failed"].includes(outcome)) return null;
  const where = String(p.where ?? m?.[3] ?? "").trim();
  return { t: e.t, lesson, key: typeof p.key === "string" ? p.key : null, outcome, where: where || null, origin: e.origin ?? null };
}

// A reference to a lesson, from a probe or a freeze, resolved on THIS ledger. By content key first (every probe written since 0.10.0
// carries one). A row carried by state merge names the branch's numbering: its origin maps a carried row back, and a number at or before
// the merge's fork names the same row on both sides. Anything else on a carried row resolves to nothing, never to whatever row holds that
// number here (review 5, 2026-10-16). A row written here names this ledger's numbering.
function resolver(events) {
  const byT = new Map(), byOrigin = new Map(), byKey = new Map(), forks = [];
  for (const e of events) {
    if (Number.isInteger(e.t)) byT.set(e.t, e);
    if (e.origin?.branch && Number.isInteger(e.origin.t)) byOrigin.set(`${e.origin.branch}\u0000${e.origin.t}`, e);
    if (isLesson(e)) byKey.set(lessonKey(e), e);
    if (tagged(e, "merge") && e.state?.branch && Number.isInteger(e.state.fork)) forks.push(e.state);
  }
  return (t, key, origin) => {
    if (key && byKey.has(key)) return byKey.get(key);
    if (origin?.branch) {
      const o = byOrigin.get(`${origin.branch}\u0000${t}`); if (o) return o;
      const m = forks.find((f) => f.branch === origin.branch && typeof f.capsule === "string" && f.capsule.startsWith(String(origin.capsule ?? "\u0000")));
      return m && t <= m.fork ? byT.get(t) ?? null : null;
    }
    return byT.get(t) ?? null;
  };
}
// A freeze names lessons as { t, key }; a hand-written row may hold bare numbers. Anything else is ignored, never thrown on (review 3).
const refOf = (r) => (Number.isInteger(r) ? { t: r, key: null } : r && typeof r === "object" && Number.isInteger(r.t) ? { t: r.t, key: typeof r.key === "string" ? r.key : null } : null);
const rowWhere = (e) => slug(e.where ?? (e.tags ?? []).find((t) => /^where:/.test(t))?.slice(6) ?? "") || null;

/**
 * The bank over rows already in force. Returns { bank: [{ t, text, status, places, held, failed, source }], heldOut: [{ t, reason }],
 * lessons, frozen: { t, size } | null, since }. status is pinned | proven | probation.
 */
export function lessonBank(events, { max = BANK_MAX, live = false, instructionLike = () => [] } = {}) {
  const lessons = events.filter((e) => isLesson(e) && Number.isInteger(e.t)); const find = resolver(events);
  const heldOut = [], cands = new Map(), dupOf = new Map(), seen = new Map();
  const pref = (e) => (e.pinned ? 0 : isAmbient(e) ? 2 : 1);
  for (const e of [...lessons].sort((a, b) => pref(a) - pref(b) || a.t - b.t)) {
    const raw = String(e.note ?? e.effect ?? "");
    if (instructionLike(raw).length) { heldOut.push({ t: e.t, reason: "instruction" }); continue; }
    const body = raw.replace(PREFIX, "").trim();
    const sc = isAmbient(e) ? screenLesson(body, { clipped: body.length >= 155 }) : body ? { ok: true, text: body } : { ok: false, reason: "fragment" };
    if (!sc.ok) { heldOut.push({ t: e.t, reason: sc.reason }); continue; }
    const norm = sc.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (seen.has(norm)) { heldOut.push({ t: e.t, reason: "duplicate", of: seen.get(norm) }); dupOf.set(e.t, seen.get(norm)); continue; }
    seen.set(norm, e.t);
    cands.set(e.t, { t: e.t, text: sc.text, pinned: !!e.pinned, ambient: isAmbient(e), source: rowWhere(e), held: 0, failed: 0, places: new Set() });
  }
  for (const p of events.map(probeOf).filter(Boolean)) {
    const row = find(p.lesson, p.key, p.origin); if (!row) continue;
    const c = cands.get(dupOf.get(row.t) ?? row.t); if (!c) continue;
    if (p.outcome === "failed") { c.failed++; continue; }
    c.held++; const place = slug(p.where) || "unspecified"; if (place !== c.source) c.places.add(place);
  }
  for (const c of [...cands.values()]) if (c.failed && c.failed >= c.held) { cands.delete(c.t); heldOut.push({ t: c.t, reason: "failed" }); }
  const status = (c) => (c.pinned ? "pinned" : c.places.size ? "proven" : "probation");
  const out = (c) => ({ t: c.t, text: c.text, status: status(c), places: [...c.places].sort(), held: c.held, failed: c.failed, source: c.source });

  // a freeze binds the ledger it was made on: one carried in by a merge stays the branch's bookkeeping
  const freeze = [...events].reverse().find((e) => tagged(e, "lesson-bank") && !e.origin);
  if (!live && freeze && Array.isArray(freeze.bank)) {
    const bank = [...new Set(freeze.bank.map(refOf).filter(Boolean).map((r) => find(r.t, r.key, null)).map((row) => row && cands.get(dupOf.get(row.t) ?? row.t)).filter(Boolean))];
    const inBank = new Set(bank.map((c) => c.t));
    return { bank: bank.map(out), heldOut, lessons: lessons.length, frozen: { t: freeze.t, size: freeze.bank.length },
             since: [...cands.values()].filter((c) => c.t > freeze.t && !inBank.has(c.t)).length };
  }

  const all = [...cands.values()];
  const bank = all.filter((c) => c.pinned).sort((a, b) => b.t - a.t).slice(0, max);
  const probation = all.filter((c) => !c.pinned && !c.places.size).sort((a, b) => Number(a.ambient) - Number(b.ambient) || b.t - a.t);
  const proven = all.filter((c) => !c.pinned && c.places.size);
  const room = Math.max(0, max - bank.length - Math.min(PROBATION_SLOTS, probation.length));
  const covered = new Set(bank.flatMap((c) => [...c.places]));
  for (let n = 0; n < room && proven.length; n++) {
    // coverage first: the lesson that adds the most places not yet covered; then the widest, the most held, the oldest
    const gain = (c) => [...c.places].filter((p) => !covered.has(p)).length;
    proven.sort((a, b) => gain(b) - gain(a) || b.places.size - a.places.size || b.held - a.held || a.t - b.t);
    const pick = proven.shift(); bank.push(pick); for (const p of pick.places) covered.add(p);
  }
  bank.push(...probation.slice(0, Math.max(0, max - bank.length)));
  return { bank: bank.map(out), heldOut, lessons: lessons.length, frozen: null, since: 0 };
}

/** What the identity block prints of a lesson: its first sentence, or 240 characters cut at a word. Ten whole lessons written on purpose
 * ran the estate's identity block to 11,231 characters, past the host cap where every lesson line is dropped (2026-10-16). */
export function lessonHead(text, max = 240) {
  const s = String(text).replace(/\s+/g, " ").trim(); const end = SENTENCE_END.exec(s);
  if (end && end.index < max) return s.slice(0, end.index + 1);
  return s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, "")}…`;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** "bank of 8 from 57; 49 held out: 46 fragments, 3 duplicates" (and the freeze, when there is one). */
export function bankSummary(b) {
  const counts = {}; for (const h of b.heldOut) counts[h.reason] = (counts[h.reason] ?? 0) + 1;
  const names = { fragment: "fragment", truncated: "truncated", duplicate: "duplicate", failed: "failed its probes", instruction: "held back as instruction-like" };
  const held = Object.entries(counts).map(([r, n]) => (r === "fragment" || r === "duplicate" ? plural(n, names[r]) : `${n} ${names[r] ?? r}`)).join(", ");
  return `bank of ${b.bank.length} from ${b.lessons}${b.frozen ? `, frozen at t${b.frozen.t}, ${plural(b.since, "newer lesson")} since` : ""}${b.heldOut.length ? `; ${b.heldOut.length} held out: ${held}` : ""}`;
}
/** The label after a lesson: pinned, held in N places, on probation. `places` lists them (the CLI does; the identity block does not). */
export function bankLabel(c, { places = false } = {}) {
  if (c.status === "pinned") return "pinned";
  const fail = c.failed ? `, failed ${c.failed}` : "";
  if (c.status === "proven") return `held in ${plural(c.places.length, "place")}${places ? ` (${c.places.join(", ")})` : ""}${fail}`;
  return c.held ? `on probation, held only where it was learned${fail}` : `on probation${fail}`;
}
