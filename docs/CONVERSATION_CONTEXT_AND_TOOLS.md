# 对话上下文与工具连续性

## 1. 为什么这是核心规范

对话客户端最危险的错误不是显式报错，而是 UI 看起来保留了完整历史，模型下一轮却只收到助手最终文本。对于必须依赖前一步工具事实的任务，这会让模型在缺少原始证据时继续推理，并产生难以被用户发现的自信错误。

本规范将“工具结果跨轮连续性”定义为 P0 产品契约。任何 Provider、SDK、上下文优化或 UI 性能方案都不得绕过它。

## 2. 术语

| 术语 | 定义 |
|---|---|
| 持久化历史 | SQLite 中保存的会话、消息、块和关联数据 |
| UI 历史 | 当前为了渲染而加载到内存中的消息窗口 |
| 当前分支 | 从根消息沿 `parent_id` 到当前叶节点的唯一路径 |
| 规范上下文 | 与 Provider 无关、保留完整语义的 `CanonicalContext` |
| 线协议上下文 | Provider serializer 生成的实际 API message/input 结构 |
| 模型可见工具结果 | 工具在调用当轮实际提供给模型的文本或结构化内容 |
| 原始工具结果 | 工具返回的完整本地结果、文件或 JSON，可比模型可见内容更大 |
| ContextManifest | 记录本轮选入、排除或变换了哪些块及原因的清单 |
| Provider anchor | `previous_response_id`、session id 等由服务端保存上下文的续接标识 |

## 3. 不可违反的六条不变量

### 3.1 同一事实链

UI 展示、数据库保存和模型请求必须能追踪到同一组消息与块。允许展示格式不同，但不允许语义内容在无说明的情况下消失。

### 3.2 工具调用与结果成对回放

只要当前分支包含已完成工具交换，下一轮上下文必须包含 Provider 所需的工具调用和工具结果。不能只发送工具名称、UI 卡片标题或助手总结。

### 3.3 第一轮回答不是工具结果的替代品

即使助手在当轮回答中总结了工具结果，也不能因此删除工具结果。总结是模型生成内容，不是外部事实的等价副本。

### 3.4 UI 分页不影响模型上下文

UI 只加载最近 50 条、内存只保留约 300 条，是渲染优化。ContextAssembler 必须按当前分支从持久化层读取需要的历史，不能直接使用 UI store 中可见的消息数组作为权威输入。

### 3.5 不静默裁剪

默认不得因 token、消息数量、工具结果大小或客户端性能而静默删除历史。任何排除、摘要或降级都必须进入 ContextManifest，并由用户明确触发或确认。

### 3.6 无法可靠续接时显式失败

如果 Provider 只允许服务端 anchor 续接，而 anchor 已失效且客户端无法显式重建工具历史，不得退化为只发送最终文本。应显示“无法保证历史工具证据连续性”的可恢复错误。

## 4. 权威数据模型

当前数据规范将消息保存为块数组。工具交换在持久化层使用一个语义完整的 `tool_call` 块，并在块内保存结果：

```ts
type ToolCallBlock = {
  type: 'tool_call'
  id: string
  name: string
  args: unknown
  status: 'requested' | 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled'
  source: 'client' | 'mcp' | 'provider'
  startedAt?: number
  finishedAt?: number
  result?: {
    modelContent: ToolModelContent
    rawRef?: string
    rawHash?: string
    mimeType?: string
    truncatedAtSource?: boolean
    error?: ToolError
  }
  providerMeta?: Record<string, unknown>
}
```

`modelContent` 是最关键字段。它表示工具调用当轮真正交给模型的内容。后续轮次默认回放同一语义内容，不能重新从 UI 摘要生成。

### 4.1 modelContent 与 rawRef

| 情况 | `modelContent` | `rawRef` |
|---|---|---|
| 小型 JSON 查询 | 完整 JSON 或确定性文本表示 | 可选 |
| 网页搜索 | 实际提供给模型的结果列表、摘要和 URL | 可保存完整抓取结果 |
| 文件分析 | 提取文本、页码和元数据 | 指向原始文件或解析产物 |
| 图片 | Provider 所需 image block 或稳定附件引用 | 指向本地内容哈希文件 |
| 超大数据库结果 | 工具自身明确生成的分页/摘要结果 | 指向完整结果文件 |

