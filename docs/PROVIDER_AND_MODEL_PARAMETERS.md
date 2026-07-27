# Provider、端点、协议与模型参数规范

## 1. 目标

Provider 层必须同时满足两类用户：普通用户可以用官方 preset 快速完成配置，高级用户可以控制任意中转站、端口、协议、端点、模型能力、参数名、参数路径、工具格式和响应映射。

核心原则：

1. Provider 名称和模型品牌不决定协议。
2. 一个中转站可以有多个端口和多个端点，每个端点可以使用不同协议。
3. 内置 preset 只提供可编辑建议，不能成为能力白名单。
4. UI 语义标签与实际 wire key/path 分离。
5. 未知模型、未知字段、未知枚举和未知工具默认允许配置。
6. 不支持参数的行为必须通过官方资料或端点探测记录，不能假设会被忽略。

## 2. 五层配置模型

```text
ProviderConnection  用户命名的中转站、账号或连接分组
  -> EndpointConfig  实际 URL、端口、路径、认证和协议选择
    -> ProtocolProfile  请求/响应/流式/工具的 wire 规则
      -> ModelConfig  某个端点上的实际 model id 与能力覆盖
        -> ConversationOverride  当前会话的参数、工具和原始覆盖
```

“Claude 中转”“Gemini 账号”“OpenAI 兼容站”都只是显示名称或 `vendorHint`。它们不能自动锁定 `ProtocolProfile`。

## 3. ProviderConnection

```ts
type ProviderConnection = {
  id: string
  name: string
  vendorHint?: string
  description?: string
  endpointIds: string[]
  enabled: boolean
}
```

- `vendorHint` 只用于图标、文档建议和筛选，可以为空或任意文本。
- 一个连接可以拥有多个端点，例如 `主站 :443 Responses`、`实验站 :8443 Chat Completions`、`内网 :9000 Anthropic Messages`。
- 同一个远程模型可以在多个端点中分别配置，不强制共享能力或参数结论。

## 4. EndpointConfig

```ts
type EndpointConfig = {
  id: string
  connectionId: string
  name: string
  baseUrl: string
  port?: number
  pathTemplate: string
  method: 'POST' | 'GET' | 'PUT' | 'PATCH' | string
  protocolProfileId: string
  authBindings: AuthBinding[]
  headers: Record<string, string>
  query: Record<string, string>
  bodyDefaults?: Record<string, unknown>
  timeoutMs?: number
  retryPolicy?: RetryPolicy
  enabled: boolean
}
```

### 4.1 URL 与端口

- UI 同时支持直接输入完整 Base URL，以及“scheme / host / port / base path”的结构化编辑方式。
- `baseUrl` 中已经存在显式端口时必须原样保留；结构化 `port` 只在用户明确设置时覆盖。
- URL 正常化只能去除首尾空白和确定冗余，不得删除自定义路径、端口、反向代理前缀或版本段。
- `pathTemplate` 可包含受控变量，例如 `{model}`、`{apiVersion}`、`{deployment}`；变量值来自当前端点或模型配置。
- 请求预览必须显示最终完整 URL，端口不能只藏在 Base URL 文本中。

### 4.2 认证绑定

```ts
type AuthBinding = {
  placement: 'header' | 'query' | 'body' | 'none'
  name?: string
  prefix?: string
  valueRef?: string
  literalValue?: string
}
```

- 认证方式不使用 `bearer | x-api-key | query_key` 封闭枚举锁死；preset 可以预填，用户可以编辑字段名、前缀和位置。
- API Key、token 或其他凭据如何持久化属于后续安全专题，当前规范只要求请求构造能引用配置值。
- 一个端点可以组合多个认证绑定，例如 Header token + Query project id。

### 4.3 端点与厂商解耦

以下都必须合法：

- 名为 Gemini 的模型通过 OpenAI Chat Completions 中转。
- 名为 Claude 的模型通过 OpenAI Responses 中转。
- 任意模型通过 Anthropic Messages 兼容口。
- 同一中转站在 `:443` 提供 Responses，在 `:8443` 提供 Chat Completions。
- 用户从空白 JSON/SSE profile 开始配置私有协议。

