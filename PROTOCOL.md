# CodexApp 客户端 ↔ 中继 协议

所有客户端（web / iOS / Android）都通过 **WebSocket** 连接同一个中继，说同一套 JSON 协议。
本文件说明消息字段和调用方式。连接入口见 [relay/transport.mjs](relay/transport.mjs)。

## 连接

```
ws(s)://<relay-host>:<port>/ws?token=<TOKEN>
```

- 页面/客户端用 `http` 源 → `ws://`；`https` 源 → `wss://`。
- Token 错误：服务端发 `{"type":"error","message":"无效 token"}` 后用关闭码 **4001** 断开。
- 连接成功后，服务端立即推一条 `hello` 快照。
- 建议客户端做指数退避自动重连（web 端 1s→×1.6→最大 15s）。

## 服务端 → 客户端

| type | 字段 | 说明 |
|---|---|---|
| `hello` | `state`, `config`, `pendingApprovals[]`, `recentEvents[]`, `history?`, `requestId?`, `imageUpload?` | 连接快照；分页模式仅携带有限近期记录；图片能力按后端声明启用 |
| `historyPage` | `threadId`, `events[]`, `nextCursor`, `requestId` | 按时间正序排列的一页历史；游标继续读取更早记录 |
| `historyItem` | `threadId`, `itemId?`, `text`, `offset`, `textLength`, `nextOffset`, `detailCursor`, `requestId` | 历史长文本的一个内容片段 |
| `state` | `state` | 状态变化 |
| `models` | `models[]`, `defaultModel`, `defaultReasoningEffort`, `error` | 响应 `listModels`；列表可能为空或部分加载失败 |
| `configSaved` | `requestId?` | 选择已保存到电脑端配置，不代表当前任务的权限已切换；实际结果见 `state.permissions` |
| `writerConflict` | `threadId`, `owners[]`, `message`, `onOpen?`, `requestId?`, `inspectionFailed?` | 外部占用或探测失败；展示进程和受影响会话，不自动结束进程 |
| `event` | `event` | 新增一条 feed 条目 |
| `assistantDelta` | `text` | 助手回复的流式增量（拼接显示） |
| `outputDelta` | `text` | 命令输出增量（可选展示） |
| `approval` | `approval` | 新的审批请求 |
| `approvalResolved` | `key`, `by`(`"user"`/`"server"`) | 审批已处理，移除对应卡片 |
| `error` | `message` | 错误提示 |
| `diff` | `diff` | 本次 turn 的统一 diff（Codex 编辑代码时更新，空串表示清空） |
| `projectTree` | `projects[]`, `projectless[]` | 项目和对话列表（响应 `listThreads`） |

### `state` 对象
```jsonc
{
  "codexConnected": true,        // 中继是否连上 codex
  "codexVersion": "…",
  "threadId": "…|null",
  "turnId": "…|null",
  "cwd": "C:\\test",
  "status": "idle" | "running",
  "readOnly": true, // 仅查看历史；发送前尝试接续，写入占用仍须确认
  "model": "…|null",
  "effectiveModel": "…|null", // 最近一次会话/任务实际使用的模型
  "reasoningEffort": "high|null", // 已选等级，null 表示跟随默认
  "effectiveReasoningEffort": "high|null", // 最近一次任务的实际等级
  "approvalPolicy": "on-request" | "untrusted" | "on-failure" | "never",
  "sandbox": "workspace-write" | "read-only" | "danger-full-access", // 用户已保存的选择
  "permissions": { // 可选的权限状态
    "supported": true,
    "applied": { "sandbox": "workspace-write", "approvalPolicy": "on-request" } | null,
    "pending": false,
    "applying": false,
    "error": "…" | null
  }
}
```

### `event` 对象
```jsonc
{ "id": "uuid", "ts": 1700000000000, "kind": "…", "text": "…" }
```
`kind` 取值：`user`、`item:agentMessage`、`item:commandExecution`、`item:fileChange`、
`item:reasoning`、`item:webSearch`、`item:mcpToolCall`、`thread`、`turn`、`error`、
`approval-requested`、`approval-resolved`。客户端按前缀决定样式即可。

### `approval` 对象
```jsonc
{
  "key": "uuid",                 // 回传决策时用
  "kind": "command" | "file" | "exec-legacy" | "patch-legacy" | "permission",
  "title": "运行命令",
  "command": "…",                // 命令或改动摘要
  "cwd": "…|null",
  "reason": "…|null",
  "network": null,               // 受管网络审批上下文（可能为 null）
  "note": "…",                   // 可选提示（如 permission 限制）
  "options": [
    { "id": "approve",        "label": "批准",        "style": "primary"   },
    { "id": "approveSession", "label": "本会话都批准", "style": "secondary" },
    { "id": "deny",           "label": "拒绝",        "style": "danger"    }
  ]
}
```
> 客户端只需把 `options` 渲染成按钮，点击后回传 `optionId`。具体到 Codex 的决策值由中继映射，
> 客户端不关心。`permission` 类只会给 `deny` 选项。

