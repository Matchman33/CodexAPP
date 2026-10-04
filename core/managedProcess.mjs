// 只响应本机启动器的 IPC 探测，网络故障不会触发整个进程重启。
if (process.env.CODEXAPP_MANAGED === "1" && process.send) {
  process.on("message", message => {
    if (message?.type === "codexapp-health" && process.connected) process.send({ type: "codexapp-health" }, () => {});
  });
}
