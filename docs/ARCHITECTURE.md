# 总体架构

## 1. 架构目标

Eternal Chat 的架构服务于四个目标：

1. Provider、参数、上下文和 UI 的快速迭代全部留在 TypeScript。
2. 跨域请求、取消、超时和 SSE 合批由小型 Rust 管道统一处理；认证字段在进入管道前已经完成最终装配。
3. 历史消息、工具结果和请求快照具有可验证的数据链路。
4. 核心聊天保持轻量，知识库、MCP、同步等后续能力按模块装载。

## 2. 运行时边界

```text
┌──────────────────────── WebView / TypeScript ────────────────────────┐
│ React UI                                                            │
│  ├─ 会话库 / 聊天 / 连接、端点与模型 / 设置 / 按需右侧面板           │
│  └─ 虚拟列表 / Markdown / 思考搜索轨迹 / 上下文检查器                 │
│                                                                     │
│ Application                                                         │
│  ├─ use cases: send / stop / regenerate / edit / branch / export    │
│  ├─ dispatch preparer: input -> immutable PreparedDispatch           │
│  ├─ active request registry: execution ownership + UI subscriptions  │
│  ├─ retry coordinator: logical request -> bounded attempts           │
│  ├─ context assembler: 当前分支 -> 规范消息块 -> Provider 输入        │
│  ├─ stream reducer: 原始事件 -> 统一事件 -> streaming state          │
│  └─ feature registry: 核心与可选模块                                │
│                                                                     │
│ Domain                                                              │
│  ├─ Conversation / Message / Block / ToolExchange / RequestSnapshot │
│  └─ Connection / Endpoint / ProtocolProfile / Model / StreamEvent    │
│                                                                     │
│ Infrastructure                                                      │
│  ├─ protocol codecs / profile runtime / serializers / parsers       │
│  ├─ SQLite repositories / migrations / FTS                          │
│  ├─ Tauri IPC client / attachment storage                           │
│  └─ logging / diagnostics / import-export                           │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ invoke + Channel
┌──────────────────────────────┴──── Rust / Tauri ────────────────────┐
│ pipeline.rs: final request + HTTP/SSE + 30ms batch + cancel          │
│ lib.rs: plugin/command registration                                 │
└─────────────────────────────────────────────────────────────────────┘
```

Rust 不解析 OpenAI、Anthropic、Gemini、Grok、thinking、tool call、citation、认证类型或参数语义。任何 Provider/协议特有行为进入 Rust 都视为架构回归。

## 3. 建议目录结构

脚手架建立后，建议使用以下最小结构。目录是职责边界，不要求为每个文件预建空壳。

```text
src/
├── app/
│   ├── App.tsx
│   ├── routes.tsx
│   └── featureRegistry.ts
├── components/
│   ├── ui/                    # shadcn/ui 生成和本地定制组件
│   └── shared/                # 跨功能的轻量展示组件
├── domain/
│   ├── chat/
│   ├── provider/
│   └── settings/
├── features/
│   ├── conversations/
│   ├── chat/
│   ├── providers/
│   ├── models/
│   ├── settings/
│   └── diagnostics/
├── application/
│   ├── chat/
│   ├── context/
│   └── importExport/
├── infrastructure/
│   ├── db/
│   ├── providers/
│   ├── streaming/
│   ├── tauri/
│   └── files/
├── stores/
│   ├── chatHistoryStore.ts
│   ├── chatStreamingStore.ts
│   └── uiStore.ts
├── styles/
└── test/
    ├── fixtures/
    ├── mockServer/
    └── seed/

src-tauri/
└── src/
    ├── pipeline.rs
    └── lib.rs
```

## 4. 依赖方向

```text
UI/features -> application -> domain
                    |
                    v
              infrastructure -> Tauri IPC / SQLite / filesystem / network
```

规则：

- `domain` 不导入 React、Tauri、SQLite、Zustand 或 Provider SDK。
- `application` 编排用例，但不直接操作 DOM。
- `infrastructure` 实现端口和序列化，不决定产品策略。
- React 组件不直接拼 Provider 请求体，不直接执行散落 SQL。
- Zustand store 不成为所有业务逻辑的容器。可测试的 reducer、serializer 和 use case 应保持纯函数或独立服务。
- Protocol codec/profile runtime 不能读取 UI 组件状态，应接收完整的请求快照。

## 5. 核心领域对象

### 5.1 Conversation

保存标题、当前模型、系统提示词、会话参数、会话级 `extra_body`、当前分支叶节点和归档状态。

### 5.2 Message

属于一个会话，具有角色、块数组、状态、父消息、模型引用、用量和时间。消息是持久化与分支的基本单位。

### 5.3 MessageBlock

