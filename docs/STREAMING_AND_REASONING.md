# 流式、思考与搜索事件规范

## 1. 目标

流式层必须把 Provider 的原始事件可靠地转换成可渲染、可持久化、可恢复的语义事件，同时保持顺序、关联 ID、时间和错误。对 Grok 等会返回搜索、工具和代理轨迹的接口，不能只提取最终文本。

## 2. 三层事件

```text
Raw transport event
  -> Provider parsed event
  -> Domain stream event
  -> Streaming message blocks / persisted message blocks
```

### 2.1 Raw transport event

Rust 管道回传的原始 SSE `data` 字符串或 protocol codec 声明的等价数据片段。Rust 不解释内容。

### 2.2 Provider parsed event

Protocol codec 识别的协议特有事件，可保留原始字段和 response id。

### 2.3 Domain stream event

跨 Provider 的稳定语义事件，供 reducer、UI 和持久化使用。

## 3. 统一事件模型

在当前统一 `StreamEvent` 契约上做加法扩展：

```ts
type StreamEvent =
  | { type: 'stream_started'; responseId?: string; ts: number }
  | { type: 'heartbeat'; idleMs: number; ts: number }
  | { type: 'text_delta'; blockId: string; text: string; ts: number }
  | { type: 'thinking_started'; blockId: string; label?: string; ts: number }
  | { type: 'thinking_delta'; blockId: string; text: string; ts: number }
  | { type: 'thinking_completed'; blockId: string; durationMs?: number; ts: number }
  | { type: 'tool_call_started'; call: ToolCallStart; ts: number }
  | { type: 'tool_call_delta'; id: string; argsDelta?: string; ts: number }
  | { type: 'tool_call_completed'; id: string; args?: unknown; ts: number }
  | { type: 'tool_result'; id: string; result: ToolResultEvent; ts: number }
  | { type: 'source'; source: SourceEvent; ts: number }
  | { type: 'citation'; citation: CitationEvent; ts: number }
  | { type: 'agent_status'; agent: AgentStatusEvent; ts: number }
  | { type: 'usage'; input: number; output: number; reasoning?: number; ts: number }
  | { type: 'metadata'; key: string; value: unknown; ts: number }
  | { type: 'done'; finishReason: string; responseId?: string; ts: number }
  | { type: 'error'; code: string; message: string; rawRef?: string; ts: number }
```

每个事件由应用层附加单调递增 `seq`、request id、conversation id 和 message id。Provider 提供的时间可以保存为 metadata，但本地接收时间是排序和计时的基础。

自动重试的 `attempt_started`、`retry_scheduled`、`retry_cancelled` 和 `attempt_failed` 属于 request lifecycle event，不伪装成 Provider `StreamEvent`，也不写成模型消息正文。它们通过 logical request id 与当前消息关联，详细规则见 [自动重试与请求尝试](./features/16-automatic-retry.md)。

## 4. Rust 管道要求

- 使用 request id 注册取消 token。
- 只发送 TypeScript 已构造完成的 URL、method、Header、Query 和 Body，不补写认证或改名业务字段。
- 校验 HTTP 状态并把非成功响应正文作为最多 16 KiB 的受限错误片段回传；错误不得拼入请求 Header、Query、Body、认证值或完整 URL。
- 按 30ms、最大 64 个 data 事件或 256 KiB UTF-8 data payload 三个具名边界有序合批；单个 data 超过上限时返回 `stream`，不拆分原始事件。
- 取消、断流和正常 EOF 都必须清理 running map。
- 最后一个非空 batch 必须在 done 前发送。
- 取消优先于 batch timer 和读取；尚未发出的 pending batch 不得拖延停止。
- `timeoutMs` 覆盖同一次 attempt 的连接、等待响应、非成功正文读取和活动流生命周期。
- Channel 关闭后停止无意义读取和发送并清理 reader、timer、取消 token 与 running map。
- transport 错误稳定区分 `invalid_request`、`network`、`http`、`timeout`、`stream`、`cancelled` 和 `channel_closed`，不在 Rust 解析协议内嵌错误。

### 4.1 执行所有权与 UI 订阅

- active request 由应用根级 `ActiveRequestRegistry` 拥有，不由聊天页面、消息组件或某个 React hook 的生命周期拥有。
- 路由切换、会话切换和组件卸载只 detach 当前 UI subscriber，不调用 `sse_cancel`。用户点击停止、退出流程的明确选择或执行策略触发的 abort 才能取消上游请求。
- registry 持续消费 Rust Channel、更新 reducer、保存低频检查点并在终态写入 SQLite，即使当前没有消息页面订阅。
- 返回会话时 subscriber 先读取 registry 的当前规范化快照，再订阅后续事件；若 registry 已结束或不存在，则读取 SQLite 权威消息。
- 每个 subscriber 的通知必须隔离错误。一个页面、诊断面板或状态指示器抛错，不能阻断其他 subscriber 和终态持久化。
- MVP 只保证同一应用进程内的 detach/attach；应用进程退出或 WebView 崩溃后仍按 `interrupted` 恢复，不宣称普通 SSE 可以跨进程继续。

