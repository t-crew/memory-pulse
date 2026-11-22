// Reading a shell command without running it. Written on 0.16.1 (2026-10-23, never merged) and ported onto 0.18.0 (2026-11-21).
// One use in the guard: writes whose content sits in the command. sed -i / perl -i (only the replacement side is written),
// python -c / node -e with a write call whose argument is a string literal, and a heredoc whose redirect follows the marker
// (cat <<'EOF' > file).
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
// Rewritten after a review (2026-11-21, G-2): the first reader blocked commands that remove the old value. It read the `a` inside a
// sed address as the append command, the `i` in perl's -Mstrict as -i, and took a whole python -c or node -e program as the text
// written. A write is returned only for text on the side that is written, and anything the reader cannot read returns nothing.

const unescape = (v) => v.replace(/\\(.)/gs, "$1");
// One delimited field from k: up to the next unescaped `d`. [text, index after the delimiter], or null when it does not close.
// `\d` stands for the delimiter; any other escape is kept as written.
function field(s, k, d) {
  let v = "";
  while (k < s.length && s[k] !== d) {
    if (s[k] === "\n") return null;
    if (s[k] === "\\" && k + 1 < s.length) { v += s[k + 1] === d ? d : s[k] + s[k + 1]; k += 2; continue; }
    v += s[k++];
  }
  return k < s.length ? [v, k + 1] : null;
}

/** What a sed script writes: the replacement side of each `s`, the text of each one-line `a`, `i` or `c`. null when the script cannot be read. */
function sedScriptWrites(script) {
  const s = String(script), out = []; let k = 0;
  const blanks = () => { while (k < s.length && (s[k] === " " || s[k] === "\t")) k++; };
  const toLineEnd = () => { const nl = s.indexOf("\n", k), v = s.slice(k, nl < 0 ? s.length : nl); k = nl < 0 ? s.length : nl; return v; };
  // an address: a line number (GNU first~step), $, /regex/ or \cregexc, then GNU's I and M. true, false (no address here) or null (unreadable)
  const address = () => {
    const c = s[k];
    if (c >= "0" && c <= "9") { while (k < s.length && /[\d~]/.test(s[k])) k++; return true; }
    if (c === "$") { k++; return true; }
    let d = null;
    if (c === "/") { d = "/"; k++; } else if (c === "\\" && k + 1 < s.length && s[k + 1] !== "\n") { d = s[k + 1]; k += 2; }
    if (d === null) return false;
    const f = field(s, k, d); if (!f) return null;
    k = f[1]; while (s[k] === "I" || s[k] === "M") k++;
    return true;
  };
  while (k < s.length) {
    while (k < s.length && /[\s;]/.test(s[k])) k++;
    if (k >= s.length) break;
    if (s[k] === "#") { toLineEnd(); continue; }
    if (s[k] === "}") { k++; continue; }
    // the addresses come first: a letter inside /Pro is a plan/ is not a command
    const a1 = address(); if (a1 === null) return null;
    if (a1) { blanks(); if (s[k] === ",") { k++; blanks(); if (s[k] === "+" || s[k] === "~") k++; if (!address()) return null; } }
    blanks(); while (s[k] === "!") { k++; blanks(); }
    const c = s[k]; if (c === undefined) return null;
    k++;
    if (c === "{") continue;
    if (c === "s" || c === "y") {
      const d = s[k]; if (d === undefined || /[\w\s\\]/.test(d)) return null;
      const one = field(s, k + 1, d); if (!one) return null;
      const two = field(s, one[1], d); if (!two) return null;
      k = two[1];
      if (c === "y") continue;                                   // characters are mapped: no text of its own
      for (;;) {                                                 // flags: g p I i M m, a number, `w file`
        const f = s[k];
        if (f === "w") { toLineEnd(); break; }
        if (f === "e") return null;                              // runs the result as a command
        if (f !== undefined && /[gpIiMm\d]/.test(f)) { k++; continue; }
        break;
      }
      out.push(unescape(two[0]));
      continue;
    }
    if (c === "a" || c === "i" || c === "c") {
      // `a text` and `a\text` on one line are read. Text on the lines that follow (`a\` and a new line, or a line that ends in a
      // backslash) is skipped, not read: a miss.
      blanks();
      if (s[k] === "\\" && s[k + 1] !== "\n") { k++; blanks(); }
      let line = toLineEnd();
      const text = line.replace(/\\$/, "").trim();
      if (text) out.push(text);
      while (/(?:^|[^\\])(?:\\\\)*\\$/.test(line) && k < s.length) { k++; line = toLineEnd(); }
      continue;
    }
    if ("dDpPgGhHxnN=zF".includes(c)) continue;                  // delete, print, hold space: nothing is written that was not there
    if (c === "l" || c === "q" || c === "Q" || c === "L") { blanks(); while (k < s.length && /\d/.test(s[k])) k++; continue; }
    if (c === "b" || c === "t" || c === "T" || c === ":") { while (k < s.length && s[k] !== ";" && s[k] !== "\n" && s[k] !== "}") k++; continue; }
    if (c === "r" || c === "R" || c === "w" || c === "W") { toLineEnd(); continue; }   // another file's text: not in the command
    return null;                                                 // `e` runs a command; anything else is not sed this reader knows
  }
  return out;
}
function sedWrite(w) {
  let inPlace = false, fromFile = false; const scripts = [], rest = [];
  for (let k = 1; k < w.length; k++) {
    const x = w[k];
    if (x === "--") { rest.push(...w.slice(k + 1)); break; }
    if (x === "--in-place" || x.startsWith("--in-place=")) { inPlace = true; continue; }
    if (x === "--expression") { if (w[k + 1] != null) scripts.push(w[++k]); continue; }
    if (x.startsWith("--expression=")) { scripts.push(x.slice(13)); continue; }
    if (x === "--file" || x.startsWith("--file=")) { fromFile = true; if (x === "--file") k++; continue; }
    if (x.startsWith("--")) continue;
    if (!/^-[A-Za-z]/.test(x)) { rest.push(x); continue; }
    // a cluster of one-letter options: -i takes the rest of the cluster as its suffix, -e and -f the rest or the next word
    for (let j = 1; j < x.length; j++) {
      const c = x[j], tail = x.slice(j + 1);
      if (c === "i") {
        inPlace = true;
        // BSD sed: the suffix is the next word ('' or .bak)
        if (!tail && w[k + 1] != null && (w[k + 1] === "" || /^\.[\w.-]*$/.test(w[k + 1]))) k++;
        break;
      }
      if (c === "e") { if (tail) scripts.push(tail); else if (w[k + 1] != null) scripts.push(w[++k]); break; }
      if (c === "f") { fromFile = true; if (!tail) k++; break; }
      if (c === "l") { if (!tail) k++; break; }
    }
  }
  if (!inPlace || fromFile) return null;                         // a script in a file is not in the command
  if (!scripts.length && rest.length) scripts.push(rest.shift());
  const parts = scripts.map(sedScriptWrites);
  if (parts.some((p) => p === null)) return null;
  const text = parts.flat().join("\n");
  return rest.length && text ? { path: rest[0], text } : null;
}

