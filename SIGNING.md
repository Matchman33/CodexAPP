# Windows 代码签名

项目的 Agent 和 Electron 便携版构建脚本支持调用 `signtool` 签名，并验证签名结果。配置签名方式后，打包时自动执行；未配置时生成未签名产物。

## 准备

- 安装 Windows SDK 中的 `signtool.exe`，或通过 `CODEXAPP_SIGNTOOL` 指定路径。
- 准备可用的签名证书或云签名配置。
- 确保签名工具能够访问所配置的时间戳服务。

## 选择签名方式

在执行打包命令的 PowerShell 中，选择一种方式设置环境变量。

### 证书指纹

查看当前用户证书：

```powershell
Get-ChildItem Cert:\CurrentUser\My | Format-List Subject, Thumbprint
$env:CODEXAPP_SIGN_SHA1 = "你的证书指纹"
```

### 证书主题名

```powershell
$env:CODEXAPP_SIGN_SUBJECT = "Your Company, Inc."
```

### PFX 文件

```powershell
$env:CODEXAPP_SIGN_PFX = "C:/certificates/signing.pfx"
$env:CODEXAPP_SIGN_PASS = "证书密码"
```

### 云签名

准备签名客户端 DLL 和账户元数据文件，并按所用服务完成认证：

```powershell
$env:CODEXAPP_SIGN_AZURE = "C:/signing/metadata.json"
$env:CODEXAPP_AZURE_DLIB = "C:/signing/Azure.CodeSigning.Dlib.dll"
```

元数据可参考 [trusted-signing.example.json](trusted-signing.example.json)，填写自己的服务端点、账户名和证书配置名。

## 可选设置

| 变量 | 用途 |
|---|---|
| `CODEXAPP_SIGNTOOL` | 指定 `signtool.exe` 路径 |
| `CODEXAPP_SIGN_TS` | 指定时间戳服务地址 |
| `CODEXAPP_SIGN=0` | 禁用自动签名 |

## 构建与检查

在项目根目录构建 Agent：

```powershell
node cloud/build-agent.mjs
```

或进入桌面客户端目录构建便携版：

```powershell
cd desktop
npm run dist:portable
```

配置签名后，脚本会执行签名和验证，失败时停止构建。硬件证书可能要求输入 PIN。

在项目根目录检查 Agent 签名：

```powershell
Get-AuthenticodeSignature ./dist/CodexApp-Agent.exe | Format-List Status, SignerCertificate, TimeStamperCertificate
```

查看 `Status`、签名证书和时间戳信息。Windows 是否允许运行还取决于系统策略，签名验证结果不等同于所有设备上的运行许可。

分发 Agent 时保留构建生成的网页目录、终端 worker 和依赖文件。证书、私钥、密码及云签名凭据不应提交到仓库。
