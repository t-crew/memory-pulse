// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
// Holes in the guard found by a cold stranger audit of 0.16.1 (2026-10-23), plus the enforcement HN asked for (item 49949330: "use jq
// instead of writing a python script to parse json ... Yet that constantly happens"):
//   1. a replacement anywhere in an edit released the withdrawn term everywhere in it ("| Pro | $49/mo |" plus "<!-- coupon: $29 -->"
//      on another line passed);
//   2. adopt read "Never use Postgres 14; use Postgres 16." as banning "Postgres", so the guard then blocked "We run Postgres 16";
//   3. shell writes the guard could read but did not: sed -i / perl -i (the replacement side), python -c / node -e with a write call,
//      and a heredoc whose redirect comes after the marker (cat <<'EOF' > file);
//   4. a correction could withdraw a value but not a command: nothing blocked running the tool the user said to stop using.
// The fixes were written on 0.16.1 (branch fix/0.16.2-guard-holes) and never merged. Ported onto 0.18.0 on 2026-11-21: holes 1, 2 and 3
// were still open and are closed here the same way. Hole 4 was closed in 0.18.0 by another route, a rule on shell commands declared in
// invariants.jsonl ("on": "command"), so `remember --withdrawn-command` is not ported; the tests of hole 4 pin that route and say where
// it differs. One part of that fix is kept: a hyphenated option to `remember` was dropped without a word and is now refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "..", "server.mjs");

function mk(label) {
  const cwd = mkdtempSync(join(tmpdir(), `mp-holes-${label}-`));
  const ledger = join(cwd, ".memory-pulse", "events.jsonl");
  const env = { ...process.env, HOME: join(cwd, "home"), MEMORY_PULSE_MODE: "deliberate", MEMORY_PULSE_AGENT: join(cwd, "home", ".memory-pulse", "agent", "events.jsonl"), MEMORY_PULSE_LEDGER: ledger, MEMORY_PULSE_TRUST_DIR: join(cwd, "trust"), MEMORY_PULSE_DATA_DIR: join(cwd, "data"), MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_SETTINGS_DIR: join(cwd, "settings"), NO_COLOR: "1", CI: "1" };
  const run = (args, input = "") => spawnSync(process.execPath, [SERVER, ...args], { cwd, env, input, encoding: "utf8" });
  const remember = (...args) => { const r = run(["remember", ...args]); assert.equal(r.status, 0, r.stderr + r.stdout); return r; };
  const write = (file, content) => run(["guard"], JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(cwd, file), content } }));
  const bash = (command) => run(["guard"], JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "x" } }));
  return { cwd, ledger, run, remember, write, bash };
}
const price = (t) => t.remember("pricing-set", "price-corrected", "--kind", "correction", "--withdrawn", "$49", "--replacement", "$29", "--note", "Pro is 29 dollars a month");

