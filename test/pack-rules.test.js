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
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, SERVER } from "./_helpers.mjs";
import { localCheck } from "../server.mjs";
import { verifyPack, packAsInvariants, installedPackRules, BUNDLED_DIR } from "../lib/packs.mjs";

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
      // a rule that says where it applies: every path it names fires, every path it rules out does not
      const at = (path) => localCheck([], { kind: "edit", text: list(fx.hit)[0], path }, inv).invariants.some((h) => h.id === rule.id);
      for (const path of fx.in ?? []) assert.ok(at(path), `${rule.id} must fire at ${path}`);
      for (const path of fx.out ?? []) assert.ok(!at(path), `${rule.id} must not fire at ${path}`);
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
    const add = spawnSync(process.execPath, [SERVER, "pack", "add", name, "--block"], { cwd: dir, env, encoding: "utf8" });
    assert.equal(add.status, 0, add.stderr); assert.ok(existsSync(join(dir, ".memory-pulse", "packs", `${name}.jsonl`)));
    const rules = jsonl(join(BUNDLED_DIR, `${name}.jsonl`)).slice(1), fixtures = jsonl(join(BUNDLED_DIR, "fixtures", `${name}.jsonl`));
    // one block rule and one warn rule per pack, where the pack has them
    for (const sev of ["block", "warn"]) {
      const rule = rules.find((r) => r.severity === sev); if (!rule) continue;
      const fx = fixtures.find((x) => x.rule === rule.id);
      const g = spawnSync(process.execPath, [SERVER, "guard"], { cwd: dir, env, encoding: "utf8", input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(dir, fx.path), content: list(fx.hit)[0] }, cwd: dir }) });
      const said = `${g.stdout}${g.stderr}`;
      assert.equal(g.status, sev === "block" ? 2 : 0, `${name}/${rule.id}: ${said}`);
      assert.ok(said.includes(`pack ${name}, rule ${rule.id}`), said); assert.ok(said.includes(rule.source), said); if (sev === "block") assert.ok(said.includes(`read ${rule.verified}`), said);
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
    if (r.severity === "block" && hits === 0) assert.match(cells[7], /no hit/, `${name} ${r.id} is marked safe to block and never fired in the corpus: the table says so`);
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
  for (const name of names) assert.match(l.stdout, new RegExp(`^  ${name}\\s+\\d+\\.\\d+\\.\\d+\\s+\\S+\\s+\\d+ rules \\(\\d+ can block, \\d+ warn\\)\\s+verified \\d{4}-\\d{2}-\\d{2}\\s+not installed`, "m"), name);
  assert.equal(existsSync(join(dir, ".memory-pulse")), false, "listing writes nothing");
  const s = spawnSync(process.execPath, [SERVER, "pack", "show", "python-stdlib"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr); assert.match(s.stdout, /unittest-aliases\s+can block/); assert.match(s.stdout, /imp-module\s+warn/); assert.match(s.stdout, /https:\/\/docs\.python\.org\/3\/whatsnew\/3\.12\.html \(read \d{4}-\d{2}-\d{2}\)/);
});

// ---- review of 0.19.0
const ALL = () => names.flatMap((n) => packAsInvariants(join(BUNDLED_DIR, `${n}.jsonl`)));
const NEAR = jsonl(join(BUNDLED_DIR, "fixtures", "near-misses.jsonl"));
const blockedBy = (inv, s) => localCheck([], { kind: "edit", text: s.text, path: s.path }, inv).invariants.filter((h) => h.severity === "block").map((h) => h.id);

test("a line that only names the old API never blocks, with every rule a pack marks turned on (the review's mention snippets)", () => {
  const inv = ALL(), mention = NEAR.filter((s) => s.kind === "mention");
  assert.equal(NEAR.length, 110); assert.equal(mention.length, 24);
  for (const s of mention) assert.deepEqual(blockedBy(inv, s), [], `${s.rule} :: ${s.path} :: ${s.name}`);
});

test("the near-miss counts in packs/MEASURED.md are the ones this suite measures: none as installed, and the stated number with every marked rule on", () => {
  const md = readFileSync(join(BUNDLED_DIR, "MEASURED.md"), "utf8");
  const blocked = NEAR.filter((s) => blockedBy(ALL(), s).length);
  const m = /with every marked rule turned on: (\d+) of 110/.exec(md); assert.ok(m, "MEASURED.md states the count with blocking on");
  assert.equal(Number(m[1]), blocked.length, blocked.map((s) => `${s.kind} ${s.rule} ${s.path}`).join("\n"));
  assert.ok(!blocked.some((s) => s.kind === "mention" || s.kind === "modern"), "what still blocks is another library's or the project's own spelling, or a version guard");
  // as installed, every rule of every pack is a warning
  const base = mkdtempSync(join(tmpdir(), "mp-default-")), packs = join(base, ".memory-pulse", "packs"); mkdirSync(packs, { recursive: true });
  for (const f of PACKS) copyFileSync(join(BUNDLED_DIR, f), join(packs, f));
  const installed = installedPackRules(packs);
  assert.equal(installed.length, 61); assert.ok(installed.every((r) => r.severity === "warn"), "a pack never blocks by default");
  assert.equal(NEAR.filter((s) => blockedBy(installed, s).length).length, 0);
  assert.match(md, /as installed, before a project turns anything on: 0 of 110/);
});

