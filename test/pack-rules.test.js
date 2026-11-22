// The bundled rule packs (packs/*.jsonl). Every pack passes the pack linter; every rule has a fixture that must hit and one that
// must not (packs/fixtures/<pack>.jsonl), checked through the same localCheck the guard runs; every rule is in the measurement
// table (packs/MEASURED.md) with its corpus counts, and a block rule there has every hit read and none false; and the packs ship
// in the npm tarball. A rule added without a fixture, a
// measurement or a vendor source is a red test.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
for (const k of ["MEMORY_PULSE_LEDGER", "MEMORY_PULSE_PROJECT", "MEMORY_PULSE_KEY", "MEMORY_PULSE_BOARD"]) delete process.env[k];
process.env.MEMORY_PULSE_MODE = "deliberate"; process.env.MEMORY_PULSE_AGENT = "/nonexistent/agent/events.jsonl";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, SERVER } from "./_helpers.mjs";
import { localCheck } from "../server.mjs";
import { verifyPack, packAsInvariants, BUNDLED_DIR } from "../lib/packs.mjs";

const PACKS = readdirSync(BUNDLED_DIR).filter((f) => f.endsWith(".jsonl")).sort();
const names = PACKS.map((f) => f.replace(/\.jsonl$/, ""));
const jsonl = (p) => readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const list = (x) => (Array.isArray(x) ? x : [x]);

test("the bundled packs are the set this release names", () => {
  assert.deepEqual(names, ["cloudflare-workers", "fastapi", "llm-models", "nextjs-app-router", "pydantic-v2", "python-stdlib", "stripe", "supabase-auth"]);
});

test("the pack linter passes over every bundled pack, with no note left standing", () => {
  for (const f of PACKS) {
    const v = verifyPack(join(BUNDLED_DIR, f));
    assert.deepEqual(v.errors, [], f); assert.deepEqual(v.warnings, [], f);
    assert.equal(`${v.header.name}.jsonl`, f, "a bundled pack's file is named after it");
    assert.ok(v.rules.length >= 4 && v.rules.length <= 12, `${f}: ${v.rules.length} rules; a bundled pack has 4 to 12`);
  }
});

test("every bundled rule has a statement, a vendor source over https and the date it was read", () => {
  for (const f of PACKS) for (const r of jsonl(join(BUNDLED_DIR, f)).slice(1)) {
    assert.ok(typeof r.statement === "string" && r.statement.length > 10, `${f} ${r.id}: statement`);
    assert.match(r.source, /^https:\/\//, `${f} ${r.id}`); assert.match(r.verified, /^\d{4}-\d{2}-\d{2}$/, `${f} ${r.id}`);
    assert.ok(Array.isArray(r.paths) && r.paths.some((p) => p.includes("*") && !p.startsWith("!")), `${f} ${r.id}: a glob scope`);
    assert.doesNotMatch(`${r.statement} ${r.replacement ?? ""}`, /—/, `${f} ${r.id}: no em dash in rule text`);
  }
});

test("every bundled rule has a fixture that must hit and a fixture that must not, through the guard's own check", () => {
  let rules = 0;
  for (const name of names) {
    const inv = packAsInvariants(join(BUNDLED_DIR, `${name}.jsonl`));
    const fixtures = new Map(jsonl(join(BUNDLED_DIR, "fixtures", `${name}.jsonl`)).map((x) => [x.rule, x]));
    assert.deepEqual([...fixtures.keys()].sort(), inv.map((r) => r.pack.rule).sort(), `${name}: one fixture line per rule, no more and no fewer`);
    for (const rule of inv) {
      const fx = fixtures.get(rule.pack.rule); rules++;
      const ids = (text) => localCheck([], { kind: "edit", text, path: fx.path }, inv).invariants.map((h) => h.id);
      assert.ok(list(fx.hit).length && list(fx.miss).length, `${rule.id}: needs a hit and a miss`);
      for (const text of list(fx.hit)) assert.ok(ids(text).includes(rule.id), `${rule.id} must hit ${fx.path}:\n${text}`);
      for (const text of list(fx.miss)) assert.ok(!ids(text).includes(rule.id), `${rule.id} must not hit ${fx.path}:\n${text}`);
      // the same text outside the rule's path scope is not this rule's business
      for (const text of list(fx.hit)) assert.ok(!localCheck([], { kind: "edit", text, path: "notes/unrelated.txt" }, inv).invariants.some((h) => h.id === rule.id), `${rule.id} fired outside its paths`);
    }
  }
  assert.ok(rules >= 40, `${rules} bundled rules checked`);
});

test("a block rule's fixture blocks through the guard and a warn rule's does not", () => {
  for (const name of names) {
    const base = mkdtempSync(join(tmpdir(), "mp-packrule-")); const dir = join(base, "p"); mkdirSync(dir);
    const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, NO_COLOR: "1", MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_AGENT: join(base, "agent.jsonl"), MEMORY_PULSE_MODE: "deliberate", MEMORY_PULSE_TRUST_DIR: join(base, "trust"), MEMORY_PULSE_DATA_DIR: join(base, "data") };
    const add = spawnSync(process.execPath, [SERVER, "pack", "add", name], { cwd: dir, env, encoding: "utf8" });
    assert.equal(add.status, 0, add.stderr); assert.ok(existsSync(join(dir, ".memory-pulse", "packs", `${name}.jsonl`)));
    const rules = jsonl(join(BUNDLED_DIR, `${name}.jsonl`)).slice(1), fixtures = jsonl(join(BUNDLED_DIR, "fixtures", `${name}.jsonl`));
    // one block rule and one warn rule per pack, where the pack has them
    for (const sev of ["block", "warn"]) {
      const rule = rules.find((r) => r.severity === sev); if (!rule) continue;
      const fx = fixtures.find((x) => x.rule === rule.id);
      const g = spawnSync(process.execPath, [SERVER, "guard"], { cwd: dir, env, encoding: "utf8", input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(dir, fx.path), content: list(fx.hit)[0] }, cwd: dir }) });
      const said = `${g.stdout}${g.stderr}`;
      assert.equal(g.status, sev === "block" ? 2 : 0, `${name}/${rule.id}: ${said}`);
      assert.ok(said.includes(`pack ${name}, rule ${rule.id}`), said); assert.ok(said.includes(rule.source), said); assert.ok(said.includes(`read ${rule.verified}`), said);
      if (sev === "block") assert.ok(said.includes(`memory-pulse pack rule ${name}/${rule.id} warn`), said);
    }
  }
});