// ---- 1. a replacement releases the withdrawn term only on its own line
test("hole 1: a replacement on another line does not release the withdrawn value", () => {
  const t = mk("line"); price(t);
  assert.equal(t.write("pricing.md", "| Pro | $49/mo |\n<!-- coupon: $29 -->").status, 2);
  assert.equal(t.write("pricing.md", "PRO = '$49'\n# was $29").status, 2);
});
test("hole 1: a comparison on one line still passes", () => {
  const t = mk("same"); price(t);
  for (const ok of ["Pro was $49/mo; it is $29/mo now.", "| Pro | ~~$49~~ $29 |", "dropped from $49 to $29\nother line"]) assert.equal(t.write("pricing.md", ok).status, 0, ok);
});
test("hole 1: findViolations, localCheck and the brief's stale marker use the same line rule", async () => {
  process.env.MEMORY_PULSE_LEDGER = join(mkdtempSync(join(tmpdir(), "mp-holes-fn-")), "events.jsonl");
  const { findViolations, localCheck } = await import("../server.mjs");
  const { staleMarker } = await import("../lib/scaffold.mjs");
  const { supersededSet, containsTerm } = await import("../server.mjs");
  const events = [{ t: 1, cause: "a", effect: "b", kind: "correction", withdrawn: ["$49"], replacement: ["$29"] }];
  const split = "Pro is $49.\nCoupon: $29.", joined = "Pro was $49, now $29.";
  assert.equal(findViolations(events, split).length, 1);
  assert.equal(findViolations(events, joined).length, 0);
  assert.equal(localCheck(events, { text: split }, [], { blockOnly: true }).verdict, "blocked");
  assert.notEqual(localCheck(events, { text: joined }, [], { blockOnly: true }).verdict, "blocked");
  const mark = staleMarker([[events, ""]], { supersededSet, containsTerm });
  assert.match(mark(split), /withdrawn at t1/);
  assert.equal(mark(joined), "");
});
test("hole 1: every edit shape is judged by line: an Edit's new_string, a MultiEdit, an apply_patch section", () => {
  const t = mk("shapes"); price(t);
  const hook = (tool_name, tool_input) => t.run(["guard"], JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input }));
  const file_path = join(t.cwd, "pricing.md");
  assert.equal(hook("Edit", { file_path, old_string: "x", new_string: "Pro: $49\nnote: $29 coupon" }).status, 2);
  assert.equal(hook("Edit", { file_path, old_string: "x", new_string: "Pro: $29 (was $49)" }).status, 0);
  assert.equal(hook("MultiEdit", { file_path, edits: [{ old_string: "a", new_string: "Pro: $49" }, { old_string: "b", new_string: "coupon: $29" }] }).status, 2, "two edits are two lines");
  assert.equal(hook("apply_patch", { input: "*** Begin Patch\n*** Update File: pricing.md\n+Pro: $49\n+coupon: $29\n*** End Patch" }).status, 2);
});
test("hole 1: a correction with no replacement, and an advisory word, behave as before", async () => {
  const { localCheck } = await import("../server.mjs");
  const events = [{ t: 1, cause: "a", effect: "b", kind: "correction", withdrawn: ["us-east-1"] },
                  { t: 2, cause: "user-correction-send", effect: "send-withdrawn", kind: "correction", withdrawn: ["send"], replacement: ["hold"], tags: ["ambient", "say-not"] }];
  assert.equal(localCheck(events, { text: "region: us-east-1\nother" }, [], { blockOnly: true }).verdict, "blocked");
  assert.notEqual(localCheck(events, { text: "api.send(x)\nhold on" }, [], { blockOnly: true }).verdict, "blocked");
});
test("hole 1: the Python client's check uses the same line rule", () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-holes-py-")); const PYDIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "python");
  const r = spawnSync("python3", ["-c", `
import sys, json; sys.path.insert(0, ${JSON.stringify(PYDIR)})
from memory_pulse import Ledger
L = Ledger(${JSON.stringify(join(dir, "events.jsonl"))})
L.append("pricing-corrected", "price-is-29", kind="correction", withdrawn=["$49"], replacement=["$29"])
print(json.dumps([L.check("| Pro | $49/mo |\\n<!-- coupon: $29 -->")["verdict"], L.check("was $49, now $29\\nother line")["verdict"], L.check("the price is $49")["verdict"]]))
`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), ["blocked", "verified", "blocked"]);
});

