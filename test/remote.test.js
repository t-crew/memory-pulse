// `memory-pulse http` (lib/remote.mjs): the remote MCP server a claude.ai custom connector reaches. Driven end to end against a
// fake engine on localhost: discovery, client registration, the sign-in page, PKCE, tokens, the four tools through real
// worker processes, and the hosted ledger they read and write. The fake engine keeps one ledger per key and project, which
// is what lets the isolation tests mean something.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { seal, unseal, redirectOk, remoteTools, scheduler, createRemoteServer } from "../lib/remote.mjs";

const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "..", "server.mjs");
const SECRET = "test-secret-".padEnd(48, "x");
const KEYS = new Set(["key-alice", "key-bob"]);
const store = new Map();   // `${key}\0${project}` -> capsule
let engine, engineUrl, remote, base;

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));
const readBody = async (req) => { let s = ""; for await (const c of req) s += c; return s; };

before(async () => {
  engine = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x"); const key = req.headers["x-mp-key"]; const raw = await readBody(req);
    const json = (status, b) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (url.pathname === "/v1/state") {
      if (!KEYS.has(key)) return json(401, { error: "invalid key" });
      const id = `${key}\0${url.searchParams.get("project")}`;
      if (req.method === "GET") return store.has(id) ? json(200, store.get(id)) : json(404, { error: "no hosted state" });
      const cap = JSON.parse(raw); const had = store.get(id)?.rows ?? 0; store.set(id, cap);
      return json(200, { status: had ? "fast-forwarded" : "installed", rows: cap.rows, appended: cap.rows - had });
    }
    if (url.pathname === "/v1/pulse") { const b = JSON.parse(raw); return json(200, { brief: b.events.map((e) => `${e.cause} -> ${e.effect}`).join("\n"), project: b.project, n: b.events.length }); }
    return json(404, { error: "no route" });
  });
  engineUrl = await listen(engine);
  // the public address must be known before the server is built; take a port, then build on it
  const probe = createServer(); base = await listen(probe); await new Promise((r) => probe.close(r));
  const { TOOLS } = await import("../server.mjs");
  remote = createRemoteServer({ secret: SECRET, publicUrl: base, api: engineUrl, TOOLS, version: "test", log: () => {} });
  await new Promise((r) => remote.listen(Number(new URL(base).port), "127.0.0.1", r));
});
after(() => { remote?.close(); engine?.close(); });

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
async function register(redirect_uris = [REDIRECT]) {
  const r = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris }) });
  return { status: r.status, body: await r.json() };
}
// The whole sign-in, as claude.ai does it: register, open the page, submit the key, exchange the code with the verifier.
async function connect(key, project = "contractor-division") {
  const { body: client } = await register();
  const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", resource: `${base}/mcp` });
  const pageRes = await fetch(`${base}/authorize?${q}`); assert.equal(pageRes.status, 200);
  const html = await pageRes.text(); const form = /name="form" value="([^"]+)"/.exec(html)[1];
  const sub = await fetch(`${base}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ form, key, project }) });
  if (sub.status !== 302) return { refused: sub.status, html: await sub.text() };
  const loc = new URL(sub.headers.get("location"));
  assert.equal(`${loc.origin}${loc.pathname}`, REDIRECT); assert.equal(loc.searchParams.get("state"), "st-1");
  const code = loc.searchParams.get("code");
  const tok = await fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: `${base}/mcp` }) });
  return { client, code, verifier, tokens: await tok.json(), status: tok.status };
}
let nextId = 1;
async function rpc(token, method, params, headers = {}) {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }) });
  const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, headers: r.headers, body };
}
const toolJson = (r) => JSON.parse(r.body.result.content[0].text);

test("sealed values round-trip, and refuse another type, an edit, the wrong secret and expiry", () => {
  const t = seal({ typ: "at", k: "x", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  assert.equal(unseal(t, SECRET, "at").k, "x");
  assert.equal(unseal(t, SECRET, "rt"), null);
  assert.equal(unseal(t, "another-secret".padEnd(40, "y"), "at"), null);
  assert.equal(unseal(t.slice(0, -2) + (t.endsWith("A") ? "BB" : "AA"), SECRET, "at"), null);
  assert.equal(unseal(seal({ typ: "at", exp: 1 }, SECRET), SECRET, "at"), null);
  assert.ok(!t.includes("x\""), "the payload is not readable in the token");
});

test("redirect URIs: https, or http on loopback only", () => {
  assert.ok(redirectOk("https://claude.ai/api/mcp/auth_callback"));
  assert.ok(redirectOk("http://localhost:6274/oauth/callback"));
  assert.ok(!redirectOk("http://evil.example/cb"));
  assert.ok(!redirectOk("https://claude.ai/cb#frag"));
  assert.ok(!redirectOk("javascript:alert(1)"));
});

test("the remote tool list drops the agent scope and says remember goes to the hosted ledger", async () => {
  const { TOOLS } = await import("../server.mjs");
  const r = remoteTools(TOOLS).find((t) => t.name === "remember");
  assert.equal(r.inputSchema.properties.scope, undefined);
  assert.match(r.description, /hosted ledger/);
  assert.doesNotMatch(r.description, /fully local/);
  assert.equal(TOOLS.find((t) => t.name === "remember").inputSchema.properties.scope.type, "string", "the stdio list is not changed");
});

test("a server without a long secret refuses to start", async () => {
  const { TOOLS } = await import("../server.mjs");
  assert.throws(() => createRemoteServer({ secret: "short", publicUrl: "http://localhost:1", api: engineUrl, TOOLS }), /MEMORY_PULSE_HTTP_SECRET/);
});

test("discovery: /mcp without a token answers 401 pointing at the metadata, which points at the sign-in", async () => {
  const r = await rpc(null, "initialize", { protocolVersion: "2025-06-18" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), new RegExp(`resource_metadata="${base}/.well-known/oauth-protected-resource"`));
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(prm.resource, `${base}/mcp`); assert.deepEqual(prm.authorization_servers, [base]);
  const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(asm.issuer, base); assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);
  assert.equal(asm.registration_endpoint, `${base}/register`);
});

test("registration refuses a redirect that is not https (or loopback http)", async () => {
  assert.equal((await register(["http://evil.example/cb"])).status, 400);
  assert.equal((await register([])).status, 400);
  const ok = await register(); assert.equal(ok.status, 201); assert.equal(ok.body.token_endpoint_auth_method, "none");
});

test("the sign-in page escapes the client's name and refuses an unregistered redirect", async () => {
  const r = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "<script>x</script>", redirect_uris: [REDIRECT] }) });
  const { client_id } = await r.json();
  const q = (redirect_uri) => new URLSearchParams({ response_type: "code", client_id, redirect_uri, code_challenge: "a".repeat(43), code_challenge_method: "S256" });
  const page = await (await fetch(`${base}/authorize?${q(REDIRECT)}`)).text();
  assert.ok(!page.includes("<script>x"), "client name is escaped"); assert.match(page, /&lt;script&gt;x/);
  assert.equal((await fetch(`${base}/authorize?${q("https://attacker.example/cb")}`)).status, 400);
  const noPkce = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: REDIRECT })}`, { redirect: "manual" });
  assert.equal(noPkce.status, 302); assert.equal(new URL(noPkce.headers.get("location")).searchParams.get("error"), "invalid_request");
});