test("every bundled rule is in packs/MEASURED.md with its corpus counts, and a block rule has no false positive on record", () => {
  const md = readFileSync(join(BUNDLED_DIR, "MEASURED.md"), "utf8");
  for (const f of PACKS) for (const r of jsonl(join(BUNDLED_DIR, f)).slice(1)) {
    const name = f.replace(/\.jsonl$/, "");
    const row = md.split("\n").find((l) => l.startsWith(`| ${name} | ${r.id} |`));
    assert.ok(row, `packs/MEASURED.md has no row for ${name} ${r.id}`);
    const cells = row.split("|").slice(1, -1).map((c) => c.trim());
    assert.equal(cells[2], r.severity, `${name} ${r.id}: the table says ${cells[2]}, the pack says ${r.severity}`);
    // hits measured, then of the hits that were read: true, false, and how many were read
    const [hits, tp, fp, read] = cells.slice(3, 7).map(Number);
    assert.ok([hits, tp, fp, read].every(Number.isInteger), `${name} ${r.id}: hits, true, false and read are counts`);
    assert.equal(tp + fp, read, `${name} ${r.id}: true + false = read`); assert.ok(read <= hits, `${name} ${r.id}: read ${read} of ${hits}`);
    if (r.severity === "block") { assert.equal(read, hits, `${name} ${r.id} blocks: every hit is read`); assert.equal(fp, 0, `${name} ${r.id} blocks and has ${fp} false positive(s) in the corpus`); }
  }
});

test("the packs ship in the npm tarball, the fixtures and the measurement notes do not need to", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("packs/*.jsonl"), "package.json files lists packs/*.jsonl");
  assert.ok(pkg.files.includes("lib/*.mjs"));
  assert.ok(existsSync(join(BUNDLED_DIR, "CONTRIBUTING.md")));
  const contributing = readFileSync(join(BUNDLED_DIR, "CONTRIBUTING.md"), "utf8");
  assert.ok(contributing.split("\n").length <= 40, "packs/CONTRIBUTING.md stays under 40 lines");
  for (const need of ["source", "verified", "fixture", "MEASURED.md", "pack verify", "pack check"]) assert.ok(contributing.includes(need), `CONTRIBUTING names ${need}`);
});

test("pack list names every bundled pack with its counts, and pack show prints a bundled pack by name", () => {
  const base = mkdtempSync(join(tmpdir(), "mp-packlist-")); const dir = join(base, "p"); mkdirSync(dir);
  const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, NO_COLOR: "1", MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_AGENT: join(base, "agent.jsonl"), MEMORY_PULSE_MODE: "deliberate", MEMORY_PULSE_TRUST_DIR: join(base, "trust"), MEMORY_PULSE_DATA_DIR: join(base, "data") };
  const l = spawnSync(process.execPath, [SERVER, "pack", "list"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(l.status, 0, l.stderr);
  for (const name of names) assert.match(l.stdout, new RegExp(`^  ${name}\\s+\\d+\\.\\d+\\.\\d+\\s+\\S+\\s+\\d+ rules \\(\\d+ block, \\d+ warn\\)\\s+verified \\d{4}-\\d{2}-\\d{2}\\s+not installed`, "m"), name);
  assert.equal(existsSync(join(dir, ".memory-pulse")), false, "listing writes nothing");
  const s = spawnSync(process.execPath, [SERVER, "pack", "show", "python-stdlib"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr); assert.match(s.stdout, /ssl-wrap-socket\s+block/); assert.match(s.stdout, /imp-module\s+warn/); assert.match(s.stdout, /https:\/\/docs\.python\.org\/3\/whatsnew\/3\.12\.html \(read \d{4}-\d{2}-\d{2}\)/);
});
