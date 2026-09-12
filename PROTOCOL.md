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
| `hello` | `state`, `config`, `pendingApprovals[]`, `recentEvents[]` | 连接快照 |
| `state` | `state` | 状态变化 |
| `models` | `models[]`, `defaultModel`, `error` | 响应 `listModels`；列表可能为空或部分加载失败 |
| `configSaved` | `requestId?` | `setConfig` 已应用，模型选择已保存到电脑端配置 |
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
| `setConfig` | `approvalPolicy?`, `sandbox?`, `cwd?`, `model?`, `requestId?` | 改策略/模型；模型下一条消息生效，沙箱下个会话生效 |
| `listModels` | `cwd?` | 从电脑端 Codex 获取模型列表与该目录的默认模型 |
| `getState` | — | 请求重新下发快照 |
| `listThreads` | — | 请求会话/项目列表，服务端回 `projectTree` |
| `readThread` | `threadId` | 只读查看完整历史，不获取写入锁；回 `hello` |
| `resumeThread` | `threadId` | 接续已有会话（切到它的项目 cwd，继续这段对话） |
| `inspectWriter` | `threadId`, `requestId?` | 只读检查该会话锁的占用进程，返回 `writerConflict` |
| `takeoverThread` | `threadId`, `token`, `confirmed:true`, `requestId?` | 确认后结束已识别占用进程，确认退出后尝试接续会话 |

`projects[]` 每条：`{ id, root, roots[], label, threads[] }`；`projectless[]` 和 `threads[]` 每条：`{ id, name, cwd, updatedAt(秒), source }`。`state` 增加 `threadName`(当前会话名)、`lastDiff` 和 `readOnly`。

列表读取所有模型提供商的非归档交互会话，遍历分页并按会话 ID 去重。新版项目 ID 由 `local-projects` 解析，显式 `thread-project-assignments` 优先于路径匹配，兼容旧版目录格式、多个工作根目录和工作区提示。未分配的会话保留在对话组，不再静默丢弃。

打开列表中的会话使用 `readThread`；仅发送提示词或明确接续时才调用 `thread/resume`。占用时保持历史和草稿，不自动结束其他进程。历史来自 Codex 的只读历史接口；完整历史快照不再限制为最后 120 条，客户端也不再截断为 300 条。包含文本、附件路径、计划、推理摘要和工具结果，图片本体暂不通过中继传输。事件可以附带 `itemId`、`threadId`、`turnId`、`phase`；同一 `event.id` 更新替换，流式回复按 `itemId` 归并，切换快照时清空旧流式状态。

### 模型设置

`hello.config` 包含 `model`；`state.model` 表示已选模型 ID，`null` 表示跟随 Codex 配置。
`models[]` 每条为 `{ model, displayName, description, isDefault }`，其中 `model` 是实际发送的 ID。列表来自 Codex `model/list`，过滤隐藏项并处理分页，不保证服务商支持每一个目录项。`defaultModel` 优先读取指定目录的有效 Codex 配置，因此可以是目录列表之外的服务商别名。

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
