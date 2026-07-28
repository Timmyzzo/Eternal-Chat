# 自动重试与请求尝试

## 状态

- 里程碑：MVP
- 当前状态：`verified`
- 优先级：OpenAI 兼容基础聊天之后、动态参数与多 Provider 扩展之前
- 核心依赖：统一错误模型、RequestSnapshot、Rust 通用网络管道、可取消计时器

## 用户问题

用户主要通过 NewAPI 等 OpenAI Chat Completions / Responses 兼容中转站访问模型。中转站在高峰期可能出现 429、临时 5xx、连接失败或首包超时。如果每次都要求用户手动重新发送，不仅打断工作，也会让长推理和搜索任务很难稳定完成。

自动重试同时存在真实风险：上游可能已经接收甚至计费，只是客户端没有收到结果；已经出现部分文本或工具调用后从头重试，还可能产生重复文本、重复工具副作用和重复费用。因此本功能必须以“可审计、可取消、只在安全边界内自动执行”为前提。

## 目标

- 对明确的临时网络、限流和上游故障自动重试。
- 尊重 Provider 返回的 `Retry-After`，否则使用带 full jitter 的指数退避。
- 把一次用户发送建模为一个 logical request，下面可以有多个 request attempt。
- 每次尝试的原因、等待、状态、耗时和错误都可见、可持久化、可诊断。
- 自动重试保持相同上下文、参数和请求体，不受等待期间设置变化影响。
- 默认不在已经收到有价值输出后自动从头重发。
- 不重复执行已经完成的 MCP、本地函数或其他有副作用工具。

## 非目标

- 不保证任何请求“只计费一次”；兼容中转站可能在客户端断线前已经把请求交给上游。
- 不把参数错误、鉴权错误或模型不存在伪装成临时故障。
- 不自动删除被拒绝的参数，也不把 `xhigh` 降为 `high` 后重试。
- 不用提示词模拟 Provider 不支持的续传或幂等能力。
- 不在 MVP 实现跨进程恢复远端仍在运行的普通 SSE。
- 不把自动重试扩展成模型、账号或 Provider 自动切换；故障转移是后续独立功能。

## 术语

### Logical request

一次用户明确发送、继续工具流程或手动重新生成所创建的逻辑请求。它固定以下内容：

- user message / assistant placeholder 关联。
- connection、endpoint、protocol profile revision 和模型。
- ContextManifest 与 context hash。
- 最终 URL、脱敏 Header 结构、参数和请求 body hash。
- 本次生效的 RetryPolicy。

### Request attempt

logical request 的一次实际网络尝试。第 1 次为 initial attempt，后续为 automatic retry attempt。每次尝试拥有独立 transport request id、起止时间、HTTP/Provider 错误、`Retry-After`、字节数和终态。

### 手动重新生成

用户点击消息上的“重新生成”或失败后的“重试”。它允许用户先修改模型、参数或上下文，并创建新的 assistant sibling 和新的 logical request。它不属于旧 logical request 的 attempt。

## RetryPolicy

当前规范配置：

```ts
type RetryPolicy = {
  enabled: boolean
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  maxTotalElapsedMs: number
  retryableHttpStatuses: number[]
  retryableProviderCodes: string[]
  retryOnConnectionFailure: boolean
  retryOnConnectTimeout: boolean
  retryOnFirstByteTimeout: boolean
}
```

Phase 5A 已通过确定性本地 fixture、SQLite 集成和 UI 验收确认以下默认值；外部端点只作为补充证据，不替代错误与重试契约：

| 设置 | 当前默认值 | 说明 |
|---|---:|---|
| 启用 | 是 | 只对满足安全条件的失败生效 |
| `maxRetries` | 3 | 最多 4 次实际尝试 |
| `baseDelayMs` | 1000 | 无 `Retry-After` 时的初始退避基数 |
| `maxDelayMs` | 30000 | 单次退避上限 |
| `maxTotalElapsedMs` | 90000 | 包含尝试耗时、排队、退避和 `Retry-After` |
| HTTP 状态 | 408、429、500、502、503、504 | 默认可重试状态 |

配置层级为：应用默认 -> endpoint 覆盖。MVP 不增加模型级持久化重试配置，因为重试主要反映具体端点可靠性；当前请求的等待状态可以被用户停止。

## 可重试分类

### 默认可重试

- 临时连接建立失败、连接被重置或远端提前关闭。
- 连接超时。
- 尚未收到 Provider 接受信号时的首包超时。
- HTTP 408、429、500、502、503、504。
- HTTP 成功状态下、在任何有价值输出前，由特定 codec/profile 明确识别出的临时上游错误代码。

