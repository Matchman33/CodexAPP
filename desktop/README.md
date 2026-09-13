# CodexApp 电脑客户端(原生桌面版 / Electron)

真正的桌面程序窗口(不是网页):内部运行 agent(连 Broker + 驱动本地 Codex),
界面在一个原生 Electron 窗口里显示。

当前桌面启动器运行的是保留的云 Agent 路线，不会启动根目录的本地 4123 中继，也不安装或启动 NPC。选择 NPS、Tailscale 或局域网直连时，在根目录启动本地中继，按 [主说明的远程访问章节](../README.md#4-手机远程访问用户自选映射) 自行维护映射；不能把本目录的 npm start 当成本地中继入口。

## 开发运行
```bash
cd desktop
npm install
npm start          # 打包 agent + 启动 electron 窗口
```

## 打包成安装程序(Windows)
```bash
npm run dist       # 产出 dist/CodexApp-Setup-<version>.exe (NSIS 安装包)
```
> 在哪个系统上打包就出哪个系统的安装包(Electron 不能交叉编译)。macOS 上 `npm run dist` 需改用 mac target。

## 说明
- `build.mjs` 用 esbuild 把 `../cloud/agent.mjs` 打成 `agent.cjs`,由 Electron 主进程 require。
- 配置/密钥存在用户目录(`app.getPath("userData")`),不在安装目录。
- 云端 Broker 使用现有 Agent 配置；它与根目录本地中继是不同路线，具体配置见 [云端说明](../cloud/README.md)。
- 未签名:Windows SmartScreen 首次会提示,正式发布请用代码签名证书。