保存文本、思考、工具交换、引用、附件、错误和 Provider 元数据。块是 UI 展示和 Provider 序列化之间的共同语义层。

### 5.4 PreparedDispatch

`PreparedDispatch` 是发送准备阶段的不可变结果，包含 logical request、会话、user message、assistant placeholder、RequestSnapshot、最终 WireRequest、parser/profile revision 和执行所需引用。准备阶段可以读取数据库和配置，但不得启动网络；一旦返回，后续执行不能再从 React 状态、当前 Provider 显示名或可变 preset 重新解析请求。

### 5.5 RequestSnapshot

记录一个 logical request 实际采用的连接、端点、协议 profile revision、模型、参数、上下文清单、最终 URL/Body 哈希、RetryPolicy、codec 版本、起止时间和终止原因。自动重试共享该 snapshot；用户手动重新生成创建新 snapshot 和 sibling。认证与请求明细的持久化范围属于后续安全专题，当前不作为架构门禁。

### 5.6 RequestAttempt

记录 logical request 的一次真实网络尝试，包括 attempt_no、transport request id、HTTP/Provider 错误、`Retry-After`、退避、首字节/首语义事件和终态。attempt 不得改变父 snapshot 的 context/body hash。

### 5.7 StreamEvent

Provider parser 输出的统一事件。事件进入 reducer 后形成当前流式消息，完成时再一次性转换为持久化 Message。

## 6. 发送一轮消息的端到端流程

```text
用户提交
  -> 校验当前连接/端点/profile/模型/输入
  -> 事务写入 user message + pending assistant placeholder
  -> 沿 parent_id 读取当前分支
  -> ContextAssembler 生成 CanonicalContext
  -> ContextPolicy 做预算检查，不静默裁剪
  -> ProtocolCodec.serializeContext(profile)
  -> 有序参数管线合并 endpoint/model/conversation/raw override
  -> 保存 RequestSnapshot(pending)
  -> 冻结 immutable PreparedDispatch
  -> ActiveRequestRegistry.start(prepared)
  -> 写入 initial RequestAttempt(running)
  -> RetryCoordinator 调用 Tauri invoke(sse_request)
  -> Rust 按最终 URL/Method/Header/Query/Body 发起单次 attempt
  -> Rust 30ms 合批回传原始 SSE data
  -> ProtocolCodec.parseEvent(profile) / classifyError
  -> StreamReducer 更新唯一 streaming 状态
  -> UI 只重绘流式消息和相关状态
  -> done/error/cancel
       |-> 满足重试条件: waiting_retry -> 新 RequestAttempt
       |-> 已有语义输出: 保留部分内容，不自动从头重发
  -> 持久化最终 blocks、usage、status、response anchor
  -> 完成 RequestSnapshot
```

用户消息和 assistant placeholder 必须在网络请求前进入同一事务或等价的可恢复操作。这样应用崩溃后可以识别并修复 `pending`，而不是丢失用户输入或制造重复发送。

### 6.1 准备与执行分离

`prepareDispatch` 与 `start` 是两个明确阶段：

- `prepareDispatch` 解析 endpoint/profile/model、构造上下文、应用参数管线、生成预览并持久化 pending snapshot；其结果可以使用假 repository 独立测试。
- `ActiveRequestRegistry.start` 是聊天请求的唯一执行入口。它注册 logical request、创建 attempt、接收 Rust Channel 事件并驱动 reducer/持久化。
- React 页面只能提交意图、订阅状态和发出显式 stop；组件不得持有 transport reader、直接调用 Rust 或在卸载时隐式取消请求。
- 自动重试复用同一 PreparedDispatch/RequestSnapshot；如果需要改变参数、上下文、端点或 profile，必须创建新的 logical request，而不是修改正在执行的对象。

这一设计吸收 Cherry Stream Manager 的“准备、执行、订阅、持久化分离”不变量，但保留 Eternal Chat 的 Tauri/Rust 单次 attempt 管道，不引入 Electron Main 或 Cherry 的 lifecycle/IoC 实现。

## 7. 上下文构造边界

ContextAssembler 只处理产品语义：

- 选择当前分支路径。
- 读取消息与块。
- 检查工具调用/结果配对。
- 应用用户明确选择的上下文策略。
- 生成与 Provider 无关的 `CanonicalContext` 和 `ContextManifest`。

Provider serializer 只处理协议差异：

- OpenAI Chat Completions 的 `assistant.tool_calls` + `role=tool`。
- OpenAI Responses 的 input/output item 或可靠的 `previous_response_id`。
- Anthropic 的 `tool_use` + `tool_result`。
- Gemini 的 `functionCall` + `functionResponse`。
- 各 Provider 对思考块、签名和缓存控制的要求。