test("the Next.js rules reach app/ in a monorepo, and the rule on wrangler publish cites the page that states the removal", () => {
  const next = new Map(jsonl(join(BUNDLED_DIR, "fixtures", "nextjs-app-router.jsonl")).map((x) => [x.rule, x]));
  for (const id of ["pages-data-fetching", "next-router-import", "next-head-import", "sync-request-apis", "revalidate-tag-single-argument"]) {
    const fx = next.get(id);
    for (const root of ["app/", "src/app/", "apps/web/app/"]) assert.ok(fx.in.some((p) => p.startsWith(root)), `${id}: a fixture under ${root}`);
    assert.ok(fx.out.some((p) => p.startsWith("myapp/")), `${id}: a folder merely named like app`);
  }
  const wp = jsonl(join(BUNDLED_DIR, "cloudflare-workers.jsonl")).find((r) => r.id === "wrangler-publish");
  assert.equal(wp.source, "https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/");
});

test("the ledger's own correction stays in the edit context however many pack warnings there are, and the cut is counted", () => {
  const base = mkdtempSync(join(tmpdir(), "mp-crowd-")); const dir = join(base, "p"); mkdirSync(dir);
  const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, NO_COLOR: "1", MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_AGENT: join(base, "agent.jsonl"), MEMORY_PULSE_MODE: "deliberate", MEMORY_PULSE_TRUST_DIR: join(base, "trust"), MEMORY_PULSE_DATA_DIR: join(base, "data") };
  const mp = (args, input) => spawnSync(process.execPath, [SERVER, ...args], { cwd: dir, env, encoding: "utf8", input, timeout: 60000, killSignal: "SIGKILL" });
  assert.equal(mp(["remember", "rate-limit-review", "rate-limit-is-120-per-minute", "--kind", "correction", "--withdrawn", "60 requests per minute", "--replacement", "120 requests per minute", "--note", "the items endpoint allows 120 requests per minute, not 60"]).status, 0);
  for (const p of ["fastapi", "pydantic-v2", "python-stdlib", "llm-models"]) assert.equal(mp(["pack", "add", p]).status, 0);
  const legacy = [
    "from datetime import datetime", "import asyncio", "from fastapi import FastAPI, Query", "from fastapi.responses import ORJSONResponse", "from pydantic import BaseModel, BaseSettings, Field, validator, root_validator", "",
    "class Settings(BaseSettings):", '    model: str = "gpt-4o-2024-08-06"', '    fallback_model: str = "gpt-3.5-turbo"', '    claude: str = "claude-3-opus-20240229"', "",
    "class ItemOut(BaseModel):", '    name: str = Field(..., regex="^[a-z]+$")', "    created_at: datetime = Field(default_factory=datetime.utcnow)", "    class Config:", "        orm_mode = True", '    @validator("name")', "    def name_ok(cls, v):", "        return v.strip()", "",
    'app = FastAPI(title="items", root_path="/api/v1")', "", '@app.on_event("startup")', "async def startup():", "    app.state.started = datetime.utcnow()", "    app.state.is_async = asyncio.iscoroutinefunction(startup)", "",
    '@app.get("/items/{item_id}", response_class=ORJSONResponse)', 'async def read_item(item_id: int, q: str | None = Query(None, regex="^[a-z]+$")):', "    # the rate limit for this endpoint is 120 requests per minute", '    return ItemOut.parse_obj({"name": "x"})', ""].join("\n");
  const g = mp(["guard"], JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", cwd: dir, tool_input: { file_path: join(dir, "app", "main.py"), content: legacy } }));
  assert.equal(g.status, 0, g.stderr);
  const ctx = JSON.parse(g.stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctx.length <= 2000, `${ctx.length} characters`);
  const own = ctx.indexOf("120 requests per minute"), packs = ctx.indexOf("installed rule packs have");
  assert.ok(own >= 0, `the ledger's correction is not in the context:\n${ctx}`); assert.ok(packs > own, "the ledger's own lines come first");
  const announced = Number(/installed rule packs have (\d+) warnings/.exec(ctx)[1]), shown = (ctx.match(/^  warning pack /gm) ?? []).length, more = /^  and (\d+) more: memory-pulse pack check --installed/m.exec(ctx);
  assert.ok(announced >= 12, `${announced} warnings`); assert.ok(shown >= 2 && shown < announced); assert.ok(more, "the cut is counted"); assert.equal(shown + Number(more[1]), announced);
  assert.ok(ctx.length - packs <= 1200 + 1, "pack warnings keep to their share (PACK_CONTEXT_CHARS)");
  for (const line of ctx.split("\n").filter((l) => l.startsWith("  warning pack "))) { assert.ok(line.length <= 302, line); assert.match(line, /Source: https:\/\//); assert.doesNotMatch(line, /\(matched /); }
  assert.ok(g.stderr.length < 2500, `stderr is capped too: ${g.stderr.length} bytes`);
});
