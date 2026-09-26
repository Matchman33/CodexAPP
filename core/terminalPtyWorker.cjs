// Keep native PTY resources outside the relay/Electron main process.
let pty, userPaused = false, pending = 0, stopping = false;
const send = message => {
  if (!process.connected) return;
  const size = message.data?.length || 0; pending += size;
  if (pending > 131072) pty?.pause();
  process.send(message, () => { pending -= size; if (pending < 32768 && !userPaused && !stopping) pty?.resume(); });
};
function stop() {
  if (stopping) return;
  stopping = true;
  try { pty?.kill(); } catch {}
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("disconnect", stop);
process.on("message", message => {
  try {
    switch (message.type) {
      case "init": {
        if (pty) throw new Error("PTY already initialized");
        pty = require("node-pty").spawn(message.file, message.args, message.options);
        pty.onData(data => send({ type: "data", data }));
        pty.onExit(result => {
          stopping = true;
          if (process.connected) process.send({ type: "exit", ...result }, () => process.exit(0));
          else process.exit(0);
        });
        send({ type: "ready", pid: pty.pid }); break;
      }
      case "write": pty.write(message.data); break;
      case "resize": pty.resize(message.cols, message.rows); break;
      case "pause": userPaused = true; pty.pause(); break;
      case "resume": userPaused = false; if (pending < 32768) pty.resume(); break;
      case "kill": stop(); break;
    }
  } catch (error) {
    if (process.connected) process.send({ type: "error", message: error.message }, stop);
    else stop();
  }
});
