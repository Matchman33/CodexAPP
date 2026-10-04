export function supervise(launch, { logger = console, finished = () => {} } = {}) {
  let child, timer, healthTimer, stopping = false, active = false, failures = 0;
  const start = () => {
    if (stopping) return;
    let restart = false;
    const started = Date.now();
    child = launch();
    active = true;
    const current = child;
    let lastReply = started, lastTick = started;
    child.on("message", message => {
      if (message?.type === "codexapp-restart") restart = true;
      if (message?.type === "codexapp-health") lastReply = Date.now();
    });
    if (typeof child.send === "function") healthTimer = setInterval(() => {
      const now = Date.now();
      if (now - lastTick > 30000) lastReply = now;
      lastTick = now;
      if (now - lastReply > 60000) {
        clearInterval(healthTimer);
        logger.error("[launcher] 子进程持续 60 秒未响应，重新启动");
        current.kill(); return;
      }
      if (current.connected) current.send({ type: "codexapp-health" }, () => {});
    }, 10000);
    child.on("error", error => logger.error("[launcher]", error.message));
    child.once("exit", (code, signal) => {
      active = false;
      clearInterval(healthTimer);
      if (stopping || (!restart && code === 0 && !signal)) { finished(code || 0); return; }
      if (Date.now() - started >= 60000) failures = 0;
      const delay = restart ? 0 : Math.min(1000 * 2 ** Math.min(failures++, 5), 30000);
      logger.error(`[launcher] 进程退出 code=${code} signal=${signal || "none"}；${delay}ms 后重新启动`);
      timer = setTimeout(start, delay);
    });
  };
  start();
  return {
    stop(signal = "SIGTERM") {
      stopping = true; clearTimeout(timer); clearInterval(healthTimer);
      if (active) child.kill(signal); else finished(0);
    },
    stopManaged() {
      stopping = true; clearTimeout(timer); clearInterval(healthTimer);
      if (!active) finished(0);
      else if (child.connected) child.send({ type: "codexapp-stop" });
      else child.kill();
    },
  };
}
