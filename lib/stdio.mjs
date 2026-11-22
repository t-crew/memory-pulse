// Output that reaches a pipe whole, in bounded time.
//
// A command here prints and then calls process.exit(). When standard output is a pipe to another program, Node writes to it
// without waiting on macOS, and process.exit() drops whatever has not been written yet. Measured on 2026-11-22 with the output
// captured by a parent process, which is how every host runs a hook and how an agent's shell tool runs a command: cut at 8,192
// bytes on Node 18 and 20, at 65,536 to 72,704 bytes on Node 22 to 26. `help` is 18 KB; `scaffold --section corrections` passed
// 8 KB at about 85 corrections, and the reader saw a list that stopped in the middle of a line.
//
// The first cure (9675b96) set the two streams to blocking. Its review (REVIEW-01a6482, F-1) found the cost: a host that reads
// stderr only after the hook exits made a blocked guard hang in write(2) for ever, and a host that times a hung hook out lets
// the edit through. A timer cannot reach a process stuck in a blocking write. It also left a shared pipe in blocking mode after
// SIGKILL (F-3).
//
// So the streams keep the mode they were given, and each write to a pipe or socket is made here, synchronously: written as far
// as the reader takes it, retried every few milliseconds while the pipe is full, and given up when the reader has taken nothing
// for STALL_MS. Nothing is left queued when the process exits, a reader that reads gets everything, a reader that never reads
// costs at most STALL_MS per stream, and the exit status is the command's own. A file or a terminal is written by Node as before.

import { writeSync, fstatSync } from "node:fs";

export const STALL_MS = 2000;
const nap = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(nap, 0, 0, ms);

/** Write all of `buf` to `fd`, or as much as a reader takes before it stops reading for STALL_MS. State is per stream. */
function writeAll(state, buf) {
  let off = 0, stalledSince = 0;
  while (off < buf.length) {
    if (state.closed) return false;
    try {
      const n = writeSync(state.fd, buf, off, buf.length - off);
      off += n; if (n > 0) stalledSince = 0;
    } catch (e) {
      if (e?.code === "EAGAIN" || e?.code === "EWOULDBLOCK") {
        const now = Date.now(); if (!stalledSince) stalledSince = now;
        if (now - stalledSince >= STALL_MS) { state.closed = true; return false; }   // the reader stopped reading: the rest is dropped
        sleep(2); continue;
      }
      if (e?.code === "EPIPE" || e?.code === "EBADF" || e?.code === "ECONNRESET") { state.closed = true; return false; }   // no reader
      throw e;
    }
  }
  return true;
}

/** For commands that print and exit; not for the long-running stdio server, which writes as Node does and waits in written(). */
export function wholeOutput(streams = [process.stdout, process.stderr]) {
  for (const s of streams) {
    const fd = s?.fd;
    if (typeof fd !== "number") continue;
    let piped = false;
    try { const st = fstatSync(fd); piped = st.isFIFO() || st.isSocket(); } catch { continue; }   // closed at start (>&-): Node's own write
    if (!piped) continue;
    const state = { fd, closed: false };
    s.write = function write(chunk, encoding, cb) {
      if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
      const buf = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk, encoding || "utf8") : Buffer.from(chunk);
      writeAll(state, buf);
      if (typeof cb === "function") process.nextTick(cb);
      return true;
    };
  }
}

/** Resolve when everything already written to `stream` has left the process, or after `ms`: for the stdio server's last answers
 *  before it exits. The limit is for a reader that has stopped reading without closing. */
export function written(stream = process.stdout, ms = 5000) {
  return new Promise((done) => {
    const t = setTimeout(done, ms); t.unref?.();
    try { stream.write("", () => { clearTimeout(t); done(); }); } catch { clearTimeout(t); done(); }
  });
}