## 客户端 → 服务端

### 生成文件下载

文本预览使用 `readAttachment` 分块协议。网页根据已登记的文件扩展名提供纯文本预览，最多展示前 1 MiB，取得所需分块后停止请求剩余内容；完整下载仍从头获取全部分块。`files[].preview` 表示光栅图片预览，文本预览由网页根据文件类型识别。下载进度和错误显示在聊天附件内。

同一附件可带可选 `references[]`，包含助手对该文件使用的多个路径写法。网页在 Markdown 清理前将已登记的文件链接映射为内部片段标记，图片引用映射为预览，文字链接映射为下载；不会放开 `file:`、Windows 驱动器路径或不安全 URL 协议的浏览器导航。附件始终通过当前连接传输，NPS 入口不需要额外下载端口或回环地址；接收完成后的保存链接使用浏览器本地 Blob。

`hello.fileDownloads` 声明 `{supported:true,maxBytes:33554432,chunkBytes:196608,perEvent:12,entries:512}`。助手消息、文件变更与图片生成事件可以携带 `files[]`：`{id,threadId,name,size,mime,preview,reference}`；`reference` 是原始文件引用，仅供网页关联聊天链接，不能代替下载授权。历史转换保留有界 `fileRefs[]`，保证长文本截断后仍可登记附件。

客户端发送 `{type:"readAttachment",attachmentId,threadId,offset:0,requestId}`。后端响应 `{type:"attachmentChunk",attachmentId,threadId,requestId,offset,total,data,nextOffset}`；`data` 是该块的 Base64，`nextOffset:null` 表示完成，其他值用于请求下一块。客户端逐块校验 ID、会话、位置与总长度，收齐后创建下载文件；取消或断线丢弃未完成内容，不自动重试。错误使用原有 `error` 并回传 `requestId`。

登记接受明确出现在助手文件引用或生成事件中的允许类型本机文件，包括项目外的绝对路径、`../` 相对路径及指向项目外的目录链接。拒绝网络地址、硬链接、隐藏目录、常见凭据及未开放类型；每次读取核验规范路径和文件身份、大小、修改时间。客户端只能请求已登记的随机附件 ID，不能指定文件系统路径。旧 ID 因文件变化、登记淘汰或后端重启失效时，应重新打开历史获取元信息。会话删除会撤销对应登记。

文件引用识别会去掉 `:行号[:列号]` 与 `#L行号` 定位后缀，并规范 Windows 的 `/C:/` 前缀，但保留原始 `reference/references` 用于前端匹配；相对路径以会话工作目录解析，绝对路径可指向其他本机目录。HTTP(S) 和明确的 IP 端口地址不登记为附件。不可用附件在前端使用无 `href` 的说明入口，不生成公共地址加内部占位片段。

已登记的行内代码文件引用和独立 Markdown 路径可转换为预览入口，独立路径仍经过相同的敏感路径及文件身份检查；不解析代码块或把命令字符串作为文件链接。前端保留原始引用用于复制，复制动作不发起文件读取，也不使用内部附件片段地址作为复制内容。普通 HTTP 页面在 Clipboard API 不可用时使用用户点击触发的兼容复制方式。

前端在将文件引用转换为附件标记时，另保留该链接的行号、列号及行范围，用于文本预览滚动和高亮；同一附件的不同引用不能共享或覆盖彼此的定位信息。定位只影响展示，不修改文件字节和分块读取协议，也不扩大 1 MiB 文本预览上限。

语法高亮完全在浏览器本地执行，不增加传输字段或扩大文件读取范围。Worker 使用指定语法返回有界结构化标记，前端以文本节点和受限 span 构造展示并校验原文一致，保留 CRLF 和行列偏移；不会把文件作为 HTML 插入执行。超出着色容量、处理失败或 Worker 不可用时退回纯文本，保留定位与下载能力。

单个文件不超过 32 MiB，每块不超过 192 KiB，全局最多 4 个同时读取请求，登记表最多 512 个条目。下载通过已鉴权的原连接返回给请求方，直连不广播文件分块；云 Agent 使用既有 E2E 信封。文件请求不进入模型任务控制队列，不等待模型执行完成；不新增公开文件下载目录或接受任意磁盘路径的 HTTP 接口。网页原图预览仅允许 PNG/JPEG/WebP/GIF；文本类型通过 `textContent` 显示，HTML、SVG 和代码不执行，其他文件只提供下载。

### 会话管理

`hello.threadManagement` 为 `{delete:true,release:true}`。未声明能力的后端禁用对应网页按钮；Codex 运行时不支持接口则返回错误，不回退为磁盘删除或结束外部进程。

