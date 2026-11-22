/**
 * The shell reader returns a write only when the text is on the side that is written (lib/shell.mjs).
 *
 * An independent review (2026-11-21, G-2) ran 22 ordinary operations past the guard with `$49` corrected to `$29`. Four
 * commands that remove or only read the old value were blocked, and 0.18.0 had passed all four:
 *   11  sed -i '/Pro is a \$49 plan/d'      the `a` inside the address was read as sed's append command
 *   14  perl -Mstrict -ne '... s/USD/\$49/'  the `i` in -Mstrict was read as -i; the command edits nothing
 *   16  python -c that replaces old with new the whole program was taken as the text written
 *   18  node -e that looks for the old value and writes a marker file: the same
 * The rule now: a sed script is parsed command by command, addresses first; perl's -i is read from its own flag cluster;
 * for python -c and node -e the text is the string literal handed to the write call. Whatever the reader cannot read it
 * does not return: a miss, which `check --ci` catches on the pull request, and never a block.
 */
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { commandWrites } from "../lib/shell.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SERVER = join(HERE, "..", "server.mjs");
const OPS = JSON.parse(readFileSync(join(HERE, "fixtures", "ordinary-operations.json"), "utf8"));
const texts = (cmd) => commandWrites(cmd).map((w) => w.text);

function mk() {
  const cwd = mkdtempSync(join(tmpdir(), "mp-shell-"));
  const env = { PATH: process.env.PATH, HOME: join(cwd, "home"), MEMORY_PULSE_MODE: "deliberate", MEMORY_PULSE_TRUST_DIR: join(cwd, "trust"), MEMORY_PULSE_DATA_DIR: join(cwd, "data"), MEMORY_PULSE_API: "http://127.0.0.1:9", NO_COLOR: "1" };
  const run = (args, input = "") => spawnSync(process.execPath, [SERVER, ...args], { cwd, env, input, encoding: "utf8" });
  const guard = (tool_name, tool_input) => run(["guard"], JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd }));
  return { cwd, run, guard };
}

test("the review's 22 ordinary operations: the four commands that remove or only read the old value pass; the line rule's blocks stand", () => {
  assert.equal(OPS.cases.length, 22);
  const t = mk();
  assert.equal(t.run(["remember", "pricing-set", "price-corrected", "--kind", "correction", "--withdrawn", OPS.correction.withdrawn, "--replacement", OPS.correction.replacement]).status, 0);
  const got = OPS.cases.map((c) => t.guard(c.tool_name, c.tool_input).status);
  const wrong = OPS.cases.filter((c, i) => got[i] !== c.exit).map((c, i) => `${c.n} ${c.name}: expected exit ${c.exit}`);
  assert.deepEqual(wrong, []);
  assert.deepEqual(OPS.cases.filter((c) => c.why === "G-2").map((c) => c.n), [11, 14, 16, 18]);
  assert.equal(got.filter((x) => x === 2).length, 11, "ten by the line rule, one that 0.18.0 blocked too");
});

test("sed: an address is not a command; a deletion, a print or a transliteration writes nothing the reader can name", () => {
  for (const cmd of [
    "sed -i '' '/Pro is a \\$49 plan/d' docs/pricing.md",       // the review's case 11
    "sed -i '/\\$49/d' docs/pricing.md",
    "sed -i '/in a $49 box/,/c $49 end/d' f.md",
    "sed -i '\\|a $49 b|d' f.md",
    "sed -i '/i $49/!d' f.md",
    "sed -i -n '/$49/!p' f.md",
    "sed -i 'y/$49/abc/' f.md",
    "sed -i '3,5d;/a $49/d' f.md",
    "sed -i '/$49/{N;d;}' f.md",
  ]) assert.deepEqual(texts(cmd), [], cmd);
});

test("sed: the replacement side of s, and the text of a one-line a, i or c, is what is written", () => {
  assert.deepEqual(texts("sed -i 's/\\$29/\\$49/' pricing.md"), ["$49"]);
  assert.deepEqual(texts("sed -i 's/\\$49/\\$29/g' pricing.md"), ["$29"], "the pattern side is what is removed");
  assert.deepEqual(texts("sed -i '/Pro is a plan/s/\\$29/\\$49/' pricing.md"), ["$49"], "an address, then s");
  assert.deepEqual(texts("sed -i '1,/a b/s|x|Pro is $49|' pricing.md"), ["Pro is $49"]);
  assert.deepEqual(texts("sed -i '/Pro/a Pro is $49' pricing.md"), ["Pro is $49"]);
  assert.deepEqual(texts("sed -i '$ a\\Pro is $49' pricing.md"), ["Pro is $49"]);
  assert.deepEqual(texts("sed -i '/\\$49/c\\Pro is $29' pricing.md"), ["Pro is $29"], "c replaces the line that held the old value");
  assert.deepEqual(texts("sed -i '' -e 's|29|49|' -e 's/$29/$49/g' pricing.md"), ["49\n$49"]);
  assert.deepEqual(texts("sed -n 's/$29/$49/p' pricing.md"), [], "no -i: prints, writes nothing");
});

test("sed: what the reader cannot read it does not return", () => {
  for (const cmd of [
    "sed -i -f fix.sed pricing.md",                        // the script is in a file
    "sed -i 'Z $49' pricing.md",                           // not a sed command
    "sed -i '/unterminated $49' pricing.md",
    "sed -i 's/x/$49' pricing.md",                         // s with no closing delimiter
    "sed -i '1e echo $49' pricing.md",                     // e runs a command
    "sed -i '1i\\\nPrice changed from $49\\\nto $29.' docs/pricing.md",   // the review's case 13: text on the following lines is skipped, not read
  ]) assert.deepEqual(texts(cmd), [], cmd);
});

