# CodexApp — 手机远程控制电脑上的 Codex

在手机上控制电脑里运行的 Codex：**发提示词**、**审批**它想执行的命令/文件改动、实时**看状态**。
**手机端不需要登录 Codex** —— 认证全在电脑侧，手机只跟你自己的中继通信。

```
        ┌─ web/      网页/PWA（任意手机+电脑浏览器，由中继托管）
[ 客户端 ]┤
        └─ mobile/   Expo / React Native（iPhone + Android 同一套代码）
              │
              └──WS(token)──→ [ relay/  Node 中继 ] ──JSON-RPC/stdio──→ [ codex app-server ]
                                本机 4123 端口                          Codex 本体 + 认证 + 执行
```

所有客户端说**同一套协议**连同一个中继 —— 协议定义见 **[PROTOCOL.md](PROTOCOL.md)**（唯一事实来源）。
中继是 `codex app-server` 的唯一客户端，把官方协议（`turn/start` / `turn/steer` /
`turn/interrupt` / 审批请求 / 状态通知）桥接成手机用的简单协议。

## 仓库结构

```
CodexApp/
├─ relay/        共享后端：Node 中继（spawn app-server + WS + 托管 web + token 鉴权）
├─ web/          网页/PWA 客户端（纯 JS，由中继托管，可加到主屏幕）
├─ mobile/       Expo 客户端（iOS + Android 一套代码）            → 见 mobile/README.md
├─ protocol/ts/  从本机 codex 二进制导出的真实协议定义（参考）
├─ archive/      已退役的原生工程（native-android / native-ios，留作参考）
├─ PROTOCOL.md   中继 ↔ 客户端 协议规范
├─ codexapp.config.json   中继配置（首次启动自动生成 token）
└─ package.json
```

## 1. 启动中继（电脑端，所有客户端都要它）

```powershell
cd C:\test\CodexAPP
npm install     # 第一次（装 ws）
npm start
```

启动后终端打印局域网地址和 Token：

```
  PWA:   http://192.168.1.84:4123/
  Token: <你的Token（npm start 时终端会打印）>
```

> 别的设备连不上 → 放行防火墙：
> `New-NetFirewallRule -DisplayName "CodexApp 4123" -Direction Inbound -LocalPort 4123 -Protocol TCP -Action Allow`

## Windows 防自动睡眠

Windows 上，中继和电脑 Agent 默认在服务运行期间请求系统保持唤醒，屏幕仍可熄灭，也不需要永久修改系统电源设置。隐藏的 PowerShell 辅助进程使用 `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`，在同一线程持有和释放请求；退出服务后恢复原电源策略。父进程异常退出时，辅助进程通过标准输入 EOF 退出，避免留下常驻防睡眠进程。

此功能在服务等待客户端、Agent 未登录或退出账号但程序仍运行时也有效。要关闭，可在中继 `codexapp.config.json` 或 Agent `agent.config.json` 设置 `"preventSleep": false` 并重启服务；也可设置环境变量 `CODEXAPP_PREVENT_SLEEP=0` 后启动。其他操作系统不启动辅助进程。

中继 `/health` 和 Agent `/api/status` 的 `sleepPrevention` 返回 `{ supported, enabled, active, error }`。只有 Windows API 成功返回后才显示 `active: true`；启动失败或辅助进程异常退出会在日志中告警，不影响远程控制服务运行。辅助进程异常退出后需重启服务恢复防睡眠。

不阻止手动睡眠、合盖触发睡眠或低电量等系统强制行为，不关闭屏幕保护或锁屏策略。此机制不唤醒已睡眠的电脑。已有安装包需要重新构建才能包含此功能。测试：`npm run test:sleep-process`，只启动独立防睡眠测试进程，不操作 Codex 会话。

## 2. 选一个客户端