test("a key the engine refuses is not accepted on the sign-in page", async () => {
  const r = await connect("key-mallory");
  assert.equal(r.refused, 400); assert.match(r.html, /That key was refused/);
});

test("the token exchange needs the right verifier, and a code works once", async () => {
  const { body: client } = await register();
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  const form = /name="form" value="([^"]+)"/.exec(await (await fetch(`${base}/authorize?${q}`)).text())[1];
  const sub = await fetch(`${base}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ form, key: "key-alice", project: "p1" }) });
  const code = new URL(sub.headers.get("location")).searchParams.get("code");
  const exchange = (code_verifier) => fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier, client_id: client.client_id, redirect_uri: REDIRECT }) });
  const bad = await exchange("wrong-verifier-".padEnd(43, "z")); assert.equal(bad.status, 400); assert.equal((await bad.json()).error, "invalid_grant");
  const good = await exchange(verifier); assert.equal(good.status, 200);
  const t = await good.json(); assert.equal(t.token_type, "Bearer"); assert.ok(t.refresh_token);
  assert.ok(!t.access_token.includes("key-alice"), "the key is not readable in the token");
  const again = await exchange(verifier); assert.equal(again.status, 400); assert.match((await again.json()).error_description, /already used/);
});

test("end to end: sign in, list the tools, remember to the hosted ledger, pulse reads it back", async () => {
  const c = await connect("key-alice");
  assert.equal(c.status, 200);
  const at = c.tokens.access_token;
  const init = await rpc(at, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.status, 200); assert.equal(init.body.result.protocolVersion, "2025-06-18"); assert.ok(init.body.result.capabilities.tools);
  const note = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${at}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(note.status, 202);
  const list = await rpc(at, "tools/list");
  assert.deepEqual(list.body.result.tools.map((t) => t.name).sort(), ["execute", "pulse", "recall", "remember"]);

  const empty = toolJson(await rpc(at, "tools/call", { name: "pulse", arguments: {} }));
  assert.equal(empty.empty, true); assert.equal(empty.ledger, "hosted:contractor-division");

  const r1 = await rpc(at, "tools/call", { name: "remember", arguments: { cause: "pricing", effect: "price-corrected-to-29", kind: "correction", withdrawn: ["$19"], replacement: ["$29"] } });
  assert.equal(r1.body.result.isError, undefined, r1.body.result.content[0].text);
  const w1 = toolJson(r1); assert.equal(w1.written, true); assert.equal(w1.ledger, "hosted:contractor-division"); assert.equal(w1.hosted.status, "installed");
  const r2 = toolJson(await rpc(at, "tools/call", { name: "remember", arguments: { cause: "deploy", effect: "moved-to-fly" } }));
  assert.equal(r2.hosted.status, "fast-forwarded");

  const stored = store.get("key-alice\0contractor-division");
  assert.equal(stored.rows, 2, "two rows, and no state-resumed row from the pull");
  assert.ok(stored.lines.every((l) => !l.includes("state-resumed")));
  assert.ok(!JSON.stringify(stored).includes("mp-http-"), "no temporary path reaches the hosted ledger");

  const pulse = toolJson(await rpc(at, "tools/call", { name: "pulse", arguments: {} }));
  assert.equal(pulse.n, 2); assert.match(pulse.brief, /pricing -> price-corrected-to-29/); assert.equal(pulse.project, "contractor-division");
});

test("isolation: another key, or another project, sees none of it", async () => {
  const bob = (await connect("key-bob")).tokens.access_token;
  const seen = toolJson(await rpc(bob, "tools/call", { name: "pulse", arguments: {} }));
  assert.equal(seen.empty, true, "bob's ledger for the same project name is his own");
  const other = (await connect("key-alice", "another-project")).tokens.access_token;
  assert.equal(toolJson(await rpc(other, "tools/call", { name: "pulse", arguments: {} })).empty, true);
});

test("refusals: a bad or edited token, a foreign origin, the agent scope, an unknown tool", async () => {
  const c = await connect("key-alice", "refusals");
  const at = c.tokens.access_token;
  const edited = await rpc(at.slice(0, -3) + "abc", "tools/list");
  assert.equal(edited.status, 401); assert.match(edited.headers.get("www-authenticate"), /invalid_token/);
  assert.equal((await rpc(c.tokens.refresh_token, "tools/list")).status, 401, "a refresh token is not an access token");
  assert.equal((await rpc(at, "tools/list", null, { origin: "https://evil.example" })).status, 403);
  assert.equal((await rpc(at, "tools/list", null, { origin: "https://claude.ai" })).status, 200);
  const agent = await rpc(at, "tools/call", { name: "remember", arguments: { cause: "a", effect: "b", scope: "agent" } });
  assert.equal(agent.body.result.isError, true);
  assert.equal((await rpc(at, "tools/call", { name: "board_post", arguments: {} })).body.result.isError, true);
  assert.equal((await rpc(at, "no/such")).body.error.code, -32601);
  const get = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${at}` } }); assert.equal(get.status, 405);
});

