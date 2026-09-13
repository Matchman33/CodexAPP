# CodexApp 云中转 + 端到端加密（v1）

本目录是保留的可选云路线，不是根目录 npm start 的默认启动内容。根目录只运行本机中继和 Codex app-server；NPS/NPC、Tailscale 或 frp 映射由用户独立选择，见 [主说明](../README.md#4-手机远程访问用户自选映射)。NPC 安装快捷命令不启动本目录的 Broker 或 Agent，NPS TCP 转发也不等同于下面的应用层端到端加密和云配对。

让用户**装个 exe、登录同账号，就能从任何网络用手机控制电脑上的 Codex**——不用公网 IP、不用端口转发，且**服务器看不到你的内容**。

```
[手机 App] ──WSS /link──►┌──────────────┐◄──WSS /link(出站)── [PC Agent] ──stdio──► [codex app-server]
  登录账号                │  云 Broker    │                      登录同账号              Codex 本体+认证+执行
  E2E 加密                │ 按账号配对    │                      E2E 解密/驱动 codex
                         │ 只转发密文    │
                         └──────────────┘
```

- **PC Agent 主动外连 Broker**（出站连接天然穿 NAT/CGNAT，零网络配置）。
- Broker 按**账号**把手机和这台 Agent 配对，**只转发端到端加密的密文**，自己读不懂。
- 手机和 Agent 用 **NaCl box（Curve25519 + XSalsa20-Poly1305）** 端到端加密；密钥不出设备。

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
| `auth` | →Broker | `token`, `role`(`agent`/`phone`), `pubkey` | 登录后用 session token 认证 + 公布本端公钥 |
| `authed` | →端 | `peerOnline`, `peerPubkey` | 认证成功，告知对端是否在线及其公钥 |
| `peer` | →端 | `online`, `pubkey` | 对端上/下线 + 公钥（用于密钥交换） |
| `e2e` | 双向 | `nonce`, `box` | **加密信封**，Broker 原样转发给对端，读不懂 |

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

- **Broker 不可信**：所有 CodexApp 消息端到端加密，Broker 只是个加密管道。即使 Broker 被攻破，也读不到你的代码/命令/回复。
- **审批闸门保留**：手机仍然要批准 Codex 的命令/文件改动——远程能力可控。
- **密钥**：Agent 的设备密钥存 `cloud/agent.keys.json`（已 gitignore），不出本机。

> ✅ **MITM 已封堵（配对码）**：手机和 Agent 通过 Broker 交换公钥，但首次连接必须完成
> **配对码握手**——Agent 显示一个配对码，用户在手机上输入；该码经 `sas()` 绑进**双方公钥**
> 的短认证串。恶意 Broker 若调包公钥，SAS 不匹配 → 配对被拒。配对成功后 Agent **pin** 手机公钥，
> 后续免码。**未配对的手机拿不到任何数据、也无法让 Codex 执行命令。**（正/负用例已测。）

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
   **仍待**：APNs 推送、App 内购买(IAP)、上架。
6. ✅ **传输安全**：Broker 已支持 **wss/https**（`TLS_CERT`/`TLS_KEY`，无证书回落 http/ws）；
   部署见 [DEPLOY.md](DEPLOY.md)（Caddy 自动 TLS / 原生 TLS / systemd）。**仍待**：速率限制、滥用防护。
7. **多设备**：当前一账号一 Agent 一手机。多手机/多电脑需扩展路由与多方密钥。
8. **可观测**：日志、监控、连接数扩展（每用户 2 条常连）。

把 v1 内核（本目录）跑通后，上面这些是工程化与产品化，不再有"能不能实现"的不确定性。
