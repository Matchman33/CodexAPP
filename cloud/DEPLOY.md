# 部署 CodexApp Broker（生产）

你只需要部署 **Broker**（一台小服务器）。Agent 跑在用户电脑、App 在用户手机——它们都**主动外连**你的 Broker，所以 Broker 只要有个公网域名 + HTTPS 即可。

## 准备

- 一台 VPS（1 核 512MB 起步就够，Broker 很轻）
- 一个域名指向它，例如 `broker.yourdomain.com`
- **Node ≥ 22**（Broker 用内置 `node:sqlite` 存账号）
- 一个发信渠道（SMTP / SendGrid / Mailgun / SES…）用于发验证邮件

## 一键部署（推荐）

在服务器上(域名 DNS 已指向它),用 root 运行:
```bash
curl -fsSL https://raw.githubusercontent.com/LuckyYouStudio/CodexAPP/main/cloud/deploy.sh -o deploy.sh
sudo bash deploy.sh        # 按提示填:域名、管理员邮箱、SMTP
```
脚本自动:装 Node22 + Caddy → 拉代码 → 配 `/etc/codexapp/broker.env`(含随机生成的 `ADMIN_TOKEN`)→ systemd 常驻 Broker → Caddy 自动 HTTPS。完成后访问 `https://你的域名/` 即网页客户端,`https://你的域名/admin` 是**管理后台**(脚本结尾会打印管理员令牌)。再次运行 = 更新代码 + 重启(保留原令牌)。

下面是手动步骤(想自己控制时参考)。

## 方式 A：Caddy 自动 HTTPS（推荐，最省事）

让 Caddy 反向代理并自动签 Let's Encrypt 证书，Broker 本身只在本地跑明文。

```
# /etc/caddy/Caddyfile
broker.yourdomain.com {
    reverse_proxy 127.0.0.1:8787
}
```

Broker 本地起（明文，仅监听本机）：
```bash
HOST=127.0.0.1 PORT=8787 PUBLIC_URL=https://broker.yourdomain.com node cloud/broker.mjs
```
Caddy 负责对外的 `https/wss`。WebSocket 升级 Caddy 默认透传，无需额外配置。

## 方式 B：Broker 原生 TLS

用 certbot 拿证书，直接让 Broker 监听 443：
```bash
sudo certbot certonly --standalone -d broker.yourdomain.com
sudo HOST=0.0.0.0 PORT=443 PUBLIC_URL=https://broker.yourdomain.com \
  TLS_CERT=/etc/letsencrypt/live/broker.yourdomain.com/fullchain.pem \
  TLS_KEY=/etc/letsencrypt/live/broker.yourdomain.com/privkey.pem \
  node cloud/broker.mjs
```
启动日志会显示 `[https/wss]`。

## systemd 常驻

```ini
# /etc/systemd/system/codexapp-broker.service
[Unit]
Description=CodexApp Broker
After=network.target

[Service]
WorkingDirectory=/opt/codexapp
Environment=HOST=127.0.0.1 PORT=8787 PUBLIC_URL=https://broker.yourdomain.com ADMIN_TOKEN=换成够长的随机串
Environment=SMTP_HOST=smtp.yourprovider.com SMTP_PORT=587 SMTP_USER=apikey SMTP_PASS=*** SMTP_FROM=no-reply@yourdomain.com
ExecStart=/usr/bin/node cloud/broker.mjs
Restart=always
User=codexapp

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now codexapp-broker
```

## 管理后台

访问 `https://broker.yourdomain.com/admin`,用 `ADMIN_TOKEN`(在 `broker.env`,一键部署会随机生成并在结尾打印)登录。功能:

- **SMTP 设置**:可视化填发信邮箱(主机/端口/用户名/密码/发件人/TLS),**保存即时生效,无需重启**,带「测试连接」。这是配发验证邮件最省事的方式 —— 不必去服务器改 env。
- **概览**：总用户、已验证、已停用账号及当前在线账号和连接数。
- **用户管理**：标记邮箱验证、重发验证邮件、停用或恢复账号、退出全部设备、删除账号。

> SMTP 优先级:后台填的值(存在数据库)**覆盖** env 里的 `SMTP_*`。即未配 env 也行,登录后台填即可。
> 没设 `ADMIN_TOKEN` 时 `/admin` 接口返回「admin 未启用」,纯手动部署记得在 `broker.env` 加一行 `ADMIN_TOKEN=<够长的随机串>`。

## 免费使用与账号停用

- 直连与云账号连接均免费，云端账号通过邮箱验证且未被停用即可使用，不检查会员或试用期限。
- 管理员在用户列表点击“停用账号”，立即断开该账号的全部云连接，拒绝密码登录和旧令牌重连；修改密码或验证邮箱不能解除停用。
- 点击“恢复账号”后允许重新登录，停用前的令牌仍失效。停用只影响云端访问，本机任务继续运行，本地 Token 直连不受影响。
- 数据库自动增加 `disabled` 字段，旧账号默认正常。历史会员字段和兑换码记录保留但不再使用；相关收费接口与界面已经移除，`TRIAL_DAYS` 不再生效。
- 更新 Broker 时同步更新网页、Agent 和 Expo 客户端；旧客户端仍可能因自身会员判断阻止连接。