| type | 字段 | 说明 |
|---|---|---|
| `deleteThread` | `threadId`, `confirmed:true`, `requestId` | 永久删除会话和派生子会话，客户端必须先显示名称与不可恢复确认 |
| `deleteProject` | `projectId`, `confirmed:true`, `requestId` | 删除项目全部会话（含归档和派生会话），再移除项目记录；保留项目目录与文件 |
| `releaseThread` | `threadId`, `requestId` | 暂停等待队列，取消当前中继订阅并确认卸载；必须明确匹配当前会话 ID |
| `threadDeleted` | `threadId`, `requestId?` | 删除已确认；后代删除也单独广播。重复通知按 ID 幂等处理 |
| `threadReleased` | `threadId`, `writerReleased`, `requestId` | 当前中继已确认释放；不代表其他独立进程也释放了它们的占用 |

`state.threadAction` 在操作期间为 `delete` 或 `release`，完成后清空。客户端在操作期间禁用发送、切换、队列继续和相关设置，收到与 `requestId` 对应的错误时保留页面并允许人工重试。删除成功后清理相关历史页、流式状态、等待队列和列表项，并忽略迟到的旧会话响应。前端不自动重试超时的删除请求。

`state.writerReleased:true` 表示当前中继已确认目标未加载；会话仍可保留在只读页面。发送或接续后重置此字段。释放前检查当前无活动任务或审批，取消订阅后重置权限同步状态，防止权限同步重新获取写入占用。队列保留且暂停；删除会话则移除对应等待条目但保留有限受理凭据，避免迟到的入队重试重复执行。

`projectTree.projectDeletion:true` 表示 Codex 返回了有效的 `project/list`，项目 ID 可用于 `deleteProject`。服务端重新枚举全部分页、归档和派生会话，检查空闲状态，暂停相关队列，通过 `thread/delete` 删除后再调用 `project/delete`。不读取客户端传来的会话清单。删除期间阻止本中继新的变更操作，外部进程新增或残留的项目会话会在项目记录删除前再次检查；此流程不是跨进程事务。

每完成一个会话发送 `projectDeleteProgress {requestId,deleted,total}`；成功广播 `projectDeleted {projectId,threadIds}` 并向发起客户端返回带 `requestId` 的同名响应。已有 `threadDeleted` 通知照常清理其他客户端的标签、历史及附件登记。部分失败用原有 `error` 返回已删除数量，保留项目记录和剩余暂停队列。项目目录与磁盘文件始终保留。

主动释放通过 `thread/unsubscribe` 和 `thread/loaded/list` 确认。若 Codex 宽限期仍保留目标，只在已加载会话都确认空闲时重连本应用独占的 app-server 子进程；不结束其他进程，不删除写入锁文件。多会话切换不取消后台订阅，刷新网页也不会释放正在运行的任务。

### 图片输入

`hello.imageUpload` 为 `{ supported:true, count:4, bytes:1048576, totalBytes:4194304, previewBytes:8192, queueChars:25165824 }`。未声明能力的后端不应接收图片请求；前端禁用选图，不影响文字消息。

`prompt`、`enqueuePrompt`、`steer` 的可选 `images` 形如：

```jsonc
{
  "text": "分析截图",
  "images": [
    { "name": "capture.png", "dataUrl": "data:image/png;base64,...", "previewDataUrl": "data:image/jpeg;base64,..." }
  ]
}
```

图片只接受 PNG、JPEG、WebP 的完整 Base64 Data URL，后端校验声明格式与文件头、Base64 及解码字节数；不接受 URL、电脑路径或任意文件读取请求。每条消息最多 4 张、单图最多 1 MiB、总计最多 4 MiB；可选缩略图最多 8 KiB。文字可以为空，但文字和图片不能同时为空。输入映射到 Codex 的 `{type:"image",url:dataUrl}`；文件名和缩略图不进入模型输入。

等待队列原图和缩略图的 Data URL 字符总计不超过 24 MiB；该值是字符串容量，不是原图解码字节总数。直连入站帧上限 8 MiB，Broker 的加密信封入站帧上限 12 MiB。Broker 只转发密文，Agent 解密后再次执行相同的图片校验。

用户事件及队列快照的 `images` 为 `[{id,name,url?}]`，`id` 来自原图 Data URL 的 SHA-256，`url` 仅是缩略图，没有原图 `dataUrl`。历史分页的 65536 字符预算包含缩略图字符串；原图 Base64 不拼到用户消息文本中。经本功能上传的缩略图缓存在电脑的 Codex 用户目录，历史用原图身份恢复；不属于此缓存的附件显示占位。

