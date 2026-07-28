# 官方 API、模型能力与参数兼容矩阵

## 1. 文档定位

本文件定义 Eternal Chat 如何持续跟进主流官方文档，并把最新模型、协议、端点、参数、工具、流式事件和错误行为转成可编辑 preset。它不是永久能力白名单，也不允许用模型公司名称决定最终请求。

- 最近核对日期：2026-07-28
- 状态：`in_progress`；Phase 6 request catalog/preset/golden fixture 已验证，完整响应/流式目录与非 OpenAI 网络 parser 继续按后续阶段实现
- 当前重点：OpenAI、ChatGPT 产品、Claude/Anthropic、Grok/xAI、Gemini/Google
- 配置原则：官方建议优先用于预填，用户 wire 配置优先用于发送

## 2. 项目级官方入口

以下入口从设计、实现、测试到发布都要持续参考：

| 体系 | 官方入口 | 权威范围 |
|---|---|---|
| Claude / Anthropic | <https://platform.claude.com/docs/zh-CN/get-started> | Claude API、模型、Messages、thinking/effort、工具、流式、错误、迁移 |
| OpenAI API | <https://developers.openai.com/api/docs> | OpenAI API、Models、Responses、Chat Completions、工具、参数、事件、错误 |
| ChatGPT 产品 | <https://learn.chatgpt.com/docs> | ChatGPT、Codex 等产品能力和交互参考；不替代 API wire reference |
| Grok / xAI | <https://docs.x.ai/overview> | Grok 模型、Responses/Chat、reasoning、搜索、工具、流式和兼容行为 |
| Gemini / Google | <https://ai.google.dev/gemini-api/docs> | Gemini 模型、generateContent/Interactions、thinking、工具、流式和错误 |

每次实现新模型、新能力、新工具或新参数，只读取相关官方章节即可，不要求完整遍历所有文档。但以下时机必须重新核对：

- 新增或更新内置 preset。
- 支持新的 model alias/snapshot/API version。
- 用户报告参数无效、被忽略或报错。
- 发布候选生成前。
- 官方 deprecation、release notes 或 API reference 发生变化。

## 3. 完整字段目录契约

每个内置 endpoint preset 必须维护完整字段目录，而不是只记录客户端当前有专用控件的字段。

```ts
type OfficialFieldRecord = {
  endpoint: string
  apiVersion?: string
  location: 'path' | 'query' | 'header' | 'body' | 'response' | 'stream_event'
  path: string
  semanticLabel: string
  type: string
  required: boolean
  default?: unknown
  values?: unknown[]
  modelScope?: string[]
  conditions?: string[]
  deprecated?: boolean
  replacement?: string
  unsupportedBehavior?: 'unknown' | 'ignored' | 'error' | 'translated'
  sourceUrl: string
  checkedAt: string
  revision: number
}
```

规则：

- 官方 reference 中出现的请求字段必须进入目录，即使它只显示在高级模式。
- 客户端没有专用控件时，自动生成类型合适的高级字段；仍无法表达时，raw Body/Header/Query 必须可达。
- 响应字段和流式事件同样进入目录，以便解析 usage、reasoning、tool、citation、finish reason 和错误。
- 模型页可以显示已知支持范围，但不能把未列出等同于不支持。
- 模型 ID 推断只能建议 preset，不能自动改变用户 wire path。

## 4. 协议和兼容端点

| Protocol profile | 常见请求主体 | 常见流式 | 工具交换 | 说明 |
|---|---|---|---|---|
| OpenAI Chat Completions | `messages` | SSE `choices[].delta` | assistant `tool_calls` + `role=tool` | 可被大量中转站和非 OpenAI 模型实现 |
| OpenAI Responses | `input` / items | 类型化 SSE events | function call/output items、hosted tools | OpenAI 与 xAI 等兼容实现可能有扩展和子集 |
| Anthropic Messages | `messages` + content blocks | 类型化 SSE events | `tool_use` + `tool_result` | 可由第三方兼容端点承载，不只用于 Claude |
| Gemini generateContent | `contents` + `generationConfig` | generateContent stream | `functionCall` + `functionResponse` | REST 与 SDK 命名可能不同，按 wire profile 区分 |
| Gemini Interactions | `input` | 类型化 interaction events | interaction tool items | 与 generateContent 不能混用字段路径 |
| Custom JSON / SSE | 用户声明 | 用户声明 | 用户声明 | 用于私有网关和目录未覆盖的协议 |

Provider 显示身份与上述 profile 没有一一对应关系。一个名为 Gemini 的模型使用 OpenAI profile、一个 Claude 中转使用 Responses profile，都是合法配置。

