// `memory-pulse login | logout` (2026-10-21): connect a machine to a hosted project without handling a key. The CLI starts a device
// request on the engine (the shape of RFC 8628), shows the code and opens the console; the signed-in owner approves it there for a
// project; the CLI's poll receives the key once and saves it to ~/.config/memory-pulse/key (mode 600). Every command then uses that key
// when MEMORY_PULSE_KEY is unset. Login also turns board sync on for this folder's board and pushes it. Tests: test/login.test.js.
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export const configDir = () => join(homedir(), ".config", "memory-pulse");
export const keyFile = () => join(configDir(), "key");
const loginFile = () => join(configDir(), "login.json");

const DEFAULT_API = "https://pulse.strategic-innovations.ai";
const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };
const currentApi = () => (process.env.MEMORY_PULSE_API ?? DEFAULT_API).replace(/\/$/, "");
// printed values come from the network: control characters never reach the terminal (review 2026-10-21, finding 7)
const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

/**
 * The key `memory-pulse login` saved, or null. Only for the engine it came from: login.json records that engine's origin, and a
 * different MEMORY_PULSE_API never receives it (review 2026-10-21, finding 2). Read once at start-up; never printed.
 */
export function savedKey(api = currentApi()) {
  try {
    const info = JSON.parse(readFileSync(loginFile(), "utf8"));
    if (!info.api || info.api !== originOf(api)) return null;
    const k = readFileSync(keyFile(), "utf8").trim(); return /^mp_live_[0-9a-f]{32,}$/.test(k) ? k : null;
  } catch { return null; }
}

// written whole or not at all, readable only by the user from its first byte (review, finding 13)
function writePrivate(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  try { writeFileSync(tmp, text, { mode: 0o600, flag: "wx" }); renameSync(tmp, path); } catch (e) { try { unlinkSync(tmp); } catch { /* not created */ } throw e; }
}

function openBrowser(url) {
  // no shell: cmd /c start would read & in the URL as a second command (review, finding 7)
  const [cmd, args] = platform() === "darwin" ? ["open", [url]] : platform() === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try { const p = spawn(cmd, args, { stdio: "ignore", detached: true }); p.on("error", () => {}); p.unref(); } catch { /* the link is printed anyway */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function cliLogin(argv, { api, version }) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const post = async (path, body) => {
    const res = await fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    let b = {}; try { b = await res.json(); } catch { /* not JSON */ } return { status: res.status, body: b };
  };
  const old = savedKey(api);                // proves the key this login replaces; the engine never sees the key itself (review, 1)
  const startBody = { host: hostname(), client: `memory-pulse ${version}`, ...(old ? { replaces: createHash("sha256").update(old).digest("hex") } : {}) };
  let start;
  try { start = await post("/v1/auth/device", startBody); }
  catch (e) { console.error(`memory-pulse login: the engine is unreachable at ${api} (${e?.cause?.code ?? e.message})`); return 1; }
  if (start.status !== 200 || !start.body.device_code) { console.error(`memory-pulse login: ${start.status} — ${start.body.error ?? "the engine refused the request"}`); return 1; }
  const s = start.body, code = clean(s.user_code), mine = originOf(api);
  // the link is built here, on this engine's own origin; the engine's link is opened only when it is exactly that (review, 7)
  const link = `${mine}/app?device=${encodeURIComponent(code)}`;
  const sent = String(s.verification_uri_complete ?? ""), safe = originOf(sent) === mine && sent === link && /^https?:$/.test(new URL(link).protocol);
  console.log(`To connect this machine, open\n  ${link}\nand check that the page shows the code  ${code}\nthen choose a project and approve. Waiting up to ${Math.round(Number(s.expires_in) / 60) || 10} minutes...`);
  if (!safe) console.error("memory-pulse login: not opening the link the engine sent (it is not this engine's console page); open the one above yourself");
  else if (!flags.has("--no-open") && !process.env.CI) openBrowser(link);
  const deadline = Date.now() + s.expires_in * 1000; let interval = Math.max(1, Number(s.interval) || 5);
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    let r; try { r = await post("/v1/auth/device/token", { device_code: s.device_code }); } catch { continue; }    // a dropped poll is retried
    if (r.status >= 500 || r.status === 429) continue;                                                          // so is a server error (review, 9)
    if (r.status === 200 && r.body.key) return finish(r.body, flags, mine);
    const e = r.body.error;
    if (e === "authorization_pending") { if (r.body.interval) interval = Math.max(1, Number(r.body.interval)); continue; }
    if (e === "slow_down") { interval += 5; continue; }
    if (e === "access_denied") { console.error("memory-pulse login: the request was denied in the console; nothing was saved"); return 1; }
    if (e === "expired_token") break;
    if (r.body.message) { console.error(`memory-pulse login: ${clean(r.body.message)}`); return 1; }
    console.error(`memory-pulse login: ${r.status} — ${e ?? "unexpected answer"}`); return 1;
  }
  console.error("memory-pulse login: the request expired before it was approved; nothing was saved. Run memory-pulse login again"); return 1;
}

async function finish(t, flags, api) {
  if (!/^mp_live_[0-9a-f]{32,}$/.test(String(t.key ?? ""))) { console.error("memory-pulse login: the engine sent something that is not a key; nothing was saved"); return 1; }
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writePrivate(keyFile(), t.key + "\n");
  writePrivate(loginFile(), JSON.stringify({ api, project: t.project ?? null, prefix: t.prefix ?? null, hosted: !!t.hosted, replaced: t.replaced ?? null, saved: new Date().toISOString() }, null, 2) + "\n");
  const name = clean(t.project?.name ?? "?");
  console.log(`Logged in: project ${name}; key ${clean(t.prefix ?? "")} saved to ${keyFile()} (only you can read it)${t.replaced ? `; it replaces ${clean(t.replaced)}, now revoked` : ""}.`);
  if (process.env.MEMORY_PULSE_KEY) console.error("memory-pulse login: MEMORY_PULSE_KEY is set in this shell, so commands here keep using that key, not the new one; unset it to use the login");
  if (flags.has("--no-sync")) return 0;
  const B = await import("./board.mjs"); const path = B.boardPath(null), cfg = B.syncConfig(path);
  B.setSync(path, { on: true, project: cfg.project });                     // a configured project is kept (review, 12)
  console.log(`Board sync turned on for ${path} (\`memory-pulse board sync off\` stops it).`);
  if (!t.hosted) { console.log(`Hosted memory is off for ${name}: turn it on in the console and the next post syncs.`); return 0; }
  const r = await B.pushBoard(path, { key: t.key, project: cfg.project });  // this process read its key before the login
  console.log(r.pushed ? `First push: ${r.status}; open the project's Board in the console.` : `First push did not go through (${clean(r.reason)}); the next post retries.`);
  return 0;
}

export function cliLogout() {
  let info = null; try { info = JSON.parse(readFileSync(loginFile(), "utf8")); } catch { /* never logged in */ }
  for (const f of [keyFile(), loginFile()]) { try { unlinkSync(f); } catch { /* already gone */ } }
  console.log(`Logged out: the saved key${info?.prefix ? ` ${info.prefix}` : ""} is removed from this machine. It keeps working until you revoke it in the console (Keys).`);
  return 0;
}