| type | 字段 | 说明 |
|---|---|---|
| `prompt` | `text`, `cwd?`, `images[]?`, `requestId?` | 发提示词，开始一个新 turn（无会话则自动新建）；图片非空时文字可为空 |
| `steer` | `text`, `images[]?` | 纠偏：往当前进行中的 turn 插话；支持图片 |
| `interrupt` | `threadId?`, `turnId?` | 中断指定或当前任务；后端向 Codex 传齐两个 ID |
| `approval` | `key`, `optionId` | 回传审批决策（`optionId` ∈ approve/approveSession/deny） |
| `newThread` | `cwd?`, `scope?`, `requestId?` | 新建会话；`scope` 为 `project` 或 `temporary`，后者使用独立目录 |
| `setConfig` | `approvalPolicy?`, `sandbox?`, `cwd?`, `model?`, `reasoningEffort?`, `requestId?` | 保存选择；模型与等级下一条消息生效，权限在当前任务结束后同步，空闲已接续会话立即同步 |
| `listModels` | `cwd?` | 从电脑端 Codex 获取模型列表与该目录的默认模型 |
| `getState` | — | 请求重新下发快照 |
| `listThreads` | — | 请求会话/项目列表，服务端回 `projectTree` |
| `readThread` | `threadId`, `historyMode?`, `requestId?` | 只读打开或切换查看目标，不检查占用、不停止其他会话 |
| `historyPage` | `threadId`, `cursor?`, `requestId` | 只读获取历史页；省略游标获取最新页，回 `historyPage` |
| `readHistoryItem` | `threadId`, `detailCursor`, `offset?`, `requestId` | 分段读取超长消息或工具输出，回 `historyItem` |
| `resumeThread` | `threadId` | 接续已有会话（切到它的项目 cwd，继续这段对话） |
| `inspectWriter` | `threadId`, `requestId?` | 只读检查该会话锁的占用进程，返回 `writerConflict` |
| `takeoverThread` | `threadId`, `token`, `confirmed:true`, `requestId?` | 确认后结束已识别占用进程，确认退出后尝试接续会话 |

`projects[]` 每条：`{ id, root, roots[], label, threads[] }`；`projectless[]` 和 `threads[]` 每条：`{ id, name, cwd, updatedAt(秒), source }`。`state` 增加 `threadName`(当前会话名)、`lastDiff` 和 `readOnly`。

列表读取所有模型提供商的非归档交互会话，遍历分页并按会话 ID 去重。项目 ID 由 `local-projects` 解析，显式 `thread-project-assignments` 优先于路径匹配，支持多个工作根目录和工作区提示。未分配的会话显示在对话组。

打开列表中的会话使用 `readThread`；仅发送提示词或明确接续时才调用 `thread/resume`。占用时保持历史和草稿，不自动结束其他进程。网页启用下方的历史分页模式；未传 `historyMode` 时读取完整历史。历史包含文本、附件路径、计划、推理摘要和工具结果；经图片上传功能发送的附件可恢复缩略图，原图不作为历史文本传输，也不自动读取其他本地图片路径或下载远程地址。事件可附带 `itemId`、`threadId`、`turnId`、`phase`、`images`；同一 `event.id` 更新替换，流式回复按 `itemId` 归并，切换快照时清空旧流式状态。

### 历史分页与缓存

打开历史不做写入占用检测；真正发送或明确接续发生 active-writer 错误时才触发 `writerConflict`。原进程确认结束后再次核实锁持有者：已经自行退出且没有新持有者时可以继续；发现新进程时必须重新确认，不自动结束新进程。无持有者但接续短暂冲突时有限重试，其他接续错误明确区分为解除后的失败。

### 多会话与受控重启

`hello.multiSession.supported:true` 表示支持多会话。直连在 WebSocket 查询中发送 `clientId`；云端在内层命令中发送 `clientId`。选择按客户端隔离；直连未提供标识时使用 `legacy` 选择，云 Agent 为各手机分配独立标识。命令可携带 `threadId` 明确目标；状态、事件、队列、审批和定向响应携带会话/客户端标识，前端不能将后台状态应用到当前页面。`sessions` 返回会话摘要列表，包含 `threadId/name/cwd/projectless/status/approvals/queued`。

云端 `/link` 支持同账号多 Agent。Agent 在原有设备签名认证中附带可选 `deviceName`；Broker 根据已验证的 `deviceKey` 计算 SHA-256 十六进制 `agentId`，不接受 Agent 自报路由 ID。同一设备重连替换原连接，不影响其他设备；旧的无设备身份 Agent 只支持独占账号。

手机 `auth` 可携带 `multiAgent:true, agentId:null|string`。`authed` 返回 `multiAgent:true, agents:[{id,name,pubkey}], agentId, peerOnline, peerPubkey`；只有一台在线且未指定目标时自动绑定，多台时保持未选状态。设备上线/下线通过 `agents` 推送当前在线列表和当前连接所选 `agentId`。已选离线目标不会自动切换。客户端切换电脑需重新建立带目标 ID 的连接，隔离本地会话、草稿和终端状态；网页按账号与 Agent ID 保存会话恢复键。

