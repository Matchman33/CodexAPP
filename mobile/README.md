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
- 设置：工作目录 cwd、审批策略、沙箱；新建会话；开启审批通知
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

电脑先运行中继 `npm start`，再运行 `tailscale funnel --bg 4123`。首次启用按命令提示完成授权，确认输出 **`Available on the internet`**。详细启动、从 Serve 切换和关闭方法见[根目录 README](../README.md#4-手机远程访问tailscale-funnel)。

手机不需要安装 Tailscale 或配置 VPN。在 App 中选择 **「局域网直连」** 模式，中继地址填写 Funnel 输出的完整 HTTPS 域名，例如 `https://my-pc.tail123456.ts.net`（替换成实际域名，不加 `:4123`），再填写中继 Token；WebSocket 自动使用 `wss://`。浏览器也可直接打开这个地址使用网页客户端。

`tailscale serve` 的 HTTPS 地址和 `100.x.x.x` 的 Tailscale IP 仍只供私网使用；免装 Tailscale 的远程访问需要 **Funnel**。公网 DNS 首次更新可能需要最多约 10 分钟，保持电脑、中继和 Tailscale 运行后稍候重试。

Funnel 这里只转发中继，不转发 Expo 的 Metro 开发服务。使用 Expo Go 时还需确保手机能访问 Metro；只想用手机浏览器时直接打开 Funnel 地址即可。

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
- **App 里连不上中继**：局域网直连时使用电脑 `npm start` 打印的实际局域网 IP，检查防火墙是否允许 4123。Funnel 远程访问时使用它输出的 HTTPS 域名，不加 `:4123`，并确认选择「局域网直连」模式和正确 Token。两种方式都要求中继持续运行。
- **Funnel 域名打不开**：先等待公网 DNS 生效，再用手机移动网络访问 `https://<实际域名>/health`。返回 `"ok": true` 表示转发正常；若仍失败，按根目录 README 的排查步骤区分 DNS、HTTPS 和本地服务问题。
- **状态卡在「中继已连，等待 Codex」**：中继没连上 codex，看中继终端日志。
- **收不到通知**：设置里点「开启审批通知」并在系统里允许。