如果工具在源头就只返回摘要，客户端不能声称保存了完整原始资料；应设置 `truncatedAtSource` 或等价元数据。

### 4.2 为什么不只保存 raw result

原始结果可能包含二进制、无法序列化对象、临时 URL 或远大于模型窗口的数据。后续回放必须复现模型当轮实际看到的内容，因此 `modelContent` 需要独立持久化。`rawRef` 用于审计、用户查看和后续重新处理，不自动等于模型上下文。

## 5. ContextAssembler 输入与输出

```ts
type ContextBuildInput = {
  conversationId: string
  anchorMessageId: string
  provider: ProviderConfig
  model: ModelConfig
  policy: ContextPolicy
}

type CanonicalContext = {
  system: CanonicalBlock[]
  turns: CanonicalTurn[]
  manifest: ContextManifest
  estimatedTokens?: number
}
```

ContextAssembler 不读取 React state，不调用 Provider API，也不拼最终 JSON 请求体。

## 6. 上下文构造流程

### Step 1: 确定 anchor

- 普通发送以新写入的 user message 为 anchor。
- 重新生成以目标 assistant 的父 user message 为 anchor，并创建新的 assistant sibling。
- 编辑历史 user message 后，从编辑后的新消息节点建立新分支，不覆盖原节点。
- 工具批准后继续时，以包含已更新工具状态的 assistant/tool exchange 节点为 anchor。

### Step 2: 读取当前分支

从 anchor 沿 `parent_id` 反向读取到 conversation 的无内容虚拟根，再排除虚拟根并按路径顺序排列。不能简单按 `created_at` 读取整个会话，也不能因为 parent 不在当前分页结果中就猜测已经到达首轮，否则会把其他分支混入上下文或提前截断路径。

### Step 3: 校验结构

至少检查：

- 消息 ID 唯一且没有 parent 环。
- 角色与块类型兼容。
- 每个工具调用 ID 在当前分支内可唯一识别。
- `succeeded` 工具有 `result.modelContent`。
- `failed` 工具有明确错误内容。
- Provider 需要的 thinking signature 或 opaque state 未丢失。

结构错误必须产生稳定错误代码，不能跳过坏块继续发送。

### Step 4: 生成规范 turn

将持久化 Message 映射为 Provider 无关的规范结构。工具交换仍保持成对语义，不在此时决定 OpenAI/Anthropic/Gemini 的角色形式。

### Step 5: 应用显式用户排除

用户可以在上下文检查器中主动排除某条消息或附件。排除动作必须：

- 只作用于当前请求或明确保存的会话策略。
- 在 manifest 中记录对象 ID、原因和操作者。
- 自动检查是否打断工具调用/结果配对。
- 不删除数据库原始数据。

### Step 6: 应用上下文策略

MVP 默认只有 `lossless`。后续可增加 `manual` 和 `summary_compaction`，但不得默认启用。

### Step 7: 预算预检

根据模型已知上下文窗口、codec/profile 估算器和输出预算计算风险。估算不确定时必须标记不确定性，不能通过删除历史“保证成功”。

### Step 8: 生成 ContextManifest

Manifest 至少包含：

```ts
type ContextManifestItem = {
  messageId: string
  blockIndex: number
  blockType: string
  contentHash: string
  decision: 'included' | 'excluded' | 'summarized' | 'provider_anchor'
  reason?: string
  toolCallId?: string
}
```

### Step 9: Provider serializer

将 CanonicalContext 转换为目标协议。serializer 不得丢弃它不认识的规范块后继续成功；应返回 `unsupported_block`，或在文档明确允许时转换成可见文本并在 manifest 标记。

### Step 10: 保存请求快照

在调用 Rust 前保存脱敏参数、manifest 和最终协议消息的稳定哈希。开发者模式可以保存脱敏的请求预览，但不得保存 Authorization 值。

### Step 11: 发送与事件关联

所有流式事件使用同一 request id、message id 和 Provider response id 关联，防止重试或切换会话时把事件写入错误消息。

### Step 12: 终态核对

完成时检查：

- 本轮使用的工具结果是否全部持久化。
- Provider anchor 是否保存。
- manifest 与 RequestSnapshot 是否完成。
- assistant placeholder 是否进入唯一终态。

## 7. Provider 序列化规则

### 7.1 OpenAI Chat Completions 兼容

一个客户端工具交换通常展开为：

