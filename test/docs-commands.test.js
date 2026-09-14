// Every `memory-pulse <sub>` / `npx memory-pulse <sub>` a document tells the reader to type must exist in
// the dispatch table. The Action's PR comment once recommended `memory-pulse remember` while no such
// subcommand existed; this test makes that class of drift a red test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { dispatched } from "./_helpers.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DOCS = ["README.md", "docs/GUIDE.md", "skills/memory-pulse/SKILL.md", "action/run.mjs"].map((p) => join(ROOT, p));

// Commands named inline in backticks, plus command lines inside fenced blocks that are not `text` blocks.
export function commandsIn(md) {
  const found = [];
  const add = (s, where) => {
    const m = /^\$?\s*(?:npx\s+(?:-y\s+)?)?memory-pulse(?:@[0-9][^\s]*)?\s+(\S+)(?:\s+(\S+))?/.exec(s.trim());
    if (!m) return;
    const sub = m[1].replace(/[:;,.)"'`]+$/, "");
    // "memory-pulse guard: blocked." is quoted output, not a command with an argument.
    const output = /[:]$/.test(m[1]);
    found.push({ sub, next: output ? "" : (m[2] ?? "").replace(/[:;,.)"'`]+$/, ""), where, line: s.trim() });
  };
  let fence = null;
  for (const [i, raw] of md.split("\n").entries()) {
    const f = /^\s*```\s*(\S*)/.exec(raw);
    if (f) { fence = fence === null ? f[1] : null; continue; }
    if (fence !== null) { if (!/^text/.test(fence)) add(raw, i + 1); continue; }
    for (const m of raw.matchAll(/`([^`\n]+)`/g)) add(m[1], i + 1);
  }
  return found;
}

test("every memory-pulse command named in the docs exists in server.mjs's dispatch table", () => {
  const known = new Set([...dispatched().map((n) => n.split(" ")[0]), "help", "--help", "-h"]);
  for (const file of DOCS) {
    if (!existsSync(file)) continue;
    const cmds = commandsIn(readFileSync(file, "utf8"));
    assert.ok(cmds.length > 0, `${file} names no commands`);
    for (const c of cmds) {
      if (c.sub.startsWith("<") || c.sub.startsWith("[")) continue; // a placeholder like <sub>
      // In a code file a template literal can read "memory-pulse blocked this change": a prose word after the
      // name means a sentence, not a command. Markdown spans are always commands.
      if (!file.endsWith(".md") && c.next && !/^[-<"\[]/.test(c.next) && c.next !== "allow") continue;
      assert.ok(known.has(c.sub), `${file}:${c.where} names "memory-pulse ${c.sub}" which does not exist (${c.line})`);
      if (c.sub === "guard" && c.next && !c.next.startsWith("-") && !c.next.startsWith("#")) assert.equal(c.next, "allow", `${file}:${c.where}: guard takes only "allow"`);
    }
  }
});

test("the guide exists and is linked from the README", () => {
  assert.ok(existsSync(join(ROOT, "docs", "GUIDE.md")), "docs/GUIDE.md missing");
  assert.match(readFileSync(join(ROOT, "README.md"), "utf8"), /docs\/GUIDE\.md/);
});