Broker 只将手机密文转发到该连接已绑定的 Agent，忽略密文信封中自报的目标；Agent 发回的 `e2e` 信封附带 Broker 确定的 `agentId`，且其 `phoneId` 必须属于同一账号、同一 Agent。配对与加密协议不变，设备列表元信息可由 Broker 读取，业务消息仍端到端加密。账号停用、撤销和删除断开该账号所有 Agent 和手机。未支持电脑选择的旧手机在多台在线且无目标时返回 `agent_selection_required`。

每个会话独立管理权限、队列、审批、历史和命令顺序，共享一个 Codex RPC 连接。历史与附件读取不进入任务控制队列。`closeThread {threadId}` 只关闭浏览标签，活动任务或等待队列仍保留；`watchThread {threadId,requestId}` 只读获取最新有界历史页，响应 `historyUpdate` 包含分页数据、`syncedAt`，已取得写入权时返回 `skipped:true`。前端轮询退避，不获取写入权；阅读旧页时不自动跳至最新位置。

`state.projectless:true` 表示临时会话。`newThread.scope:"temporary"` 忽略传入的项目目录，创建应用数据目录下的独立工作目录并持久化归属；不会把空目录参数解释为沿用旧项目。`hello.historyEpoch` 用于识别缓存实例，实例改变时丢弃旧历史游标。

`hello.serviceRestart` 和 `serviceRestart` 消息包含 `supported`、`phase`（`idle/waiting/restarting`）及 `error`。`restartService {confirmed:true,requestId}` 需要已有认证，等待本应用全部活动任务完成并阻止下一条队列启动；`cancelRestart` 仅在等待阶段有效。开始重启前保存未执行队列及受理凭据，恢复后为暂停状态，不自动重发。启动器通过固定 IPC 消息重新启动固定入口，不接受客户端传入命令或路径；未受管的启动方式声明不支持。

### 交互终端协议

`hello.terminal` 声明 `supported/error/shell` 和容量限制。所有命令沿用原认证通道及 `clientId`，终端命令不进入 AI 控制队列，不因 Codex 未连接而禁止执行。终端运行权限为操作系统账户权限，与 `approvalPolicy/sandbox` 分开。

| 命令 | 参数 | 行为 |
|---|---|---|
| `terminalOpen` | `threadId?`, `cols?`, `rows?`, `requestId` | 从该会话或默认目录启动固定 shell；忽略客户端传入的 cwd |
| `terminalList` | `requestId?` | 返回终端摘要和活动数量 |
| `terminalAttach` | `terminalId`, `takeControl?`, `requestId` | 恢复屏幕，`takeControl:true` 明确接管输入 |
| `terminalInput` | `terminalId`, `lease`, `inputSeq`, `data`, `requestId?` | 写入原始按键；序号连续，重复序号不再次写入 |
| `terminalResize` | `terminalId`, `lease`, `cols`, `rows` | 控制页面调整尺寸，列 10～240、行 2～80 |
| `terminalAck` | `terminalId`, `seq` | 浏览器完成解析后确认输出，回收传输窗口 |
| `terminalDetach` | `terminalId?` | 解除本页查看与控制，进程继续 |
| `terminalClose` | `terminalId`, `lease`, `confirmed:true`, `requestId` | 明确结束终端并回收资源 |

`terminalAttached` 返回 `terminalId/threadId/cwd/shell/status/exitCode/cols/rows/seq/data/canInput/lease`，`data` 为当前屏幕的 ANSI 序列，控制租约只给控制页面。后续 `terminalOutput {terminalId,seq,data}` 按序号递增，前端解析后发送确认；`terminalControl`、`terminalResized`、`terminalExit`、`terminalClosed` 更新状态。屏幕和输出不能作为 HTML 执行。

每个慢页面最多保留 131072 个未确认输出字符，达到限制时发出 `terminalPaused` 并停止向该页推送；重连后从当前屏幕恢复。服务端模拟屏幕保留最多 500 行，PTY 独立子进程也有传输背压。输入单包最多 16384 字符，禁止自动重放输入；重连与接管生成新租约，旧页面的输入与缩放请求会被拒绝。

打开或正在启动的终端阻止 `restartService`；等待项目重启时禁止创建终端。终端不恢复到新的服务进程。API 只结束本应用创建的 PTY，不按系统进程名称批量结束程序。

普通消息的实时回显可附带 `inputEcho:true`。任务受理后使用同一 `event.id` 补齐实际 `turnId`，不是再次提交提示词。网页发现同一会话、同一轮次且文本一致的持久化用户条目时移除对应临时回显；不同轮次的相同文本仍保留为独立消息。

