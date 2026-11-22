// Reading a shell command without running it. Written on 0.16.1 (2026-10-23, never merged) and ported onto 0.18.0 (2026-11-21).
// One use in the guard: writes whose content sits in the command. sed -i / perl -i (only the replacement side is written),
// python -c / node -e with a write call, and a heredoc whose redirect follows the marker (cat <<'EOF' > file).
// To find them the reader has to know which program each simple command runs, after env assignments, wrappers (sudo, env, xargs,
// timeout, ...) and `bash -c "..."`. The unmerged version also matched a withdrawn COMMAND with this reader; 0.18.0 does that with
// a rule on shell commands in invariants.jsonl ("on": "command"), so that part is not here.
// Static and deliberately small: quotes, escapes, operators, $( ) and backticks, heredoc bodies (skipped as data) and redirections. What
// it cannot read it does not return, so a miss stays a miss and never becomes a false block.

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
// wrapper -> options that take a separate argument
const WRAPPERS = new Map([
  ["sudo", new Set(["-u", "-g", "-C", "-h", "-p", "-U", "-r", "-t"])], ["doas", new Set(["-u", "-C"])], ["env", new Set(["-u", "-C", "-S", "--unset", "--chdir"])],
  ["time", new Set(["-f", "-o"])], ["nice", new Set(["-n"])], ["nohup", new Set()], ["command", new Set()], ["exec", new Set(["-a"])], ["builtin", new Set()],
  ["xargs", new Set(["-n", "-I", "-P", "-L", "-d", "-E", "-s", "-a", "-J", "-R", "-S"])], ["stdbuf", new Set(["-i", "-o", "-e"])], ["timeout", new Set(["-s", "-k", "--signal", "--kill-after"])],
]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
export const basename = (w) => String(w).replace(/^.*\//, "");

function matchParen(s, open) {
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    const c = s[k];
    if (c === "'") { const j = s.indexOf("'", k + 1); if (j < 0) return s.length; k = j; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return k;
  }
  return s.length;
}

/** The simple commands in a command line, each as its list of words (quotes removed), nested ones included. */
export function simpleCommands(cmd, depth = 0) {
  const s = String(cmd ?? ""), out = [], heredocs = [];
  let words = [], cur = "", has = false, i = 0;
  const endWord = () => { if (has) words.push(cur); cur = ""; has = false; };
  const endSeg = () => { endWord(); if (words.length) out.push(words); words = []; };
  const nested = (src) => { if (depth < 4) out.push(...simpleCommands(src, depth + 1)); };
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { if (s[i + 1] !== "\n") { cur += s[i + 1]; has = true; } i += 2; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1), e = j < 0 ? s.length : j; cur += s.slice(i + 1, e); has = true; i = e + 1; continue; }
    if (c === '"') {
      let j = i + 1, buf = "";
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\" && j + 1 < s.length && '"\\$`\n'.includes(s[j + 1])) { buf += s[j + 1]; j += 2; continue; }
        if (s[j] === "$" && s[j + 1] === "(" && s[j + 2] !== "(") { const k = matchParen(s, j + 1); nested(s.slice(j + 2, k)); buf += s.slice(j, k + 1); j = k + 1; continue; }
        if (s[j] === "`") { const k = s.indexOf("`", j + 1), e = k < 0 ? s.length : k; nested(s.slice(j + 1, e)); buf += s.slice(j, e + 1); j = e + 1; continue; }
        buf += s[j]; j++;
      }
      cur += buf; has = true; i = j + 1; continue;
    }
    if (c === "$" && s[i + 1] === "(" && s[i + 2] !== "(") { const k = matchParen(s, i + 1); nested(s.slice(i + 2, k)); cur += s.slice(i, k + 1); has = true; i = k + 1; continue; }
    if (c === "`") { const k = s.indexOf("`", i + 1), e = k < 0 ? s.length : k; nested(s.slice(i + 1, e)); cur += s.slice(i, e + 1); has = true; i = e + 1; continue; }
    if (c === "#" && !has) { const j = s.indexOf("\n", i); i = j < 0 ? s.length : j; continue; }
    if (c === "\n") {
      endSeg(); i++;
      // heredoc bodies are data: skip each to its closing tag
      while (heredocs.length) {
        const { tag, strip } = heredocs.shift();
        for (;;) {
          const nl = s.indexOf("\n", i), line = s.slice(i, nl < 0 ? s.length : nl);
          i = nl < 0 ? s.length : nl + 1;
          if ((strip ? line.replace(/^\t+/, "") : line) === tag || nl < 0) break;
        }
      }
      continue;
    }
    if (c === "<" && s[i + 1] === "<" && s[i + 2] !== "<") {
      const m = /^<<(-?)[ \t]*(['"]?)([A-Za-z_][\w.-]*)\2/.exec(s.slice(i));
      if (m) { endWord(); heredocs.push({ tag: m[3], strip: m[1] === "-" }); i += m[0].length; continue; }
    }
    if (c === ">" || c === "<") {
      // a redirection: drop a file-descriptor number before it, then skip the operator and its target
      if (has && /^\d+$/.test(cur)) { cur = ""; has = false; } else endWord();
      i++; while (i < s.length && /[<>&|]/.test(s[i])) i++;
      while (i < s.length && /[ \t]/.test(s[i])) i++;
      const save = { words, cur, has }; words = []; cur = ""; has = false;
      // the target is one word, quotes allowed
      while (i < s.length && !/[\s;&|()<>]/.test(s[i])) {
        if (s[i] === "'" || s[i] === '"') { const q = s[i], j = s.indexOf(q, i + 1); i = j < 0 ? s.length : j + 1; continue; }
        i++;
      }
      ({ words, cur, has } = save); continue;
    }
    if (";&|()".includes(c)) { endSeg(); i++; continue; }
    if (c === " " || c === "\t") { endWord(); i++; continue; }
    cur += c; has = true; i++;
  }
  endSeg();
  // `bash -c "<script>"` runs the script: read it as commands too
  for (const w of [...out]) {
    const k = w.findIndex((x, n) => n > 0 && /^-[a-z]*c[a-z]*$/.test(x));
    if (SHELLS.has(basename(w[0])) && k > 0 && w[k + 1] != null) nested(w[k + 1]);
  }
  return out;
}

/** The words of a simple command from the program on: env assignments and wrappers (sudo, env, xargs, timeout, ...) removed. */
export function programWords(words) {
  let w = [...words];
  for (let guard = 0; guard < 8; guard++) {
    while (w.length && ASSIGN.test(w[0])) w.shift();
    const wrap = WRAPPERS.get(basename(w[0] ?? ""));
    if (!wrap) break;
    const name = basename(w[0]); w.shift();
    while (w.length && (w[0].startsWith("-") || (name === "env" && ASSIGN.test(w[0])))) {
      const opt = w.shift();
      if (wrap.has(opt) && w.length) w.shift();
      else if (opt === "--") break;
    }
    if (name === "timeout" && w.length && /^\d/.test(w[0])) w.shift(); // the duration
    if (name === "nice" && w.length && /^-?\d+$/.test(w[0])) w.shift();
  }
  return w;
}

// ---- writes whose content is in the command
// s<d>pattern<d>replacement<d>flags, any delimiter; only the replacement is written. `a text` / `i text` / `c text` add a line.
function editScriptWrites(script, perl = false) {
  const out = [], s = String(script);
  const field = (k, d) => { let v = ""; while (k < s.length && s[k] !== d) { if (s[k] === "\\" && k + 1 < s.length) { v += s[k + 1] === d ? d : (perl ? s[k + 1] : s[k] + s[k + 1]); k += 2; continue; } v += s[k++]; } return k < s.length ? [v, k + 1] : [null, k]; };
  for (let k = 0; k < s.length; k++) {
    const prev = k === 0 ? "" : s[k - 1];
    if (k > 0 && !/[;\s{}\d$/!]/.test(prev)) continue;
    if (s[k] === "s" && k + 1 < s.length && !/[\w\s\\]/.test(s[k + 1])) {
      const d = s[k + 1]; const [pat, k1] = field(k + 2, d); if (pat == null) continue;
      const [rep, k2] = field(k1, d); if (rep == null) continue;
      out.push(perl ? rep : rep.replace(/\\(.)/g, "$1")); k = k2 - 1; continue;
    }
    if (!perl && "aic".includes(s[k]) && (s[k + 1] === "\\" || s[k + 1] === " ")) {
      const nl = s.indexOf("\n", k); const text = s.slice(k + 1, nl < 0 ? s.length : nl).replace(/^\\\s*/, "").trimStart();
      if (text) out.push(text); k = nl < 0 ? s.length : nl;
    }
  }
  return out;
}
function sedWrite(w) {
  const prog = basename(w[0]);
  if (prog === "sed") {
    let inPlace = false; const scripts = [], rest = [];
    for (let k = 1; k < w.length; k++) {
      const x = w[k];
      if (x === "--in-place" || x.startsWith("--in-place=")) { inPlace = true; continue; }
      if (x === "-e" || x === "--expression") { if (w[k + 1] != null) scripts.push(w[++k]); continue; }
      if (x.startsWith("--expression=")) { scripts.push(x.slice(13)); continue; }
      if (x === "-f" || x === "--file") { k++; continue; }
      if (/^-[A-Za-z]+/.test(x)) {
        if (/^-[A-Za-z]*i/.test(x)) { inPlace = true; if (x === "-i" && w[k + 1] != null && (w[k + 1] === "" || /^\.[\w.-]*$/.test(w[k + 1]))) k++; }
        continue;
      }
      rest.push(x);
    }
    if (!inPlace) return null;
    if (!scripts.length && rest.length) scripts.push(rest.shift());
    const text = scripts.flatMap((x) => editScriptWrites(x)).join("\n");
    return rest.length && text ? { path: rest[0], text } : null;
  }
  if (prog === "perl") {
    let inPlace = false; const scripts = [], rest = [];
    for (let k = 1; k < w.length; k++) {
      const x = w[k];
      if (/^-[A-Za-z]*e$/.test(x)) { if (/i/.test(x)) inPlace = true; if (w[k + 1] != null) scripts.push(w[++k]); continue; }
      if (/^-[A-Za-z]+/.test(x)) { if (/^-[A-Za-z]*i/.test(x)) inPlace = true; continue; }
      rest.push(x);
    }
    if (!inPlace) return null;
    const text = scripts.flatMap((x) => editScriptWrites(x, true)).join("\n");
    return rest.length && text ? { path: rest[0], text } : null;
  }
  return null;
}
// python -c / node -e whose code writes a file the code names: the code is the content
const PY_WRITE = [/\bopen\(\s*(['"])(.+?)\1\s*,\s*(?:mode\s*=\s*)?['"][wax][b+t]*['"]/, /\bPath\(\s*(['"])(.+?)\1\s*\)\s*\.\s*write_(?:text|bytes)\(/];
const JS_WRITE = [/\b(?:writeFileSync|appendFileSync|writeFile|appendFile)\(\s*(['"`])(.+?)\1/];
function inlineCodeWrite(w) {
  const prog = basename(w[0]);
  const flag = /^python[\d.]*$/.test(prog) ? ["-c"] : /^(node|bun|deno)$/.test(prog) ? ["-e", "--eval", "-p", "--print"] : null;
  if (!flag) return null;
  const k = w.findIndex((x, n) => n > 0 && flag.includes(x)); const code = k > 0 ? w[k + 1] : null;
  if (typeof code !== "string") return null;
  for (const re of prog.startsWith("python") ? PY_WRITE : JS_WRITE) { const m = re.exec(code); if (m) return { path: m[2], text: code }; }
  return null;
}
// cat <<'EOF' > file ... EOF: the redirect after the marker, the form agents write most. (The redirect before the marker is read in
// server.mjs shellWrites, as it was.)
const HEREDOC_AFTER = /(?:^|[;&|]\s*)\w[\w./-]*\s*<<-?\s*(["']?)([A-Za-z_]\w*)\1\s*>>?\s*(["']?[\w./~-]+["']?)[^\n]*\n([\s\S]*?)\n\s*\2\s*(?:$|\n)/g;
/** Writes readable from the command: a heredoc with the redirect after its marker, sed -i, perl -i, python -c and node -e with a write call. */
export function commandWrites(commandLine) {
  const out = [];
  for (const m of String(commandLine ?? "").matchAll(HEREDOC_AFTER)) out.push({ path: m[3], text: m[4] });
  for (const words of simpleCommands(commandLine)) {
    const w = programWords(words); if (!w.length) continue;
    const hit = sedWrite(w) ?? inlineCodeWrite(w);
    if (hit) out.push(hit);
  }
  return out;
}
