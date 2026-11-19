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
