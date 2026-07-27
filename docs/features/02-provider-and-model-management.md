# Provider、端点与模型管理

## 状态

- 里程碑：MVP
- 当前状态：`specified`
- 核心依赖：连接/端点数据模型、协议 profile、参数/能力/工具 schema、RequestSnapshot、RetryPolicy

## 用户问题

用户可能通过 NewAPI、企业网关、本地服务或其他中转访问模型。不同端口可能暴露不同协议；Gemini、Claude、Grok 或其他模型名称也可能走 OpenAI Chat、Responses、Anthropic Messages 或自定义兼容接口。客户端不能从公司或模型名称硬推断请求格式和全部参数。

## 目标

- 添加、编辑、启用、禁用和删除连接分组。
- 每个连接配置多个独立端点，包括 Base URL、显式端口、路径、方法、认证、Header、Query 和 timeout。
- 每个端点选择或 fork 一个协议 profile。
- 拉取远程模型，也可手工添加任意 model id。
- 配置完整 capability、参数 schema、工具 descriptor、响应映射和原始覆盖。
- 使用官方 preset 提供建议，同时允许用户编辑任意 key/path/value。
- 内置 preset 支持 tracked override 与 detached fork，两者的更新和所有权语义明确可见。
- 显示最终请求和参数兼容状态。

## 非目标

- 不为每个厂商建立独立且封闭的设置页。
- 不保证远程模型目录元数据正确或完整。
- 不用模型名自动选择“最佳”协议和参数。
- 不自动下载或执行任意代码型 codec；自定义协议优先使用声明式 JSON/SSE profile。
- 安全和凭据存储方案当前 `deferred`。

## 模型支持分层

- 当前主流且进入内置目录的模型属于主动支持：维护官方来源、preset、兼容证据和发布回归测试。
- 非主流模型只有在仍具不可替代能力或存在已确认真实需求时，才通过明确决定进入特殊支持。
- 其他旧模型、手工添加模型和中转站 alias 属于尽力兼容：允许配置、发送和探测，初始兼容状态为 `unknown`，不预建专用 UI、逐型号规则或发布门禁。
- 历史参数案例可以保留为协议行为证据，但不能据此扩大主动支持清单。
- 尽力兼容不允许静默删字段、改值或更换模型；失败时仍显示实际请求和原始错误。

## 配置流程

1. 创建连接分组并填写显示名；厂商提示可选。
2. 添加端点，填写完整 URL 或 scheme/host/port/path。
3. 选择协议 profile，例如 OpenAI Chat、Responses、Anthropic Messages、Gemini 原生或自定义 JSON/SSE。
4. 配置认证绑定、Header、Query、timeout 和重试。
5. 运行 URL/协议最小连接测试。
6. 拉取模型或手工添加 model id。
7. 导入官方建议 schema、fork 现有 profile，或从空配置开始。
8. 选择继续跟踪 preset revision，或脱离为完全用户所有的 fork。
9. 查看最终请求预览并保存。

失败时保留所有输入，显示最终 URL、端口、protocol profile、HTTP 状态和结构化错误。

## 参数与能力编辑

- 普通视图按“生成、推理、输出、工具、状态/缓存、Provider 特有”分组。
- 每项同时显示友好标签、实际 wire path、placement、启用状态和来源。
- “努力程度/思考预算”等 tooltip 可以列出官方常见写法，但用户决定实际字段。
- 枚举始终允许自定义值；数值允许输入官方建议范围之外的值并显示提示。
- capability 的 `unknown` 不等于不支持。
- raw Body/Header/Query 覆盖优先级最高，冲突时显示来源。
- tracked preset 显示 base revision、override 字段和可用更新；detached fork 明确显示不会接收内置更新。

## 协议与工具

- endpoint profile 决定 messages/input/contents、stream event、tool call/result 和 continuation wire format。
- Provider 名称、模型名称和图标不参与协议选择。
- Provider 内置工具、function tools 和 MCP 工具分组展示。
- `off | auto | required` 只是 UI 意图，最终 descriptor 和 tool choice 可编辑。
- profile 无法解析未知事件时保留原始片段并显示 parse error。

## 不支持参数体验

- 每个 endpoint + model + parameter 单独记录 `unknown`、`accepted_effective`、`accepted_ignored`、`rejected` 或 `translated`。
- 用户可以运行最小参数探测；连接测试成功不能替代参数探测。
- Provider 拒绝参数时不自动删字段重试。
- 无法证明参数产生效果时不能标记为 `accepted_effective`。
- 中转站、端口、API 版本或 model alias 变化后，旧探测结果标记可能过期。

## UI

### 连接列表

显示名称、端点数量、最近使用端点和启用状态。厂商只作为可选视觉提示。

### 端点工作台

显示最终 `host:port`、path、method、protocol profile、模型数量和最近测试结果。支持复制、fork、排序和禁用。

### 模型列表

显示 model id、显示名、端点、protocol profile、能力来源、schema revision 和状态。相同 model id 在不同端点可共存。

### 高级编辑

参数表单、能力、内置工具、schema、raw request 和响应映射分 tab。复杂 JSON 使用专用编辑器并提供格式化、定位和最终 diff。

## 数据

连接、端点、协议 profile、模型、能力、参数和工具配置进入 SQLite。凭据的最终存储方式由后续安全专题决定，不在本功能当前验收中锁定。

## 错误与边界

- 远程 models endpoint 不存在：允许手工添加。
- Base URL 正常化不得删除自定义路径和显式端口。
- 切换协议 profile 可能与历史工具/anchor 不兼容，需提示新分支。
- endpoint 不支持 required：可以保留用户自定义 mapping，不由模型名禁用。
- schema 无效：定位到具体 path。
- 参数被官方标记不支持：显示建议和证据，但允许用户覆盖中转站差异。
- 参数被拒绝：保留原值和错误，不静默降级。

## 测试

- 同一连接多个端口和混合协议。
- Gemini 名称 + OpenAI profile、Claude 名称 + Responses profile。
- 手工未知模型和空白 profile。
- 自定义 effort/reasoningEffort/thinkingBudget 任意 path。
- temperature/top_p/top_k/输出限制/工具/结构化输出全量 schema round trip。
- ignored/rejected/unknown compatibility 状态。
- profile fork 和官方 revision 更新不覆盖用户版本。
- tracked preset 更新只改变未覆盖字段，冲突/删除/改名有 diff；detached fork 保持不变。
- 请求预览、RequestSnapshot 和 mock server 使用同一个冻结 PreparedDispatch/WireRequest。
- 最终 URL、Header、Query、Body、工具 descriptor 和响应 mapping 预览。
- 临时错误重试不改变参数、端点、profile、ContextManifest 或 body hash。

## 验收标准

- 普通用户能用 preset 完成一个端点和首个模型配置。
- 高级用户能在同一连接中建立多个端口、多个协议和完全自定义 wire mapping。
- 未知模型不依赖应用升级即可发送。
- 参数显示语义不会决定实际 key/path。
- 用户能在 tracked 与 detached 模式间通过预览明确转换，不发生静默重置或重新附着。
- 至少验证一个报错参数、一个静默忽略参数和一个未知参数，客户端行为与记录一致。
- 未进入主动支持或特殊支持范围的模型不会增加发布阻断，但其通用透传、错误展示和手工探测仍可使用。
