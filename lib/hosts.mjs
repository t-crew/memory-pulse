// Host adapters (2026-10-21). The hook code reads Claude Code's payload; another host's payload is mapped onto it here, and the few
// places where a host needs a different answer (Cursor's JSON permission on every preToolUse call) check `host`. Tests: cursor.test.js.
//   cursor   cursor.com/docs/agent/hooks (read 2026-10-21): conversation_id, tool_name Shell / Write / Read / MCP:<name>, tool_output
//            as a JSON string, error_message on failure, workspace_roots instead of cwd.
export function hostOf(argv) { const i = argv.indexOf("--host"); return i >= 0 ? String(argv[i + 1] ?? "").toLowerCase() : "claude"; }

const CURSOR_EVENTS = { preToolUse: "PreToolUse", postToolUse: "PostToolUse", postToolUseFailure: "PostToolUseFailure", stop: "Stop", sessionEnd: "SessionEnd",
                        sessionStart: "SessionStart", preCompact: "PreCompact", beforeSubmitPrompt: "UserPromptSubmit" };
const CURSOR_TOOLS = { Shell: "Bash", Write: "Write", Read: "Read", Delete: "Delete", Grep: "Grep", Task: "Task" };

export function normalizeHook(host, p) {
  if (host !== "cursor" || !p || typeof p !== "object") return p;
  let tool = p.tool_name;
  if (typeof tool === "string") tool = tool.startsWith("MCP:") ? `mcp__${tool.slice(4)}` : CURSOR_TOOLS[tool] ?? tool;
  const ti = { ...(p.tool_input ?? {}) };
  if (!ti.file_path && typeof (ti.path ?? ti.target_file) === "string") ti.file_path = ti.path ?? ti.target_file;   // the write tool's names vary
  if (ti.content === undefined) for (const k of ["contents", "code_edit", "text"]) if (typeof ti[k] === "string") { ti.content = ti[k]; break; }
  let out = p.tool_output, parsed = null;
  if (typeof out === "string") { try { parsed = JSON.parse(out); } catch { parsed = null; } }
  else if (out && typeof out === "object") parsed = out;
  const tool_response = parsed && typeof parsed === "object"
    ? { ...parsed, stdout: parsed.stdout ?? parsed.output ?? "", stderr: parsed.stderr ?? "" }
    : { stdout: typeof out === "string" ? out : "", stderr: "" };
  return { ...p, hook_event_name: CURSOR_EVENTS[p.hook_event_name] ?? p.hook_event_name, session_id: p.conversation_id ?? p.session_id,
           cwd: p.cwd ?? ti.working_directory ?? (Array.isArray(p.workspace_roots) ? p.workspace_roots[0] : undefined),
           tool_name: tool, tool_input: ti, tool_response, error: p.error ?? p.error_message };
}