中转站可能用 HTTP 200 包裹错误对象。此时只有 codec/profile 或 endpoint 配置中经过测试的结构化规则可以把它分类为可重试错误，例如精确匹配顶层 `error.code`。不得通过搜索自然语言中的“busy”“try again”等词自动重试。

### 默认不可重试

- 400、401、403、404、422。
- URL、TLS 证书、代理或本地安全策略的确定性配置错误。
- 模型不存在、权限不足、余额不足、参数不支持、上下文超限。
- JSON/schema 构造错误、序列化错误和通常不会自行恢复的 parser 兼容错误。
- 用户取消。
- 已收到有价值输出后发生的普通断流。

其他状态默认不可重试，只有 endpoint 级显式规则和测试可以加入 allowlist。

## 安全重试边界

只有尚未观察到以下任一信号时，客户端才可以自动从头重试：

- Provider response id、server-side anchor 或等价“请求已接受”标识。
- reasoning/thinking 内容或摘要。
- 文本 delta。
- tool call、tool result、search、source、citation 或 agent event。
- Provider 表明已完成一部分工作的其他语义事件。

heartbeat、客户端本地计时和不代表 Provider 已接受请求的 transport metadata 不阻止重试。

一旦越过自动重试边界，默认行为是：保留已收到内容，终态记为 `interrupted` 或 `error`，显示手动重新生成入口。如果 codec/profile 具有经过 fixture 和真实端点验证的查询、resume 或 response anchor 恢复能力，可以恢复同一远端请求；它不能退化为静默从头重发。

## 退避算法

处理顺序：

1. 读取标准 `Retry-After`，同时支持秒数和 HTTP-date。
2. 若存在合法 `Retry-After`，至少等待该时长；等待超过剩余总预算时，不提前请求，而是结束为 `retry_budget_exhausted`。
3. 没有合法 `Retry-After` 时使用 full jitter：

```text
cap = min(maxDelayMs, baseDelayMs * 2 ^ retryIndex)
delay = random(0, cap)
```

4. 总预算从 initial attempt 开始计时，包含网络尝试、客户端排队、退避等待和 `Retry-After`。
5. 失败请求也可能消耗 Provider 限额，因此到达次数或总预算后必须停止，不能无限循环。

测试使用可注入时钟和确定性随机源，生产实现不得依赖不可控 sleep 造成脆弱测试。

## 请求不可变性

同一 logical request 的每次自动尝试必须满足：

- ContextManifest、context hash 和当前分支完全一致。
- connection、endpoint、protocol profile revision、模型、最终 URL 和参数一致。
- 序列化 body hash 一致；仅允许 codec/profile 明确定义的 attempt metadata 变化。
- 等待期间修改的设置只影响下一次 logical request。
- RequestSnapshot 记录 policy 快照，而不是完成后读取最新设置。

如果重试需要改变模型、删除参数、缩短上下文或切换 endpoint，必须停止自动重试并让用户发起新的 logical request。

## 工具与副作用

### 客户端工具

- 已完成的 MCP、本地函数或其他客户端工具不得因 Provider continuation 重试而再次执行。
- 工具结果先持久化，再创建包含该 result 的 continuation logical request。
- continuation 的自动重试只重发相同、已持久化的 tool result 和上下文。
- 工具本身若需要重试，必须由工具执行层使用独立策略和幂等规则，不能与模型请求重试混为一体。

### Provider 内置工具

`web_search`、`x_search`、Google Search、Anthropic web search 等 server-side 工具可能在 Provider 内部已经执行。客户端在未收到任何接受信号时重发仍可能导致重复搜索、重复费用或不同结果。UI 和设置必须提示这一事实。

### Idempotency

只有端点或中转站官方文档明确支持、且 codec/profile 已验证时，才发送 idempotency key。不得假设同一个自定义 Header 对所有 OpenAI 兼容端点都有效，也不得把本地 logical request id 当作远端幂等保证。

## UI 与交互

自动重试等待时，assistant placeholder 保持同一消息，不创建 sibling。消息状态区显示：

- `第 2 / 4 次尝试`。
- 失败类别，例如 `429 请求过多` 或 `连接超时`。
- 下一次尝试倒计时。
- `停止`。
- 没有强制 `Retry-After` 时可提供 `立即重试`；存在服务端等待要求时禁用提前发送并说明原因。

详细抽屉显示各 attempt 的时间、状态、HTTP 状态、Provider 错误代码、退避来源和是否越过安全边界。普通聊天区不为每次失败创建新的错误卡片，最终失败后显示一个汇总错误和可展开尝试记录。

取消等待必须立即清理 timer，并把 logical request 终结为 `interrupted`。取消与 timer 到期竞态只能启动零次或一次下一 attempt。

## 状态与错误代码

logical request 至少支持：

