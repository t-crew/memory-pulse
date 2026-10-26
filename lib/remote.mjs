// memory-pulse over HTTP (0.17.0): the four tools as a remote MCP server, so a client that only takes a URL (a claude.ai
// custom connector, Claude Duet, any Streamable HTTP client) can use the same memory the stdio server uses.
//
// What runs where, stated plainly because it is the privacy contract here too:
//
//   - The memory lives in the person's hosted ledger on the engine (`memory-pulse state push|pull`, GET/POST /v1/state),
//     reached with their own project key. This server keeps no ledger, no key and no token store of its own.
//   - The key is entered once, on this server's own sign-in page, and travels only inside tokens this server encrypts
//     (AES-256-GCM under MEMORY_PULSE_HTTP_SECRET). The client holds the token; nobody holds a readable key.
//   - Every tool call runs in a fresh child process with that person's key, a temporary folder and nothing else in
//     its environment: pull the hosted ledger, run the call through the same handleCall the stdio server runs, push
//     after a `remember`, delete the folder. Two people's calls never share a process, a folder or a variable.
//
// Transport: MCP Streamable HTTP (2025-06-18), answered as JSON (no SSE stream: every call returns one response).
// Sign-in: OAuth 2.1 with PKCE (S256) and dynamic client registration, which is what claude.ai custom connectors use.
// Stateless by design: client ids, codes and tokens are sealed values, so the server can restart or run as several
// copies behind one secret. The one in-memory state is the set of codes already exchanged (single use per copy).
//
// No dependencies, like the rest of the client.
import { createServer } from "node:http";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "remote-worker.mjs");
export const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const ACCESS_TTL = 3600, REFRESH_TTL = 30 * 86400, CODE_TTL = 300, FORM_TTL = 900;
const MAX_BODY = 1 << 20;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const DEFAULT_PROJECT = "claude";

// ------------------------------------------------------------- sealing ----
// One sealed format for every value this server hands out: "mp1." + base64url(iv | tag | ciphertext). The payload says
// what it is (typ) and when it ends (exp); unseal refuses a wrong type, an expired value and anything edited.
const keyOf = (secret) => createHash("sha256").update(`memory-pulse-http-v1\0${secret}`).digest();
export function seal(payload, secret) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()]);
  return `mp1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url")}`;
}
export function unseal(token, secret, typ, now = Date.now()) {
  if (typeof token !== "string" || !token.startsWith("mp1.") || token.length > 8192) return null;
  try {
    const raw = Buffer.from(token.slice(4), "base64url");
    if (raw.length < 29) return null;
    const d = createDecipheriv("aes-256-gcm", keyOf(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const p = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
    if (!p || p.typ !== typ) return null;
    if (typeof p.exp === "number" && p.exp * 1000 <= now) return null;
    return p;
  } catch { return null; }
}
const nowS = () => Math.floor(Date.now() / 1000);
const s256 = (v) => createHash("sha256").update(v).digest("base64url");
const sameStr = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

// ------------------------------------------------------- redirect URIs ----
// https anywhere, or http on the loopback host only (desktop clients). No fragment, no credentials in the URL.
export function redirectOk(u) {
  let url; try { url = new URL(u); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

// ------------------------------------------------------------- tools ----
// The stdio tool list, with two changes that are true only here: remember writes to the hosted ledger, not a local file,
// and there is no agent scope (the agent ledger is a file in the home folder of the machine that runs the client).
export function remoteTools(TOOLS) {
  return TOOLS.map((t) => {
    if (t.name !== "remember") return t;
    const { scope, ...properties } = t.inputSchema.properties;
    return { ...t, description: t.description.replace(/Cheap, idempotent, and fully local \(works offline\)\./, "Recorded in your hosted ledger, the same one `memory-pulse state pull` brings to your other machines."), inputSchema: { ...t.inputSchema, properties } };
  });
}

// ------------------------------------------------------------ workers ----
// One child process per call. The environment is built from nothing: PATH, the person's key, their project, the engine,
// and folders inside the call's own temporary directory. MEMORY_PULSE_HTTP_SECRET never reaches a worker.
export function runWorker({ key, project, api, name, args, timeoutMs = 60_000, node = process.execPath }) {
  const dir = mkdtempSync(join(tmpdir(), "mp-http-"));
  const env = {
    PATH: process.env.PATH ?? "", HOME: dir, MEMORY_PULSE_KEY: key, MEMORY_PULSE_PROJECT: project, MEMORY_PULSE_API: api,
    MEMORY_PULSE_LEDGER: join(dir, ".memory-pulse", "events.jsonl"), MEMORY_PULSE_TRUST_DIR: join(dir, "trust"),
    MEMORY_PULSE_DATA_DIR: join(dir, "data"), MEMORY_PULSE_MEMORY_KEY: "off", MEMORY_PULSE_TELEMETRY: "off", DO_NOT_TRACK: "1",
    ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
  };
  return new Promise((resolve) => {
    let out = "", err = "", done = false;
    const child = spawn(node, [WORKER], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } resolve(v); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ ok: false, error: `the call took longer than ${Math.round(timeoutMs / 1000)} s and was stopped` }); }, timeoutMs);
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { if (err.length < 4000) err += c; });
    child.on("error", (e) => finish({ ok: false, error: `worker failed to start (${e.message})` }));
    child.on("close", () => {
      try { finish(JSON.parse(out)); }
      catch { finish({ ok: false, error: `worker ended without an answer${err.trim() ? `: ${err.trim().split("\n").slice(-1)[0].slice(0, 300)}` : ""}` }); }
    });
    child.stdin.end(JSON.stringify({ name, args }));
  });
}

