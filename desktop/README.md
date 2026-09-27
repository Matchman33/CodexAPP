# 电脑客户端

Electron 电脑客户端在桌面窗口中提供 Agent 登录、注册、连接状态、设备指纹和配对码管理。

## 功能

- 使用云账号连接 Broker，供手机远程访问本机 Codex。
- 支持同账号免码连接和配对码模式。
- 显示在线客户端数量、授权状态和错误信息。
- 使用本机共享中继，与直连客户端共用任务、审批和终端。
- 在用户配置目录保存登录与设备信息。

## 运行

电脑需安装 Node.js，并完成 Codex 登录或 API 配置。在项目根目录安装依赖：

```powershell
npm ci
```

然后进入桌面客户端目录：

```powershell
cd desktop
npm ci
$env:CODEXAPP_BROKER = "http://你的服务器IP:8787"
npm start
```

`npm start` 会构建 Agent、网页及终端运行文件，再打开桌面窗口。

1. 在窗口中注册或登录云账号。
2. 确认 Broker 和 Codex 已连接。
3. 需要配对码时，在窗口中切换连接模式。
4. 手机打开 Broker 网页或手机客户端，登录相同账号并完成配对。

## 配置

桌面客户端使用 Electron 的用户数据目录保存 `agent.config.json`、设备密钥和配对信息。

`CODEXAPP_BROKER` 指定云端地址；`CODEXAPP_RELAY_CONFIG` 可指定本机中继配置文件。需要与源码启动的中继共享服务时，让两端使用同一份中继配置。

账号停用、会话占用和项目重启的操作说明见[使用指南](../docs/使用指南.md)与[云账号使用](../cloud/README.md)。

## 打包

在 `desktop` 目录运行：

| 命令 | 产物 |
|---|---|
| `npm run bundle` | 构建 Agent、网页和终端运行文件 |
| `npm run dist` | Windows NSIS 安装程序 |
| `npm run dist:portable` | Windows x64 便携目录及 ZIP |

产物位于 `desktop/dist/`。便携分发需保留完整目录，包括网页资源、终端 worker 和 `node-pty` 依赖。

项目的上述分发命令面向 Windows。终端原生模块与构建平台、架构相关，请使用与目标环境匹配的构建产物。

Windows 签名配置见[代码签名](../SIGNING.md)。
