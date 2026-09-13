# Windows NPC 客户端快速安装

## 安装到当前项目目录

项目根目录已包含 install.ps1。在 Windows 的项目根目录执行：

~~~powershell
npm run npc:install
~~~

等价命令：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 npc latest .
~~~

最后一个 . 表示当前项目目录，不再安装到 D:\nps。npm 命令从 package.json 所在目录运行；安装结果是根目录 npc.exe 和 conf/npc.conf。这里必须使用 npc 参数：nps 安装的是服务端，all 安装两者，服务端包可能覆盖项目 web/，不要在本项目目录使用这两个模式。

这是用户手动选择的 Windows 安装快捷命令，不是 npm start 的前置步骤，也不适用于 Linux。安装脚本只下载和复制文件，不自动连接 NPS、启动 Codex、注册服务或开机自启。

## 配置与启动由用户维护

安装后先检查 conf/npc.conf，按照服务器实际配置填写 server_addr、conn_type、vkey；已有配置被保留，新模板写入 conf/npc.conf.default。客户端和服务端必须兼容，latest 会在运行时尝试查询 GitHub 最新发行，查询失败时使用脚本原有镜像回退；不能认为 latest 一定兼容当前服务器。

需要与既有服务端对齐时，直接指定版本，例如：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 npc v0.34.7 .
~~~

确认配置正确、本机 4123 已正常运行后，由用户手动启动：

~~~powershell
.\npc.exe -config=".\conf\npc.conf" -log=off
~~~

此处 -log=off 用于减少日志中的凭据暴露，不代表完成日志安全审计。不要同时运行相同设备身份的多个 NPC，也不要在 NPC 正在使用二进制时重跑安装。

npc.exe、conf/npc.conf、conf/npc.conf.default 和 conf/multi_account.conf 已加入 Git 忽略。vkey 属于私密凭据，不放入 package.json 或公开命令、截图；不要复制电脑 Codex 登录文件给服务器。

## 验证范围与安全边界

install.ps1 按用户提供的下载版本原样留存，当前命令未执行真实下载或安装，未校验最终发行包或镜像内容。脚本原有下载逻辑没有包 SHA-256 校验，需用户自行确认来源；本项目不将它宣传为安全审计过的安装器。ExecutionPolicy Bypass 仅针对这次 PowerShell 进程，不自动修改系统持久执行策略。

本轮只检查 PowerShell 语法、npm 命令帮助调用、配置忽略规则和本地网页构建。不会为了验证安装去覆盖现有 NPC、停止服务或启动另一个 Codex。

NPS 面板、TLS 接入、TCP 映射、公网 HTTPS、证书、防火墙及后台运行仍由用户独立维护，参见 [远程访问与端口映射说明](远程访问与端口映射说明.md)。
