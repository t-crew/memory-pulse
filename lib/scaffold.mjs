// The scaffolded prompt memory (0.7.0). The ledger stays the only source of truth; this renders its in-force rows into fixed
// sections, each with a character budget, every line citing the row it came from. Plain code: no hypervector code ships in the
// public client. Server helpers arrive through `deps` so this module never imports server.mjs.

export const DEFAULT_BUDGETS = { identity: 1200, corrections: 2000, state: 1200, findings: 1200, threads: 600 };
export const SECTIONS = ["identity", "corrections", "state", "findings", "threads"];
const HEADINGS = { identity: "IDENTITY AND RULES", corrections: "CORRECTIONS IN FORCE", state: "PROJECT STATE", findings: "RECENT FINDINGS", threads: "OPEN THREADS" };
const STATE_TAGS = ["state", "decision"], THREAD_TAGS = ["open", "todo"];
const SKIP_TAGS = ["handoff", "rollback", "identity", "rule", "credit", "resolved"];
const hasTag = (e, list) => Array.isArray(e.tags) && e.tags.some((x) => list.includes(x));
const clip = (s, n = 140) => { const v = String(s ?? "").replace(/\s+/g, " ").trim(); return v.length > n ? v.slice(0, n - 1) + "…" : v; };
// A row written by another tool, or arriving through git, may carry a string where a list belongs; never crash on it.
export const terms = (x) => (Array.isArray(x) ? x : typeof x === "string" && x ? [x] : []).filter((v) => v != null && v !== "").map(String);

/** One correction as a line: withdrawn terms, the replacement, the citation. `cite` is "" or "agent ". */
export function correctionLine(e, { cite = "", blocked = 0 } = {}) {
  const w = terms(e.withdrawn), r = terms(e.replacement).join(" / ");
  return `  ${w.map((x) => `"${x}"`).join(", ")} ${w.length > 1 ? "were" : "was"} withdrawn${r ? `; use ${r}` : ""} (${cite}t${e.t}${blocked ? `; blocked ${blocked} time${blocked === 1 ? "" : "s"}` : ""})`;
}

/**
 * renderScaffold(allEvents, { agentEvents, budgets, now, blocks, chain, only, deps }) -> { text, sections }
 * deps: { inForce, supersededSet, instructionLike, handoffLine, held }
 */