## 5. ProtocolProfile

ProtocolProfile 描述 wire format，不描述模型品牌。

```ts
type ProtocolProfile = {
  id: string
  name: string
  codec:
    | 'openai_chat_completions'
    | 'openai_responses'
    | 'anthropic_messages'
    | 'gemini_generate_content'
    | 'gemini_interactions'
    | 'custom_json'
    | 'custom_json_sse'
  request: RequestWireMapping
  response: ResponseWireMapping
  tools: ToolWireMapping
  continuation?: ContinuationMapping
  source?: SourceMetadata
  presetBinding?: PresetBinding
  userEdited: boolean
  revision: number
}
```

```ts
type PresetBinding =
  | {
      mode: 'tracked'
      presetId: string
      baseRevision: number
      overridePatch: Record<string, unknown>
    }
  | {
      mode: 'detached'
      forkedFromPresetId?: string
      forkedFromRevision?: number
    }
```

`userEdited` 只用于快速显示，不能替代 `presetBinding` 的所有权语义。

### 5.1 RequestWireMapping

至少可以描述：

- model id 放在 path、query、header 或 body 的哪个位置。
- system/developer/user/assistant 消息如何编码。
- 多模态 part、附件和文件引用如何编码。
- `stream`、输出上限、结构化输出、缓存、服务档位等基础字段。
- 参数 schema 写入 body/header/query/path 的位置。
- 工具列表、工具选择、并行工具、函数结果和内置工具 descriptor。
- endpoint 固定字段和用户原始覆盖。

### 5.2 ResponseWireMapping

至少可以描述：

- 非流式文本、思考摘要、工具调用、来源、usage、finish reason 和 response id 路径。
- SSE/JSONL/WebSocket 事件类型字段和增量内容路径。
- 多段 JSON、一个 data 内多个事件、空 keepalive 和终止事件。
- Provider HTTP 200 内嵌错误的结构化路径。
- 未识别事件的保留方式。

### 5.3 ToolWireMapping

至少可以描述：

- function/tool 定义的名称、描述、输入 schema 和 strict 字段。
- `tool_choice` 的 none/auto/required/指定工具表达方式。
- 并行工具调用开关。
- assistant tool call 与 tool result 的角色、block、ID 和排序要求。
- Provider 内置工具和客户端工具的不同 descriptor。
- 跨轮需要保留的 signature、encrypted content、reasoning item 或 thought signature。

### 5.4 内置 codec 与自定义 profile

- 内置 codec 负责可靠处理常见协议状态机和边界。
- 用户 fork 内置 profile 后可以覆盖字段路径、descriptor、事件映射和默认值。
- `custom_json` / `custom_json_sse` 使用声明式映射，不要求用户编写应用代码。
- 如果自定义映射不足以表达某协议，应显示明确限制并允许新增 codec；不能假装已兼容后静默丢字段。

## 6. ModelConfig

```ts
type ModelConfig = {
  id: string
  endpointId: string
  modelId: string
  displayName: string
  capabilities: CapabilityProfile
  paramsSchema: ParameterDefinition[]
  builtInTools: BuiltInToolDefinition[]
  extraBody?: Record<string, unknown>
  extraHeaders?: Record<string, string>
  extraQuery?: Record<string, string>
  protocolProfileOverrideId?: string
  contextWindow?: number
  maxOutputTokens?: number
  enabled: boolean
}
```

`modelId` 是实际 wire 值，`displayName` 和 `vendorHint` 只用于 UI。一个模型可以覆盖端点默认 protocol profile，但切换时必须显示历史序列化和 continuation 影响。

## 7. 全量能力模型

能力不是布尔白名单，而是可编辑、带来源和验证状态的数据。