## 5. 全量参数与能力目录

内置目录至少按以下分组跟踪每个 endpoint/model 的官方字段。这里列的是语义类别和常见 wire 名，不代表统一映射。

### 5.1 请求与输出基础

- model、input/messages/contents、instructions/system/developer。
- stream、stream options、background、batch、deferred。
- max tokens、max completion tokens、max output tokens、输出长度/verbosity。
- modalities、audio/image/video/file 输入输出配置。
- stop/stop sequences、n/candidates、response count。

### 5.2 采样与概率

- `temperature`、`top_p`、`top_k`、`min_p`。
- frequency/presence/repetition penalty。
- seed、logit bias、logprobs、top logprobs。
- Provider 特有采样字段。

### 5.3 推理与思考

- `reasoning_effort`、`reasoning.effort`、`reasoningEffort`。
- `reasoning.mode`、reasoning context、summary/include。
- `output_config.effort`。
- `thinking` adaptive/enabled/disabled、`budget_tokens`。
- `thinkingLevel`、`thinkingBudget`、`includeThoughts`。
- encrypted/opaque reasoning、thought signature、thinking signature 和跨轮 continuation。

### 5.4 结构化输出

- JSON mode、JSON Schema、response format、output config format。
- strict function schema、grammar、regex/enum 限制。
- structured output 与 tool call、stream、reasoning 的组合限制。

### 5.5 工具与搜索

- function/tool definitions、tool choice、parallel tool calls、最大工具轮次。
- OpenAI `web_search`、file search、code interpreter、computer use 等。
- xAI `web_search`、`x_search`、remote MCP 和其他内置工具。
- Gemini Google Search、URL context、code execution、file search 等。
- Anthropic 版本化 web search/web fetch/code execution/tool search 等 server tools。
- 每个工具的 descriptor 版本、参数、结果块、citation 和计费/usage 字段。

### 5.6 状态、缓存与调度

- previous response/conversation、store、continuation anchor。
- prompt cache key、cache retention、cached content。
- service tier、priority/flex、latency preference、timeout。
- metadata/user/safety identifier 等 Provider 特有字段。

### 5.7 安全/策略型模型参数

本项目的产品安全专题虽然 `deferred`，但 API 自身的 safety setting、moderation option、blocked reason、refusal 和 policy-related finish reason 仍属于协议字段，必须按官方格式解析和允许配置。

## 6. UI 语义与 wire mapping

UI 可以稳定显示：

- 温度。
- Top P / Top K / Min P。
- 最大输出。
- 努力程度 / 思考预算。
- 思考摘要。
- 结构化输出。
- 工具选择与并行工具。

hover tooltip 可以展示常见官方写法和来源，例如：

```text
努力程度 / 思考预算
OpenAI REST: reasoning.effort 或 reasoning_effort
xAI SDK / REST: agent_count、reasoning.effort、reasoning_effort
Anthropic: output_config.effort 或 thinking.budget_tokens
Gemini: thinkingLevel、thinkingBudget、generation_config.thinking_level
```

这些提示只帮助用户理解，不能触发公司识别或自动改名。实际字段由当前 `ProtocolProfile + ParameterDefinition` 决定。

## 7. 当前思考控制矩阵