// Calls for one person (key + project) run one at a time, so two `remember` calls cannot push past each other; calls for
// different people run side by side up to `workers`, and the rest wait in line up to `queue`.
export function scheduler({ workers = 4, queue = 64 } = {}) {
  const tenants = new Map(); let running = 0; const waiting = [];
  const slot = () => (running < workers ? (running++, Promise.resolve()) : waiting.length >= queue ? Promise.reject(new Error("the server is busy; try again in a moment")) : new Promise((r) => waiting.push(r)));
  const release = () => { const next = waiting.shift(); if (next) next(); else running--; };
  return function run(tenant, job) {
    const prev = tenants.get(tenant) ?? Promise.resolve();
    const mine = prev.catch(() => {}).then(async () => { await slot(); try { return await job(); } finally { release(); } });
    const tail = mine.catch(() => {});
    tenants.set(tenant, tail);
    tail.then(() => { if (tenants.get(tenant) === tail) tenants.delete(tenant); });
    return mine;
  };
}

// ---------------------------------------------------------------- html ----
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function signInPage({ client, redirectHost, form, project, error, consoleUrl }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect memory-pulse</title><meta name="referrer" content="no-referrer">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
label{display:block;margin:1rem 0 .25rem;font-weight:600}input{width:100%;box-sizing:border-box;padding:.6rem;font:inherit;border:1px solid #bbb;border-radius:6px}
button{margin-top:1.25rem;padding:.6rem 1.2rem;font:inherit;border:0;border-radius:6px;background:#5b3fd1;color:#fff;cursor:pointer}
.err{background:#fdecea;border:1px solid #f5c2c0;padding:.6rem;border-radius:6px}.small{font-size:.875rem;color:#555}</style></head><body>
<h1>Connect memory-pulse</h1>
<p><strong>${esc(client)}</strong> is asking to use your memory-pulse memory. You will be sent back to <strong>${esc(redirectHost)}</strong>.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="authorize" autocomplete="off">
<input type="hidden" name="form" value="${esc(form)}">
<label for="key">Project key</label><input id="key" name="key" type="password" required spellcheck="false">
<p class="small">Make one in the console: <a href="${esc(consoleUrl)}" target="_blank" rel="noopener">${esc(consoleUrl)}</a>. It is kept only inside the encrypted token your client holds.</p>
<label for="project">Project</label><input id="project" name="project" value="${esc(project)}" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" required spellcheck="false">
<p class="small">The hosted ledger to use. To share memory with a project on your computer, use the name it has there (its folder name, or MEMORY_PULSE_PROJECT).</p>
<button type="submit">Connect</button></form></body></html>`;
}

// ------------------------------------------------------------- server ----
/**
 * createRemoteServer({ secret, publicUrl, api, TOOLS, validateKey?, workers?, queue?, timeoutMs?, log? }) -> http.Server
 * publicUrl is the address clients reach (https://host, no path); the MCP endpoint is publicUrl + "/mcp".
 */
export function createRemoteServer(opts) {
  const { secret, api, TOOLS } = opts;
  if (typeof secret !== "string" || secret.length < 32) throw new Error("MEMORY_PULSE_HTTP_SECRET must be set to at least 32 characters (for example: openssl rand -hex 32)");
  const base = String(opts.publicUrl).replace(/\/+$/, "");
  const resource = `${base}/mcp`;
  const tools = remoteTools(TOOLS);
  const run = scheduler({ workers: opts.workers, queue: opts.queue });
  const callTool = opts.callTool ?? ((t, name, args) => runWorker({ key: t.k, project: t.p, api, name, args, timeoutMs: opts.timeoutMs }));
  const validateKey = opts.validateKey ?? ((key, project) => defaultValidateKey(api, key, project));
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  const allowedOrigins = new Set(["https://claude.ai", "https://claude.com", base, ...(opts.origins ?? [])]);
  const usedCodes = new Map();
  const spend = (code, exp) => { const t = nowS(); for (const [c, e] of usedCodes) if (e <= t) usedCodes.delete(c); if (usedCodes.has(code)) return false; usedCodes.set(code, exp); return true; };

  const prm = { resource, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: ["memory"], resource_name: "memory-pulse" };
  const asm = {
    issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["memory"],
  };
  const challenge = `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`;
  // a resource indicator, when a client sends one, must name this server
  const targetOk = (r) => r == null || r === "" || [resource, base].includes(String(r).replace(/\/+$/, ""));

  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body !== "string";
    res.writeHead(status, { "content-type": isJson ? "application/json" : "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
    res.end(isJson ? JSON.stringify(body) : body);
  };
  const oauthError = (res, status, error, description) => send(res, status, { error, error_description: description });

  function authorizeParams(q) {
    const client = unseal(q.client_id, secret, "client");
    if (!client) return { error: "unknown client_id (register the client first)" };
    if (!q.redirect_uri || !client.r.includes(q.redirect_uri)) return { error: "redirect_uri is not one this client registered" };
    // from here on the redirect is trusted, so errors go back to the client
    const back = (error, description) => ({ redirect: withQuery(q.redirect_uri, { error, error_description: description, state: q.state }) });
    if (q.response_type !== "code") return back("unsupported_response_type", "only code is supported");
    if (q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge ?? "")) return back("invalid_request", "PKCE with S256 is required");
    if (!targetOk(q.resource)) return back("invalid_target", `resource must be ${resource}`);
    return { ok: { client_id: q.client_id, name: client.n, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, state: q.state ?? null } };
  }
  const page = (res, p, { error = null, project = DEFAULT_PROJECT, status = 200 } = {}) =>
    send(res, status, signInPage({ client: p.name || "An MCP client", redirectHost: new URL(p.redirect_uri).host, project, error, consoleUrl: `${api}/app`,
      form: seal({ typ: "form", exp: nowS() + FORM_TTL, ...p }, secret) }), { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'" });

  function issue(k, p, client_id) {
    const at = seal({ typ: "at", k, p, aud: resource, exp: nowS() + ACCESS_TTL }, secret);
    const rt = seal({ typ: "rt", k, p, c: client_id, exp: nowS() + REFRESH_TTL }, secret);
    return { access_token: at, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: rt, scope: "memory" };
  }

  async function mcp(msg, tenant) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "invalid request" } };
    const { id, method, params } = msg;
    const ok = (result) => (id === undefined ? null : { jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      const wanted = params?.protocolVersion;
      return ok({ protocolVersion: PROTOCOLS.includes(wanted) ? wanted : PROTOCOLS[0], capabilities: { tools: {} },
        serverInfo: { name: "memory-pulse", version: opts.version ?? "0.0.0" },
        instructions: `Memory for project "${tenant.p}", kept in its hosted ledger. Call pulse before answering questions about prior work; record corrections with remember (kind correction, with withdrawn terms).` });
    }
    if (id === undefined) return null;   // notifications/initialized and every other notification: nothing to answer
    if (method === "ping") return ok({});
    if (method === "tools/list") return ok({ tools });
    if (method === "tools/call") {
      const name = params?.name, args = params?.arguments ?? {};
      if (!tools.some((t) => t.name === name)) return ok({ content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true });
      if (name === "remember" && args.scope === "agent") return ok({ content: [{ type: "text", text: "the agent scope lives on the machine that runs the client; this connector records to the project's hosted ledger only" }], isError: true });
      let out;
      try { out = await run(createHash("sha256").update(`${tenant.k}\0${tenant.p}`).digest("hex"), () => callTool(tenant, name, args)); }
      catch (e) { out = { ok: false, error: String(e?.message ?? e) }; }
      return out.ok ? ok({ content: [{ type: "text", text: JSON.stringify(out.result, null, 2) }] }) : ok({ content: [{ type: "text", text: out.error }], isError: true });
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  }

  async function handle(req, res) {
    const url = new URL(req.url, base);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const q = Object.fromEntries(url.searchParams);

    if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) return send(res, 200, prm);
    if (req.method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp")) return send(res, 200, asm);
    if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true });
    if (req.method === "GET" && path === "/") return send(res, 200, { name: "memory-pulse", mcp: resource, docs: "https://github.com/t-crew/memory-pulse/blob/main/docs/REMOTE.md" });

    if (path === "/register" && req.method === "POST") {
      const b = await body(req, res); if (!b) return;
      const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
      if (!uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && u.length <= 2000 && redirectOk(u))) return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris must be 1 to 10 https URLs (http only on localhost)");
      const name = typeof b.client_name === "string" ? b.client_name.replace(/[\u0000-\u001f]/g, "").slice(0, 100) : "";
      const client_id = seal({ typ: "client", r: uris, n: name }, secret);
      return send(res, 201, { client_id, client_id_issued_at: nowS(), client_name: name || undefined, redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
    }

    if (path === "/authorize" && req.method === "GET") {
      const a = authorizeParams(q);
      if (a.error) return send(res, 400, `<!doctype html><meta charset="utf-8"><title>memory-pulse</title><p>${esc(a.error)}</p>`);
      if (a.redirect) { res.writeHead(302, { location: a.redirect, "cache-control": "no-store" }); return res.end(); }
      return page(res, a.ok);
    }
    if (path === "/authorize" && req.method === "POST") {
      const b = await body(req, res); if (!b) return;
      const p = unseal(b.form, secret, "form");
      if (!p) return send(res, 400, `<!doctype html><meta charset="utf-8"><title>memory-pulse</title><p>This sign-in page expired. Start connecting again from your client.</p>`);
      const { typ, exp, ...params } = p;
      const key = String(b.key ?? "").trim(), project = String(b.project ?? "").trim() || DEFAULT_PROJECT;
      if (!key || key.length > 512) return page(res, params, { error: "Enter your project key.", project, status: 400 });
      if (!PROJECT_RE.test(project)) return page(res, params, { error: "A project name is letters, digits, dot, dash or underscore, up to 64 characters.", project, status: 400 });
      const v = await validateKey(key, project);
      if (!v.ok) return page(res, params, { error: v.error, project, status: 400 });
      const code = seal({ typ: "code", k: key, p: project, c: params.client_id, r: params.redirect_uri, ch: params.code_challenge, exp: nowS() + CODE_TTL }, secret);
      log(`memory-pulse http: connected a client to project ${project}`);
      res.writeHead(302, { location: withQuery(params.redirect_uri, { code, state: params.state }), "cache-control": "no-store" });
      return res.end();
    }

    if (path === "/token" && req.method === "POST") {
      const b = await body(req, res); if (!b) return;
      if (b.grant_type === "authorization_code") {
        const c = unseal(b.code, secret, "code");
        if (!c || !sameStr(c.c, b.client_id ?? "") || c.r !== b.redirect_uri) return oauthError(res, 400, "invalid_grant", "the code is invalid, expired, or was issued to another client or redirect_uri");
        if (typeof b.code_verifier !== "string" || !sameStr(s256(b.code_verifier), c.ch)) return oauthError(res, 400, "invalid_grant", "code_verifier does not match the code_challenge");
        if (!targetOk(b.resource)) return oauthError(res, 400, "invalid_target", `resource must be ${resource}`);
        if (!spend(createHash("sha256").update(b.code).digest("hex"), c.exp)) return oauthError(res, 400, "invalid_grant", "the code was already used");
        return send(res, 200, issue(c.k, c.p, c.c));
      }
      if (b.grant_type === "refresh_token") {
        const r = unseal(b.refresh_token, secret, "rt");
        if (!r || (b.client_id && !sameStr(r.c, b.client_id))) return oauthError(res, 400, "invalid_grant", "the refresh token is invalid or expired");
        if (!targetOk(b.resource)) return oauthError(res, 400, "invalid_target", `resource must be ${resource}`);
        return send(res, 200, issue(r.k, r.p, r.c));
      }
      return oauthError(res, 400, "unsupported_grant_type", "authorization_code or refresh_token");
    }

    if (path === "/mcp") {
      // DNS rebinding: a browser page may not drive this endpoint from another origin
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) return send(res, 403, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "origin not allowed" } });
      const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
      const tenant = auth ? unseal(auth[1], secret, "at") : null;
      if (!tenant || tenant.aud !== resource) return send(res, 401, { error: "invalid_token", error_description: auth ? "the access token is invalid or expired" : "sign in to use this server" }, { "www-authenticate": auth ? `${challenge}, error="invalid_token"` : challenge });
      if (req.method === "GET") return send(res, 405, { error: "this server answers each POST with JSON and offers no event stream" }, { allow: "POST" });
      if (req.method === "DELETE") return send(res, 405, { error: "this server keeps no sessions" }, { allow: "POST" });
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }, { allow: "POST" });
      const b = await body(req, res, { json: true }); if (!b) return;
      if (Array.isArray(b)) {
        if (!b.length) return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "empty batch" } });
        const outs = (await Promise.all(b.map((m) => mcp(m, tenant)))).filter(Boolean);
        if (!outs.length) { res.writeHead(202); return res.end(); }
        return send(res, 200, outs);
      }
      const out = await mcp(b, tenant);
      if (!out) { res.writeHead(202); return res.end(); }
      return send(res, 200, out);
    }
    return send(res, 404, { error: "not found" });
  }

  // Bodies: JSON or a form, at most 1 MiB. Returns null after answering when the body cannot be read.
  async function body(req, res, { json = false } = {}) {
    let raw = "", size = 0;
    try {
      for await (const c of req) { size += c.length; if (size > MAX_BODY) { send(res, 413, { error: "request body too large" }); return null; } raw += c; }
    } catch { send(res, 400, { error: "could not read the request body" }); return null; }
    const type = String(req.headers["content-type"] ?? "");
    try {
      if (json || type.includes("application/json")) return JSON.parse(raw);
      return Object.fromEntries(new URLSearchParams(raw));
    } catch {
      if (json) send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); else send(res, 400, { error: "invalid_request", error_description: "the body is not JSON or a form" });
      return null;
    }
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`memory-pulse http: ${e?.message ?? e}`);
      if (!res.headersSent) send(res, 500, { error: "server_error" }); else res.end();
    });
  });
}

function withQuery(u, params) {
  const url = new URL(u);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, v);
  return url.toString();
}

// A key the engine refuses (401 or 403) is not accepted on the sign-in page. Any other answer, including 404 for a project
// with nothing stored yet, means the key is good; an unreachable engine is said to be.
export async function defaultValidateKey(api, key, project) {
  try {
    const res = await fetch(`${api}/v1/state?project=${encodeURIComponent(project)}`, { headers: { "x-mp-key": key }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "That key was refused. Check it in the console, or make a new one." };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `The memory-pulse service could not be reached just now (${e?.cause?.code ?? e?.name ?? "error"}). Try again in a moment.` };
  }
}

/** `memory-pulse http`: read the settings, start listening, say where. */
export async function cliHttp({ env = process.env, argv = [], TOOLS, version, api }) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const port = Number(flag("port") ?? env.MEMORY_PULSE_HTTP_PORT ?? env.PORT ?? 8787);
  const host = flag("host") ?? env.MEMORY_PULSE_HTTP_HOST ?? "0.0.0.0";
  const publicUrl = flag("url") ?? env.MEMORY_PULSE_HTTP_URL ?? `http://localhost:${port}`;
  const workers = Number(env.MEMORY_PULSE_HTTP_WORKERS ?? 4);
  if (!/^https:\/\//.test(publicUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(publicUrl.replace(/\/+$/, ""))) {
    throw new Error(`MEMORY_PULSE_HTTP_URL must be the https address clients reach (got ${publicUrl})`);
  }
  const server = createRemoteServer({ secret: env.MEMORY_PULSE_HTTP_SECRET, publicUrl, api, TOOLS, version, workers: Number.isFinite(workers) && workers > 0 ? workers : 4 });
  await new Promise((r) => server.listen(port, host, r));
  process.stderr.write(`memory-pulse http: MCP at ${publicUrl.replace(/\/+$/, "")}/mcp (listening on ${host}:${port}); engine ${api}\n`);
  return server;
}