网页直连时在 WebSocket 地址增加 `history=paged`；云端通过 `getState` 的 `historyMode:"paged"` 启用。打开和新建会话也传递该模式。分页快照的 `history` 为 `{ paged:true, nextCursor:string|null }`；未声明分页模式时，`readThread` 返回完整历史。

- 首次读取会话元数据时不包含完整轮次；每页最多 50 个事件、65536 个文本字符，每个事件预览最多 8192 个字符。字符数按 JavaScript UTF-16 字符串长度计算，不等于网络字节数。
- `events[]` 为正序；客户端用 `nextCursor` 请求更早页，再前置到当前消息。游标绑定会话并签名，重启服务后失效；错误时重新打开会话，不伪造游标。
- `truncated:true` 表示当前仅为预览或片段，`textLength` 为完整文本长度，`detailCursor` 用于读取余下内容。工具输出、消息及超长轮次错误均可分段查看。实时消息尚未持久化时内容读取可能失败，需完成后刷新历史。
- 中继在分页模式只保留最多 100 条近期事件；网页只保留 3 页历史及最多 100 条近期更新，DOM 最多创建 60 条邻近可视消息。旧页内容淘汰后通过保留的游标重新读取，不删除 Codex 历史。
- 网页滚到顶部读取更早页；回读较新页或回到最新消息时重新取回已淘汰内容。仅保留附近的导航游标，超出缓存的导航位置回到最新页后可重新向前浏览。
- 历史及内容响应回传 `requestId` 和 `threadId`；客户端忽略迟到或不匹配的结果。历史分页不进入任务控制队列，不等待分页完成才处理审批或停止。
- 浏览历史的页数不改变 Codex 模型上下文。接续仍由 Codex 加载自己的完整上下文，并保留运行中 `turnId`；不是把模型历史截断到 50 条。

历史分页需要 Codex 提供条目或轮次分页能力。不支持时返回错误，不通过写入接续读取历史；单轮输出很大时，读取仍可能需要较长时间。

### 模型设置

`hello.config` 包含 `model`；`state.model` 表示已选模型 ID，`null` 表示跟随 Codex 配置。
`models[]` 每条为 `{ model, displayName, description, isDefault }`，其中 `model` 是实际发送的 ID。列表来自 Codex `model/list`，过滤隐藏项并处理分页，不保证服务商支持每一个目录项。`defaultModel` 优先读取指定目录的有效 Codex 配置，因此可以是目录列表之外的服务商别名。

每条模型另含 `supportedReasoningEfforts: [{ reasoningEffort, description }] | null` 与 `defaultReasoningEffort: string | null`。支持列表为 `null` 表示能力未知；空数组表示没有可选择的明确等级，两者不能混同。顶层 `models.defaultReasoningEffort` 是指定目录 Codex 配置中的默认值。

`setConfig` 支持 `reasoningEffort: string | null`；省略则保留原选择，`null` 或空字符串恢复默认。等级允许小写字母开头、字母/数字/下划线/连字符，总长不超过 64；允许服务商扩展值，不将等级固定为一套枚举。已知模型只接受其支持列表内的值；能力未知或自定义模型允许显式指定，由实际调用确认支持情况。模型与等级同时校验并原子保存，失败不会部分更新，也不会返回成功确认。

下一轮通过 `turn/start.effort` 显式传入所选或解析出的默认等级；不更改当前运行任务。恢复默认优先使用与模型匹配的 `config/read.config.model_reasoning_effort`，再使用模型目录默认值。接续后重新解析，避免已有会话的等级粘滞。无法解析默认且原会话已有明确等级时返回错误，要求明确选择。模型能力目录用于发送校验时每 60 秒尝试重新获取，失败保留上次成功目录，主动刷新列表会更新缓存。

`setConfig` 可选字段包括 `model: string | null` 与 `requestId: string`。省略 `model` 保持原选择；空字符串或 `null` 恢复默认；其他类型、含空白或超过 200 字符的 ID 返回 `error`。自定义 ID 不要求出现在列表中。
选择保存成功后才广播状态并返回 `configSaved`；错误返回原 `requestId`，客户端不应提前显示保存成功。模型、等级、审批策略与沙箱选择持久化到中继或 Agent 配置，不覆盖凭据。工作目录仍为原有内存设置行为。

### 会话权限同步

`state.approvalPolicy` 与 `state.sandbox` 表示已保存的选择，`permissions.applied` 表示后端确认的实际权限；未确认时为 `null`，未知沙箱类型显示 `external-sandbox`。`pending` 表示选择尚未生效，`applying` 表示同步中，`error` 最多 1024 字符。客户端根据这些字段展示状态，不能把 `configSaved` 当作生效确认。