## 客户端怎么填

- **网页**：访问 `https://broker.yourdomain.com`，云连接使用网页同源地址。
- **手机 App**（云账号模式）：构建时设置 `mobile/src/config.js` 中的 `BROKER_URL`，WS 自动走 `wss://`。
- **PC Agent**：启动前设置环境变量 `CODEXAPP_BROKER=https://broker.yourdomain.com`。当前代码不读取配置文件中的 `brokerUrl`。

### 多账号、多手机升级

每个账号最多一台在线 Agent，同账号多个手机可同时连接；不同账号由 Broker 独立路由。先更新 Broker，再更新 Agent，旧安装包须重新构建。相同账号的第二台 Agent 会被拒绝，不会挤掉第一台；切换电脑须先退出原 Agent。电脑面板显示在线与已授权的客户端连接数，管理后台显示每账号的客户端连接数。

登录同一账号只负责找到 Agent。默认免码模式直接授权；在电脑面板切换为配对码模式后，每台新手机需输入该电脑显示的配对码，成功后保存手机公钥。已有配对记录继续有效。手机通信协议保持兼容，但取消会员机制需要同步更新客户端，详见 [多账号与多手机](README.md#多账号与多手机)。

专项验证使用 `node --test tests/cloudMultiPhone.test.mjs tests/cloudMultiPhone.integration.mjs`，不操作生产账号或真实模型任务。

新版还支持同设备签名重连、账号登录版本撤销，以及本机直连与云端共享一个核心。升级需要同时包含 `cloud/deviceIdentity.mjs`、新版 `db.mjs` 和本机 `relay/transport.mjs` 等依赖，不能只覆盖两个入口文件。数据库会自动增加 `auth_version`。详细行为、数据目录选择和升级顺序见 [连接与会话优化](../docs/连接与会话优化.md)。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址（Caddy 模式设 `127.0.0.1`） |
| `PORT` | `8787` | 端口 |
| `TLS_CERT` / `TLS_KEY` | 空 | PEM 路径；都设了才走 https/wss，否则 http/ws |
| `PUBLIC_URL` | 自动推断 | 验证邮件里链接的域名，例 `https://broker.yourdomain.com`（Caddy 后建议显式设） |
| `DB_PATH` | `cloud/codexapp.db` | SQLite 账号库路径 |
| `ADMIN_TOKEN` | 空 | 设了才启用 `/admin` 管理后台；登录令牌 |
| `SMTP_HOST` / `SMTP_PORT` | 空 | 发信服务器；**不设则验证链接只打到日志**（dev）。后台填的值会覆盖这里 |
| `SMTP_USER` / `SMTP_PASS` | 空 | 发信认证 |
| `SMTP_FROM` | = `SMTP_USER` | 发件人地址 |
| `SMTP_FROM_NAME` | 空 | 发件人显示名（后台「发件人名称」） |

示例（带发信）：
```bash
HOST=127.0.0.1 PORT=8787 PUBLIC_URL=https://broker.yourdomain.com \
  SMTP_HOST=smtp.sendgrid.net SMTP_PORT=587 SMTP_USER=apikey SMTP_PASS=*** \
  SMTP_FROM="CodexApp <no-reply@yourdomain.com>" node cloud/broker.mjs
```

## 生产清单（重要）

- **配 SMTP**（否则验证邮件发不出去，用户无法激活）。最省事:进 `/admin` → SMTP 设置 填写(即时生效)。本地不配时验证链接会打到 Broker 日志，仅供测试。
- **设 `ADMIN_TOKEN`** 并妥善保管(一键部署已自动随机生成);它能进后台改 SMTP、删用户。
- 账号库已是 **SQLite + JWT（带过期）+ 邮箱验证 + 登录限流**。备份 `codexapp.db` 和 `broker.secret`。
- 防火墙只放行 443（和 SSH）。
- Broker 看不到用户内容（端到端加密），但它是配对路由点——保证它本身不被入侵。
- 找回密码已就绪：登录页「忘记密码」→ 邮件链接 → `/reset` 设新密码（链接 1 小时有效，配 SMTP 才发得出；未配则链接打到日志）。
- 账号及停用状态保存在 `codexapp.db` 中。找回密码不会解除账号停用，恢复操作只能由管理员执行。
- 仍待接入：APNs 推送（审批提醒）。

> 配对码模式通过 SAS 绑定双方公钥；默认免码模式依赖账号认证。网页由 Broker 发布，业务消息加密不能替代对网页代码来源的信任。详见 [安全模型](README.md#安全模型)。