// ---- 1b. a withdrawn term that spans lines (review G-5, 2026-11-21). The text was split into lines before the term was looked for,
// so a term with a newline in it was found on no line and, once a replacement was recorded, never blocked. 0.18.0 blocked it.
const POLICY = "retries: 3\n  backoff: none", POLICY_TEXT = "http:\n  retries: 3\n  backoff: none\n  timeout: 10\n";
test("G-5: a two-line withdrawn term written back whole is blocked, with a replacement recorded and without one", () => {
  const a = mk("ml-a"); a.remember("retry-policy", "policy-corrected", "--kind", "correction", "--withdrawn", POLICY, "--replacement", "backoff: exponential");
  assert.equal(a.write("config.yml", POLICY_TEXT).status, 2, "with a replacement (the review's case: 0.18.0 blocked it)");
  const b = mk("ml-b"); b.remember("retry-policy", "policy-corrected", "--kind", "correction", "--withdrawn", POLICY);
  assert.equal(b.write("config.yml", POLICY_TEXT).status, 2, "without one");
  assert.equal(a.write("config.yml", "http:\n  retries: 3\n  backoff: exponential\n").status, 0, "the corrected policy passes");
  assert.equal(a.write("config.yml", "http:\n  retries: 3\n\n  backoff: none\n").status, 0, "not the term: a blank line stands between its two lines");
});
test("G-5: for a term that spans lines the release rule is judged on the lines the occurrence covers", async () => {
  const { bareTerm: bare } = await import("../lib/release.mjs");
  process.env.MEMORY_PULSE_LEDGER = join(mkdtempSync(join(tmpdir(), "mp-holes-ml-")), "events.jsonl");
  const { bareTerm, findViolations, localCheck } = await import("../server.mjs");
  const rep = ["backoff: exponential"];
  for (const f of [bare, bareTerm]) {
    assert.equal(f(POLICY_TEXT, POLICY, rep), true, "the term alone on its lines");
    assert.equal(f(`# was\n  retries: 3\n  backoff: none  (now backoff: exponential)\n`, POLICY, rep), false, "old and new on the lines the term covers: a comparison");
    assert.equal(f(`  retries: 3  # backoff: exponential replaces this\n  backoff: none\n`, POLICY, rep), false, "the replacement on the term's first line counts too");
    assert.equal(f(`${POLICY_TEXT}\n# elsewhere: backoff: exponential\n`, POLICY, rep), true, "a replacement on a line the term does not cover releases nothing");
    assert.equal(f(`  retries: 3\n  backoff: none  (now backoff: exponential)\n\nlater:\n  retries: 3\n  backoff: none\n`, POLICY, rep), true, "one occurrence compared, another bare: blocked");
    assert.equal(f("retries: 3\n\n  backoff: none", POLICY, rep), false, "the term is not there");
    assert.equal(f(POLICY_TEXT, POLICY, []), true);
  }
  const events = [{ t: 1, cause: "a", effect: "b", kind: "correction", withdrawn: [POLICY], replacement: rep }];
  assert.equal(findViolations(events, POLICY_TEXT).length, 1);
  assert.equal(localCheck(events, { text: POLICY_TEXT }, [], { blockOnly: true }).verdict, "blocked");
  assert.notEqual(localCheck(events, { text: "  retries: 3\n  backoff: none  (now backoff: exponential)\n" }, [], { blockOnly: true }).verdict, "blocked");
  // a term on one line is judged line by line, as before
  assert.equal(bareTerm("Pro is $49.\nCoupon: $29.", "$49", ["$29"]), true);
  assert.equal(bareTerm("Pro was $49, now $29.", "$49", ["$29"]), false);
});