运行中仅保存选择，不改本轮权限或已有审批；`turn/completed` 后先同步权限再启动等待消息。空闲且已接续的会话立即同步。已加载会话直接 `thread/resume` 可能忽略覆盖，因此在任务结束后按 `thread/unsubscribe`、`thread/resume` 顺序重新接续同一会话，使用 `excludeTurns: true`，不清空历史缓存。同步失败或实际权限不匹配时保留待生效状态并暂停队列；再次保存可重试，队列仍需手动继续。

只读历史不自动取得写入占用；新建但尚未落盘的会话不取消订阅，在首次任务应用选择。每次 `turn/start` 显式传入 `approvalPolicy` 与结构化 `sandboxPolicy`；同沙箱模式优先保留后端确认的完整策略，收到 `thread/settings/updated` 时更新实际权限。同步和发送命令串行执行，网页重连通过快照恢复权限状态。

切换模型不影响进行中的任务，从下一次 `prompt` 开始生效（含新建/接续会话）。`effectiveModel` 与已选模型可以暂时不同。恢复默认时，后端重新读取工作目录的默认模型并显式传入下一次 `turn/start`，避免已有会话沿用旧模型。只改中继/Agent 自己的配置，不修改 `~/.codex/config.toml` 或登录凭据。

## 实时条目与结构化展示

思考增量支持 `item/reasoning/summaryTextDelta` 和 `item/reasoning/textDelta`，归一为 `itemDelta`；可选 `reasoningSource`（`summary` / `content`）标记当前文本来源。摘要优先：正文已显示后首次收到摘要，清空原正文窗口及位置再累计摘要；收到摘要后忽略后续正文，二者不拼接。空的思考结束事件也更新原条目状态，保留已收到的文本；结束事件仅有正文时不覆盖已有摘要。历史读取优先返回实际摘要，没有摘要时使用实际正文。不会请求或补造上游未提供的内容。

网页在思考执行中且文本为空时显示等待状态；正常结束后仍为空则隐藏条目，但保留失败或中断状态及错误信息。空内容占位不计入文本长度，流式内容仍受既有预览上限约束。

消息排序以条目开始时的位置为准，不以首个文字片段或完成事件的到达时间重新排序。空的助手开始事件保留相同条目 ID 和位置，网页不显示空气泡。分页合并以历史页内的顺序为准，实时独有记录保留在相邻已知条目前；用户临时回显按会话、轮次及文本匹配持久化消息后，在原位置替换身份，避免跨页读取时改变消息及状态提示的顺序。

`assistantDelta`、`outputDelta` 和 `itemDelta` 携带 `threadId`、`turnId`、`itemId`、`kind`、`text`。`text` 仍为本次增量，不随每个片段反复发送完整预览。命令通知的 `callId` 可作为条目 ID；无法识别条目的输出忽略，不猜测其目标。过期会话、过期任务和已结束条目的输出不覆盖当前消息。

`event` 及快照条目提供 `text`，并可包含以下字段：

- `live`、`status`：实时或完成状态；启动、输出、完成保持相同事件 ID。状态为 `running`、`completed`、`failed`、`interrupted` 或 `ended`。任务结束时收尾未完成条目，`ended` 不等同于成功。
- 命令：`command`（最多 2048 字符）、`exitCode`、`durationMs`、`output`（最多 8192 字符）、`outputLength`、`outputStart`。`outputStart` 为兼容文本中命令输出的绝对开始位置，历史分段据此避免重复显示命令头。
- 文件：`changeCount` 和 `changes`。最多 20 个文件预览，路径最多 1024 字符，单文件 diff 最多 2048 字符，路径与 diff 合计最多 8192 字符；每项含 `path`、`changeKind`、`diff`、`diffLength`。完整 diff 仍在历史兼容文本中，通过内容游标读取。
- 工具：`server`、`tool`（各最多 256 字符）和可选 `error`（最多 2048 字符）。不发送任意原始工具对象或连接配置。

分页模式实时条目最多保留 `text` 最新窗口和 `headText` 开头窗口各 8192 字符，`textOffset` 为当前窗口绝对位置，`textLength` 为完整长度，`preview` 为 `head` 或 `tail`。实时窗口不保证包含全部中间文本；接续历史开头后新增内容按真实偏移记录，不伪造连续窗口。`headText` 仅在实时截断条目上保留，完成后移除，用 `detailCursor` 分段获取完整内容。历史页的字符限制仍只计算 `text`，上述有界结构化字段另有传输开销，不能将其误认为整个 JSON 的字节上限。

网页实时片段只更新目标事件，按浏览器帧渲染；分页加载和持久化回显身份归并仍保留原路径。截断内容使用纯文本，不解析被截断的 Markdown。客户端可根据这些字段展示工具状态。

## 消息队列

`setConfig` 的 `approvalPolicy` 与 `sandbox` 同模型和思考等级一起校验并原子保存。只有持久化成功后才更新后端选择状态并返回 `configSaved`；保存失败不报告成功。审批策略允许 `on-request`、`untrusted`、`on-failure`、`never`，沙箱允许 `workspace-write`、`read-only`、`danger-full-access`。未传字段保留原选择，存储中的其他字段和凭据不覆盖。下一次 `turn/start` 显式传入当前审批策略；已有任务及待处理审批仍遵循其原请求，不自动批准。

