# CodexApp 客户端 ↔ 中继 协议

所有客户端（web / iOS / Android）都通过 **WebSocket** 连接同一个中继，说同一套 JSON 协议。
这是三端实现的唯一事实来源。中继实现见 [relay/server.mjs](relay/server.mjs)。

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
  "permissions": { // 可选；旧后端没有此字段
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

### 会话管理

新版 `hello.threadManagement` 为 `{delete:true,release:true}`。未声明能力的后端禁用对应网页按钮；Codex 运行时不支持接口则返回错误，不回退为磁盘删除或结束外部进程。

| type | 字段 | 说明 |
|---|---|---|
| `deleteThread` | `threadId`, `confirmed:true`, `requestId` | 永久删除会话和派生子会话，客户端必须先显示名称与不可恢复确认 |
| `releaseThread` | `threadId`, `requestId` | 暂停等待队列，取消当前中继订阅并确认卸载；必须明确匹配当前会话 ID |
| `threadDeleted` | `threadId`, `requestId?` | 删除已确认；后代删除也单独广播。重复通知按 ID 幂等处理 |
| `threadReleased` | `threadId`, `writerReleased`, `requestId` | 当前中继已确认释放；不代表其他独立进程也释放了它们的占用 |

`state.threadAction` 在操作期间为 `delete` 或 `release`，完成后清空。客户端在操作期间禁用发送、切换、队列继续和相关设置，收到与 `requestId` 对应的错误时保留页面并允许人工重试。删除成功后清理相关历史页、流式状态、等待队列和列表项，并忽略迟到的旧会话响应。前端不自动重试超时的删除请求。

`state.writerReleased:true` 表示当前中继已确认目标未加载；会话仍可保留在只读页面。发送或接续后重置此字段。释放前检查当前无活动任务或审批，取消订阅后重置权限同步状态，防止权限同步重新获取写入占用。队列保留且暂停；删除会话则移除对应等待条目但保留有限受理凭据，避免迟到的入队重试重复执行。

主动释放通过 `thread/unsubscribe` 和 `thread/loaded/list` 确认。若 Codex 宽限期仍保留目标，只在已加载会话都确认空闲时重连本应用独占的 app-server 子进程；不结束其他进程，不删除写入锁文件。切换会话只取消旧订阅，不强制重连；刷新网页不会释放正在运行的任务。

### 图片输入

`hello.imageUpload` 为 `{ supported:true, count:4, bytes:1048576, totalBytes:4194304, previewBytes:8192, queueChars:25165824 }`。未声明能力的旧后端不应接收图片请求；前端禁用选图，不影响文字消息。

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
| `newThread` | `cwd?` | 新建会话 |
| `setConfig` | `approvalPolicy?`, `sandbox?`, `cwd?`, `model?`, `reasoningEffort?`, `requestId?` | 保存选择；模型与等级下一条消息生效，权限在当前任务结束后同步，空闲已接续会话立即同步 |
| `listModels` | `cwd?` | 从电脑端 Codex 获取模型列表与该目录的默认模型 |
| `getState` | — | 请求重新下发快照 |
| `listThreads` | — | 请求会话/项目列表，服务端回 `projectTree` |
| `readThread` | `threadId`, `historyMode?`, `requestId?`, `checkWriter?` | 只读查看会话，不获取写入锁；网页切换默认传 `checkWriter:true`，先检测外部占用再加载历史 |
| `historyPage` | `threadId`, `cursor?`, `requestId` | 只读获取历史页；省略游标获取最新页，回 `historyPage` |
| `readHistoryItem` | `threadId`, `detailCursor`, `offset?`, `requestId` | 分段读取超长消息或工具输出，回 `historyItem` |
| `resumeThread` | `threadId` | 接续已有会话（切到它的项目 cwd，继续这段对话） |
| `inspectWriter` | `threadId`, `requestId?` | 只读检查该会话锁的占用进程，返回 `writerConflict` |
| `takeoverThread` | `threadId`, `token`, `confirmed:true`, `requestId?` | 确认后结束已识别占用进程，确认退出后尝试接续会话 |

`projects[]` 每条：`{ id, root, roots[], label, threads[] }`；`projectless[]` 和 `threads[]` 每条：`{ id, name, cwd, updatedAt(秒), source }`。`state` 增加 `threadName`(当前会话名)、`lastDiff` 和 `readOnly`。

列表读取所有模型提供商的非归档交互会话，遍历分页并按会话 ID 去重。新版项目 ID 由 `local-projects` 解析，显式 `thread-project-assignments` 优先于路径匹配，兼容旧版目录格式、多个工作根目录和工作区提示。未分配的会话保留在对话组，不再静默丢弃。

打开列表中的会话使用 `readThread`；仅发送提示词或明确接续时才调用 `thread/resume`。占用时保持历史和草稿，不自动结束其他进程。新版网页启用下方的历史分页模式；未传 `historyMode` 的旧客户端保留完整历史读取兼容路径。历史包含文本、附件路径、计划、推理摘要和工具结果；经图片上传功能发送的附件可恢复缩略图，原图不作为历史文本传输，也不自动读取其他本地图片路径或下载远程地址。事件可附带 `itemId`、`threadId`、`turnId`、`phase`、`images`；同一 `event.id` 更新替换，流式回复按 `itemId` 归并，切换快照时清空旧流式状态。

### 历史分页与缓存

`readThread.checkWriter:true` 在读取历史及取消原会话订阅之前探测目标锁。Windows UUID 会话的外部持有者触发 `writerConflict`，同时带 `onOpen:true` 和原 `requestId`，本次不切换当前会话。直连只向发起选择的客户端发出该提示；网页用选择 ID 丢弃迟到的检查结果并结束加载状态。非 Windows 或非 UUID 会话暂不执行文件锁探测，接续时仍保留原有冲突处理。主动选择「仅查看历史」时重发 `readThread` 并传 `checkWriter:false`，不调用 `thread/resume`。普通旧客户端省略该字段仍按只读方式打开。此检查过滤中继自身与其 app-server PID；`releaseThread` 不会因此取得结束外部进程的权限。

普通消息的实时回显可附带 `inputEcho:true`。任务受理后使用同一 `event.id` 补齐实际 `turnId`，不是再次提交提示词。网页发现同一会话、同一轮次且文本一致的持久化用户条目时移除对应临时回显；不同轮次的相同文本仍保留为独立消息。

新版网页直连时在 WebSocket 地址增加 `history=paged`；云端通过 `getState` 的 `historyMode:"paged"` 启用。打开和新建会话也传递该模式。分页快照的 `history` 为 `{ paged:true, nextCursor:string|null }`；旧客户端未声明模式时仍可通过原 `readThread` 读取完整历史，但不享受后端有界缓存优化。

- 首次读取会话元数据时不包含完整轮次；每页最多 50 个事件、65536 个文本字符，每个事件预览最多 8192 个字符。字符数按 JavaScript UTF-16 字符串长度计算，不等于网络字节数。
- `events[]` 为正序；客户端用 `nextCursor` 请求更早页，再前置到当前消息。游标绑定会话并签名，重启服务后失效；错误时重新打开会话，不伪造游标。
- `truncated:true` 表示当前仅为预览或片段，`textLength` 为完整文本长度，`detailCursor` 用于读取余下内容。工具输出、消息及超长轮次错误均可分段查看。实时消息尚未持久化时内容读取可能失败，需完成后刷新历史。
- 中继在分页模式只保留最多 100 条近期事件；网页只保留 3 页历史及最多 100 条近期更新，DOM 最多创建 60 条邻近可视消息。旧页内容淘汰后通过保留的游标重新读取，不删除 Codex 历史。
- 网页滚到顶部读取更早页；回读较新页或回到最新消息时重新取回已淘汰内容。仅保留附近的导航游标，超出缓存的导航位置回到最新页后可重新向前浏览。
- 历史及内容响应回传 `requestId` 和 `threadId`；客户端忽略迟到或不匹配的结果。历史分页不进入任务控制队列，不等待分页完成才处理审批或停止。
- 浏览历史的页数不改变 Codex 模型上下文。接续仍由 Codex 加载自己的完整上下文，并保留运行中 `turnId`；不是把模型历史截断到 50 条。

接口适配依次使用 `thread/items/list`、旧版 `thread/turns/items/list`。若二者都未实现，则降级为 `thread/turns/list` 一次读取一轮完整条目，再生成有限显示页。此降级仍避免一次传输全部会话，但单轮巨量输出的读取开销及 Codex 内部读盘行为不能由网页分页彻底消除。不支持轮次分页时返回错误，不偷偷改用写入接续读取历史。

### 模型设置

`hello.config` 包含 `model`；`state.model` 表示已选模型 ID，`null` 表示跟随 Codex 配置。
`models[]` 每条为 `{ model, displayName, description, isDefault }`，其中 `model` 是实际发送的 ID。列表来自 Codex `model/list`，过滤隐藏项并处理分页，不保证服务商支持每一个目录项。`defaultModel` 优先读取指定目录的有效 Codex 配置，因此可以是目录列表之外的服务商别名。

每条模型另含 `supportedReasoningEfforts: [{ reasoningEffort, description }] | null` 与 `defaultReasoningEffort: string | null`。支持列表为 `null` 表示能力未知（兼容旧服务端）；空数组表示没有可选择的明确等级，两者不能混同。顶层 `models.defaultReasoningEffort` 是指定目录 Codex 配置中的默认值。

`setConfig` 支持 `reasoningEffort: string | null`；省略则保留原选择，`null` 或空字符串恢复默认。等级允许小写字母开头、字母/数字/下划线/连字符，总长不超过 64；允许服务商扩展值，不将等级固定为一套枚举。已知模型只接受其支持列表内的值；能力未知或自定义模型允许显式指定，由实际调用确认支持情况。模型与等级同时校验并原子保存，失败不会部分更新，也不会返回成功确认。

下一轮通过 `turn/start.effort` 显式传入所选或解析出的默认等级；不更改当前运行任务。恢复默认优先使用与模型匹配的 `config/read.config.model_reasoning_effort`，再使用模型目录默认值。接续后重新解析，避免已有会话的等级粘滞。无法解析默认且原会话已有明确等级时返回错误，要求明确选择。模型能力目录用于发送校验时每 60 秒尝试重新获取，失败保留上次成功目录，主动刷新列表会更新缓存。

`setConfig` 新增可选字段 `model: string | null` 与 `requestId: string`。省略 `model` 保持原选择；空字符串或 `null` 恢复默认；其他类型、含空白或超过 200 字符的 ID 返回 `error`。自定义 ID 不要求出现在列表中。
选择保存成功后才广播状态并返回 `configSaved`；错误返回原 `requestId`，客户端不应提前显示保存成功。模型、等级、审批策略与沙箱选择持久化到中继或 Agent 配置，不覆盖凭据。工作目录仍为原有内存设置行为。

### 会话权限同步

`state.approvalPolicy` 与 `state.sandbox` 表示已保存的选择，`permissions.applied` 表示后端确认的实际权限；未确认时为 `null`，未知沙箱类型显示 `external-sandbox`。`pending` 表示选择尚未生效，`applying` 表示同步中，`error` 最多 1024 字符。客户端根据这些字段展示状态，不能把 `configSaved` 当作生效确认。

运行中仅保存选择，不改本轮权限或已有审批；`turn/completed` 后先同步权限再启动等待消息。空闲且已接续的会话立即同步。已加载会话直接 `thread/resume` 可能忽略覆盖，因此在任务结束后按 `thread/unsubscribe`、`thread/resume` 顺序重新接续同一会话，使用 `excludeTurns: true`，不清空历史缓存。同步失败或实际权限不匹配时保留待生效状态并暂停队列；再次保存可重试，队列仍需手动继续。

只读历史不自动取得写入占用；新建但尚未落盘的会话不取消订阅，在首次任务应用选择。每次 `turn/start` 显式传入 `approvalPolicy` 与结构化 `sandboxPolicy`；同沙箱模式优先保留后端确认的完整策略，收到 `thread/settings/updated` 时更新实际权限。同步和发送命令串行执行，网页重连通过快照恢复权限状态。

切换模型不影响进行中的任务，从下一次 `prompt` 开始生效（含新建/接续会话）。`effectiveModel` 与已选模型可以暂时不同。恢复默认时，后端重新读取工作目录的默认模型并显式传入下一次 `turn/start`，避免已有会话沿用旧模型。只改中继/Agent 自己的配置，不修改 `~/.codex/config.toml` 或登录凭据。

## 实时条目与结构化展示

思考增量支持 `item/reasoning/summaryTextDelta` 和 `item/reasoning/textDelta`，归一为 `itemDelta`；新增可选 `reasoningSource`（`summary` / `content`）标记当前文本来源。摘要优先：正文已显示后首次收到摘要，清空原正文窗口及位置再累计摘要；收到摘要后忽略后续正文，二者不拼接。空的思考结束事件也更新原条目状态，保留已收到的文本；结束事件仅有正文时不覆盖已有摘要。历史读取优先返回实际摘要，没有摘要时使用实际正文。不会请求或补造上游未提供的内容。

网页在思考执行中且文本为空时显示等待状态；正常结束后仍为空则隐藏条目，但保留失败或中断状态及错误信息。空内容占位不计入文本长度，流式内容仍受既有预览上限约束。

消息排序以条目开始时的位置为准，不以首个文字片段或完成事件的到达时间重新排序。空的助手开始事件保留相同条目 ID 和位置，网页不显示空气泡。分页合并以历史页内的顺序为准，实时独有记录保留在相邻已知条目前；用户临时回显按会话、轮次及文本匹配持久化消息后，在原位置替换身份，避免跨页读取时改变消息及状态提示的顺序。

`assistantDelta`、`outputDelta` 和新增 `itemDelta` 携带 `threadId`、`turnId`、`itemId`、`kind`、`text`。`text` 仍为本次增量，不随每个片段反复发送完整预览。命令旧版通知的 `callId` 可作为条目 ID；无法识别条目的输出忽略，不猜测其目标。过期会话、过期任务和已结束条目的输出不覆盖当前消息。

`event` 及快照条目继续提供兼容 `text`，可新增以下字段：

- `live`、`status`：实时或完成状态；启动、输出、完成保持相同事件 ID。状态为 `running`、`completed`、`failed`、`interrupted` 或 `ended`。任务结束时收尾未完成条目，`ended` 不等同于成功。
- 命令：`command`（最多 2048 字符）、`exitCode`、`durationMs`、`output`（最多 8192 字符）、`outputLength`、`outputStart`。`outputStart` 为兼容文本中命令输出的绝对开始位置，历史分段据此避免重复显示命令头。
- 文件：`changeCount` 和 `changes`。最多 20 个文件预览，路径最多 1024 字符，单文件 diff 最多 2048 字符，路径与 diff 合计最多 8192 字符；每项含 `path`、`changeKind`、`diff`、`diffLength`。完整 diff 仍在历史兼容文本中，通过内容游标读取。
- 工具：`server`、`tool`（各最多 256 字符）和可选 `error`（最多 2048 字符）。不发送任意原始工具对象或连接配置。

分页模式实时条目最多保留 `text` 最新窗口和 `headText` 开头窗口各 8192 字符，`textOffset` 为当前窗口绝对位置，`textLength` 为完整长度，`preview` 为 `head` 或 `tail`。实时窗口不保证包含全部中间文本；接续历史开头后新增内容按真实偏移记录，不伪造连续窗口。`headText` 仅在实时截断条目上保留，完成后移除，用 `detailCursor` 分段获取完整内容。历史页的字符限制仍只计算 `text`，上述有界结构化字段另有传输开销，不能将其误认为整个 JSON 的字节上限。

网页实时片段只更新目标事件，按浏览器帧渲染；分页加载和持久化回显身份归并仍保留原路径。截断内容使用纯文本，不解析被截断的 Markdown。旧客户端可以忽略新增字段继续显示 `text`，但不会自动获得新的工具状态界面。

## 消息队列

`setConfig` 的 `approvalPolicy` 与 `sandbox` 同模型和思考等级一起校验并原子保存。只有持久化成功后才更新后端选择状态并返回 `configSaved`；保存失败不报告成功。审批策略允许 `on-request`、`untrusted`、`on-failure`、`never`，沙箱允许 `workspace-write`、`read-only`、`danger-full-access`。未传字段保留原选择，存储中的其他字段和凭据不覆盖。下一次 `turn/start` 显式传入当前审批策略；已有任务及待处理审批仍遵循其原请求，不自动批准。

新增命令：

| type | 字段 | 说明 |
|---|---|---|
| enqueuePrompt | text, threadId?, cwd?, requestId, images[]? | 将图文或纯图片消息排入当前会话；仅无当前会话时允许省略会话 ID 并自动新建 |
| cancelQueuedPrompt | threadId, id, requestId? | 取消尚未开始的消息，启动中消息需使用停止任务 |
| pauseQueue | threadId, requestId? | 暂停该会话后续消息，不中断当前任务 |
| resumeQueue | threadId, requestId? | 手动继续当前会话队列；运行中的任务仍需先完成 |

快照新增 promptQueue，字段为 supported、threadId、paused、reason、items、activeId、acceptedRequestIds、limit。items 包含 id、requestId、threadId、text、可选 cwd，以及 status（queued 或 starting）；activeId 表示正在启动或执行的队列消息。任务受理并取得 turnId 后从等待列表移除，不代表任务已完成。

队列变化广播 type:"promptQueue"、queue；入队受理回传 type:"promptAccepted"、id、requestId、threadId、queue。后端先登记受理凭据再调度执行；受理不代表任务成功。错误沿用 type:"error" 并回传原 requestId。客户端应匹配自己的请求 ID 后清空对应草稿，不能把其他客户端的确认当成自己的发送确认。

请求 ID 须为 1～160 个 ASCII 字母、数字或下划线、点、冒号、连字符。同 ID、同会话、同文本、同 cwd 和同图片内容的重试返回原凭据；变更内容（含原图、名称或缩略图）则报错。保留最近 200 个凭据并保护等待及执行中的请求，已取消消息的重试也不会恢复入队。该窗口是有限的，不支持跨后端重启的幂等；网页不会自动重发未确认消息。

队列仅存电脑端后端内存，关闭网页后继续保留，服务重启清空。全会话合计上限为 20 条、262144 字符，单条上限为 65536 字符，字符按 JavaScript UTF-16 长度计。等待消息按原会话 FIFO 执行，仅 turn.status 为 completed 才自动推进；中断、失败、未知状态、写入占用或 Codex 断连均暂停队列。切换会话会暂停原会话队列，只能在重新打开原会话后手动继续。消息开始执行时使用当时的模型、思考等级和审批策略。

普通 prompt 保留给旧客户端，但运行中拒绝启动第二个任务。steer 不进入队列。入队时不生成用户气泡；开始执行才生成带稳定 id 和 inputEcho:true 的临时回显，并在取得任务 ID 后补齐 turnId。队列调度与任务控制共用串行命令链，历史分页仍独立处理。

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