export function renderScaffold(allEvents, { agentEvents = [], withIdentity = true, budgets = DEFAULT_BUDGETS, now = Date.now(), blocks = [], chain = null, only = null, hide = null, soulLines = [], deps } = {}) {
  const { inForce, supersededSet, instructionLike, handoffLine, held } = deps;
  const events = inForce(allEvents ?? []), agent = inForce(agentEvents ?? []);
  if (!events.length && !agent.length) return { text: "", sections: SECTIONS.map((name) => ({ name, shown: 0, omitted: 0 })) };
  // Every rendered line is checked, not just the note: an effect slug, a handoff or a term can carry an instruction too,
  // and rows that arrive through git or an import were never screened at write time.
  const guard = (line, cite) => (instructionLike(line).length ? `  ${held} (${cite})` : line);
  const plain = (e, cite) => guard(`  ${clip(e.note ?? `${e.cause} -> ${e.effect}`)} (${cite}t${e.t})`, `${cite}t${e.t}`);

  // identity and standing rules come from the agent ledger; their citations say so
  const self = agent.filter((e) => hasTag(e, ["identity"]));
  const rules = agent.filter((e) => hasTag(e, ["rule"]));
  const line = (e) => guard(`  ${hasTag(e, ["rule"]) ? "rule" : "self"}: ${clip(e.note ?? `${e.cause} -> ${e.effect}`)} (agent t${e.t})`, `agent t${e.t}`);
  // soul mode (lib/soul.mjs): the soul, the user, long-term memory, recent days, open proposals and any drift sit right after the self line
  const identity = !withIdentity ? [] : [...(self.length ? [line(self.filter((e) => e.pinned).at(-1) ?? self.at(-1))] : []), ...soulLines, ...rules.map(line)];

  // corrections, from both ledgers, each superseded within its own ledger: blocked first, then enforced, then newest;
  // a correction with no withdrawn terms is still a correction, listed and marked as not enforced
  const blockCount = new Map(); for (const b of blocks) for (const h of b.hits ?? []) blockCount.set(Number(h.t), (blockCount.get(Number(h.t)) ?? 0) + 1);
  const corrRows = [];
  for (const [rows, cite] of [[events, ""], [agent, "agent "]]) {
    const retired = supersededSet(rows);
    for (const e of rows) {
      if (e.kind !== "correction" || retired.has(e.t)) continue;
      const enforced = terms(e.withdrawn).length > 0, blocked = cite ? 0 : blockCount.get(e.t) ?? 0;
      const line = enforced ? guard(correctionLine(e, { cite, blocked }), `${cite}t${e.t}`)
        : guard(`  ${clip(e.note ?? `${e.cause} -> ${e.effect}`)} (${cite}t${e.t}; not enforced: no withdrawn terms)`, `${cite}t${e.t}`);
      corrRows.push({ t: e.t, enforced, blocked, line });
    }
  }
  corrRows.sort((a, b) => b.blocked - a.blocked || Number(b.enforced) - Number(a.enforced) || b.t - a.t);
  const corrections = corrRows.map((x) => x.line);

  const isCorrection = (e) => e.kind === "correction" || e.kind === "override";
  // `hide`: rows sitting out this session (lib/weights.mjs withholding) are read but not shown
  const shownRow = (e) => !hide?.has?.(e.t);
  const state = events.filter((e) => !isCorrection(e) && (hasTag(e, STATE_TAGS) || e.pinned) && !hasTag(e, SKIP_TAGS) && shownRow(e)).reverse().map((e) => plain(e, ""));
  // a thread a later row resolves (a captured fix, or a passing run of the same check: lib/capture.mjs) is closed
  const closedThreads = new Set(events.flatMap((e) => (Array.isArray(e.resolves) ? e.resolves : [])));
  const threads = events.filter((e) => !isCorrection(e) && hasTag(e, THREAD_TAGS) && !closedThreads.has(e.t) && shownRow(e)).reverse().map((e) => plain(e, ""));
  let hl = ""; try { hl = handoffLine(events, { now }); } catch { hl = ""; }
  if (hl) { const h = [...events].reverse().find((e) => hasTag(e, ["handoff"])); threads.unshift(guard(`  ${clip(String(hl).replace(/^↩ /, ""), 300)} (t${h.t})`, `t${h.t}`)); }
  // recent findings: newest rows by t (most rows carry no timestamp), excluding what the other sections already show
  const findings = events.filter((e) => !isCorrection(e) && !hasTag(e, [...STATE_TAGS, ...THREAD_TAGS, ...SKIP_TAGS]) && !e.pinned && shownRow(e)).reverse().map((e) => plain(e, ""));

  const header = chain && chain.ok === false
    ? `memory-pulse: ledger chain broken at t=${chain.brokenAt ?? "?"} (${chain.reason ?? "verification failed"}); run memory-pulse verify. The rows below may be incomplete.`
    : `memory-pulse: memory from ${events.length} ledger row${events.length === 1 ? "" : "s"}; each line cites its row.`;
  const lines = { identity, corrections, state, findings, threads };
  // A one-section render (`scaffold --section`) has no budget: it is the command an overflow line points at.
  const order = only ? SECTIONS.filter((x) => x === only) : SECTIONS;
  // the header line (and the blank line before each later section) is charged to the first non-empty section's budget,
  // so the whole scaffold never exceeds the budgets' sum
  const first = order.find((x) => lines[x].length);
  const sections = [], out = [];
  for (const name of order) {
    const rows = lines[name];
    if (!rows.length) { sections.push({ name, shown: 0, omitted: 0 }); continue; }
    const budget = only ? Infinity : budgets[name] ?? DEFAULT_BUDGETS[name];
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