### 4.2 PreparedDispatch 边界

流式执行只接受已经冻结的 `PreparedDispatch`。registry 和 Rust 管道不得在 attempt 开始后重新解析 Provider 显示名、模型目录、UI 表单或最新版 preset。自动 attempt 复用同一 WireRequest/context hash；需要改变任何语义字段时创建新的 logical request。

## 5. 解析器要求

### 5.1 增量安全

- 一个 transport batch 可以含多个 Provider 事件。
- 一个 JSON 对象可能跨 transport chunk，解析器必须保留 buffer。
- SSE data 中可能有空行、`[DONE]`、注释、心跳或非 JSON 文本。
- JSON 解析失败不能立即丢弃全部 buffer，应区分“不完整”和“确实无效”。

### 5.2 顺序

- 同一 request 的语义事件按接收顺序输出。
- 工具 args delta 必须在 completed 前应用。
- `done` 后到达的非诊断事件应被忽略并记录协议异常。
- 重试产生的新 HTTP 流必须继续同一逻辑 request 的序号，但记录 transport attempt。

### 5.3 未知事件

未知事件不能被自动当成 text。普通模式可记录事件类型计数，开发者追踪模式保存原始片段。若未知事件可能影响终态、工具或文本，应产生可见兼容性警告。

## 6. 思考内容语义

客户端只展示 Provider 实际返回的内容：

- `reasoning_content`、`thinking`、reasoning summary 或等价字段。
- API 返回的结构化 reasoning layout。
- 搜索查询、工具卡片、rollout/agent 状态和结果。

客户端不得：

- 根据最终回答反推并补写思考过程。
- 把普通 token 等待动画称为真实思考内容。
- 把 Provider 的“推理摘要”标成“完整内部思维链”。
- 在 Provider 没有返回持续时间时伪造精确远端推理耗时。

UI 推荐标签：

- Provider 返回可见 reasoning text：`思考内容`。
- Provider 明确称为 summary：`思考摘要`。
- 结构化搜索/工具：`搜索与工具过程`。
- 仅本地等待计时：`已等待 12 秒`，不称为模型内部思考时间。

## 7. Grok 搜索与多代理事件

codec/profile runtime 应尽可能规范化下列信息：

| 信息 | 示例字段 | 领域表示 |
|---|---|---|
| reasoning layout | effort、willThinkLong、rolloutIds | thinking metadata |
| 工具开始 | function call、tool usage card | `tool_call_started` |
| 搜索查询 | tool args 中的 query | tool call args |
| 搜索结果 | web/x search result list | `tool_result` + `source` |
| 来源 | title、url、preview、favicon、author、time | SourceEvent |
| 引用 | card id、citation id、URL、文本位置 | CitationEvent |
| 多代理 | rollout id、agent id、状态、当前活动项 | AgentStatusEvent |
| Provider response | response id、previous response id | metadata / request snapshot |
| 思考区间 | isThinking true/false 或明确 start/end | thinking timing |

不要把模型名称推断出的“16 个 agent”当成真实运行数量。只有 Provider 返回可关联的代理/rollout 信息时，UI 才显示具体数量；否则显示“多代理模式”或 Provider 原始描述。

## 8. SourceEvent

```ts
type SourceEvent = {
  id: string
  kind: 'web' | 'x_post' | 'file' | 'database' | 'other'
  title?: string
  url?: string
  preview?: string
  favicon?: string
  authorName?: string
  authorHandle?: string
  publishedAt?: string
  toolCallId?: string
  providerMeta?: Record<string, unknown>
}
```

### 8.1 去重

优先使用 Provider source/card id；否则使用规范化 URL + 标题哈希。去重不能丢掉不同工具调用中的关联信息，应允许一个 source 被多个 toolCallId 引用。

### 8.2 链接交互

- Web URL 通过系统浏览器打开，本地附件使用应用内部定位。
- UI 显示实际域名，不能用标题隐藏完全不同的目的 URL。

## 9. 流式 reducer

Reducer 必须是确定性的：给定相同初始状态和事件序列，得到相同消息块。

主要规则：

- 相同 `blockId` 的 text/thinking delta 追加到同一块。
- thinking 和 final text 不混进同一块。
- 工具调用通过 call id 更新，不能按数组最后一项猜测。
- tool result 到达时关闭对应 running 状态。
- source/citation 可以先于或晚于最终文本到达。
- done 冻结 duration、usage 和 finish reason。
- error 保存已收到内容并转为 failed，不清空历史。
- cancel 保存部分块并转为 interrupted。

## 10. UI 状态

### 10.1 连接中

显示低干扰 loading 状态。超过合理时间没有首个事件时，显示“仍在连接”与停止按钮，不弹阻塞 alert。

### 10.2 思考中

- 展示实时计时和最近事件。
- 默认可展开，用户可以折叠但不停止采集。
- 多代理时显示稳定尺寸的头像/标识区域，避免事件数量改变布局。

### 10.3 搜索中