```ts
type CapabilityState = 'unknown' | 'reported' | 'verified' | 'rejected'

type CapabilityEntry<T = unknown> = {
  state: CapabilityState
  value?: T
  source?: SourceMetadata
  userEdited: boolean
}

type CapabilityProfile = {
  inputModalities: CapabilityEntry<string[]>
  outputModalities: CapabilityEntry<string[]>
  streaming: CapabilityEntry
  reasoning: CapabilityEntry
  visibleReasoning: CapabilityEntry
  structuredOutput: CapabilityEntry
  functionTools: CapabilityEntry
  parallelTools: CapabilityEntry
  builtInTools: CapabilityEntry<string[]>
  remoteMcp: CapabilityEntry
  citations: CapabilityEntry
  logprobs: CapabilityEntry
  promptCaching: CapabilityEntry
  serverState: CapabilityEntry
  background: CapabilityEntry
  batch: CapabilityEntry
  usageBreakdown: CapabilityEntry
  custom: Record<string, CapabilityEntry>
}
```

能力目录至少覆盖：

- 文本、图片、音频、视频、文件和多模态输入/输出。
- 普通流式、结构化事件、WebSocket、后台任务和 Batch。
- reasoning/thinking 的开关、档位、预算、模式、摘要和跨轮状态。
- JSON mode、JSON Schema、grammar、strict function schema。
- function calling、并行调用、指定工具、内置搜索、代码执行、文件检索、浏览器、remote MCP。
- citations、annotations、search sources、usage、reasoning token、cache token。
- logprobs、seed、stop、penalties、service tier、priority/flex、prompt cache 和 continuation anchor。

目录中没有的能力放入 `custom`，不能因客户端尚无专用图标而丢失。

## 8. ParameterDefinition

```ts
type ParameterDefinition = {
  id: string
  label: string
  semanticHint?:
    | 'temperature'
    | 'top_p'
    | 'top_k'
    | 'min_p'
    | 'max_output'
    | 'reasoning_effort'
    | 'thinking_budget'
    | 'verbosity'
    | 'custom'
  description?: string
  examples?: string[]
  placement: 'body' | 'header' | 'query' | 'path'
  path: string
  type: 'boolean' | 'integer' | 'number' | 'string' | 'select' | 'json'
  control?: 'toggle' | 'stepper' | 'slider' | 'select' | 'text' | 'json'
  default?: unknown
  options?: Array<{ label: string; value: unknown; note?: string }>
  allowCustomValue: boolean
  min?: number
  max?: number
  step?: number
  omitWhen?: 'undefined' | 'nullish' | 'default' | 'disabled'
  enabledByDefault?: boolean
  source?: SourceMetadata
  compatibility?: ParameterCompatibility
  advanced?: boolean
}
```

### 8.1 语义提示不等于 wire 识别

例如 UI 可以显示“努力程度 / 思考预算”，tooltip 列出常见官方写法：

```text
effort
reasoning_effort
reasoning.effort
reasoningEffort
output_config.effort
thinkingLevel
thinkingBudget
```

但客户端不得因此自动选择其中任何一个。真正发送哪个字段，只看当前 `ParameterDefinition.placement + path`。用户甚至可以把该控件映射到 `custom.deep.reasoningEffort`。

### 8.2 常见参数类别

内置 preset 应在官方支持时覆盖，但不局限于：

- 采样：`temperature`、`top_p`、`top_k`、`min_p`、典型采样扩展。
- 惩罚与确定性：presence/frequency/repetition penalty、seed、stop。
- 输出：max tokens/output tokens、verbosity、modalities、audio/image/video 配置。
- 推理：effort、mode、thinking level、thinking budget、summary、include thoughts、context persistence。
- 结构化输出：response format、JSON schema、strict、grammar。
- 工具：tools、tool choice、parallel tool calls、最大工具轮次、内置工具参数。
- 可观测性：logprobs、top logprobs、usage include、stream options。
- 状态与缓存：store、previous response/conversation id、cache key、cache retention。
- 调度：service tier、priority、background、batch、timeout。
- Provider 特有字段和用户任意自定义字段。

### 8.3 自定义值

