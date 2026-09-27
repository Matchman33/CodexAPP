# CodexApp 云中转 + 端到端加密（v1）

本目录是保留的可选云路线，不是根目录 npm start 的默认启动内容。根目录只运行本机中继和 Codex app-server；NPS/NPC、Tailscale 或 frp 映射由用户独立选择，见 [主说明](../README.md#4-手机远程访问用户自选映射)。NPC 安装快捷命令不启动本目录的 Broker 或 Agent，NPS TCP 转发也不等同于下面的应用层端到端加密和云配对。

让用户**装个 exe、登录同账号，就能从任何网络用手机控制电脑上的 Codex**——不用公网 IP、不用端口转发，且**服务器看不到你的内容**。

```
[手机 App] ──WSS /link──►┌──────────────┐◄──WSS /link(出站)── [PC Agent] ──本机中继──► [codex app-server]
  登录账号                │  云 Broker    │                      登录同账号              Codex 本体+认证+执行
  E2E 加密                │ 按账号配对    │                      E2E 解密/驱动 codex
                         │ 只转发密文    │
                         └──────────────┘
```

- **PC Agent 主动外连 Broker**（出站连接天然穿 NAT/CGNAT，零网络配置）。
- Broker 按**账号**把手机和这台 Agent 配对，**只转发端到端加密的密文**，自己读不懂。
- 手机和 Agent 用 **NaCl box（Curve25519 + XSalsa20-Poly1305）** 端到端加密；密钥不出设备。

## 多账号与多手机

云账号连接免费使用，不需要会员、试用期或兑换码。账号仍需完成邮箱验证，并保持未停用状态。管理员可在后台停用或恢复账号；停用立即断开云连接并阻止再次登录，本机任务继续执行。

支持多个账号各自连接一台 Agent；同一账号可以同时连接多个手机、浏览器或网页标签。不同账号的连接路由相互隔离，不支持跨账号分享 Agent，也不提供同账号多台电脑选择。

登录后，Broker 用登录令牌中的 `accountId` 定位该账号唯一在线的 Agent，不需要手机填写电脑地址。电脑不在线时显示等待；另一台设备使用同账号上线会收到 `agent_already_online`。新版 Agent 使用设备私钥证明同设备身份后，可替换断网遗留的旧连接，不必等待心跳清理；旧 Agent 或主动换机仍需先退出原 Agent。详情见 [连接与会话优化](../docs/连接与会话优化.md)。

账号定位和设备配对分开处理：

- `pairingMode: "open"` 是当前默认值，同账号登录直接授权。
- `pairingMode: "code"` 要求每台新手机输入电脑面板显示的配对码；校验绑定双方公钥，成功后 Agent 记住该手机公钥，后续免码。浏览器清除本地密钥后需要重新配对。
- 多个手机共用同一台 Agent 的配对码，但各自使用设备密钥和独立信封。未配对的连接不能读取业务状态或执行命令。
- 电脑面板显示在线连接数、已授权连接数和设备指纹。同一浏览器多个标签共享设备密钥，但连接和会话选择分别管理，因此连接数不等于物理手机数。

每个手机独立选择会话；可以查看同一会话，也可以在不同会话中同时运行任务。审批只处理一次并同步结果，重复处理返回已失效；停止只作用于目标会话。只读历史、外部占用确认、权限延后生效、排队消息和终端输入控制规则沿用直连核心。断开某个手机只清理其订阅及终端查看状态，不停止后台任务、不释放其他手机的控制权。重新连接后可重新选择原会话读取快照；网页沿用已有的会话恢复逻辑，旧版原生客户端可能需要手动选择。

云端账号隔离不等于同一操作系统内的文件权限隔离。同一电脑运行不同账号的 Agent 时，需要分别配置 `CODEXAPP_DIR`，并按需要隔离 Codex 环境及系统用户权限。

### 升级与验证

先更新并重启 Broker，再更新网页、Agent 和 Expo 客户端；已有 SEA/Electron 安装包需要重新构建。手机侧加密协议保持兼容，不必重新注册账号或重新生成已有设备密钥，但客户端需要更新以移除旧版会员判断。新版 Agent 遇到旧 Broker 会明确提示更新；新版 Broker 对旧 Agent 保留单手机通信兼容。

专项验证：`node --test tests/cloudMultiPhone.test.mjs tests/cloudMultiPhone.integration.mjs tests/sessionHub.test.mjs tests/terminalHub.test.mjs`。多手机测试覆盖跨账号路由隔离、独立加密与配对、相同公钥的多连接、旧客户端无 `clientId`、重复 Agent、定向回复、审批去重、终端控制权及断线清理。进程测试启动临时 Broker、两个 Agent 和模拟手机，使用独立数据库、随机端口与模拟 Codex，不发送真实模型请求、不重启现有服务。

免费账号专项：`node --test tests/freeAccounts.test.mjs tests/cloudMultiPhone.integration.mjs` 与 `node tests/freeAccess-web.integration.mjs`，验证旧数据库迁移、免费连接、管理员停用与恢复、失效令牌、无收费入口和停用提示。Expo 客户端已做 Android 导出检查，真机使用仍需加载新版客户端。

## 组成

| 文件 | 作用 |
|---|---|
| `cloud/broker.mjs` | 云 Broker：账号登录、按账号配对、转发密文。**部署在你的服务器**。 |
| `cloud/agent.mjs` | PC Agent：出站连 Broker + E2E + 驱动本地 Codex。**打包成 exe 给用户**。 |
| `cloud/e2e.mjs` | 端到端加密（NaCl box）。 |
| `core/codexBridge.mjs` | 传输无关的 Codex 控制核心（LAN 中继与云 Agent 共用）。 |
| `cloud/testPhone.mjs` | 模拟手机的端到端测试客户端。 |

## 消息协议

**手机/Agent ↔ Broker（明文，仅用于路由）**

| type | 方向 | 字段 | 说明 |
|---|---|---|---|
| `auth` | →Broker | `token`, `role`(`agent`/`phone`), `pubkey`, `multiPhone` | 新 Agent 必须声明 `multiPhone: true`；手机无需新增字段 |
| `agentChallenge` / `agentProof` | Broker ↔ Agent | `challenge` / `signature` | Agent 在 `auth` 中提供 `deviceKey` 后完成一次性签名挑战，证明持有设备私钥 |
| `authed` | →端 | `peerOnline`, `peerPubkey` 或 `peers[]` | 手机仍收到 Agent 公钥；新 Agent 收到 `multiPhone: true` 与 `{phoneId, pubkey}` 列表 |
| `peer` | →端 | `online`, `pubkey`, `phoneId` | 通知 Agent 时携带对应手机的 `phoneId`；通知手机时仅描述 Agent |
| `e2e` | 双向 | `nonce`, `box`, `phoneId` | Agent 收发时携带 Broker 分配的连接标识；手机的发送身份由 Broker 写入，不能自行指定；回复只发送给同账号目标连接 |

Agent 为每个连接分配独立的内部 `clientId`，与手机消息里的 `clientId` 绑定并在回复时转换，避免不同手机或共享设备密钥的网页标签串用会话。业务广播也由 Agent 针对每个已授权连接分别加密，Broker 不广播同一密文给全部手机。管理后台 `/api/admin/overview` 的在线项保留 `phone` 布尔字段，同时增加 `phoneCount`；Agent `/api/status` 增加 `onlinePhones` 和 `pairedPhones`。

**信封解密后（手机 ↔ Agent，端到端）= 既有的 CodexApp 协议**（`prompt`/`approval`/`event`/`diff`/`hello`…，见 [../PROTOCOL.md](../PROTOCOL.md)）。也就是说云中转**完全复用**了原有协议，只是套了一层 E2E + 账号路由。

**认证 REST**

```
POST /api/register  {email, password} -> {accountId}
POST /api/login     {email, password} -> {token, accountId}
```

## 跑通（本地三进程演示）

```powershell
# 1) Broker
node cloud/broker.mjs                       # :8787

# 2) PC Agent（填 cloud/agent.config.json 的 email/password）
node cloud/agent.mjs                        # 出站连 Broker + 启动本地 codex

# 3) 模拟手机（同账号）
node cloud/testPhone.mjs you@example.com yourpassword "只用一个词回复我：你好"
```

已实测：手机端**加密**发提示词 → 经 Broker（只见密文）→ Agent 解密驱动真实 Codex → 回复**加密**回传 → 手机解密显示。Broker 日志只有"谁上下线"，无任何消息内容。

## 安全模型

- **消息保密性**：业务消息端到端加密，正常转发的 Broker 只处理密文。配对身份校验与网页发布来源的信任边界见下文，不能仅凭加密宣称服务器失陷后所有客户端仍然安全。
- **审批闸门保留**：手机仍然要批准 Codex 的命令/文件改动——远程能力可控。
- **密钥**：Agent 的设备密钥保存在配置目录的 `agent.keys.json`，配对记录在 `agent.pairing.json`；Windows 默认配置目录为 `%APPDATA%/CodexApp`，可用 `CODEXAPP_DIR` 指定。

> **配对码模式**：首次连接必须完成配对码握手，`sas()` 将配对码与双方公钥绑定；成功后 Agent 固定手机公钥。上述配对检查仅适用于 `pairingMode: "code"`，默认免码模式依赖 Broker 的账号认证，不能套用同样的身份校验保证。网页代码由 Broker 托管，端到端加密也不替代对网页发布来源的信任。

## 离生产还差什么

已完成的是**最核心、最难的连通 + E2E 内核**。要做成上架产品，还需：

1. **账号系统**：✅ 已加固——HMAC 签名 token（带过期、broker 重启不失效）、邮箱/密码校验、
   登录限流（per IP+email）、scrypt + 定时安全比较。**仍待**：换真数据库（现为 `accounts.json`）、
   邮箱验证、找回密码、刷新令牌。
2. ✅ **配对码 + SAS 核对**：已实现，堵上 MITM（见上）。
3. **推送通知**：审批到达时推到手机（APNs）。Broker 需接 APNs，Agent 离线/手机后台时发推送。
4. **打包(跨平台)**：✅ 已做——`node cloud/build-agent.mjs` 用 esbuild + Node SEA 打成单文件,
   **在哪个系统上跑就出哪个系统的二进制**(不能交叉编译):Windows→`dist/CodexApp-Agent.exe`、
   macOS→`dist/CodexApp-Agent`(自动 ad-hoc 签名)、Linux→`dist/CodexApp-Agent`,用户都无需装 Node。
   安装脚本:Windows `cloud/installer/Install.cmd`(隐藏窗口开机自启);macOS
   `cloud/installer/install-mac.sh`(LaunchAgent 登录自启 + 打开控制面板登录)。Agent 现有**内置
   控制面板**(`http://127.0.0.1:7878` 登录/注册/状态/配对码),三端通用。
   **仍待**:代码签名(Windows 免 SmartScreen;macOS 用 Developer ID 签名+公证免 Gatekeeper)。
5. **客户端云模式**：✅ 已接——
   - **网页**：`web/` 现支持「云账号」模式（邮箱注册/登录 + E2E + 配对），且 **Broker 直接托管网页**
     （用户访问 `https://<broker>/` 登录即用，同源）。多设备可同时配对（Agent pin 多个公钥）。
   - **iOS/Android**：`mobile/`（Expo）同样支持云账号模式。
   **仍待**：APNs 推送、上架。
6. ✅ **传输安全**：Broker 已支持 **wss/https**（`TLS_CERT`/`TLS_KEY`，无证书回落 http/ws）；
   部署见 [DEPLOY.md](DEPLOY.md)（Caddy 自动 TLS / 原生 TLS / systemd）。**仍待**：速率限制、滥用防护。
7. **多设备**：已支持不同账号各一台 Agent，以及同账号多个手机同时连接；同账号多电脑选择和跨账号授权暂不支持。
8. **可观测**：已有连接计数与 WebSocket 心跳；仍需按实际规模补充监控和容量规划（每账号一条 Agent 连接，加上每个手机客户端的连接）。

把 v1 内核（本目录）跑通后，上面这些是工程化与产品化，不再有"能不能实现"的不确定性。

## 交互终端分发说明

Node、SEA 和 Electron 的终端需要平台对应的 `node-pty` 原生模块及 `terminalPtyWorker.cjs`。构建脚本会把运行文件复制到产物旁；启用终端的 SEA 产物不再是仅复制单个可执行文件即可使用，必须同时分发生成的 `node_modules` 与 worker。模块缺失时只禁用终端，原云端聊天功能保留。终端沿用已配对的 E2E 通道，不新增公开执行接口。
