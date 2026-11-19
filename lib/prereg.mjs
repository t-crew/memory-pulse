// Pre-registered research (0.18.0). Tests: test/now.test.js, test/command-invariant.test.js, test/prereg.test.js, test/ran.test.js.
//
// Three slips in one night of pre-registered work are the reason for this file: a time stamp typed from memory into a record, a
// run at sizes the builder's own amendment had reserved for confirmation, and a constant about a deployed system copied into a
// sealed spec from a summary. Each is now a command instead of a habit.
//
//   now      the machine clock as the two stamps a record uses. A record's stamp is pasted from here, never typed.

/** One reading of the clock in both forms: {utc: "2026-11-19 02:15 UTC", iso: "2026-11-19T02:15:07Z"}. Truncated, never rounded up. */
export function stamps(d = new Date()) {
  const iso = d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return { utc: `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`, iso };
}
export const STAMP_RULE = "a record's stamp is pasted from these lines, never typed from memory";

export function cliNow(argv) {
  if (argv.some((a) => a !== "--json")) { console.error("usage: memory-pulse now [--json]\n  prints the machine clock; it takes no time from the caller"); return 1; }
  const s = stamps();
  console.log(argv.includes("--json") ? JSON.stringify(s) : `${s.utc}\n${s.iso}\n${STAMP_RULE}`);
  return 0;
}

// ---- Rules on shell commands. A line of .memory-pulse/invariants.jsonl with "on": "command" is matched against a shell command (the
// guard on a Bash / shell tool call, and `check --kind command`) and against nothing else; `paths` does not apply to it. One whose
// `owner` names a prereg ({prereg, row}) was declared by `prereg seal --forbid`: its block says whose command this is and how to
// proceed, and it has one exemption, a command line that starts with MEMORY_PULSE_ROLE=evaluator among its environment assignments
// (after any leading `cd <dir> &&`). That marker is read from the command's text. It is a tripwire against inattention, not a
// security boundary: anyone who types the marker passes.
const ID = /^[A-Za-z0-9._-]+$/;
const ASSIGN = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s'"]*)`;
const EVALUATOR = new RegExp(String.raw`^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)*(?:env\s+)?(?:${ASSIGN}\s+)*MEMORY_PULSE_ROLE=(?:evaluator|'evaluator'|"evaluator")(?=\s|$)`);
export const EVALUATOR_MARK = "MEMORY_PULSE_ROLE=evaluator";
export const evaluatorCommand = (cmd) => EVALUATOR.test(String(cmd ?? ""));
const ownerOf = (inv) => { const o = inv?.owner; return o && typeof o === "object" && typeof o.prereg === "string" && ID.test(o.prereg) ? { prereg: o.prereg, row: Number.isInteger(o.row) ? o.row : null } : null; };

/**
 * commandHits(command, invariants, compilePattern) -> { hits, allowed, reasons }. `hits` are the rules on commands the command trips
 * (severity block or warn), each with its `reason`; `allowed` says which prereg rules an evaluator's command passed; `reasons` is
 * every line in order. The message of a prereg's rule is built from its owner, never from the stored statement. Pure.
 */
export function commandHits(command, invariants, compilePattern) {
  const text = typeof command === "string" ? command : ""; const hits = [], allowed = [], reasons = [];
  if (!text.trim()) return { hits, allowed, reasons };
  const evaluator = evaluatorCommand(text);
  for (const inv of invariants ?? []) {
    if (!inv || inv.on !== "command" || typeof inv.id !== "string") continue;
    const tests = (Array.isArray(inv.patterns) ? inv.patterns : []).map(compilePattern);
    if (tests.some((t) => t === null)) reasons.push(`invariant ${inv.id} ignored: a pattern does not compile`);
    const hit = tests.find((t) => t && t.test(text));
    if (!hit) continue;
    const owner = ownerOf(inv);
    if (owner && evaluator) { const line = `prereg ${owner.prereg} (sealed at row ${owner.row ?? "?"}) reserves this command for the evaluator (matched ${hit.src}); allowed, because the command line starts with ${EVALUATOR_MARK}`; allowed.push(line); reasons.push(line); continue; }
    const severity = inv.severity === "warn" ? "warn" : "block";
    const cite = (Array.isArray(inv.cite) ? inv.cite : []).map((c) => typeof c === "number" ? `t${c}` : /^t\d+$/.test(String(c)) ? String(c) : /^\d+$/.test(String(c)) ? `t${c}` : null).filter(Boolean);
    const replacement = typeof inv.replacement === "string" ? inv.replacement : "";
    const reason = owner
      ? `sealed by prereg ${owner.prereg} at row ${owner.row ?? "?"}: this command is the evaluator's (matched ${hit.src}). Hand it to an evaluator, whose command line starts with ${EVALUATOR_MARK}, or settle the prereg: memory-pulse prereg settle ${owner.prereg} --verdict <WORD> --file <verdict-file>`
      : `${severity === "warn" ? "warning" : "invariant"} ${inv.id}${inv.statement ? `: ${inv.statement}` : ""} (matched ${hit.src}, a rule on shell commands)${cite.length ? ` — ledger ${cite.join(", ")}` : ""}${replacement ? ` — instead: ${replacement}` : ""}`;
    hits.push({ id: inv.id, severity, pattern: hit.src, cite, replacement, on: "command", ...(owner ? { owner } : {}), reason });
    reasons.push(reason);
  }
  return { hits, allowed, reasons };
}
/** The invariants that apply to an action of this kind, for a reader that does not know "on" (the engine's /v1/check matches every pattern against any text). */
export const invariantsFor = (kind, text, invariants) => (invariants ?? []).filter((inv) => inv?.on !== "command" || (kind === "command" && !(ownerOf(inv) && evaluatorCommand(text))));
export const COMMAND_HINT = "This is a declared rule on shell commands (.memory-pulse/invariants.jsonl), not a withdrawn value, so an override does not apply. A prereg's rule holds until the prereg is settled. It is a tripwire against inattention, not a security boundary: do not reword the command to get past the pattern.";