test("a refresh token gets a new access token for the same key and project", async () => {
  const c = await connect("key-alice", "refreshed");
  const r = await fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.tokens.refresh_token, client_id: c.client.client_id }) });
  assert.equal(r.status, 200); const t = await r.json();
  const p = unseal(t.access_token, SECRET, "at"); assert.equal(p.k, "key-alice"); assert.equal(p.p, "refreshed");
  const wrong = await fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.tokens.refresh_token, client_id: "someone-else" }) });
  assert.equal(wrong.status, 400);
});

test("the scheduler runs one call at a time per person and several people side by side", async () => {
  const run = scheduler({ workers: 2 }); const log = [];
  const job = (tag, ms) => () => new Promise((r) => { log.push(`start ${tag}`); setTimeout(() => { log.push(`end ${tag}`); r(tag); }, ms); });
  await Promise.all([run("a", job("a1", 30)), run("a", job("a2", 5)), run("b", job("b1", 5))]);
  assert.ok(log.indexOf("end a1") < log.indexOf("start a2"), log.join(", "));
  assert.ok(log.indexOf("start b1") < log.indexOf("end a1"), "b does not wait for a");
});

test("`memory-pulse http` refuses to start without a secret, and serves the metadata with one", async () => {
  const bare = await new Promise((r) => { const c = spawn(process.execPath, [SERVER, "http", "--port", "0"], { env: { PATH: process.env.PATH, HOME: process.env.HOME } }); let e = ""; c.stderr.on("data", (d) => { e += d; }); c.on("close", (code) => r({ code, e })); });
  assert.equal(bare.code, 1); assert.match(bare.e, /MEMORY_PULSE_HTTP_SECRET/);
  const probe = createServer(); const url = await listen(probe); await new Promise((r) => probe.close(r));
  const port = new URL(url).port;
  const child = spawn(process.execPath, [SERVER, "http", "--port", port, "--host", "127.0.0.1"], { env: { PATH: process.env.PATH, HOME: process.env.HOME, MEMORY_PULSE_HTTP_SECRET: SECRET, MEMORY_PULSE_API: engineUrl } });
  try {
    await new Promise((r, j) => { let e = ""; child.stderr.on("data", (d) => { e += d; if (e.includes("MCP at")) r(); }); child.on("close", () => j(new Error(e))); });
    const prm = await (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`)).json();
    assert.equal(prm.resource, `http://localhost:${port}/mcp`);
  } finally { child.kill(); }
});