| 客户端 | 适合 | 怎么用 |
|---|---|---|
| **web** | 最快、iPhone/安卓/电脑浏览器都行 | 浏览器打开中继打印的地址，填 Token，「添加到主屏幕」即像 App |
| **mobile (Expo)** | iPhone + Android 原生体验 | 手机装 **Expo Go**，`cd mobile && npx expo start` 扫码即跑。详见 [mobile/README.md](mobile/README.md) |

两个客户端连的是**同一个中继地址 + Token**。

## 3. 审批与策略

### 模型选择

在网页或 Expo 手机端的「设置 → 模型」选择模型，也可切换「自定义模型」填写服务商的模型 ID。列表由电脑端 Codex 动态提供，可刷新；选择「Codex 默认」恢复当前工作目录的 Codex 配置。服务商是否支持某个模型以实际调用结果为准。

点「应用」保存，或点「新建会话」保存并创建会话。模型从下一条消息开始生效，不中断当前任务。模型选择保存在局域网中继的 `codexapp.config.json`，或云 Agent 用户配置目录的 `agent.config.json`，重启后保留；不改 Codex 本身的配置或登录信息。云端使用时需更新电脑 Agent 与托管的网页，Expo 客户端也需加载新版代码。

### 审批策略

要让手机收到审批，中继会在每个会话强制审批策略（你的 `config.toml` 是 `never`，不强制就没审批）。
App 里可调：`on-request`(默认) / `untrusted`(几乎每条都问) / `on-failure` / `never`；
配合沙箱 `workspace-write` / `read-only` / `danger-full-access`。

> `permission` 类审批 v1 只支持拒绝；命令、文件改动审批的批准/拒绝都完整。

## 4. 远程访问 + 推送通知（Tailscale HTTPS）

⚠️ iOS 推送通知 / PWA Service Worker、以及移动端可靠后台都更适合走 **HTTPS**。局域网 `http://`
下核心功能（提示词/审批/状态）全可用。推荐：

```powershell
tailscale serve --bg 4123   # 得到 https://<机器名>.ts.net/，WS 自动走 wss
```

App / 网页里把中继地址填成这个 https 地址即可。

## 5. 安全

- **Token 即权限**：拿到地址+Token 就能批准你电脑上的命令，当密码保管。
- 别裸暴露公网；远程用 Tailscale（私网+HTTPS）。
- `~/.codex/config.toml` 内含第三方中转明文 token，别外发该文件/截图。
- 审批策略别设 `never`，否则远程控制等于放开。

## 会话占用与停止

遇到 `already has an active writer` 表示同一会话已有其他 Codex 进程持有写入锁，空闲会话也可能仍被占用。网页与手机端会显示「会话被占用」，可重试接续、重新检查占用，或在 Windows 上确认「结束进程并尝试接续」。

结束前会列出 PID 和所有受影响会话，并要求二次确认；不会自动强杀，不会批量结束其他 Codex，也不会删除锁文件。多个占用者、无权限或无法可靠识别时不提供结束操作。进程身份或受影响会话在确认后变化，操作会被拒绝，需重新检查。

**结束的是整个占用 Codex 进程，可能同时影响多个会话。已产生改动不会回滚，已启动子进程可能继续运行。优先在原电脑客户端正常停止或关闭会话。** 当前会话的「停止」按钮也已补齐 `turnId` 参数，接续本中继的运行中会话会保留任务状态。

自动测试：`npm test`。Windows 隔离进程测试：`npm run test:writer-process`（临时配置目录、独立进程、不发送模型提示词，不操作现有会话）。

## 已验证

- ✅ web 端到端：发提示词 → 流式回复 → 完成
- ✅ 审批回路：Codex 要写文件 → 手机卡片 → 拒绝 → 命令真被拦截（文件未创建）
- ✅ Token 鉴权（错误 token 关闭码 4001）、`/health`、静态托管
- ✅ mobile (Expo)：Metro 打包通过（639 modules，零错误）；真机交互需用 Expo Go 验证

各端细节见对应文件夹的 README；协议见 [PROTOCOL.md](PROTOCOL.md)。已退役的原生实现保留在 `archive/`。