- 枚举使用 select 时必须同时提供“自定义值”。
- 数值可以突破 preset 建议范围，但 UI 应显示“超出已知官方范围”，不直接改值。
- 用户可以禁用单个参数，使其完全不出现在请求中。
- schema 更新不能覆盖用户修改，除非用户主动选择 merge 或 reset。

## 9. BuiltInToolDefinition

```ts
type BuiltInToolDefinition = {
  id: string
  label: string
  modeOptions: string[]
  descriptor: Record<string, unknown>
  choiceMapping?: Record<string, unknown>
  paramsSchema: ParameterDefinition[]
  resultMapping?: ResponseWireMapping
  source?: SourceMetadata
  compatibility?: ParameterCompatibility
  userEdited: boolean
}
```

- Provider 内置工具、客户端 function 工具和 MCP 工具分组展示。
- `off | auto | required` 是常见 UI 意图，不是所有协议的固定 wire 值；映射完全可编辑。
- 用户可以添加官方目录没有的工具类型、版本化 descriptor 和自定义参数。
- 请求预览必须展示最终工具列表、tool choice、descriptor、字段来源和协议 profile。

## 10. 配置合并

```text
ProtocolProfile 基础请求
  -> Endpoint body/header/query defaults
  -> Model schema 表单值
  -> Model extra body/header/query
  -> Conversation schema 值
  -> Conversation raw overrides
```

后层优先级更高。

- 对象递归合并。
- 数组整体替换，除非该字段的 schema 明确声明自定义合并策略。
- `undefined` 不写入；`null` 是否省略由定义决定。
- 不做 snake_case/camelCase 自动猜测。
- Header 合并大小写不敏感，Body/Query/path 大小写按 wire 原样处理。
- 最终请求预览必须能逐字段显示值、来源、覆盖关系和 omit 原因。

### 10.1 有序请求装配管线

请求装配必须通过一个可测试的纯函数管线完成，不在 React 组件、Zustand action 或 Rust 中分散追加字段：

```text
resolve connection / endpoint / profile / model
  -> project tracked preset or detached fork
  -> assemble and serialize canonical context
  -> resolve enabled capabilities and tools
  -> apply ordered protocol transforms
  -> merge endpoint/model/conversation/raw parameter layers
  -> validate final URL/Header/Query/Body and build preview
  -> freeze WireRequest + RequestSnapshot as PreparedDispatch
```

- 每个阶段接收同一份只读 `RequestAssemblyScope` 或前一阶段的新结果，不允许原地修改共享 scope。
- transform 顺序是协议契约，必须有稳定名称、显式顺序和针对顺序的测试；不得依赖对象遍历、import 顺序或组件挂载顺序。
- 自定义字段仍按配置层级合并，transform 不能以“兼容”为由删除未知字段。
- 请求预览、RequestSnapshot 和真实发送都必须使用最后冻结的同一 WireRequest，不再分别重建。
- 管线可以吸收 Cherry `params-pipeline` 的纯函数和有序贡献思想，但不引入会吞未知字段的 SDK 参数白名单或大型 feature registry。

## 11. 官方 preset 与来源生命周期

```ts
type SourceMetadata = {
  sourceUrl: string
  checkedAt: string
  revision: number
  appliesTo?: {
    endpoint?: string
    models?: string[]
    apiVersion?: string
  }
}
```