这两层不得合并，否则上下文策略会被 Provider 条件分支污染，测试也无法判断是“选错历史”还是“序列化错误”。

## 8. 状态划分

### 8.1 持久历史

已完成、已中断或失败的消息来自 SQLite。React 组件按消息 ID 读取并 memo，不因流式 token 更新而整体重渲染。

### 8.2 当前流式状态

同一会话默认只允许一个主动 logical request，不同会话可以各自拥有 active request。应用根级 `ActiveRequestRegistry` 按 conversation/logical request 保存正在累积的块、事件序号、开始时间、最近事件时间、当前 attempt、重试倒计时、取消 token、订阅者和临时用量。attempt 之间不清空同一 placeholder；只有尚未出现 Provider 有价值事件时才允许自动进入下一 attempt。

切换会话、路由变化或消息组件卸载只解除 UI 订阅，不等同于 stop。只要应用进程仍运行，请求继续接收事件并在终态持久化；返回会话时从 registry 当前快照和 SQLite 检查点恢复展示。完整应用退出或 WebView 进程丢失仍按启动恢复规则标记 `interrupted`，MVP 不承诺跨进程续接普通 SSE。

### 8.3 三种状态不得混用

- conversation request status：该会话是否存在 `preparing/connecting/streaming/waiting_retry/cancelling` 的 active logical request。
- assistant message status：SQLite 中 placeholder 的 `pending/waiting_retry/streaming/done/interrupted/error`。
- request attempt status：单次网络尝试的 `scheduled/running/succeeded/failed/cancelled/skipped`。

一个 conversation 状态可以对应多个历史 message 和多个 attempts。UI 状态点不能被写回成消息事实；单个订阅者渲染失败也不能阻断其他订阅者、请求终态或持久化。

### 8.4 UI 状态

侧栏折叠、右侧面板、滚动跟随、选中 tab、展开块和临时输入属于 UI 状态，不写入消息历史。

### 8.5 长期设置

主题、语言、默认连接/端点/模型、界面个性化、性能选项和模块开关写入 store/plugin 或 SQLite preference。凭据是否以及如何持久化留给后续安全专题，当前架构只要求 `AuthBinding` 能参与最终请求装配。

## 9. IPC 契约

MVP Rust command 保持极少：

| Command | 输入 | 输出 |
|---|---|---|
| `start_stream` | transport request id、最终 URL、method、Header、Query、Body、单次 attempt 超时配置、Channel | `data` batch、`done`、`error` |
| `cancel_stream` | request id | 无或取消结果 |

TypeScript 的 `ProviderConnection + EndpointConfig + ProtocolProfile + ModelConfig + ConversationOverride` 负责得到最终请求。Rust 不接受 `providerId`、`vendorHint`、`authStyle` 或模型公司作为路由依据，也不补写、删除或改名任何业务字段。

Rust 每次只执行一个 attempt，不决定是否重试、重试哪些状态、等待多久或是否已经出现语义输出。RetryPolicy、错误分类和定时编排全部在 TypeScript 应用层，避免把 Provider 业务扩散进 Rust。

`DesktopBridge.startStream()` 的 Promise 表示 transport command 的完整生命周期：只有 terminal `PipeEvent` 已交付且 Rust 已完成资源清理后才 resolve；正常 `done` 和结构化 `error` 都通过 Channel 交付并 resolve，只有 IPC 或 Channel 自身失败才 reject。fake bridge 必须保持相同语义，不能在注册 listener 后立即 resolve。

## 10. 协议 profile 与 codec

协议 runtime 由可编辑 `ProtocolProfile` 和一个负责复杂状态机的 codec 组成。品牌名称不出现在类型判别中：

```ts
interface ProtocolCodec {
  codecId: string
  buildRequest(input: ProtocolRequestInput, profile: ProtocolProfile): WireRequest
  serializeContext(context: CanonicalContext, model: ModelConfig): unknown
  parseEvent(raw: string, state: ParserState, profile: ProtocolProfile): ParsedStreamEvent[]
  classifyError?(error: WireError): ProviderErrorClassification
  estimateContext?(context: CanonicalContext, model: ModelConfig): TokenEstimate
  validateProfile?(profile: ProtocolProfile): ValidationIssue[]
}
```

内置 codec 可以是 `openai_chat_completions`、`openai_responses`、`anthropic_messages`、`gemini_generate_content`、`gemini_interactions` 或通用 JSON/SSE codec，但它们只描述 wire format，不描述模型归属。用户可以 fork profile、修改 mapping，或在通用 codec 上从空白 profile 开始。

