# 部署 Broker

Broker 提供云账号登录、手机与 Agent 连接、网页客户端和管理后台。支持公网 IP 的 HTTP/WS 入口，以及 HTTPS/WSS 入口。

## 准备

- 可从手机和电脑访问的服务器。
- 支持内置 `node:sqlite` 的 Node.js、npm 和 Git。
- 可用的访问端口，例如 `8787`，并放行服务器防火墙及云安全组。
- 需要邮件注册和找回密码时，准备 SMTP 配置；也可由管理员手动验证账号。

以下使用 Linux、systemd 和 `/opt/codexapp` 目录。服务器只需运行 Broker，电脑端 Codex 的登录信息留在电脑上。

## 安装项目

创建运行用户和程序目录：

```bash
sudo useradd --system --create-home --home-dir /var/lib/codexapp --shell /usr/sbin/nologin codexapp
sudo mkdir -p /opt/codexapp /etc/codexapp
sudo chown codexapp:codexapp /opt/codexapp
sudo -u codexapp git clone https://github.com/Matchman33/CodexAPP.git /opt/codexapp
cd /opt/codexapp
sudo -u codexapp npm ci
sudo -u codexapp npm run build:web
```

项目依赖包含原生终端模块。Linux 安装依赖时如需本机编译，请准备 Python 3、make 和 C/C++ 编译工具。

网页的 `web/vendor/` 构建产物需要随网页一起部署。使用本地打包上传时，也要包含这些文件。

## 配置入口与后台令牌

生成独立的后台令牌：

```bash
openssl rand -hex 32
sudoedit /etc/codexapp/broker.env
```

在配置文件中填写以下内容，并替换服务器 IP 和后台令牌：

```dotenv
HOST=0.0.0.0
PORT=8787
PUBLIC_URL=http://你的服务器IP:8787
DB_PATH=/var/lib/codexapp/codexapp.db
ADMIN_TOKEN=生成的随机令牌
```

限制配置文件权限：

```bash
sudo chmod 600 /etc/codexapp/broker.env
```

HTTP/WS 入口不要求域名和证书，登录请求通过 HTTP 传输。配置 HTTPS 反向代理时，通常将 `HOST` 改为 `127.0.0.1`，并将 `PUBLIC_URL` 设置为外部 HTTPS 地址；代理需转发 WebSocket 连接。

Broker 也支持直接提供 HTTPS。在环境文件中设置 `TLS_CERT` 和 `TLS_KEY` 为可读取的 PEM 文件路径，并配置对应监听端口。

## 设置开机启动

创建服务文件：

```bash
sudoedit /etc/systemd/system/codexapp-broker.service
```

内容如下，`ExecStart` 中的 Node 路径可通过 `command -v node` 确认：

```ini
[Unit]
Description=CodexApp Broker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=codexapp
Group=codexapp
WorkingDirectory=/opt/codexapp
EnvironmentFile=/etc/codexapp/broker.env
ExecStart=/usr/bin/node /opt/codexapp/cloud/broker.mjs
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target
```

启动并检查服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codexapp-broker
systemctl status codexapp-broker --no-pager
curl http://127.0.0.1:8787/health
```

健康检查应返回包含 `"ok": true` 的 JSON。然后从手机打开配置的 `PUBLIC_URL`，确认网页可访问。

## 配置客户端

电脑在启动 Agent 的终端中设置同一个地址：

```powershell
$env:CODEXAPP_BROKER = "http://你的服务器IP:8787"
npm run start:agent
```

手机网页直接访问该地址。Expo 手机端在 `mobile/src/config.js` 中设置 `BROKER_URL`，然后运行或构建客户端。

账号注册、登录和配对步骤见[云账号使用](README.md)。

## 管理后台

访问 `PUBLIC_URL` 对应地址下的 `/admin`，使用 `ADMIN_TOKEN` 登录。

| 功能 | 操作 |
|---|---|
| SMTP 配置 | 填写服务器、端口、用户名、密码、发件人和 TLS 设置，保存后生效 |
| 连接概览 | 查看在线账号、电脑连接和手机连接数量 |
| 邮箱验证 | 手动标记已验证，或重发验证邮件 |
| 停用账号 | 立即断开云连接，并禁止该账号再次登录 |
| 恢复账号 | 允许重新登录，停用前的令牌仍失效 |
| 退出全部设备 | 撤销当前登录，用户可主动重新登录 |
| 删除账号 | 删除账号记录并断开其云连接 |

云账号免费使用，账号通过邮箱验证且未被停用即可连接。停用账号不会停止本机任务，不影响有效 Token 的直连访问。找回密码或验证邮箱不能解除停用。

后台保存的 SMTP 设置优先于环境变量。未配置 SMTP 时，验证和重置链接输出到服务器日志；可使用后台手动验证完成账号开通。

## 环境变量

| 变量 | 用途 |
|---|---|
| `HOST` | 监听地址，默认 `0.0.0.0` |
| `PORT` | 监听端口，默认 `8787` |
| `PUBLIC_URL` | 外部访问地址，用于邮件链接 |
| `DB_PATH` | SQLite 路径，默认 `cloud/codexapp.db` |
| `ADMIN_TOKEN` | 管理后台令牌，未设置时后台接口不启用 |
| `TLS_CERT` / `TLS_KEY` | HTTPS 证书与私钥的 PEM 路径 |
| `SMTP_HOST` / `SMTP_PORT` | 邮件服务器地址与端口 |
| `SMTP_USER` / `SMTP_PASS` | 邮件登录凭据 |
| `SMTP_FROM` / `SMTP_FROM_NAME` | 发件人地址与显示名称 |

## 服务维护

```bash
journalctl -u codexapp-broker -n 50 --no-pager
sudo systemctl restart codexapp-broker
sudo systemctl stop codexapp-broker
```

修改代码或部署网页后，运行 `npm run build:web`，重启 Broker 并刷新客户端页面。推送 GitHub 不会自动执行这些操作。

备份应包含 `DB_PATH` 指向的数据库、`cloud/broker.secret` 和 `/etc/codexapp/broker.env`。复制数据库文件前停止 Broker，备份完成后再启动；恢复时使用同一份签名密钥及环境配置。
