# CodexApp 移动端（Expo / React Native）

一套代码，**iPhone 和 Android 都能跑**，在 Windows 上开发，无需 Mac / Xcode / Android Studio。
连接电脑上的[中继](../relay/server.mjs)，远程控制 Codex：发提示词、纠偏、叫停、审批、看状态。
协议见 [../PROTOCOL.md](../PROTOCOL.md)。

## 今天就能在真机上跑（Expo Go，最省事）

1. 电脑先启动中继（在仓库根目录）：
   ```powershell
   cd C:\test\CodexAPP
   npm start          # 打印局域网地址 + Token
   ```
2. 启动 Expo 开发服务（本目录）：
   ```powershell
   cd C:\test\CodexAPP\mobile
   npm install        # 第一次
   npx expo start
   ```
3. 手机装 **Expo Go**（App Store / Play 商店），和电脑同一 WiFi：
   - iPhone：用相机扫终端里的二维码 → 在 Expo Go 打开
   - Android：用 Expo Go 内的扫码功能扫
4. App 打开后：填**中继地址**（如 `http://192.168.1.84:4123`）+ **Token**，点连接。

> iPhone 和 Android 用的是**同一个中继地址 + Token**，跟网页端一样。

## 功能

- 连接门：中继地址 + Token（用 AsyncStorage 记住，下次免填）
- 发提示词 / 纠偏（steer）/ 叫停（interrupt）
- 审批卡片：批准 / 本会话都批准 / 拒绝
- 实时状态：running/idle、流式回复、命令执行、文件改动、错误
- 设置：工作目录 cwd、模型、思考等级、审批策略、沙箱；新建会话；开启审批通知
- 手机聊天布局：侧边会话抽屉与搜索、快捷新建、中性深色主题、图标化发送与停止
- 审批到达：震动 + 本地通知（需在设置里授权）

## 打包成可独立安装的 App（不依赖电脑开 Expo）

用 Expo 的云构建 **EAS**（Windows 上即可，无需 Mac）：

```powershell
npm install -g eas-cli
eas login
eas build -p android --profile preview   # 出 .apk，可直接装安卓
eas build -p ios --profile preview        # 出 iOS 包，需 Apple 开发者账号($99/年)
```

- **Android**：EAS 云构建 `.apk`，下载直接装，完全不用电脑工具链。
- **iOS**：EAS 也能云构建，但要 Apple 开发者账号来签名 / 装到 iPhone。

## 远程使用（不在同一 WiFi）

新版设置支持按模型能力选择思考等级。选择「Codex 默认」恢复有效默认；能力未知时支持手动输入服务商等级。模型与等级一起保存到电脑中继或 Agent，从下一条提示词生效，不修改正在运行的任务。原生回复仍以可选择文本显示，网页的 Markdown 与浅深色选择不代表原生端也具备相同渲染。

默认使用 **Tailscale Serve**，不启用 Funnel。电脑先运行中继 `npm start`，再运行 `tailscale serve --bg 4123`。首次启用按命令提示完成授权，确认输出 **`Available within your tailnet`**。从 Funnel 切换、启动和关闭方法见[根目录 README](../README.md#4-手机远程访问tailscale-serve)。

手机需要安装并开启 Tailscale，接入电脑所在的同一网络。在 App 中选择 **「中继直连」** 模式（旧版叫「局域网直连」），中继地址填写 Serve 输出的完整 HTTPS 域名，例如 `https://my-pc.tail123456.ts.net`（替换成实际域名，不加 `:4123`），再填写中继 Token；WebSocket 自动使用 `wss://`。手机保持 Tailscale 连接时，也可用浏览器打开同一地址。

Serve 的 HTTPS 地址和 `100.x.x.x` 的 Tailscale IP 都不是普通公网入口。手机未接入 Tailscale 时无法访问，不需要等待 Funnel 的公网 DNS 生效。两端直连有机会降低延迟，无法直连时仍可能走中继。

Serve 这里只转发中继，不转发 Expo 的 Metro 开发服务。使用 Expo Go 时还需确保手机能访问 Metro；使用网页时，保持 Tailscale 连接并打开 Serve 地址即可。

## 结构

```
mobile/
├─ App.js                 # 根：连接门 vs 主界面，凭证持久化
├─ src/
│  ├─ useRelay.js         # WS 连接 + 重连 + 消息分发 + 动作 + 审批通知
│  ├─ storage.js          # AsyncStorage 存中继地址/Token
│  ├─ theme.js            # 配色
│  ├─ SetupScreen.js      # 连接门
│  ├─ MainScreen.js       # 头部状态 + 事件流 + 审批 + 输入框
│  ├─ ApprovalCard.js     # 审批卡片
│  └─ SettingsModal.js    # 设置面板
└─ app.json               # Expo 配置
```

## 故障排查

- **扫码后连不上 Metro**：手机和电脑要同一 WiFi；或 `npx expo start --tunnel`（走隧道，跨网络）。
- **App 里连不上中继**：局域网访问时使用电脑 `npm start` 打印的实际局域网 IP，检查防火墙是否允许 4123。Serve 远程访问时，先开启手机 Tailscale，再使用它输出的 HTTPS 域名，不加 `:4123`，确认选择「中继直连」模式和正确 Token。两种方式都要求中继持续运行。
- **Serve 域名打不开**：确认手机已接入同一 Tailscale 网络，再访问 `https://<实际域名>/health`。返回 `"ok": true` 表示转发正常；若仍失败，检查电脑在线状态、MagicDNS、访问规则与本地中继，不等待 Funnel 公网 DNS。
- **状态卡在「中继已连，等待 Codex」**：中继没连上 codex，看中继终端日志。
- **收不到通知**：设置里点「开启审批通知」并在系统里允许。
