// Output that reaches a pipe whole.
//
// A command here prints and then calls process.exit(). When standard output is a pipe to another program, Node writes to it
// without waiting on macOS, and process.exit() drops whatever has not been written yet. Measured on 2026-11-22 with the output
// captured by a parent process, which is how every host runs a hook and how an agent's shell tool runs a command: cut at 8,192
// bytes on Node 18 and 20, at 65,536 bytes on Node 22 to 26. Nothing is cut on Linux, to a terminal, or to a file. `help` is
// 18 KB; `scaffold --section corrections` passed 8 KB at about 85 corrections, and the reader saw a list that stopped in the
// middle of a line.
//
// The cure is to make the two output streams wait for each write. With that, 2 MB arrives whole on Node 18 to 26, the exit status
// is unchanged, a reader that closes early ends the write with EPIPE at once, and a slow reader gets everything.
// `_handle.setBlocking` is not a documented API. It has been in every Node since 6 and is what npm itself uses for this; if it is
// ever missing the call is skipped and the behaviour is the old one.

/** Make standard output and standard error wait for each write, so nothing is dropped when the process exits. For commands that
 *  print and exit; not for the long-running stdio server, which must not stall on a client that reads slowly. */
export function wholeOutput(streams = [process.stdout, process.stderr]) {
  for (const s of streams) {
    try { s?._handle?.setBlocking?.(true); } catch { /* no handle (a file, a closed stream): nothing to set */ }
    // A reader that stops reading (`| head -1`, a host that has its answer) closes the pipe. That is not an error of the command:
    // the rest of the output has nowhere to go, and the command still finishes with its own exit status.
    try { s?.on?.("error", (e) => { if (e?.code !== "EPIPE") throw e; }); } catch { /* not an emitter */ }
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