`buildRequest` 可以组合 serializer 的结果，但不得重新选择历史消息。`parseEvent` 必须容忍一个 SSE data 中包含多个语义事件，也必须支持 JSON 被多批次切分时由上层保留 parser state。`classifyError` 只能根据结构化状态/代码做显式判断，不得扫描自然语言猜测是否重试。

## 11. 数据访问

- 所有 SQL 使用参数绑定。
- schema 变更只通过有序迁移执行。
- repository 返回领域对象，不向 UI 泄漏 SQLite 行结构。
- 打开会话只加载最近 50 条，向上滚动按稳定游标分页。
- 模型上下文读取可以按当前分支流式查询或分页合并，但语义上必须完整，不能复用 UI 的 300 条内存窗口作为截断条件。
- FTS 索引是派生数据，可以重建，不作为消息权威存储。

## 12. 流式生命周期

建议状态机：

```text
idle
  -> preparing
  -> connecting
  -> streaming
  -> completed
       |-> interrupted  (用户取消或应用关闭)
       |-> failed       (Provider/网络/解析/持久化失败)
```

终态必须恰好写入一次。Rust `done`、Provider finish reason、用户取消和前端异常可能竞争，应用层必须使用 request id 和终态锁避免重复 finalize。

## 13. 错误模型

错误至少分为：

| 类别 | 示例 | 用户处理 |
|---|---|---|
| `configuration` | Base URL、模型或 schema 无效 | 回到配置并保留输入 |
| `authentication` | 401、认证字段缺失 | 编辑 endpoint 的 AuthBinding 或认证值 |
| `request_rejected` | 参数不支持、上下文超限 | 查看最终请求并调整 |
| `network` | DNS、代理、连接超时 | 按 RetryPolicy 自动重试，否则检查网络 |
| `stream` | 空闲超时、协议中断、无终止事件 | 保留部分内容；已有语义输出时不自动从头重发 |
| `parse` | 未知事件格式 | 保存原始片段到开发者追踪并标记 profile 不兼容 |
| `tool` | 工具失败、结果缺失、ID 不匹配 | 显示失败，不伪装成功 |
| `storage` | SQLite 写入或迁移失败 | 停止破坏性操作并提供备份 |

错误对象应包含稳定代码、用户消息、技术细节、是否可重试、HTTP 状态、Provider 错误代码和 request id。技术细节默认折叠；内容保留和隐藏规则由后续安全专题决定。

## 14. 模块注册

核心模块固定为聊天、连接/端点/模型和设置。后续模块通过 `FeatureModule` 注册路由、设置、聊天动作、数据库迁移和生命周期钩子。

模块规则：

- 关闭时不注册路由、按钮、订阅和后台任务。
- 入口使用动态 import。
- 模块不能修改核心消息语义，只能新增有版本的块类型或工具定义。
- 模块迁移必须可重复执行，并在卸载后保留用户数据，除非用户明确删除。

## 15. Electron 退路

所有业务代码依赖一个很小的平台端口：

```ts
interface DesktopBridge {
  startStream(request: PipeRequest, onEvent: (event: PipeEvent) => void): Promise<void>
  cancelStream(requestId: string): Promise<void>
  openExternal(url: string): Promise<void>
  notifications: NotificationPort
}
```

Tauri 实现与未来 Electron 实现都满足该接口。React、Protocol codec、ContextAssembler、SQLite repository 接口和功能模块不得直接散落调用 `invoke`。

## 16. 架构验收

- 删除或替换 Rust 管道时，不需要修改 Protocol codec/profile 和 React 组件。
- 使用假 SQLite repository 和假 DesktopBridge 可以运行上下文、参数和流式 reducer 测试。
- 一个完整的工具交换从数据库读取后，可以分别序列化成 OpenAI Chat、Responses、Anthropic Messages、Gemini 和自定义 profile fixture。
- 同一个连接可以在不同显式端口绑定不同协议 profile，最终 URL、Header、Query 和 Body 均保持用户配置。
- 名为 Gemini 或 Claude 的模型可以通过 OpenAI profile 发送；更改显示名称或 `vendorHint` 不改变 wire format。
- 一个 logical request 的多个自动 attempts 具有相同 context/body hash，且不创建 sibling 或重复客户端工具。
- `prepareDispatch` 在不启动网络的情况下可验证完整 WireRequest；执行入口不重新读取可变 UI/preset 状态。
- 切换会话或卸载消息页面不会隐式取消 active request；返回后可看到持续进度或已持久化终态。
- conversation、assistant message 和 request attempt 状态不会互相冒充，单个 UI 订阅者失败不影响持久化。
- 流式 token 更新不会触发历史消息列表、侧栏和输入框的无关重渲染。
- 关闭所有可选模块后，核心聊天仍可构建和运行。
