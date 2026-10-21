// `memory-pulse login | logout` (2026-10-21): connect a machine without handling a key. The CLI starts a device request, shows the
// code and opens the console; the user approves there; the CLI saves the key (~/.config/memory-pulse/key, mode 600), turns board sync
// on and pushes the board. The engine's half is tested in the engine. Here: what the CLI sends, saves and prints. Written first.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";

const KEY = "mp_live_" + "a1".repeat(16);
let server, base, outcome = "approve", polls = 0; const seen = [];
before(async () => {
  server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      seen.push({ method: req.method, url: req.url, key: req.headers["x-mp-key"], body });
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/v1/auth/device") { polls = 0; return send(200, { device_code: "d".repeat(64), user_code: "BCDF-GHJK", verification_uri: `${base}/app`, verification_uri_complete: `${base}/app?device=BCDF-GHJK`, expires_in: 600, interval: 1 }); }
      if (req.url === "/v1/auth/device/token") {
        if (++polls < 2) return send(400, { error: "authorization_pending", interval: 1 });
        if (outcome === "deny") return send(400, { error: "access_denied" });
        if (outcome === "expire") return send(400, { error: "expired_token" });
        return send(200, { key: KEY, prefix: KEY.slice(0, 16) + "…", project: { id: "p-9", name: "casmi-board" }, hosted: true });
      }
      if (req.url.startsWith("/v1/board")) { const cap = JSON.parse(body); const last = JSON.parse(cap.lines.at(-1)); return send(200, { status: "installed", appended: cap.lines.length, rows: cap.lines.length, head: last.hash }); }
      return send(404, { error: "no route" });
    });
  });
  await new Promise((r, j) => { server.once("error", j); server.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const home = () => { const h = mkdtempSync(join(tmpdir(), "mp-login-")); mkdirSync(join(h, "work", ".memory-pulse"), { recursive: true }); return h; };
const run = (h, args, extra = {}) => new Promise((resolve) => {
  const env = { ...process.env, HOME: h, MEMORY_PULSE_API: base, MEMORY_PULSE_LEDGER: join(h, "work", ".memory-pulse", "events.jsonl"), MEMORY_PULSE_AGENT: join(h, "agent.jsonl"), ...extra };
  delete env.MEMORY_PULSE_KEY; delete env.MEMORY_PULSE_BOARD; if (extra.MEMORY_PULSE_KEY) env.MEMORY_PULSE_KEY = extra.MEMORY_PULSE_KEY;
  const p = spawn(process.execPath, [SERVER, ...args], { cwd: join(h, "work"), env });
  let out = "", err = ""; p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c)); p.on("close", (code) => resolve({ code, out, err, all: out + err }));
});

test("login shows the code and the link, waits for the approval, saves the key (600), turns board sync on and pushes the board", async () => {
  const h = home(); outcome = "approve";
  assert.equal((await run(h, ["board", "post", "--from", "blue", "--to", "all", "--title", "hello"])).code, 0);
  const r = await run(h, ["login", "--no-open"]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /BCDF-GHJK/); assert.match(r.out, /\/app\?device=BCDF-GHJK/); assert.match(r.out, /casmi-board/);
  const kf = join(h, ".config", "memory-pulse", "key");
  assert.equal(readFileSync(kf, "utf8").trim(), KEY); assert.equal(statSync(kf).mode & 0o777, 0o600);
  assert.ok(!r.all.includes(KEY), "the key itself is never printed");
  const start = seen.find((s) => s.url === "/v1/auth/device"); assert.match(JSON.parse(start.body).client, /^memory-pulse /);
  assert.deepEqual(JSON.parse(readFileSync(join(h, "work", ".memory-pulse", "board-sync.json"), "utf8")).on, true);
  const push = seen.filter((s) => s.url.startsWith("/v1/board")).at(-1); assert.equal(push.key, KEY, "the board was pushed with the new key");
});

test("a denied or expired request ends the login with nothing saved", async () => {
  for (const o of ["deny", "expire"]) {
    const h = home(); outcome = o;
    const r = await run(h, ["login", "--no-open", "--no-sync"]);
    assert.equal(r.code, 1, r.all); assert.match(r.all, o === "deny" ? /denied/ : /expired/);
    assert.ok(!existsSync(join(h, ".config", "memory-pulse", "key")));
  }
  outcome = "approve";
});

test("after login every command uses the saved key; MEMORY_PULSE_KEY still wins; logout removes it", async () => {
  const h = home(); outcome = "approve";
  assert.equal((await run(h, ["login", "--no-open", "--no-sync"])).code, 0);
  await run(h, ["board", "post", "--from", "blue", "--to", "all", "--title", "x"]);
  assert.equal((await run(h, ["board", "push"])).code, 0); assert.equal(seen.at(-1).key, KEY);
  const other = "mp_live_" + "b2".repeat(16);
  await run(h, ["board", "post", "--from", "blue", "--to", "all", "--title", "y"]);          // something new, so the push sends
  await run(h, ["board", "push"], { MEMORY_PULSE_KEY: other }); assert.equal(seen.at(-1).key, other);
  const out = await run(h, ["logout"]);
  assert.equal(out.code, 0); assert.match(out.out, /revoke/); assert.ok(!existsSync(join(h, ".config", "memory-pulse", "key")));
  const n = seen.length; const p = await run(h, ["board", "push"]); assert.equal(p.code, 1); assert.match(p.all, /MEMORY_PULSE_KEY|login/); assert.equal(seen.length, n);
});

test("an unreachable engine fails the login plainly", async () => {
  const h = home();
  const r = await run(h, ["login", "--no-open"], { MEMORY_PULSE_API: "http://127.0.0.1:9" });
  assert.equal(r.code, 1); assert.match(r.all, /unreachable/);
});