队列命令：

| type | 字段 | 说明 |
|---|---|---|
| enqueuePrompt | text, threadId?, cwd?, requestId, images[]? | 将图文或纯图片消息排入当前会话；仅无当前会话时允许省略会话 ID 并自动新建 |
| cancelQueuedPrompt | threadId, id, requestId? | 取消尚未开始的消息，启动中消息需使用停止任务 |
| pauseQueue | threadId, requestId? | 暂停该会话后续消息，不中断当前任务 |
| resumeQueue | threadId, requestId? | 手动继续当前会话队列；运行中的任务仍需先完成 |

快照中的 promptQueue，字段为 supported、threadId、paused、reason、items、activeId、acceptedRequestIds、limit。items 包含 id、requestId、threadId、text、可选 cwd，以及 status（queued 或 starting）；activeId 表示正在启动或执行的队列消息。任务受理并取得 turnId 后从等待列表移除，不代表任务已完成。

队列变化广播 type:"promptQueue"、queue；入队受理回传 type:"promptAccepted"、id、requestId、threadId、queue。后端先登记受理凭据再调度执行；受理不代表任务成功。错误沿用 type:"error" 并回传原 requestId。客户端应匹配自己的请求 ID 后清空对应草稿，不能把其他客户端的确认当成自己的发送确认。

请求 ID 须为 1～160 个 ASCII 字母、数字或下划线、点、冒号、连字符。同 ID、同会话、同文本、同 cwd 和同图片内容的重试返回原凭据；变更内容（含原图、名称或缩略图）则报错。每个会话保留最近 200 个凭据并保护等待及执行中的请求，已取消消息的重试也不会恢复入队。受控重启恢复这些凭据，普通崩溃不保证跨重启幂等；网页不会自动重发未确认消息。

队列平时保存在电脑端内存，关闭网页后继续保留；受控重启额外写入一次性恢复文件并暂停恢复，普通崩溃不保证恢复。全会话合计上限为 20 条、262144 字符，单条最多 65536 字符（UTF-16 长度）。同一会话 FIFO，仅成功完成才自动推进；中断、失败、未知状态、占用或 Codex 断连均暂停相应队列。多会话切换不暂停后台队列，不同会话可并行，开始执行时采用该会话当前设置。

普通 prompt 可启动空闲会话的任务，运行中拒绝启动第二个任务。steer 不进入队列。入队时不生成用户气泡；开始执行才生成带稳定 id 和 inputEcho:true 的临时回显，并在取得任务 ID 后补齐 turnId。队列调度与任务控制共用串行命令链，历史分页仍独立处理。

## 典型时序

### 会话占用与接管

`thread/resume` 返回 `already has an active writer` 时保持原会话不变，返回 `writerConflict` 而非自动强杀。`owners[]` 为 `{ pid, name, affectedThreads[], canTerminate, token }`；Windows 使用系统 Restart Manager 检查该会话的 `.codex/thread-writer-locks/<UUID>.lock`。只展示锁相关进程，不扫描或批量结束所有 Codex 进程，不删除锁文件。无法识别、多个占用者、无权限、非 Windows 或中继自身的控制进程都不提供结束按钮。

客户端必须展示所有受影响会话并二次确认。`token` 为单次、60 秒有效的确认凭据，绑定会话、PID、进程启动时间和受影响会话集合。执行前再次确认同一进程仍访问该锁、启动时间未变、受影响集合未变且可执行文件为 `codex.exe`，否则拒绝操作并要求重新检查。结束失败不接续；退出后仍被其他写入者占用会再次返回 `writerConflict`，不连续结束其他进程。`error` 回传原 `requestId`。

强制结束作用于整个占用 Codex 进程，可能影响多个会话，包括当前电脑客户端的会话。已产生的文件改动不会回滚，已启动的子进程不保证一起结束。优先在原电脑客户端正常停止或关闭会话；接管是用户明确确认后的备选操作。

### 提示词与审批

```
client → {type:"prompt", text:"修复失败的测试"}
server → {type:"event", event:{kind:"user", text:"修复失败的测试"}}
server → {type:"state", state:{status:"running", turnId:"…"}}
server → {type:"assistantDelta", text:"我先"} …（多条）
server → {type:"approval", approval:{key:"K", kind:"command", command:"npm test", …}}
client → {type:"approval", key:"K", optionId:"approve"}
server → {type:"approvalResolved", key:"K", by:"user"}
server → {type:"event", event:{kind:"item:commandExecution", text:"$ npm test → exit 0"}}
server → {type:"state", state:{status:"idle"}}
```
