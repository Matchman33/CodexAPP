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
| `hello` | `state`, `config`, `pendingApprovals[]`, `recentEvents[]`, `history?`, `requestId?` | 连接快照；分页模式仅携带有限近期记录 |
| `historyPage` | `threadId`, `events[]`, `nextCursor`, `requestId` | 按时间正序排列的一页历史；游标继续读取更早记录 |
| `historyItem` | `threadId`, `itemId?`, `text`, `offset`, `textLength`, `nextOffset`, `detailCursor`, `requestId` | 历史长文本的一个内容片段 |
| `state` | `state` | 状态变化 |
| `models` | `models[]`, `defaultModel`, `defaultReasoningEffort`, `error` | 响应 `listModels`；列表可能为空或部分加载失败 |
| `configSaved` | `requestId?` | `setConfig` 已应用，模型与思考等级已保存到电脑端配置 |
| `writerConflict` | `threadId`, `owners[]`, `message` | 会话有外部写入占用；展示进程和受影响会话，不自动结束进程 |
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
  "sandbox": "workspace-write" | "read-only" | "danger-full-access"
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

| type | 字段 | 说明 |
|---|---|---|
| `prompt` | `text`, `cwd?` | 发提示词，开始一个新 turn（无会话则自动新建） |
| `steer` | `text` | 纠偏：往当前进行中的 turn 插话 |
| `interrupt` | `threadId?`, `turnId?` | 中断指定或当前任务；后端向 Codex 传齐两个 ID |
| `approval` | `key`, `optionId` | 回传审批决策（`optionId` ∈ approve/approveSession/deny） |
| `newThread` | `cwd?` | 新建会话 |
| `setConfig` | `approvalPolicy?`, `sandbox?`, `cwd?`, `model?`, `reasoningEffort?`, `requestId?` | 改策略、模型与思考等级；模型和等级下一条消息生效，沙箱下个会话生效 |
| `listModels` | `cwd?` | 从电脑端 Codex 获取模型列表与该目录的默认模型 |
| `getState` | — | 请求重新下发快照 |
| `listThreads` | — | 请求会话/项目列表，服务端回 `projectTree` |
| `readThread` | `threadId`, `historyMode?`, `requestId?` | 只读查看会话，不获取写入锁；`historyMode:"paged"` 返回近期一页，回 `hello` |
| `historyPage` | `threadId`, `cursor?`, `requestId` | 只读获取历史页；省略游标获取最新页，回 `historyPage` |
| `readHistoryItem` | `threadId`, `detailCursor`, `offset?`, `requestId` | 分段读取超长消息或工具输出，回 `historyItem` |
| `resumeThread` | `threadId` | 接续已有会话（切到它的项目 cwd，继续这段对话） |
| `inspectWriter` | `threadId`, `requestId?` | 只读检查该会话锁的占用进程，返回 `writerConflict` |
| `takeoverThread` | `threadId`, `token`, `confirmed:true`, `requestId?` | 确认后结束已识别占用进程，确认退出后尝试接续会话 |

`projects[]` 每条：`{ id, root, roots[], label, threads[] }`；`projectless[]` 和 `threads[]` 每条：`{ id, name, cwd, updatedAt(秒), source }`。`state` 增加 `threadName`(当前会话名)、`lastDiff` 和 `readOnly`。

列表读取所有模型提供商的非归档交互会话，遍历分页并按会话 ID 去重。新版项目 ID 由 `local-projects` 解析，显式 `thread-project-assignments` 优先于路径匹配，兼容旧版目录格式、多个工作根目录和工作区提示。未分配的会话保留在对话组，不再静默丢弃。

打开列表中的会话使用 `readThread`；仅发送提示词或明确接续时才调用 `thread/resume`。占用时保持历史和草稿，不自动结束其他进程。新版网页启用下方的历史分页模式；未传 `historyMode` 的旧客户端保留完整历史读取兼容路径。历史包含文本、附件路径、计划、推理摘要和工具结果，图片本体暂不通过中继传输。事件可附带 `itemId`、`threadId`、`turnId`、`phase`；同一 `event.id` 更新替换，流式回复按 `itemId` 归并，切换快照时清空旧流式状态。

### 历史分页与缓存

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
模型选择保存成功后才广播状态并返回 `configSaved`；错误返回原 `requestId`，客户端不应提前显示保存成功。其余配置保持原有内存设置行为，沙箱仍在新会话生效。

切换模型不影响进行中的任务，从下一次 `prompt` 开始生效（含新建/接续会话）。`effectiveModel` 与已选模型可以暂时不同。恢复默认时，后端重新读取工作目录的默认模型并显式传入下一次 `turn/start`，避免已有会话沿用旧模型。只改中继/Agent 自己的配置，不修改 `~/.codex/config.toml` 或登录凭据。

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
