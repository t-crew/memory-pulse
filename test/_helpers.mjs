// Shared by the documentation tests. Not a test file (no .test.js suffix), so importing it registers nothing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
export const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
export const SERVER = join(ROOT, "server.mjs");
const SRC = readFileSync(SERVER, "utf8");
// The dispatch table is the source of truth: every `sub === "name"` plus `guard allow`.
export function dispatched() {
  const names = new Set([...SRC.matchAll(/sub === "([a-z][a-z-]*)"/g)].map((m) => m[1]));
  names.add("guard allow"); names.add("serve"); // serve is accepted by `sub !== "serve"`, not a `sub ===` line
  return [...names];
}
export function envVars() {
  return [...new Set([...SRC.matchAll(/process\.env\.(MEMORY_PULSE_[A-Z_]+)/g)].map((m) => m[1]))];
}
// Prose only: fenced blocks and inline code quote tool output verbatim and are not copy.
export const prose = (md) => md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
export const BANNED = /\b(proofs?|proves?|proved|proven|unforgeable|holographic|lossless)\b/i;