// ---- 1c. the way out is in the message (review G-1, 2026-11-21). The line rule blocks before-and-after text written on separate
// lines; that is a decision and it stays. What a blocked writer needs is one sentence that says the one-line form passes.
test("G-1: the block message for a correction that has a replacement says, in one sentence, that naming old and new on one line passes", () => {
  const t = mk("msg"); price(t);
  const r = t.write("docs/migration.md", "Before:\n\n```yaml\nprice: $49\n```\n\nAfter:\n\n```yaml\nprice: $29\n```\n");
  assert.equal(r.status, 2);
  const SENTENCE = 'A line that names both "$49" and "$29" passes: the guard reads it as a comparison.';
  assert.ok(r.stderr.includes(SENTENCE), r.stderr);
  assert.equal(r.stderr.split(SENTENCE).length - 1, 1, "said once");
  assert.match(r.stderr, /guard allow "<term>" --path <prefix> "<reason>"/, "the other ways out are still named");
  assert.equal(t.write("docs/migration.md", "price: $29 (was $49)").status, 0, "and the sentence is true");
  // the same sentence reaches Cursor's agent, which is told through agent_message
  const c = t.run(["guard", "--host", "cursor"], JSON.stringify({ hook_event_name: "preToolUse", cursor_version: "1.7.0", tool_name: "Write", tool_input: { file_path: join(t.cwd, "pricing.md"), contents: "Pro: $49\ncoupon: $29" }, tool_use_id: "t1", cwd: t.cwd }));
  const answer = JSON.parse(c.stdout);
  assert.equal(answer.permission, "deny"); assert.ok(answer.agent_message.includes(SENTENCE), c.stdout);
});
test("G-1: a correction with no replacement has no comparison to offer, and the message does not offer one", () => {
  const t = mk("msg-none"); t.remember("region-moved", "region-corrected", "--kind", "correction", "--withdrawn", "us-east-1");
  const r = t.write("infra.md", "region: us-east-1");
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /as a comparison|on one line|names both/);
  assert.match(r.stderr, /Use the corrected value, record a new correction if the old one is wrong, or `memory-pulse guard allow/);
});
test("G-1: a term or a replacement too long to quote, or one that spans lines, gets the sentence without the quotation", () => {
  const t = mk("msg-long"); t.remember("retry-policy", "policy-corrected", "--kind", "correction", "--withdrawn", POLICY, "--replacement", "backoff: exponential");
  const r = t.write("config.yml", POLICY_TEXT);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("Naming the old value and its replacement on the same line passes: the guard reads it as a comparison."), r.stderr);
});

// ---- 2. adopt reads "Never X; use Y" as a correction from X to Y, versions included
test("hole 2: adopt reads 'Never use Postgres 14; use Postgres 16.' as Postgres 14 -> Postgres 16, and the guard passes Postgres 16", () => {
  const t = mk("adopt");
  writeFileSync(join(t.cwd, "CLAUDE.md"), "# Project\n\n- Never use Postgres 14; use Postgres 16.\n- Don't use moment.js, use date-fns.\n- Never use Node 16 for builds.\n");
  const j = JSON.parse(t.run(["adopt", "--json"]).stdout);
  const by = Object.fromEntries(j.candidates.map((c) => [c.withdrawn[0], c.replacement]));
  assert.deepEqual(by["Postgres 14"], ["Postgres 16"], JSON.stringify(j.candidates));
  assert.deepEqual(by["moment.js"], ["date-fns"], JSON.stringify(j.candidates));
  assert.ok("Node 16" in by, JSON.stringify(j.candidates));
  assert.ok(!("Postgres" in by) && !("Node" in by), `a bare product name was withdrawn: ${JSON.stringify(j.candidates)}`);
  assert.equal(t.run(["adopt", "--yes"]).status, 0);
  assert.equal(t.write("db.md", "We run Postgres 16 in production.").status, 0);
  assert.equal(t.write("db.md", "We run Postgres 14 in production.").status, 2);
  assert.equal(t.write("ci.md", "Builds use Node 20.").status, 0);
  assert.equal(t.write("ci.md", "Builds use Node 16.").status, 2);
});

// ---- 3. shell writes whose content is in the command
test("hole 3: sed -i and perl -i are judged on what they write, not on what they remove", () => {
  const t = mk("sed"); price(t);
  assert.equal(t.bash("sed -i 's/$29/$49/' pricing.md").status, 2, "sed writes $49");
  assert.equal(t.bash('sed -i "" "s/\\$29/\\$49/" pricing.md').status, 2, "the form re-run on 0.18.0 (2026-11-21): BSD -i \"\" with double quotes and escaped dollars");
  assert.equal(t.bash("sed -i '' -e 's|29|49|' -e 's/$29/$49/g' pricing.md").status, 2, "BSD -i '' and -e");
  assert.equal(t.bash("perl -pi -e 's/\\$29/\\$49/' pricing.md").status, 2, "perl -pi");
  assert.equal(t.bash("sed -i 's/$49/$29/' pricing.md").status, 0, "sed removes $49");
  assert.equal(t.bash("sed -n 's/$29/$49/p' pricing.md").status, 0, "no -i: prints, writes nothing");
});
test("hole 3: an escaped delimiter does not hide the withdrawn value from the guard", () => {
  const t = mk("esc");
  t.remember("api-base", "v2", "--kind", "correction", "--withdrawn", "/v1/", "--replacement", "/v2/", "--note", "v1 retired");
  assert.equal(t.bash("sed -i 's/\\/v2\\//\\/v1\\//g' client.js").status, 2);
});
test("hole 3: python -c and node -e that write a file are checked; ones that only print are not writes", async () => {
  const t = mk("py"); price(t);
  assert.equal(t.bash(`python3 -c 'open("pricing.md","w").write("Pro is $49")'`).status, 2);
  assert.equal(t.bash(`python3 -c 'from pathlib import Path; Path("pricing.md").write_text("Pro is $49")'`).status, 2);
  assert.equal(t.bash(`node -e 'require("fs").writeFileSync("pricing.md", "Pro is $49")'`).status, 2);
  const { shellWrites } = await import("../server.mjs");
  assert.deepEqual(shellWrites({ command: `python3 -c 'print("$49")'` }), []);
  assert.deepEqual(shellWrites({ command: `node -e 'console.log("$49")'` }), []);
});
test("hole 3: a heredoc whose redirect comes after the marker is a write", async () => {
  const t = mk("heredoc"); price(t);
  assert.equal(t.bash("cat <<'EOF' > pricing.md\nPro is $49\nEOF").status, 2);
  const { shellWrites } = await import("../server.mjs");
  const w = shellWrites({ command: "cat <<EOF >> notes.md\nregion us-east-1\nEOF" });
  assert.equal(w[0]?.path, "notes.md"); assert.match(w[0]?.text ?? "", /us-east-1/);
});

// ---- 4. running a command the user said to stop using: closed in 0.18.0 by a rule on shell commands, not by a withdrawn command
const noPython = (t) => { mkdirSync(join(t.cwd, ".memory-pulse"), { recursive: true }); writeFileSync(join(t.cwd, ".memory-pulse", "invariants.jsonl"), JSON.stringify({ id: "use-jq", on: "command", statement: "parse JSON with jq", patterns: ["python3 -c"], severity: "block" }) + "\n"); };
test("hole 4 (closed in 0.18.0): an `on: command` rule blocks running the program wherever it runs in the command line", () => {
  const t = mk("cmdblock"); noPython(t);
  for (const cmd of [
    `python3 -c 'import json,sys; print(json.load(sys.stdin)["a"])' < x.json`,
    `cat x.json | python3 -c 'import json,sys; print(json.load(sys.stdin))'`,
    `FOO=1 python3 -c 'print(1)'`,
    `cd src && python3 -c 'print(1)'`,
    `bash -c "python3 -c 'print(1)'"`,
    `/usr/bin/python3 -c 'print(1)'`,
  ]) {
    const g = t.bash(cmd);
    assert.equal(g.status, 2, `must block: ${cmd}\n${g.stderr}`);
    assert.match(g.stderr, /use-jq/); assert.match(g.stderr, /parse JSON with jq/);
  }
  for (const cmd of ["jq .a x.json", "python3 script.py"]) assert.equal(t.bash(cmd).status, 0, cmd);
  assert.equal(t.write("docs/howto.md", "Before: python3 -c '...'. Now: jq.").status, 0, "a file that names the command is not running it");
});
test("hole 4: where 0.18.0 differs from the unmerged fix: the rule is matched against the command line as text, so a command that names the program in an argument is blocked too", () => {
  const t = mk("cmdtext"); noPython(t);
  // the unmerged fix read which program each simple command runs and passed these; 0.18.0's behaviour is kept
  for (const cmd of ["echo 'stop using python3 -c'", "grep -rn 'python3 -c' docs/"]) assert.equal(t.bash(cmd).status, 2, cmd);
});
test("hole 4: remember --withdrawn-command is refused, not dropped without a word, and the refusal names the rule on commands", () => {
  const t = mk("cmdrow");
  const r = t.run(["remember", "json-parsing", "use-jq", "--kind", "correction", "--withdrawn-command", "python3 -c", "--replacement", "jq"]);
  assert.equal(r.status, 1, "a hyphenated option fell through as a positional and the row was written without it");
  assert.match(r.stderr, /unknown option --withdrawn-command/);
  assert.match(r.stderr, /"on": "command"/);
  assert.equal(existsSync(t.ledger) ? readFileSync(t.ledger, "utf8").trim() : "", "", "nothing was written");
  const other = t.run(["remember", "a", "b", "--no-such-thing", "x"]);
  assert.equal(other.status, 1); assert.match(other.stderr, /unknown option --no-such-thing/); assert.doesNotMatch(other.stderr, /"on": "command"/);
});