- `pending`
- `running`
- `waiting_retry`
- `completed`
- `interrupted`
- `failed`

attempt 至少支持：

- `running`
- `retryable_failed`
- `non_retryable_failed`
- `completed`
- `cancelled`

稳定错误代码至少包括：

- `retry_exhausted`
- `retry_budget_exhausted`
- `retry_after_invalid`
- `retry_disallowed_after_output`
- `retry_cancelled`
- `provider_embedded_error`

## 数据与诊断

- RequestSnapshot 表示 logical request，并保存固定的 policy、context/body hash 和最终终态。
- request_attempt 保存每次网络尝试，不复制密钥或完整敏感正文。
- 诊断默认只包含 attempt 次数、时长、状态、HTTP/Provider 代码和脱敏错误。
- 若开启原始 trace，每个 attempt 使用独立 request id，并通过 logical request id 聚合。
- 统计费用时不得把多个 attempt 合并伪装成一次确定计费；只有 Provider 返回 usage/cost 时才记录已知值。

## 测试

- 429 + `Retry-After: 2`，不会在 2 秒前重试。
- HTTP-date `Retry-After`、无效值和超过总预算。
- 无 header 的 full jitter，使用确定性随机源验证范围而非固定生产延迟。
- 408/500/502/503/504 和临时连接失败按 policy 重试。
- 400/401/403/404/422、参数错误、模型不存在不重试。
- HTTP 200 + 精确结构化上游错误仅在 Provider allowlist 命中时重试。
- response id、reasoning、text、tool、source 任一出现后断流均不自动从头重试。
- 等待期间取消不会启动下一 attempt，也不会遗留 timer。
- 每个 attempt 的 body hash、context hash、模型和参数一致。
- 等待期间修改会话参数不影响当前 logical request。
- 已完成客户端工具不会重复执行。
- 手动重新生成创建 sibling 和新 RequestSnapshot，自动重试不会。
- 达到次数上限与总时间预算均能稳定终止。
- attempt 记录保存 endpoint、profile revision、模型、参数、context/body hash 和结构化终态；请求明细保留范围由后续安全专题决定。

## 验收标准

- 用户可以在应用默认和 endpoint 级开启、关闭并调整自动重试。
- mock server 连续返回两次 429 后成功时，只产生一个 assistant 消息、一个 logical request 和三个 attempt。
- 所有自动 attempt 使用完全相同的 context/body hash。
- 任一有价值输出出现后，客户端不会自动从头重发。
- `Retry-After`、停止、倒计时和最终失败原因在 UI 中可见。
- 已完成客户端工具在 continuation 重试中执行次数仍为一次。
- 自动重试不改变分支，不隐藏费用风险，也不进行参数或上下文降级。

## 验证证据

- 连续两次 429 后成功的本地 HTTP/SSE + SQLite fixture 只产生一个 assistant、一个 logical request 和三个 attempts；除 transport request id 外，三次 wire 请求完全相同。
- 408、429、500、502、503、504、network、timeout、HTTP 200 内嵌 allowlist、合法/非法 `Retry-After`、full jitter、attempt 上限和总预算均有确定性测试。
- response id、reasoning、text、tool、source、usage 等有价值输出均会越过安全重试边界；参数、鉴权、模型和明确不可重试错误不会自动重发或删字段。
- migration v2 新增 `request_attempt` 与应用默认 policy 持久化，保留 v1 checksum；logical request、schedule、attempt 启动/终结、等待中断和重启恢复使用原子 SQLite command。
- waiting_retry、attempt 详情、倒计时和停止 UI 已在 1280×800 与 900×700 两个 Playwright 视口通过，停止/timer 竞争最多启动零次或一次下一 attempt。
- Phase 6 收口后的完整 `pnpm verify` 通过 157 个 Vitest、17 个 contract 复跑、16 个 Playwright 和 23 个 Rust 测试；Tauri debug no-bundle 构建、双视口截图、格式、静态检查、migration checksum、敏感信息和临时产物检查通过，既有 retry 契约仍全部包含在门禁中。
- Phase 5 的真实 Responses 冒烟与 Chat Completions 本地兼容端点证据继续分开记录；本功能不把外部 HTTP 200 当作参数或 retry policy 已生效的唯一证据。

## 依赖和后续扩展

- 详细表结构见 [数据模型](../DATA_MODEL.md)。
- 生命周期与断流规则见 [流式、思考与搜索事件规范](../STREAMING_AND_REASONING.md)。
- 开发顺序见 [Phase 5A](../DEVELOPMENT_ROADMAP.md#phase-5a-自动重试与请求尝试)。
- 后续可以评估 Provider 故障转移、账号轮换和可恢复 background response，但必须独立建模并保留用户控制。