本表同时保留当前映射和少量用于说明迁移行为的历史字段。历史字段出现在矩阵中，只表示客户端的数据模型必须能够表达或诊断它，不表示对应模型自动进入主动支持范围；每个发布周期的主动支持和特殊支持清单遵循 [模型支持范围](./BASELINE_AND_DECISIONS.md#331-模型支持范围)。

| API / endpoint | 常见官方 wire path | 形式 | 设计规则 |
|---|---|---|---|
| OpenAI Responses | `reasoning.effort` | 值依模型可包含 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` | 值域和默认值按模型记录，不设跨模型白名单 |
| OpenAI Chat Completions | `reasoning_effort` | 值依模型 | 与 Responses profile 分离 |
| OpenAI Responses 新模式 | `reasoning.mode` | 例如 `standard` / `pro` | 与 effort 独立控件，不合并语义 |
| xAI Responses / REST | `reasoning.effort` 等 | 依模型和 endpoint | 不能把 Chat 与 Responses 文档混用 |
| xAI multi-agent | effort 或 agent count 映射 | 可能对应代理数量 | UI 标明真实语义和 endpoint 限制 |
| Anthropic adaptive thinking | `thinking: {type: "adaptive"}` + `output_config.effort` | 模式 + effort | 按模型表记录支持范围；不能把 adaptive 与 legacy budget 混发 |
| Anthropic extended thinking | `thinking: {type: "enabled", budget_tokens: N}` | token 预算 | 默认作为历史兼容证据；Claude 4.6 已弃用但仍接受，Claude 4.7+ 明确拒绝并返回 400，较早模型可能只支持该模式 |
| Gemini 3 generateContent | `generationConfig.thinkingConfig.thinkingLevel` | 档位 | 不与 2.5 budget 混用 |
| Gemini 2.5 generateContent | `generationConfig.thinkingConfig.thinkingBudget` | 数值预算 | 默认作为历史兼容证据；部分模型可关闭，部分不可关闭 |
| Gemini Interactions | `generation_config.thinking_level` | snake_case 档位 | 独立 profile |

## 8. 工具与跨轮状态

### OpenAI Responses

- Hosted tools、function call/output items 和 reasoning items 按 Responses 规则保存。
- 使用 function calling 时，相关 reasoning/function items 必须按官方规则续接。
- Chat Completions 的 `tool_calls` 不能直接当作 Responses item 使用。

### xAI

- 内置 web/X search、remote MCP、multi-agent 工具能力依模型和 endpoint 变化。
- multi-agent 等型号可能不支持 client-side/custom function tools或 Chat Completions。
- 加密 agent/reasoning state 与可见输出分开保存。

### Anthropic

- `tool_use` 与 `tool_result` ID 必须配对。
- thinking/signature block 按官方工具工作流原样续接。
- server tool 类型带版本，不能永久硬编码一个 web search 版本。

### Gemini

- `functionCall` 与 `functionResponse` 保持名称和关联语义。
- thought signatures 是跨轮状态，不等于可见 thought summary。
- generateContent 和 Interactions 的工具 descriptor 分开维护。

## 9. 不支持参数会怎样

结论：没有统一答案，必须按 endpoint + model + API version 记录。

### 9.1 兼容事实不等于主动支持承诺

Eternal Chat 不为所有历史模型预建兼容矩阵。当前主流模型进入主动支持范围；仍有不可替代能力或明确真实需求的非主流模型可以进入特殊支持；其他旧模型、自定义模型和中转站 alias 采用尽力兼容，初始状态为 `unknown`。

本节中的 Claude legacy thinking、Gemini 2.5 thinking budget 等例子用于证明“不支持字段可能报错、忽略、兼容接受或转换”，而不是要求项目继续维护这些历史型号。未进入主动支持或特殊支持范围的组合不需要专用 preset、UI 分支或发布回归测试，但用户仍可配置、发送并执行最小探测。

| 官方体系 | 已确认行为 | 设计影响 |
|---|---|---|
| Anthropic | 请求格式/内容问题返回 400 `invalid_request_error`；Claude 4.7+ 收到 `thinking: {type: "enabled"}` 会返回 400，较早的 extended-thinking-only 模型收到 `type: "adaptive"` 也会返回 400 | 不能假设忽略；只为主动支持、特殊支持或实际探测过的组合保存拒绝结论 |
| xAI | 官方 reference 同时记录 silently ignored 字段、非 agentic 请求中 ignored 字段、仅为兼容保留字段和会直接 error 的不支持字段 | 主动支持、特殊支持或实际探测过的字段按 endpoint/model 分别记录，不能按“xAI 模型”统一推断 |
| Gemini | 使用新 API version 的功能配旧 endpoint 可得到 400 `INVALID_ARGUMENT`；Gemini 3 仍接受旧 `thinkingBudget` 作兼容，但官方警告可能产生非预期表现 | “接受”不等于“有效”；需要区分 accepted/ignored/effective |
| OpenAI | effort 值域和默认值依模型，API reference 还标记部分字段与特定模型不兼容；官方没有承诺统一忽略 | 未经证明时标记 `unknown`，按可能拒绝处理 |
| 中转站 | 可能校验、过滤、改名、转换或直接透传 | 同一 model id 在不同端点分别探测 |

### 9.2 xAI 的具体反例

当前官方资料可见：

- Grok 4.20+ 的部分 `logprobs` / `top_logprobs` 字段会被静默忽略。
- xAI Responses 的 `max_turns` 在非 agentic 请求中会被忽略。
- xAI Responses 的 `metadata` 被标记为“不支持，仅为兼容保留”。
- Chat reference 明确说明 `reasoning_effort` 在 `grok-4` 上不支持，使用会报错；其他模型的支持范围另行记录。

因此客户端不能提供一个全局“自动删除所有不支持字段”选项作为默认行为。它会掩盖用户配置错误，也可能误删中转站实际支持的扩展。

### 9.3 参数探测状态

每个字段记录：

```text
unknown
accepted_effective
accepted_ignored
rejected
translated
```

只有响应、usage、结构化结果或官方资料能证明字段产生效果时，才标记 `accepted_effective`。HTTP 200 本身只证明请求被接受。

### 9.4 Phase 6 实现边界

- 内置 endpoint request catalog 已从字符串列表升级为 `OfficialFieldRecord`，记录 endpoint、API version、location、path、type、required、unsupported behavior、source URL、checkedAt 和 revision；没有专用控件的字段仍可通过高级 schema/raw override 设置。
- OpenAI Chat/Responses、xAI Grok、Gemini generateContent/Interactions、Anthropic Messages 保持各自 endpoint、reasoning/thinking path 和工具 descriptor，不做跨协议字段翻译。Gemini/Anthropic 本轮只验证 schema 与 golden fixture，实际网络 parser 属于 Phase 9。
- compatibility probe 只对已实现网络 codec 的 OpenAI Chat/Responses 开放。一次成功请求形成 `unknown` 证据；明确 4xx 可形成 `rejected`；临时 5xx/网络失败保持 `unknown`。`accepted_effective`、`accepted_ignored` 和 `translated` 必须继续依赖可审计的独立证据。

## 10. 官方来源明细

### OpenAI

- <https://developers.openai.com/api/docs>
- <https://developers.openai.com/api/docs/guides/reasoning>
- <https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create>
- <https://developers.openai.com/api/docs/guides/tools-web-search>
- <https://learn.chatgpt.com/docs>

### Anthropic

- <https://platform.claude.com/docs/zh-CN/get-started>
- <https://platform.claude.com/docs/en/api/errors>
- <https://platform.claude.com/docs/en/api/messages/create>
- <https://platform.claude.com/docs/en/build-with-claude/effort>
- <https://platform.claude.com/docs/en/build-with-claude/thinking>
- <https://platform.claude.com/docs/en/build-with-claude/extended-thinking>
- <https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting>
- <https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows>

### xAI

- <https://docs.x.ai/overview>
- <https://docs.x.ai/developers/models>
- <https://docs.x.ai/developers/rest-api-reference/inference/chat>
- <https://docs.x.ai/developers/model-capabilities/text/reasoning>
- <https://docs.x.ai/developers/model-capabilities/text/multi-agent>
- <https://docs.x.ai/developers/tools/overview>
- <https://docs.x.ai/llms.txt>

### Google Gemini

- <https://ai.google.dev/gemini-api/docs>
- <https://ai.google.dev/gemini-api/docs/generate-content/thinking>
- <https://ai.google.dev/gemini-api/docs/thinking>
- <https://ai.google.dev/gemini-api/docs/function-calling>
- <https://ai.google.dev/gemini-api/docs/google-search>
- <https://ai.google.dev/gemini-api/docs/troubleshooting>

## 11. 必须存在的测试

- 每个已支持 endpoint 的官方 request fields 有目录覆盖率报告。
- 没有专用控件的字段仍可从高级 schema 或 raw override 设置。
- 同一品牌模型切换不同 protocol profile 时 wire format 完全由 profile 决定。
- Chat/Responses/Messages/generateContent/Interactions 的请求、工具和事件字段不混用。
- 参数 `unknown`、`accepted_effective`、`accepted_ignored`、`rejected`、`translated` 状态测试。
- 通用 fixture 覆盖静默忽略、直接拒绝、兼容接受、转换和 API version/endpoint 不匹配；主动支持或特殊支持模型再增加对应的当前官方 fixture。
- Claude legacy thinking、Gemini 2.5 thinking budget 等历史专用 fixture 不是发布门禁，除非对应模型被明确列入特殊支持范围。
- Provider 拒绝参数时不自动删字段重试。
- 官方 preset revision 更新不覆盖用户 fork。
- 来源 URL、checkedAt、适用 endpoint/model/API version 可追踪。

## 12. 验收标准

- 用户无需等待应用更新即可添加目录外模型、参数、工具和自定义协议映射。
- 主动支持和特殊支持的内置 preset 覆盖其适用的当前官方 API reference 请求字段，缺少专用 UI 的字段仍可编辑。
- 任一模型品牌都不会强制绑定协议、端点或字段命名。
- 请求预览、实际 wire fixture、兼容状态和来源记录一致。
- 不支持参数不会被默认静默删除，也不会被统一误判为忽略或报错。
- 每次发布可明确列出官方资料核对日期、更新的 preset revision 和尚未验证的字段。