- 工具条目显示 pending/running/succeeded/failed。
- 搜索 query、结果数量和信源逐步出现。
- 结果完成后保留历史，不把整个区域替换成一行摘要。

### 10.4 回答中

思考结束不等于请求结束。最终文本可以开始后仍收到引用或 usage，状态机应允许这些尾部事件。

### 10.5 完成后

- 折叠标题显示实际可得的时长，例如 `思考了 42 秒`。
- 可打开右侧详情面板查看完整时间线和来源。
- 页面重新加载后保持相同结构和顺序。

## 11. 计时

至少记录：

- request started at。
- 每个 request attempt started/completed at。
- retry scheduled at、delay source 和实际等待时长。
- first transport byte at。
- first semantic event at。
- reasoning start/end at。
- first text delta at。
- completed/failed/cancelled at。

由这些时间可以计算 attempt 级连接/首包耗时、logical request 总等待、TTFT、思考区间、输出区间和总耗时。若 Provider 给出远端时间，单独保存并标明来源，不覆盖本地测量。

## 12. 心跳与空闲超时

- Rust 或应用层应能发出本地 heartbeat，证明进程仍在等流。
- 心跳不是 Provider 内容，不写入消息正文。
- 空闲超时应根据请求类型可配置，长推理模型不能使用普通聊天的过短阈值。
- 只有在尚未收到 response id/anchor、reasoning、tool、search、source、citation、text 或其他 Provider 接受信号时，自动从头重试才进入候选。
- 已收到有价值事件后发生断流，默认保留部分内容并提示用户，不自动从头重试造成重复计费、文本或工具调用。
- codec/profile 具有经过验证的 server-side resume/查询能力时，可以恢复同一远端响应；这与从头重发不同。
- 429 和临时错误的等待、次数、full jitter、总预算及取消规则以自动重试功能规格为准。

## 13. 取消

取消流程：

1. UI 立即把按钮切换为 cancelling，避免重复点击。
2. 调用 `sse_cancel(requestId)`。
3. Rust 触发 cancellation token 并关闭读取。
4. 前端等待 cancel/done 竞态收敛到唯一 `interrupted` 终态。
5. 持久化已经收到的块、时间和用量。
6. 清理计时器、parser buffer、Channel 回调和 store 中的 active request。

取消后不得把部分消息标记为 `done`，也不得留下永远闪烁的光标。

## 14. 恢复与重连

MVP 不要求进程重启后恢复远端正在运行的普通 SSE，但必须恢复本地一致性：

- 启动时把遗留 `streaming`/`pending`/`waiting_retry` 标记为 `interrupted`。
- 保存已落库的部分块。
- 允许用户从该节点重试或继续新分支。

如果某端点支持 response id 查询或 server-side recovery，可作为 codec/profile 能力后续增加，不能成为核心消息一致性的前提。

## 15. 原始事件追踪

普通模式默认只持久化规范化块和必要 Provider metadata。开发者模式可以启用原始事件追踪：

- JSONL 或等价可流式格式。
- 按 request id 分组。
- 有大小上限、文件轮换和保留期。
- 用户可以单独删除。
- 追踪内容、认证字段和导出范围由后续安全与隐私专题决定，不作为流式协议验收门禁。

## 16. 测试矩阵

- SSE 一个事件拆成多个 byte chunk。
- 一个 chunk 包含多个 JSON/SSE 事件。
- `[DONE]` 与 finish reason 顺序差异。
- reasoning 与 text 交错。
- 工具 args 分片和多个并行 call id。
- tool result 先后顺序、失败、取消和缺失。
- source/citation 在 text 前、期间和之后到达。
- 多代理/rollout 事件重复、乱序 metadata 和未知字段。
- 连接超时、首字节超时、流空闲超时和用户取消。
- 429 `Retry-After`、5xx、waiting_retry 倒计时和 attempt 切换。
- 自动 attempt 前后 context/body hash 不变。
- response id 或任一语义事件出现后断流不自动从头重发。
- 已有内容后断流不会自动清空或重复发送。
- reducer 重放相同事件得到相同持久化块。
- 页面重载后展示与流式完成时一致。
- 会话/路由切换和消息组件卸载不会触发 `sse_cancel`，请求仍能终态持久化。
- 返回仍在生成的会话时先获得 registry 当前快照，再无缝接收新事件；没有 registry 时回退 SQLite。
- 一个 subscriber 抛错或被移除时，其他 subscriber 和持久化仍收到唯一终态。
- conversation active status、assistant message status 和 attempt status 的转换分别验证，不从任一状态猜测另一状态。

## 17. 发布阻断条件

- 最终文本正常，但 reasoning/tool/source 事件被无提示丢弃。
- 工具结果在 UI 中出现但没有持久化。
- 多个 tool call 依赖数组位置配对。
- 取消可能落成 success。
- 解析错误被转换为空答案。
- Provider 未返回思考内容时 UI 声称显示了完整思考链。
- React 页面卸载或路由切换会隐式取消仍应继续的请求。
- UI subscriber 异常导致终态未持久化或其他 subscriber 收不到事件。