// perl -i: the replacement side of each s/// with a plain delimiter. Bracketed delimiters (s{..}{..}) are not read.
function perlScriptWrites(script) {
  const out = [], s = String(script);
  for (let k = 0; k < s.length; k++) {
    if (s[k] !== "s" || k + 1 >= s.length) continue;
    const d = s[k + 1]; if (/[\w\s\\]/.test(d) || "{([<".includes(d)) continue;
    if (k > 0 && !/[;\s{}(!~]/.test(s[k - 1])) continue;         // the start of a statement or an expression, not the end of a name
    const pat = field(s, k + 2, d); if (!pat) continue;
    const rep = field(s, pat[1], d); if (!rep) continue;
    out.push(unescape(rep[0])); k = rep[1] - 1;
  }
  return out;
}
function perlWrite(w) {
  let inPlace = false; const scripts = [], rest = [];
  for (let k = 1; k < w.length; k++) {
    const x = w[k];
    if (x === "--") { rest.push(...w.slice(k + 1)); break; }
    if (!/^-./.test(x)) { rest.push(...w.slice(k)); break; }     // the first word that is not an option: the files
    // a cluster of one-letter options. -i is in-place only as its own letter: the `i` in -Mstrict or -Ilib belongs to that option's
    // argument, which runs to the end of the cluster.
    for (let j = 1; j < x.length; j++) {
      const c = x[j], tail = x.slice(j + 1);
      if (c === "i") { inPlace = true; break; }                   // -i, -pi, -i.bak: the rest is the backup suffix
      if (c === "e" || c === "E") { if (tail) scripts.push(tail); else if (w[k + 1] != null) scripts.push(w[++k]); break; }
      if (c === "I") { if (!tail && w[k + 1] != null) k++; break; }
      if ("MmxCDVdF".includes(c)) break;                         // -Mmodule, -x[dir], -C[n], -D.., -V[:name], -d[:mod], -Fpattern
      if (c === "0") { while (j + 1 < x.length && /[0-9a-fA-Fx]/.test(x[j + 1])) j++; continue; }
      if (c === "l") { while (j + 1 < x.length && /[0-7]/.test(x[j + 1])) j++; continue; }
    }
  }
  if (!inPlace) return null;
  const text = scripts.flatMap(perlScriptWrites).join("\n");
  return rest.length && text ? { path: rest[0], text } : null;
}

// python -c / node -e: the text is the string literal handed to the write call, when it is one. A name, a call, a concatenation or a
// template with a hole is not read: the program may be replacing the old value or only looking for it.
const PY_LITERAL = /^\s*([rRbBuUfF]{0,2})(?:'''([\s\S]*?)'''|"""([\s\S]*?)"""|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")\s*[,)]/;
const JS_LITERAL = /^\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`)\s*[,)]/;
function literalAt(src, js) {
  if (js) { const m = JS_LITERAL.exec(src); if (!m) return null; return m[3] !== undefined && m[3].includes("${") ? null : m[1] ?? m[2] ?? m[3]; }
  const m = PY_LITERAL.exec(src); if (!m) return null;
  const text = m[2] ?? m[3] ?? m[4] ?? m[5];
  return /f/i.test(m[1]) && text.includes("{") ? null : text;
}
const PY_OPEN = `\\bopen\\(\\s*(['"])(.+?)\\1\\s*,\\s*(?:mode\\s*=\\s*)?['"][wax][b+t]*['"][^()]*\\)`;
function pythonWrite(code) {
  const found = [];
  const take = (re, path = (m) => m[2]) => { for (const m of code.matchAll(re)) { const text = literalAt(code.slice(m.index + m[0].length), false); if (text != null) found.push({ path: path(m), text }); } };
  take(new RegExp(`${PY_OPEN}\\s*\\.\\s*write\\(`, "g"));
  take(/\bPath\(\s*(['"])(.+?)\1\s*\)\s*\.\s*write_(?:text|bytes)\(/g);
  for (const m of code.matchAll(new RegExp(`${PY_OPEN}\\s*as\\s+([A-Za-z_]\\w*)\\s*:`, "g"))) take(new RegExp(`\\b${m[3]}\\.write\\(`, "g"), () => m[2]);
  return found;
}
function jsWrite(code) {
  const found = [];
  for (const m of code.matchAll(/\b(?:writeFileSync|appendFileSync|writeFile|appendFile|writeTextFileSync|writeTextFile|Bun\.write)\(\s*(['"`])(.+?)\1\s*,/g)) {
    const text = literalAt(code.slice(m.index + m[0].length), true);
    if (text != null) found.push({ path: m[2], text });
  }
  return found;
}
function inlineCodeWrite(w) {
  const prog = basename(w[0]), py = /^python[\d.]*$/.test(prog);
  const flag = py ? ["-c"] : /^(node|bun|deno)$/.test(prog) ? ["-e", "--eval", "-p", "--print"] : null;
  if (!flag) return null;
  const k = w.findIndex((x, n) => n > 0 && flag.includes(x)); const code = k > 0 ? w[k + 1] : null;
  if (typeof code !== "string") return null;
  const found = py ? pythonWrite(code) : jsWrite(code);
  return found.length ? { path: found[0].path, text: found.map((f) => f.text).join("\n") } : null;
}
const wordsWrite = (w) => { const prog = basename(w[0]); return prog === "sed" ? sedWrite(w) : prog === "perl" ? perlWrite(w) : inlineCodeWrite(w); };

// cat <<'EOF' > file ... EOF: the redirect after the marker, the form agents write most. (The redirect before the marker is read in
// server.mjs shellWrites, as it was.)
const HEREDOC_AFTER = /(?:^|[;&|]\s*)\w[\w./-]*\s*<<-?\s*(["']?)([A-Za-z_]\w*)\1\s*>>?\s*(["']?[\w./~-]+["']?)[^\n]*\n([\s\S]*?)\n\s*\2\s*(?:$|\n)/g;
/** Writes readable from the command: a heredoc with the redirect after its marker, sed -i, perl -i, python -c and node -e with a write call. */
export function commandWrites(commandLine) {
  const out = [];
  for (const m of String(commandLine ?? "").matchAll(HEREDOC_AFTER)) out.push({ path: m[3], text: m[4] });
  for (const words of simpleCommands(commandLine)) {
    const w = programWords(words); if (!w.length) continue;
    const hit = wordsWrite(w);
    if (hit) out.push(hit);
  }
  return out;
}
