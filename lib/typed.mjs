// Was this prompt typed by a person, or did the agent schedule it for itself?
//
// The UserPromptSubmit payload does not say (Claude Code 2.1.330 sends the session, transcript_path, cwd, the permission
// mode, the prompt and a session title; no origin). The transcript does. Measured on a real scheduled wake-up (2026-11-13),
// whose prompt ambient capture recorded as a person's correction: the turn's user entry carries isMeta true, promptSource
// "system", turnOrigin "scheduled" and wakeupSource "loop_wakeup"; a system entry of subtype scheduled_task_fire carries the
// prompt, cut at 200 characters; and thirty minutes earlier the assistant's own ScheduleWakeup tool call carries the prompt
// whole. The first two are written as the turn starts and may not be on disk when the hook runs. The tool call is.
import { openSync, readSync, closeSync, fstatSync } from "node:fs";

/** The last `bytes` of a file as text (a transcript grows without bound; the hook reads its end). "" when it cannot be read. */
export function tailText(path, bytes = 32 * 1024 * 1024) {
  let fd;
  try {
    fd = openSync(path, "r"); const size = fstatSync(fd).size, len = Math.min(size, bytes), buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    return len < size ? text.slice(text.indexOf("\n") + 1) : text;   // drop the line the cut fell in
  } catch { return ""; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n") : "");

/**
 * True when the transcript shows `prompt` was not typed: the assistant put exactly this text in a tool call's `prompt`
 * (ScheduleWakeup, a cron task), the harness logged it as a scheduled task firing, or the turn's own entry is one
 * typedUserText rejects. A prompt the transcript does not hold is treated as typed: this never stops a real capture.
 */
export function scheduledPrompt(transcriptText, prompt, { typedUserText } = {}) {
  const p = String(prompt ?? "").trim(), all = String(transcriptText ?? "");
  if (!p || !all) return false;
  // only lines that hold the start of the prompt are parsed (a transcript line can be megabytes)
  const head = JSON.stringify(p.slice(0, 40)).slice(1, -1);
  if (!all.includes(head)) return false;
  for (const line of all.split("\n")) {
    if (!line.includes(head)) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o?.type === "system" && o.subtype === "scheduled_task_fire" && typeof o.prompt === "string" && o.prompt.trim().length >= 20 && p.startsWith(o.prompt.trim())) return true;
    const m = o?.message; if (!m) continue;
    if ((o.type === "assistant" || m.role === "assistant") && Array.isArray(m.content) && m.content.some((part) => part?.type === "tool_use" && typeof part.input?.prompt === "string" && part.input.prompt.trim() === p)) return true;
    if ((o.type === "user" || m.role === "user") && typeof typedUserText === "function" && text(m.content).trim() === p && !typedUserText(o)) return true;
  }
  return false;
}