test("perl: -i is read from its own flag cluster, never from inside -M or another option's argument", () => {
  assert.deepEqual(texts("perl -Mstrict -ne 'print if s/USD/\\$49/' prices.txt"), [], "the review's case 14: no -i, nothing is edited");
  assert.deepEqual(texts("perl -MFile::Basename=dirname -ne 's/USD/\\$49/; print' prices.txt"), []);
  assert.deepEqual(texts("perl -Ilib -ne 's/USD/\\$49/; print' prices.txt"), []);
  assert.deepEqual(texts("perl -ne 'print if /\\$49/' docs/pricing.md"), []);
  assert.deepEqual(texts("perl -pi -e 's/\\$29/\\$49/' pricing.md"), ["$49"]);
  assert.deepEqual(texts("perl -i -pe 's/\\$29/\\$49/' pricing.md"), ["$49"]);
  assert.deepEqual(texts("perl -i.bak -pe 's/\\$29/\\$49/' pricing.md"), ["$49"]);
  assert.deepEqual(texts("perl -Mstrict -pi.orig -e 's/\\$29/\\$49/' pricing.md"), ["$49"], "a module and -i together");
  assert.deepEqual(texts("perl -0pi -e 's/\\$29/\\$49/' pricing.md"), ["$49"]);
  assert.deepEqual(texts("perl -pi -e 's/\\$49/\\$29/' pricing.md"), ["$29"], "removes the old value");
  assert.deepEqual(texts("perl -i -ne 'print unless /\\$49/' pricing.md"), [], "deletes the lines that hold it");
});

test("python -c: the text is the string literal handed to the write call; a program that replaces or only reads writes nothing the reader can name", () => {
  const c16 = OPS.cases[15].tool_input.command, c17 = OPS.cases[16].tool_input.command;
  assert.deepEqual(texts(c16), [], "the review's case 16");
  assert.deepEqual(texts(c17), [], "the review's case 17: write(s.replace(old, new)) is not a literal");
  assert.deepEqual(texts(`python3 -c 'open("pricing.md","w").write("Pro is $49")'`), ["Pro is $49"]);
  assert.deepEqual(texts(`python3 -c 'from pathlib import Path; Path("pricing.md").write_text("Pro is $49")'`), ["Pro is $49"]);
  assert.deepEqual(texts(`python3 -c 'with open("pricing.md", "a") as fh: fh.write("Pro is $49")'`), ["Pro is $49"]);
  assert.deepEqual(texts(`python3 -c 'old = "$49"; open("pricing.md","w").write(text)'`), [], "a name is not a literal: a miss, not a block");
  assert.deepEqual(texts(`python3 -c 'print(open("pricing.md").read().count("$49"))'`), []);
  assert.deepEqual(texts(`python3 -c 'print("$49")'`), []);
  assert.equal(commandWrites(`python3 -c 'open("pricing.md","w").write("Pro is $49")'`)[0].path, "pricing.md");
});

test("node -e: the same rule", () => {
  assert.deepEqual(texts(OPS.cases[17].tool_input.command), [], "the review's case 18: looks for the old value, writes a marker");
  assert.deepEqual(texts(`node -e 'require("fs").writeFileSync("pricing.md", "Pro is $49")'`), ["Pro is $49"]);
  assert.deepEqual(texts("node -e 'require(\"fs\").appendFileSync(\"pricing.md\", `Pro is $49`)'"), ["Pro is $49"]);
  assert.deepEqual(texts(`node --input-type=module -e 'import fs from "fs"; fs.writeFileSync("pricing.md", "Pro is $49", "utf8")'`), ["Pro is $49"]);
  assert.deepEqual(texts(`node -e 'const t = "Pro is $49"; require("fs").writeFileSync("pricing.md", t)'`), [], "a name is not a literal");
  assert.deepEqual(texts("node -e 'require(\"fs\").writeFileSync(\"pricing.md\", `Pro is ${price}`)'"), [], "a template with a hole is not a literal");
  assert.deepEqual(texts(`node -e 'console.log("$49")'`), []);
});

test("the guard: a command that writes the old value is still blocked, one that removes it passes", () => {
  const t = mk();
  t.run(["remember", "pricing-set", "price-corrected", "--kind", "correction", "--withdrawn", "$49", "--replacement", "$29"]);
  const bash = (command) => t.guard("Bash", { command, description: "x" }).status;
  for (const cmd of ["sed -i 's/\\$29/\\$49/' pricing.md", "sed -i '/Pro/a Pro is $49' pricing.md", "perl -Mstrict -pi -e 's/\\$29/\\$49/' pricing.md",
                     `python3 -c 'open("pricing.md","w").write("Pro is $49")'`, `node -e 'require("fs").writeFileSync("pricing.md", "Pro is $49")'`]) assert.equal(bash(cmd), 2, cmd);
  for (const cmd of ["sed -i 's/\\$49/\\$29/' pricing.md", "sed -i '/a \\$49 plan/d' pricing.md", "perl -i -ne 'print unless /\\$49/' pricing.md",
                     `python3 -c 'import re; s=open("p.md").read(); open("p.md","w").write(s.replace("$49","$29"))'`]) assert.equal(bash(cmd), 0, cmd);
});
