// The scaffolded prompt memory (0.7.0). The ledger stays the only source of truth; this renders its in-force rows into fixed
// sections, each with a character budget, every line citing the row it came from. Plain code: no hypervector code ships in the
// public client. Server helpers arrive through `deps` so this module never imports server.mjs.

export const DEFAULT_BUDGETS = { identity: 1200, corrections: 2000, state: 1200, findings: 1200, threads: 600 };
const HEADINGS = { identity: "IDENTITY AND RULES", corrections: "CORRECTIONS IN FORCE", state: "PROJECT STATE", findings: "RECENT FINDINGS", threads: "OPEN THREADS" };
const STATE_TAGS = ["state", "decision"], THREAD_TAGS = ["open", "todo"];
const SKIP_TAGS = ["handoff", "rollback", "identity", "rule"];
const hasTag = (e, list) => Array.isArray(e.tags) && e.tags.some((x) => list.includes(x));
const clip = (s, n = 140) => { const v = String(s ?? "").replace(/\s+/g, " ").trim(); return v.length > n ? v.slice(0, n - 1) + "…" : v; };

/**
 * renderScaffold(allEvents, { agentEvents, budgets, now, blocks, chain, deps }) -> { text, sections }
 * deps: { inForce, supersededSet, instructionLike, handoffLine, held }
 */
export const SECTIONS = ["identity", "corrections", "state", "findings", "threads"];
export function renderScaffold(allEvents, { agentEvents = [], budgets = DEFAULT_BUDGETS, now = Date.now(), blocks = [], chain = null, only = null, deps } = {}) {
  const { inForce, supersededSet, instructionLike, handoffLine, held } = deps;
  const events = inForce(allEvents ?? []), agent = inForce(agentEvents ?? []);
  if (!events.length && !agent.length) return { text: "", sections: SECTIONS.map((name) => ({ name, shown: 0, omitted: 0 })) };
  const safe = (e) => (instructionLike(e.note ?? "").length ? held : clip(e.note ?? `${e.cause} -> ${e.effect}`));
  const retired = supersededSet(events);

  // identity and standing rules come from the agent ledger; their citations say so
  const self = agent.filter((e) => hasTag(e, ["identity"]));
  const rules = agent.filter((e) => hasTag(e, ["rule"]));
  const identity = [...(self.length ? [self.filter((e) => e.pinned).at(-1) ?? self.at(-1)] : []), ...rules].map((e) => `  ${hasTag(e, ["rule"]) ? "rule" : "self"}: ${safe(e)} (agent t${e.t})`);

  // corrections: AT RISK (blocked before) first, by block count, then newest first
  const blockCount = new Map(); for (const b of blocks) for (const h of b.hits ?? []) blockCount.set(Number(h.t), (blockCount.get(Number(h.t)) ?? 0) + 1);
  const corrections = events.filter((e) => e.kind === "correction" && Array.isArray(e.withdrawn) && e.withdrawn.length && !retired.has(e.t))
    .sort((a, b) => (blockCount.get(b.t) ?? 0) - (blockCount.get(a.t) ?? 0) || b.t - a.t)
    .map((e) => {
      const w = e.withdrawn.map((x) => `"${x}"`).join(", "), r = (e.replacement ?? []).join(" / "), n = blockCount.get(e.t) ?? 0;
      return `  ${w} ${e.withdrawn.length > 1 ? "were" : "was"} withdrawn${r ? `; use ${r}` : ""} (t${e.t}${n ? `; blocked ${n} time${n === 1 ? "" : "s"}` : ""})`;
    });

  const isCorrection = (e) => e.kind === "correction" || e.kind === "override";
  const state = events.filter((e) => !isCorrection(e) && (hasTag(e, STATE_TAGS) || e.pinned) && !hasTag(e, SKIP_TAGS)).reverse().map((e) => `  ${safe(e)} (t${e.t})`);
  const threads = events.filter((e) => !isCorrection(e) && hasTag(e, THREAD_TAGS)).reverse().map((e) => `  ${safe(e)} (t${e.t})`);
  const hl = handoffLine(events, { now }); if (hl) { const h = [...events].reverse().find((e) => hasTag(e, ["handoff"])); threads.unshift(`  ${clip(hl.replace(/^↩ /, ""), 300)} (t${h.t})`); }
  // recent findings: newest rows by t (most rows carry no timestamp), excluding what the other sections already show
  const findings = events.filter((e) => !isCorrection(e) && !hasTag(e, [...STATE_TAGS, ...THREAD_TAGS, ...SKIP_TAGS]) && !e.pinned).reverse().map((e) => `  ${safe(e)} (t${e.t})`);

  const header = chain && chain.ok === false
    ? `memory-pulse: ledger chain broken at t=${chain.brokenAt ?? "?"} (${chain.reason ?? "verification failed"}); run memory-pulse verify. The rows below may be incomplete.`
    : `memory-pulse: memory from ${events.length} ledger rows; each line cites its row.`;
  const lines = { identity, corrections, state, findings, threads };
  // the header line (and the blank line before each later section) is charged to the first non-empty section's budget,
  // so the whole scaffold never exceeds the budgets' sum
  const order = only ? SECTIONS.filter((x) => x === only) : SECTIONS;
  const first = order.find((x) => lines[x].length);
  const sections = [], out = [];
  for (const name of order) {
    const rows = lines[name];
    if (!rows.length) { sections.push({ name, shown: 0, omitted: 0 }); continue; }
    const budget = budgets[name] ?? DEFAULT_BUDGETS[name];
    const more = (k) => `  +${k} more — memory-pulse scaffold --section ${name}`;
    let used = HEADINGS[name].length + (name === first ? header.length + 1 : 2);
    const shown = [];
    for (let i = 0; i < rows.length; i++) {
      const left = rows.length - i - 1;
      const reserve = left ? more(left).length + 1 : 0;
      if (used + 1 + rows[i].length + reserve > budget) break;
      shown.push(rows[i]); used += 1 + rows[i].length;
    }
    const omitted = rows.length - shown.length;
    out.push([HEADINGS[name], ...shown, ...(omitted ? [more(omitted)] : [])].join("\n"));
    sections.push({ name, shown: shown.length, omitted });
  }
  return { text: `${header}\n${out.join("\n\n")}`, sections };
}