```json
[
  {
    "role": "assistant",
    "tool_calls": [
      {
        "id": "call_123",
        "type": "function",
        "function": { "name": "search", "arguments": "{...}" }
      }
    ]
  },
  {
    "role": "tool",
    "tool_call_id": "call_123",
    "content": "模型当轮实际看到的工具结果"
  }
]
```

要求：

- `tool_call_id` 必须稳定复用。
- arguments 使用确定性 JSON 序列化。
- 工具失败也要回放错误结果，不能假装调用不存在。
- 多个工具调用保持原顺序和配对。

### 7.2 OpenAI Responses 兼容

codec/profile runtime 支持两种续接策略：

1. `explicit_items`：显式重建可接受的 input/output items。
2. `provider_anchor`：使用可靠的 `previous_response_id`。

每个 Provider/网关必须通过契约测试声明支持哪种策略。不能因为 OpenAI 官方端点支持 anchor，就假设所有 OpenAI 兼容中转都支持。

对于 reasoning model + function calling，官方 OpenAI 规则要求 continuation 保留上一轮相关 reasoning items、function call items 和 function call output items。使用 `explicit_items` 时，自上一个 user message 起的这些 items 必须原样、完整进入下一请求；不能只回放可见 assistant 文本。opaque/encrypted reasoning state 与可见 reasoning summary 分开保存。

如果使用 `provider_anchor`：

- 本地仍保存完整规范历史和事件，不把服务端状态作为唯一副本。
- RequestSnapshot 标记哪些历史由 anchor 承担。
- anchor 失效时只有经过测试的 `explicit_items` 可以回退。
- 禁止回退为 final-text-only。

### 7.3 Anthropic

工具调用映射为 assistant `tool_use`，结果映射为后续 user content 中的 `tool_result`。serializer 必须保持 `tool_use_id`，并按模型要求处理 thinking block 与 signature。

如果某个历史 thinking signature 对后续请求是必需的，它必须作为 opaque Provider metadata 保存，不能只保存 UI 可见文本。

### 7.4 Gemini

工具调用映射为 model `functionCall`，结果映射为 user `functionResponse`。连续同角色消息需要按 Gemini 约束合并或规范化，但不得跨越工具角色边界。Gemini thought signatures 属于推理连续性状态，必须按 endpoint 规则保留，不能用 `includeThoughts` 返回的可见 summary 替代。

### 7.5 Provider 执行的搜索工具

Grok 或其他端点可能在服务端执行 web search，并流式返回查询、结果、引用和 response id。codec/profile runtime 必须明确：

- 这些事件能否被显式重建为下一轮 input items。
- 是否必须使用 Provider anchor。
- 哪些事件只供 UI 展示，哪些是模型续接必需状态。
- anchor 不可用时的失败行为。

“Provider 搜索结果在 UI 中可见”本身不证明下一轮会继续看到它们。

自动重试 Provider continuation 时，已经完成并持久化的客户端工具不得再次执行；新 attempt 只能重发相同的 tool result 和上下文。Provider 内置搜索可能在服务端重复执行和计费，必须按 [自动重试规格](./features/16-automatic-retry.md) 的安全边界处理。

## 8. 上下文策略

### 8.1 `lossless`，MVP 默认

- 当前分支所有可序列化消息和工具结果进入请求。
- 不自动摘要，不按条数裁剪，不因 UI 窗口释放而改变。
- 如果预计超限，发送前暂停并展示处理选项。

### 8.2 `manual`，后续可选

用户逐项选择排除内容。系统帮助保持工具配对，并明确显示预计 token 变化。

### 8.3 `summary_compaction`，后续可选

- 仅用户明确启用。
- 摘要保存为新派生块，包含覆盖范围和来源 ID。
- 原始消息和工具结果仍保存在数据库中。
- 默认不压缩最近的未完成任务、工具结果和用户标记为“必须保留”的证据。
- UI 明确显示模型看到的是摘要而非原文。

### 8.4 禁止策略

- 固定保留最近 N 条然后丢弃更早内容。
- 只保留 user/assistant 文本并删除 tool role。
- 只保留工具结果的第一段或 UI 摘要。
- 在 Provider 报上下文超限后自动缩短并重试而不通知用户。
- 用助手上一轮最终回答代替工具输出。

## 9. 上下文超限 UX

