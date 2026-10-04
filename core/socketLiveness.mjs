// TCP 连接可能在断网或休眠后仍显示 OPEN；主动探测才能触发既有重连逻辑。
export function watchSocket(socket, { interval = 20000, timeout = 15000, failed = () => {} } = {}) {
  let deadline = null;
  const pong = () => { clearTimeout(deadline); deadline = null; };
  const tick = () => {
    if (socket.readyState !== 1 || deadline) return;
    deadline = setTimeout(() => {
      deadline = null;
      failed("心跳超时");
      socket.terminate();
    }, timeout);
    deadline.unref?.();
    try { socket.ping(); } catch { socket.terminate(); }
  };
  const timer = setInterval(tick, interval);
  timer.unref?.();
  const stop = () => {
    clearInterval(timer); pong();
    socket.off("pong", pong); socket.off("close", stop);
  };
  socket.on("pong", pong); socket.once("close", stop);
  return stop;
}
