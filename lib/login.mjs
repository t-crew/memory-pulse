// `memory-pulse login | logout` (2026-10-21): connect a machine to a hosted project without handling a key. The CLI starts a device
// request on the engine (the shape of RFC 8628), shows the code and opens the console; the signed-in owner approves it there for a
// project; the CLI's poll receives the key once and saves it to ~/.config/memory-pulse/key (mode 600). Every command then uses that key
// when MEMORY_PULSE_KEY is unset. Login also turns board sync on for this folder's board and pushes it. Tests: test/login.test.js.
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export const configDir = () => join(homedir(), ".config", "memory-pulse");
export const keyFile = () => join(configDir(), "key");
const loginFile = () => join(configDir(), "login.json");

/** The key `memory-pulse login` saved, or null. Read once at start-up; never printed. */
export function savedKey() {
  try { const k = readFileSync(keyFile(), "utf8").trim(); return /^mp_live_[0-9a-f]{32,}$/.test(k) ? k : null; } catch { return null; }
}

function openBrowser(url) {
  const [cmd, args] = platform() === "darwin" ? ["open", [url]] : platform() === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { const p = spawn(cmd, args, { stdio: "ignore", detached: true }); p.on("error", () => {}); p.unref(); } catch { /* the link is printed anyway */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function cliLogin(argv, { api, version }) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const post = async (path, body) => {
    const res = await fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    let b = {}; try { b = await res.json(); } catch { /* not JSON */ } return { status: res.status, body: b };
  };
  let start;
  try { start = await post("/v1/auth/device", { host: hostname(), client: `memory-pulse ${version}` }); }
  catch (e) { console.error(`memory-pulse login: the engine is unreachable at ${api} (${e?.cause?.code ?? e.message})`); return 1; }
  if (start.status !== 200 || !start.body.device_code) { console.error(`memory-pulse login: ${start.status} — ${start.body.error ?? "the engine refused the request"}`); return 1; }
  const s = start.body;
  console.log(`To connect this machine, open\n  ${s.verification_uri_complete}\nand check that the page shows the code  ${s.user_code}\nthen choose a project and approve. Waiting up to ${Math.round(s.expires_in / 60)} minutes...`);
  if (!flags.has("--no-open") && !process.env.CI) openBrowser(s.verification_uri_complete);
  const deadline = Date.now() + s.expires_in * 1000; let interval = Math.max(1, Number(s.interval) || 5);
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    let r; try { r = await post("/v1/auth/device/token", { device_code: s.device_code }); } catch { continue; }    // a dropped poll is retried
    if (r.status === 200 && r.body.key) return finish(r.body, flags);
    const e = r.body.error;
    if (e === "authorization_pending") { if (r.body.interval) interval = Math.max(1, Number(r.body.interval)); continue; }
    if (e === "slow_down") { interval += 5; continue; }
    if (e === "access_denied") { console.error("memory-pulse login: the request was denied in the console; nothing was saved"); return 1; }
    if (e === "expired_token") break;
    console.error(`memory-pulse login: ${r.status} — ${e ?? "unexpected answer"}`); return 1;
  }
  console.error("memory-pulse login: the request expired before it was approved; nothing was saved. Run memory-pulse login again"); return 1;
}

async function finish(t, flags) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(keyFile(), t.key + "\n", { mode: 0o600 }); chmodSync(keyFile(), 0o600);
  writeFileSync(loginFile(), JSON.stringify({ project: t.project ?? null, prefix: t.prefix ?? null, hosted: !!t.hosted, saved: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  console.log(`Logged in: project ${t.project?.name ?? "?"}; key ${t.prefix ?? ""} saved to ${keyFile()} (only you can read it).`);
  if (flags.has("--no-sync")) return 0;
  const B = await import("./board.mjs"); const path = B.boardPath(null);
  B.setSync(path, { on: true, project: null });
  if (!t.hosted) { console.log(`Board sync is on for ${path}, but hosted memory is off for ${t.project?.name ?? "the project"}: turn it on in the console and the next post syncs.`); return 0; }
  const r = await B.pushBoard(path, { key: t.key });                       // this process read its key before the login
  console.log(r.pushed ? `Board sync is on for ${path} (${r.status}); open the project's Board in the console.`
    : `Board sync is on for ${path}; the first push did not go through (${r.reason}), and the next post retries.`);
  return 0;
}

export function cliLogout() {
  let info = null; try { info = JSON.parse(readFileSync(loginFile(), "utf8")); } catch { /* never logged in */ }
  for (const f of [keyFile(), loginFile()]) { try { unlinkSync(f); } catch { /* already gone */ } }
  console.log(`Logged out: the saved key${info?.prefix ? ` ${info.prefix}` : ""} is removed from this machine. It keeps working until you revoke it in the console (Keys).`);
  return 0;
}