官方入口见 [文档中心](./README.md#持续权威来源)。规则：

- 官方文档决定新的内置建议，不决定用户最终配置。
- 每次增加模型、参数、工具或 endpoint preset 前读取相关官方章节。
- 发布前复核活跃 preset；超过一个发布周期未核对时标记“资料可能过期”。
- 官方更新产生新 revision，不原地篡改用户配置；tracked binding 只更新未被覆盖字段，detached fork 完全不自动合并。
- ChatGPT 产品文档用于交互与能力参考，API wire 事实仍以 OpenAI API 文档为准。

### 11.1 preset 跟踪与脱离

内置 endpoint、protocol、model、parameter 和 tool preset 都使用不可变 revision。用户编辑时明确选择两种模式：

| 模式 | 存储 | 更新行为 | 适用场景 |
|---|---|---|---|
| `tracked` | `presetId + baseRevision + overridePatch` | 新 revision 到来时，未覆盖字段采用新默认；已覆盖字段保持用户值 | 仍希望获得官方字段、说明和修复更新 |
| `detached` | 完整用户配置，可保留来源只作审计 | 不自动合并任何后续 revision | 私有网关、重度修改或需要完全稳定的配置 |

规则：

- runtime 对外提供一个合并后的完整实体，消费者不应分别请求 preset metadata 和用户数据再自行拼接。
- tracked preset 更新前显示 diff：新增、删除、改名、默认值变化、与 override 冲突和待迁移字段。冲突时保持用户值并要求明确处理。
- 用户可以 reset 单字段、reset 全部覆盖、切换为 detached fork；detached 重新跟踪 preset 必须经过预览，不能静默附着。
- preset 被删除时保留用户 override 和最后可用 base snapshot，标记 orphaned；不得因目录更新让已有 endpoint/model 无法打开。
- `sourceUrl`、`checkedAt`、base revision、当前 revision 和用户 override 来源在 UI/导出中可追踪。

### 11.2 模型支持分层

内置目录和发布测试不追求覆盖所有历史型号，具体范围遵循 [基线与决策治理](./BASELINE_AND_DECISIONS.md#331-模型支持范围)：

- 当前主流模型进入主动支持范围，维护官方来源、preset、兼容证据和回归测试。
- 只有仍具不可替代能力或存在已确认真实需求的非主流模型，才通过明确决定进入特殊支持范围。
- 其他旧模型、目录外模型、自定义模型和中转站 alias 均为尽力兼容：允许用户配置、透传和探测，初始状态为 `unknown`，但不预建逐型号兼容规则。

尽力兼容不是静默降级。客户端仍必须保留用户字段、展示最终请求和原始错误；只是不会为了未进入支持范围的历史组合增加专用控件、默认映射和发布阻断测试。

## 12. 不支持参数的真实行为

```ts
type ParameterCompatibility = {
  status:
    | 'unknown'
    | 'accepted_effective'
    | 'accepted_ignored'
    | 'rejected'
    | 'translated'
  evidence?: 'official_doc' | 'probe' | 'user_override'
  checkedAt?: string
  note?: string
}
```

### 12.1 不能统一推断

以下案例用于证明 wire 行为不能全局推断，不表示对应历史模型都属于 Eternal Chat 的主动支持范围：

官方资料已经证明至少存在四类行为：

| 行为 | 官方示例 |
|---|---|
| 直接拒绝 | Anthropic 明确记录 Claude 4.7+ 使用 legacy `thinking.type=enabled` 会返回 HTTP 400 `invalid_request_error`，extended-thinking-only 模型使用 adaptive 也会返回 400 |
| 静默忽略 | xAI 文档明确说明 Grok 4.20+ 的部分 `logprobs` 字段会被 silently ignored |
| 条件忽略 | xAI `max_turns` 在非 agentic 请求中会被忽略 |
| 兼容接受但语义不可靠 | Gemini 3 仍接受旧 `thinkingBudget` 以保持兼容，但官方警告可能产生非预期表现 |

OpenAI 官方文档说明 reasoning effort 值域依模型而异，且部分字段与某些模型不兼容；官方文档没有给出“所有不兼容字段都会被忽略”的承诺。因此客户端必须按可能拒绝处理，不能自行删字段后重试。

Claude legacy thinking 和 Gemini 2.5 thinking budget 默认只保留为协议行为证据。除非后续被列入特殊支持范围，否则不为这些历史组合维护专用 preset、UI 分支或逐版本发布门禁。

### 12.2 端点探测

连接测试成功不能证明全部参数有效。高级测试应允许用户选择一个参数或工具执行最小探测：

1. 保存完整 endpoint/model/protocol/profile revision。
2. 发送带目标字段的最小请求。
3. 记录 HTTP 状态、结构化错误代码和响应是否可观察到效果。
4. 结果标记为 accepted/rejected/ignored/unknown；无法证明效果时不能标记 `accepted_effective`。
5. 中转站升级、模型 alias 变化或 profile revision 变化后，旧结果标记为可能过期。

客户端不得通过比较模型公司名称来批量继承探测结果。同一个 model id 在不同中转站、端口、端点和 API 版本上分别记录。

## 13. 请求预览与错误

请求预览至少显示：

- 最终 URL、显式端口、方法、协议 profile 和 revision。
- Header、Query、Body 与 path variables。
- 参数实际 key/path/value、来源和兼容状态。
- 工具 descriptor、tool choice 和工具结果协议。
- 上下文 manifest 与 continuation 策略。

错误处理：

| 情况 | 行为 |
|---|---|
| 参数不支持或值无效 | 显示原字段、端点错误和请求预览，不自动删字段 |
| 参数可能被忽略 | 标记未验证，不伪装成已生效 |
| 中转站转换字段 | 只有官方资料或可重复探测证明后标记 `translated` |
| 远程模型目录失败 | 保留本地模型和手工配置 |
| profile 无法表达响应 | 保留原始事件和明确 parse error，不吞掉未知内容 |
| 临时网络错误 | RetryPolicy 可以重试，但参数、模型、profile 和 body hash 不变 |

任何自动降级都必须由用户显式启用，并在 RequestSnapshot 中记录前后差异；默认关闭。

## 14. UI 要求

- Provider 页面先显示连接分组，再显示该连接下的端点和端口。
- 端点卡片显示最终 host:port、协议 profile、路径和最近探测结果。
- 模型页面不以厂商分组锁死能力；主要按连接/端点/profile 展示。
- 参数面板显示友好语义、实际 wire path、启用状态、来源和兼容状态。
- hover tooltip 可以解释官方常见命名，但不能触发自动改写。
- 提供表单、schema、raw request 和响应映射四个层级；用户可以从任一层进入。
- 所有复杂 JSON 编辑器提供格式化、语法定位、字段来源和最终请求 diff。

## 15. 必须存在的测试

- 同一连接的两个不同端口分别使用 Chat Completions 与 Anthropic Messages。
- 名为 Gemini 的模型通过 OpenAI Responses profile 成功构造请求。
- endpoint/profile/model 名称变化不改变 wire format。
- 用户把“努力程度”映射为任意自定义 key/path 后，请求按该 path 发送。
- 请求装配阶段顺序固定、scope 不可变，预览/snapshot/mock server 捕获到同一个冻结 WireRequest。
- tracked preset 更新时保留 override 并接收未覆盖字段更新；detached fork 在内置 revision 更新后保持逐字段不变。
- preset 删除、字段改名和重新跟踪都经过可预览迁移，不产生无法打开的 orphan 配置。
- temperature、top_p、top_k、effort、budget、structured output、tools 等 schema 均能添加、禁用、覆盖和删除。
- 未知模型、未知参数、未知枚举和未知工具不被 schema-strip。
- 参数 compatibility 的 rejected/ignored/unknown 不互相混淆。
- Provider 拒绝参数时不自动删除或降级；自动重试不改变请求。
- 主动支持和特殊支持模型拥有对应官方 preset fixture；尽力兼容模型只要求通用透传、错误展示和用户触发探测成立。
- 工具调用/结果能通过 OpenAI Chat、Responses、Anthropic、Gemini 和自定义 fixture 回放。
- 官方 preset revision 更新不覆盖用户 fork。
- 最终 URL 保留显式端口、反向代理路径和 API 版本。

## 16. 验收标准

Provider/模型管理标记为 `verified` 前，必须完成一个混合中转场景：同一连接配置至少两个不同端口和两种协议；添加目录外模型；自定义能力、参数 key/path、工具 descriptor 和响应映射；通过请求预览和 mock server 证明最终 wire 内容；模拟一个参数报错、一个参数被忽略和一个未知行为，并保证客户端不做厂商硬识别或静默降级。