当预算预检发现风险时，弹出的处理面板至少显示：

- 模型已知或推测的上下文上限。
- 当前估算输入、预留输出和不确定范围。
- 最大贡献项，例如超长工具结果、附件或历史回复。
- 可选操作：更换长上下文模型、手动排除、启用显式摘要策略、取消发送。

MVP 可以先只提供“更换模型、返回编辑、仍然尝试发送”三项，不得擅自选择其中任何一项。

## 10. 上下文检查器

开发者模式和高级用户模式应提供按本轮请求查看的上下文检查器：

- 消息和块的顺序。
- 每个块是否包含、排除、摘要或由 Provider anchor 承担。
- 工具调用和工具结果的配对状态。
- 模型可见工具内容预览。
- Provider serializer 生成的脱敏结构。
- 参数来源与最终值。
- 估算 token 和上下文风险。
- manifest hash 与 request id。

它不是普通用户必须理解的主界面，但必须足够清楚地证明“模型实际拿到了什么”。

## 11. 大型工具结果

大型结果不能通过客户端随机截断处理。允许的流程：

1. 工具自身返回分页、筛选或明确标注的模型可见摘要，同时保存 raw artifact。
2. 用户在发送前选择只纳入部分结果。
3. 后续摘要策略生成带来源范围的派生块。
4. 更换上下文窗口更大的模型。

任何截断都必须记录截断发生在工具源头、用户选择、摘要策略还是 Provider 限制。

## 12. 失败和恢复

| 失败 | 必须行为 |
|---|---|
| 工具调用有结果但落库失败 | 本轮不能标记完整成功；保留错误和可重试状态 |
| 工具 ID 不匹配 | 阻止下一轮发送，提示修复或排除损坏交换 |
| raw artifact 丢失但 modelContent 存在 | 可以继续回放 modelContent，同时标记原始证据缺失 |
| modelContent 丢失但 UI 卡片存在 | 不得发送；提示历史工具结果不可回放 |
| Provider anchor 失效 | 尝试经过验证的显式重建，否则失败 |
| serializer 不支持块类型 | 显式错误，不静默丢弃 |
| 上下文超限 | 显示处理选项，不静默重试缩短版 |
| 应用崩溃后有 pending 消息 | 启动恢复为 interrupted，并保留已持久化块 |

## 13. 必须存在的自动化测试

### 13.1 Canary 工具结果跨轮测试

1. 第一轮工具返回随机 canary，例如 `EVIDENCE_7f3a...` 和一个数值字段。
2. 第一轮助手 fixture 故意不在最终文本中复述 canary。
3. 第二轮用户询问该字段。
4. 捕获第二轮实际请求。
5. 断言请求包含与第一轮相同的 tool call id 和 modelContent。
6. 分别覆盖 OpenAI Chat、Anthropic、Gemini，以及支持的 Responses 续接模式。

### 13.2 UI 窗口独立测试

数据库创建 500 条消息，UI store 只加载最后 50 条。构造下一轮上下文时，断言早期被当前任务依赖的工具结果仍在规范上下文中。

### 13.3 分支隔离测试

同一 user message 下有两个 assistant sibling，每个分支调用不同工具。选择分支 A 时，请求不得包含分支 B 的工具结果。

### 13.4 不完整工具测试

历史中存在只有 tool call 没有 result 的交换。ContextAssembler 必须返回结构错误或按明确的 interrupted 规则处理，不能合并周围 user turn 后假装工具不存在。

### 13.5 Anchor 失效测试

模拟 `invalid_previous_response_id`。只有 codec/profile 声明并测试了显式重建时才允许回退；否则断言显示连续性错误，且没有 final-text-only 请求。

### 13.6 超限测试

创建超过模型窗口的工具结果，断言默认策略返回可见预检结果，没有自动删除任何 manifest item。

## 14. 发布阻断条件

以下任一情况存在时，核心聊天不得发布：

- 历史工具结果仅在调用当轮进入模型。
- UI 显示工具结果，但下一轮 RequestSnapshot 不包含它或可靠 anchor。
- 未知块会被 serializer 静默删除。
- UI 分页窗口被直接作为请求历史。
- SDK 默认 `ignoreIncompleteToolCalls` 等行为没有本项目自己的显式测试和产品策略。
- 上下文超限会触发无提示裁剪。
- Provider anchor 失效后会自动只发送助手文本。
