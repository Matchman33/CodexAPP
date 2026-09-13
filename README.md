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

**CodexAPP 只启动本地中继与端口，不集成或自动启动映射工具。** 默认端口为 4123，原有 Token 鉴权、会话、审批和任务停止保留。公网映射由用户自行选择和维护，**首推 NPS/NPC**；也可以使用 Tailscale、frp 或局域网直连，见下文 [手机远程访问](#4-手机远程访问用户自选映射)。

不想维护服务器时，可使用下文 [Tailscale Serve](#tailscale-serve) 路线，不需要自有服务器、NPS/frp 或本项目云账号。Windows 用户选择 NPS 时可手动执行 `npm run npc:install`，将 NPC 安装到当前项目目录，见 [NPS 快速接入](#nps-快速接入)。此命令只调用用户提供的安装脚本，不自动连接 NPS 或启动系统服务。

已有 frp 用户可自行继续维护其部署；项目不再提供服务器映射安装和续期脚本，具体部署由用户按所选版本官方说明完成。

本地网页构建、服务诊断、打包和业务测试脚本保留。除可选 NPC 文件安装快捷命令外，映射配置、客户端连接、服务端安装、系统服务、自启、证书与防火墙均由用户独立维护；`npm start` 不调用安装脚本。

当前网页/PWA 与 Expo 手机端的「中继直连」支持本地路线；电脑 Node/Electron 云 Agent 启动器仍只启动云模式，不能代替本地中继的 `npm start`。取消映射整合不更改这些启动器或删除已有云配对能力。

```
CodexApp/
├─ relay/        共享后端：Node 中继（spawn app-server + WS + 托管 web + token 鉴权）
├─ web/          网页/PWA 客户端（本地图标与 Markdown，由中继托管）
├─ mobile/       Expo 客户端（iOS + Android 一套代码）            → 见 mobile/README.md
├─ protocol/ts/  从本机 codex 二进制导出的真实协议定义（参考）
├─ archive/      已退役的原生工程（native-android / native-ios，留作参考）
├─ PROTOCOL.md   中继 ↔ 客户端 协议规范
├─ codexapp.config.json   中继配置（首次启动自动生成 token）
├─ install.ps1   Windows NPC 手动安装脚本（不参与 npm start）
└─ package.json
```

## 1. 启动中继（电脑端，所有客户端都要它）

```powershell
cd C:\test\CodexAPP
npm install     # 第一次安装依赖
npm start
```

启动后终端打印局域网地址和 Token：

`npm start` 会先运行 `npm run build:web`，将 Lucide 图标、Marked 与 DOMPurify 打包到本地。不依赖第三方 CDN。单独部署云端网页时也需要先构建，并将生成的 `web/vendor/chat-ui.js` 与网页文件一起部署；生成文件不进入 Git。

```
  PWA:   http://192.168.1.84:4123/
  Token: <你的Token（npm start 时终端会打印）>
```

> 同一局域网的其他设备直连 4123 端口时，如被 Windows 防火墙拦截，可在管理员 PowerShell 中放行：
> `New-NetFirewallRule -DisplayName "CodexApp 4123" -Direction Inbound -LocalPort 4123 -Protocol TCP -Action Allow`
>
> 使用下文的 Serve 时，通过本机回环地址转发，不需要将 4123 端口直接开放到公网，也不需要路由器端口映射。

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

### 模型与思考等级

在网页或 Expo 手机端的「设置 → 模型」选择模型，也可切换「自定义模型」填写服务商的模型 ID。列表由电脑端 Codex 动态提供，可刷新；选择「Codex 默认」恢复当前工作目录的 Codex 配置。服务商是否支持某个模型以实际调用结果为准。

点「应用」保存，或点「新建会话」保存并创建会话。模型从下一条消息开始生效，不中断当前任务。模型选择保存在局域网中继的 `codexapp.config.json`，或云 Agent 用户配置目录的 `agent.config.json`，重启后保留；不改 Codex 本身的配置或登录信息。云端使用时需更新电脑 Agent 与托管的网页，Expo 客户端也需加载新版代码。

「思考等级」按所选模型的能力动态提供，包括低、中等、高或服务商提供的扩展等级；不是每个模型都支持所有等级。目录未提供能力信息时可输入自定义等级，最终是否支持以服务商实际结果为准。更换模型时，不兼容的等级会恢复默认。

等级保存为 `reasoningEffort`，与模型一起原子保存；下一次发送通过官方 `turn/start.effort` 传入。选择「Codex 默认」后，读取工作目录的有效默认等级，或使用所选模型的目录默认等级，并显式覆盖已有会话的旧选择。无法确定默认且原会话已有明确等级时，会提示选择明确等级，不悄悄沿用旧值。调整不打断当前任务，也不影响「纠偏」中的已运行任务。

### 网页界面

- 手机使用侧边会话抽屉，桌面使用常驻侧栏；支持搜索项目与对话、显示当前会话、快捷新建。
- 顶部模型入口与输入框旁的思考入口打开设置；网页可选浅色、深色或跟随系统，外观只保存在当前浏览器。
- 用户消息使用气泡，助手消息采用不带外框的阅读布局；支持安全 Markdown、代码块、表格与复制回复。不会加载消息中的远程图片或执行 HTML 脚本。
- 阅读旧消息时，流式回复不自动拉回底部；点击向下箭头回到最新消息。输入框适配移动端可视区域与软键盘。
- 保留任务停止、纠偏、审批、文件差异和会话占用确认。新版 Expo 客户端同步加入思考等级和中性深色聊天界面；原生端仍以可选择文本显示回复，不等同于网页 Markdown 渲染。

### 长会话加载

新版网页打开会话时只读取最近一页，向上滚动或点击向上箭头加载更早记录；已移出缓存的较新记录可通过向下箭头或回到最新消息重新读取。历史仍完整保存在 Codex 中，显示分页不会缩短模型上下文，也不影响审批、停止、纠偏和会话占用处理。

每页最多 50 条、65536 个文本字符，长消息与工具输出按 8192 字符分段查看，内容范围标记显示当前段与完整长度。网页保留 3 页历史和最多 100 条近期更新，只为可视区域附近最多 60 条消息创建 DOM；不会因持续翻页无限堆积全文。流式阶段用安全纯文本更新，完成后再渲染 Markdown，避免反复解析长回复；长消息的复制按钮仅复制当前段。

本地中继和云 Agent 共享分页实现，服务端在分页模式保留最多 100 条近期事件。现有 Expo 客户端未启用新分页协议，保留原完整历史读取兼容路径，不声明分页的旧客户端不享受此后端缓存上限。旧服务端与新网页混用时也不能保证传输大小有界，应同步更新网页及实际使用的中继/Agent。

Codex 二进制版本的支持程度不同：优先使用条目分页；尚未实现时降级为一次读取一轮，而不是整个会话。单轮特别大时仍可能有后端读取延迟，Codex 自身读盘与巨大任务差异也不在本次网页优化的保证范围内。协议与字段见 [PROTOCOL.md](PROTOCOL.md)。代码更新后需重启实际使用的中继/Agent 并刷新网页。

回归测试：`npm test`、`npm run test:web`、`npm run test:history-web`。长历史测试使用 2000 条模拟消息、独立随机端口及隔离 WebSocket，检查三种屏幕宽度的分页、缓存淘汰、内容分段、迟到响应和流式归并，不操作真实 Codex 会话。截图输出到被 Git 忽略的 `dist-check/history-ui/`。

### 审批策略

要让手机收到审批，中继会在每个会话强制审批策略（你的 `config.toml` 是 `never`，不强制就没审批）。
App 里可调：`on-request`(默认) / `untrusted`(几乎每条都问) / `on-failure` / `never`；
配合沙箱 `workspace-write` / `read-only` / `danger-full-access`。

> `permission` 类审批 v1 只支持拒绝；命令、文件改动审批的批准/拒绝都完整。

## 4. 手机远程访问（用户自选映射）

公网 IP 映射首推用户独立部署 NPS/NPC。下文同时保留无需自有服务器的 Tailscale Serve 操作，已有 frp 用户也可自行维护原部署。三者均不参与 npm start，不启用任何映射工具也能使用本地中继。实际速度以同网络对比结果为准。

### 方案选择

| 方案 | 使用方式 | 自有公网服务器 |
|---|---|---|
| NPS/NPC（首推） | 服务器运行 NPS，项目电脑运行 NPC，按电脑分配独立 TCP 映射 | 通常需要 |
| Tailscale Serve | 手机与电脑接入同一 tailnet，使用私网 HTTPS 入口 | 不需要 |
| frp | 用户按所选版本官方说明独立维护隧道 | 通常需要 |
| 局域网直连 | 使用电脑局域网地址、本地端口和应用 Token | 不需要 |

### NPS 快速接入

Windows 项目根目录可手动执行客户端安装：

```powershell
npm run npc:install
```

等价命令为 `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 npc latest .`。最后的 `.` 是当前项目目录，输出为根目录 `npc.exe` 和 `conf/npc.conf`。必须使用 `npc` 模式：`nps` 安装服务端，`all` 安装两者，服务端包可能覆盖本项目 `web/`，不要在本目录使用这两个模式。

此快捷命令仅适用于 Windows，不会自动连接 NPS、注册服务、开机自启或启动另一个 Codex。`latest` 在安装时尝试解析最新发行，并使用脚本原有镜像回退；不保证与既有服务器兼容。需对齐版本时，例如执行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 npc v0.34.7 .`。安装脚本未提供包 SHA-256 校验，请用户自行确认下载来源，不在 NPC 正使用二进制时重跑安装。

安装后编辑 `conf/npc.conf`，按服务器实际设置填写 `server_addr`、`conn_type` 和 `vkey`。已有配置会保留，新模板写入 `conf/npc.conf.default`。不要用发行包示例密钥，不把真实 vkey 放入 package.json、公开命令、日志或截图；相关客户端配置和二进制均被 Git 忽略。

先确认项目电脑的中继已运行，健康检查的 `ok` 和 `codexConnected` 都为 true，再手动启动 NPC：

```powershell
Invoke-RestMethod http://127.0.0.1:4123/health
.\npc.exe -config=".\conf\npc.conf" -log=off
```

如果本机中继已运行，不要重复 npm start。NPC 应与 CodexAPP 在同一电脑、同一本地网络环境运行，不能把服务器、WSL 或容器里的回环地址误当成 Windows 本机服务。不要同时运行相同设备身份的多个 NPC。

NPS 服务器由用户独立安装和管理，不在服务器安装 CodexAPP 或复制电脑 Codex 凭据。建议 NPC 使用 TLS 接入服务器（当前配置示例为 TCP 8025），面板创建 TCP 隧道；HTTP 和 WebSocket 都可由同一 TCP 映射承载，客户端 `-type=ws` 不是网页使用 WebSocket 的必要条件。

| 隧道字段 | 建议 |
|---|---|
| 类型 | TCP |
| 客户端 | 运行 CodexAPP 的对应电脑 |
| 服务端端口 | 用户指定且空闲，例如 18123；按需放行安全组和防火墙 |
| 目标 | 127.0.0.1:4123，由项目电脑的 NPC 访问 |
| 本地代理 | 关闭，避免由服务器直接访问回环目标 |
| PROXY protocol | 禁用 / 0，本地 Node HTTP 服务不解析 V1/V2 前缀 |

两台电脑可以各自使用本地 4123，但应使用独立 vkey 和公网端口，例如 A 为 18123、B 为 18124；访问哪台电脑就填写那台的 CodexAPP 应用 Token。NPS vkey、面板密码和应用 Token 不能互换。

浏览器入口示例为 `http://服务器IP:18123/`。NPC 到服务器的 TLS 不会让公网浏览器入口自动变成 HTTPS；公网 HTTP/WS 仅用于临时联通测试，正式任务和审批应使用 HTTPS/WSS 或可信私网入口。NPS 面板、证书、来源限制及后台运行仍由用户维护。

### Tailscale Serve

已有 **Tailscale Serve** 方案不使用 Funnel 公网入口。电脑与手机都安装并连接同一个 Tailscale 网络，Serve 为本地中继提供仅限私网访问的 HTTPS 地址，不需要部署本项目的云端 Broker。

Serve 在两端成功点对点直连时有机会减少中转延迟；无法直连时仍可能走中继，不能保证一定比 Funnel 快。手机必须开启 Tailscale，仅用普通浏览器但未接入 Tailscale 网络无法访问。

#### 电脑端启动

1. 在项目根目录运行 `npm start`，保持中继进程运行。确认本机访问 `http://127.0.0.1:4123/health` 返回 `"ok": true`。
2. 在另一个 PowerShell 窗口启用 Serve：

   ```powershell
   tailscale serve --bg 4123
   ```

   首次使用如果提示 Serve 未启用，打开命令输出的授权链接，完成 HTTPS 等授权；若没有自动继续，再运行一次上述命令。
3. 成功输出应包含 **`Available within your tailnet`**，例如：

   ```text
   Available within your tailnet:
   https://my-pc.tail123456.ts.net/
   |-- proxy http://127.0.0.1:4123
   ```

   使用命令实际输出的完整域名，示例域名不可直接使用。`--bg` 让代理在后台运行，可以关闭该命令窗口；运行 `npm start` 的中继进程和电脑上的 Tailscale 仍需保持运行。

如果此前启用了 Funnel，先关闭公网入口，再启用 Serve：

```powershell
tailscale funnel --https=443 off
tailscale serve --bg 4123
```

确认 `tailscale serve status` 显示 **`tailnet only`**。本项目不需要 Funnel，不应再运行 `tailscale funnel --bg 4123` 将同一地址改回公网模式。

#### 手机连接

1. 手机安装 Tailscale，登录并加入电脑所在的同一网络，开启连接。确认电脑和手机都在线；手机无需与电脑连接同一 WiFi。
2. 浏览器打开 Serve 输出的 HTTPS 地址，**不要加 `:4123`**。网页识别到电脑中继后，默认显示 **「中继直连」** 并填入当前页面地址，不需要注册云账号。
3. 确认中继地址是同一个完整 HTTPS 地址，Token 填电脑端 `npm start` 输出的 Token，再点连接。不要填旧的 `http://192.168.x.x:4123` 或 `http://100.x.x.x:4123` 地址；WebSocket 会自动使用 `wss://`。已有自定义地址不会自动替换，可以点击「使用当前页面地址」后重新连接。

Expo 客户端也使用相同的 HTTPS 中继地址和 Token。浏览器支持时可添加到主屏幕；HTTPS 本身不保证手机锁屏后网页仍保持连接或持续接收通知。

#### 首次连接与切换网络

- 在家和外出均使用同一个 Serve HTTPS 域名。局域网 IP 与 HTTPS 域名是不同的网页来源，各自保存连接配置；换地址后需要重新输入 Token，不会共享登录信息。
- 已保存配置时会先进入对话页，但只有收到中继的初始化消息后才允许发送。看到对话页不代表连接已经成功。
- 网页的登录请求与连接初始化有 12 秒超时处理，失败后单次退避重试；网络恢复、从后台回到前台时立即重建连接。右上角重连按钮可手动重试，不会自动重新发送提示词。
- HTTPS 页面填写 HTTP 中继地址会直接提示更换地址，而不是一直显示连接中。Token 无效时保留地址并返回连接页，避免反复自动重连。
- 这些处理减少页面等待和旧连接干扰，不能消除 Tailscale 建链或中继线路的延迟。手机切到移动网络时仍需保持 Tailscale 开启。

#### 检查与关闭

```powershell
tailscale serve status              # 应显示 tailnet only
tailscale serve --https=443 off      # 关闭 HTTPS 私网入口，本地中继继续运行
tailscale status                    # 检查电脑和手机是否在线
```

- **手机打不开域名**：先确认手机 Tailscale 已连接同一网络、电脑在线，并检查私网访问规则及 MagicDNS。Serve 不是公网访问，不需要等待 Funnel 公网 DNS 生效。
- **区分域名故障与应用连接故障**：在手机打开 `https://<实际域名>/health`。返回包含 `"ok": true` 的 JSON 表示 HTTPS 转发已通；若网页能打开但应用断线，检查「中继直连」模式中的中继地址是否已换成该 HTTPS 域名，以及 Token 是否正确。
- **电脑能打开、手机打不开**：检查手机是否仍开启 Tailscale、是否在同一网络、访问规则是否允许；手机切换移动网络后也需保持 Tailscale 连接。
- **本机 `/health` 也打不开**：检查中继是否仍运行、端口是否为 4123。中继端口改变时，Serve 的目标端口也需同步修改。

访问范围和 HTTPS 配置见 [Tailscale Serve 官方文档](https://tailscale.com/docs/features/tailscale-serve)。

### 延迟与排错

优先检查电脑与手机之间的连接类型。电脑上运行 `tailscale ping <手机的 Tailscale IP>`，观察是否建立直连；`tailscale status` 也可查看活动连接的 direct/relay 信息。直连不代表一定快，仍需比较实际请求耗时。NPS 或 frp 入口则分别检查服务器监听、客户端在线状态、目标服务与实际 HTTP/WebSocket 请求。

模型响应等待与手机到电脑的网络等待是两段不同的链路。换公网入口不能直接解决模型服务商慢的问题；提高思考等级也不是网络加速方式。

## 5. 安全

- **Token 即权限**：拿到地址+Token 就能批准你电脑上的命令，当密码保管。
- 任何映射都不替代项目 Token 校验，不在分享链接、截图或公开日志中附带 Token。选择 Serve 时保持私网范围，不把同一入口误改为 Funnel 公网；选择 NPS/frp 时，由用户维护 HTTPS/WSS 和来源限制，不直接把本机 4123 裸露到公网。
- `~/.codex/config.toml` 内含第三方中转明文 token，别外发该文件/截图。
- 审批策略别设 `never`，否则远程控制等于放开。

## 会话占用与停止

遇到 `already has an active writer` 表示同一会话已有其他 Codex 进程持有写入锁，空闲会话也可能仍被占用。网页与手机端会显示「会话被占用」，可重试接续、重新检查占用，或在 Windows 上确认「结束进程并尝试接续」。

结束前会列出 PID 和所有受影响会话，并要求二次确认；不会自动强杀，不会批量结束其他 Codex，也不会删除锁文件。多个占用者、无权限或无法可靠识别时不提供结束操作。进程身份或受影响会话在确认后变化，操作会被拒绝，需重新检查。

**结束的是整个占用 Codex 进程，可能同时影响多个会话。已产生改动不会回滚，已启动子进程可能继续运行。优先在原电脑客户端正常停止或关闭会话。** 当前会话的「停止」按钮也已补齐 `turnId` 参数，接续本中继的运行中会话会保留任务状态。

自动测试：`npm test`。Windows 隔离进程测试：`npm run test:writer-process`（临时配置目录、独立进程、不发送模型提示词，不操作现有会话）。

## 已验证

下方为既有验证记录，不代表 NPS 公网流程已完整验收。本轮文档整理没有重新执行真实 Codex 任务、审批或移动端打包。

新增回归验证：`npm test`（含思考等级、默认恢复与配置保存）；`npm run test:web` 使用系统 Edge 无头浏览器与隔离模拟 WebSocket，在 320、390、1280 像素宽度检查模型联动、思考设置、搜索、历史切换、流式归并、审批、停止、纠偏与安全渲染，不操作真实 Codex 会话。需要换浏览器通道时设置 `CODEXAPP_TEST_BROWSER`，且该通道的浏览器已安装。截图在被 Git 忽略的 `dist-check/web-ui/`。

- ✅ web 端到端：发提示词 → 流式回复 → 完成
- ✅ 审批回路：Codex 要写文件 → 手机卡片 → 拒绝 → 命令真被拦截（文件未创建）
- ✅ Token 鉴权（错误 token 关闭码 4001）、`/health`、静态托管
- ✅ mobile (Expo)：Metro 打包通过（639 modules，零错误）；真机交互需用 Expo Go 验证

各端细节见对应文件夹的 README；协议见 [PROTOCOL.md](PROTOCOL.md)。已退役的原生实现保留在 `archive/`。
