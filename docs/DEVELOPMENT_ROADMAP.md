# 开发顺序与路线图

## 1. 排序原则

开发顺序围绕最危险、最基础的契约组织：先证明请求、上下文、工具结果和持久化是正确的，再扩展 UI 和 Provider 数量。Cherry 文档只用于校准当前任务的非差异化设计，不得把其完整功能目录插队到当前路线。不能先做大量页面和模块，最后才发现消息模型无法可靠回放工具结果。

## 2. 依赖关系

```text
文档基线
  -> 工程脚手架与质量门禁
  -> Rust 通用管道 + 假 SSE
  -> 连接/端点/协议 profile schema + 消息块 + 分支
  -> ContextAssembler + 工具连续性 canary
  -> OpenAI 兼容 Chat Completions + Responses 最小聊天纵切
  -> 自动重试 + logical request / request attempt
  -> 全量字段目录 + 动态参数/能力/工具 schema + 兼容探测
  -> 结构化 reasoning/search/source UI
  -> 完整聊天交互与性能
  -> Anthropic/Gemini/自定义 codec + 跨品牌协议验证
  -> MVP 发布收口
  -> V1
  -> V2 模块
```

## Phase 0: 文档与契约基线

状态：`verified`

### 交付

- 根 README 与 `docs/` 专题规范共同构成唯一文档基线。
- 产品、架构、上下文、连接/端点/协议、流式、数据、UI、性能、测试和路线文档。
- 自动重试、官方 API 兼容矩阵与开源鸣谢/发布门禁。
- [Cherry Studio 双文档参考指南](./CHERRY_STUDIO_REFERENCE_GUIDE.md)、相关开发者/用户文档映射和参考项目许可边界。
- 每个功能的独立规格。

### 退出条件

- 所有文档链接可解析。
- 关键术语和状态一致。
- 不再引用已经删除的旧版单体设计文档。
- Provider 名称、模型品牌和 `vendorHint` 不决定协议、参数或能力。
- 明确核心聊天的发布阻断条件。
- Cherry 参考文档的任务映射、采用项和明确不采用项已经记录；Cherry-only 功能没有被隐式加入 MVP。
- 项目所有者已经按 [文档中心的人工审阅流程](./README.md#人工审阅与开工确认) 完成审阅，并明确确认可以进入 Phase 1。
- 没有业务代码、脚手架或依赖变更。

## Phase 1: 工程脚手架与质量门禁

状态：`verified`（2026-07-27）

### 目标

建立最小 Tauri 2 + React 19 + TypeScript + Vite 工作区，不实现真实聊天功能。

### 任务顺序

1. 创建 Tauri React TypeScript 脚手架。
2. 选择并锁定 pnpm、Node、Rust 工具链版本。
3. 配置 Tailwind、shadcn/ui、路径别名和基础主题 token。
4. 为 pointer-down、sheet、拖拽和 reduced motion 建立最小交互 spike，决定是否采用 Motion 等小型 spring 库。
5. 加入 lint、format、typecheck、Vitest 和构建命令。
6. 建立 `DesktopBridge` 接口和假实现。
7. 建立 CI 或本地统一 `verify`。

### 验证

- 空应用在 Windows 运行。
- `pnpm verify` 和 Rust 检查通过。
- 深浅主题与小窗口无溢出。
- 没有 Provider、SQLite 和真实网络代码。

### 不做

MCP、知识库、附件、复杂路由、插件 API、自动更新发布。

### 退出证据

- Node、pnpm、Rust、Tauri、React、TypeScript、Vite 与 Motion 已精确锁定，pnpm/Cargo lockfile 已生成。
- `pnpm verify` 覆盖 format、lint、typecheck、Vitest、契约测试、构建、bundle 门禁、Playwright、Rust 与许可证清单。
- Windows 原生窗口完成启动、900x700 客户区调整、正常 `WM_CLOSE`；debug MSI 与 NSIS 均成功生成。
- 初始 JavaScript/CSS 为 439.4 KiB 原始、138.8 KiB gzip；没有 Provider、SQLite、真实网络或后续模块代码。

## Phase 2: Rust 通用流式管道

状态：`verified`（Phase 2A + Phase 2B，2026-07-27）

### 目标

用本地假 SSE server 证明最终 URL/显式端口/Method/Header/Query/Body、合批、取消、错误和资源清理。

### 任务顺序

1. 定义 PipeRequest/PipeEvent 序列化契约。
2. 实现 `pipeline.rs`。
3. 前端实现 Tauri DesktopBridge。
4. 建立本地 SSE fixture server。
5. 测试分片、30ms 合批、取消、非 2xx 和资源清理。
6. 验证 Rust 不补写认证、不改字段名、不根据 Provider/模型名称选择协议。

### 退出条件

- Rust 不含 Provider 名称和业务字段。
- 高频事件顺序不变。
- cancel 后 running map、reader 和 Channel 清理。
- TypeScript 提供的最终 URL、端口、Header、Query 和 Body 被原样发送。

### Phase 2A：传输契约与本地假 SSE 成功链路

状态：`verified`（2026-07-27）

#### 退出证据

- TypeScript 与 Rust 使用同一份 JSON golden fixture 验证 `PipeRequest`、`PipeEvent` 和错误结构；`data` 从第一版即为数组，Phase 2B 可在不改变 IPC shape 的前提下加入合批。
- Rust `pipeline.rs` 使用最终 URL、Method、Header、Query、Body 和可选 timeout 发起单次 HTTP 请求，不补写认证、不读取 Provider 或模型名称、不解析业务事件。
- 本地随机显式端口 fixture 捕获并断言现有 Query、重复 Query、Header 和原始 Body；两条 SSE `data` 按序回传，最后发送 `done`。
- Tauri 注册 `start_stream`/`cancel_stream` 命令，前端 `TauriDesktopBridge` 通过 `Channel<PipeEvent>` 转发事件；fake 与真实 bridge 共用同一具体契约。
- `pnpm verify` 覆盖格式、lint、typecheck、8 个 Vitest、3 个契约测试、生产构建、bundle 预算、4 个 Playwright 场景、Rust fmt/clippy/test 和许可证清单。

#### Phase 2A 交由 Phase 2B 收口的内容（现已完成）

- 约 30ms 或 64 个 data 事件合批及最后非空 batch 顺序。
- 随机/单字节分片、多事件同 chunk、CR/LF 边界、注释、heartbeat 和空 data。
- 取消、完成、超时、断流和 Channel 关闭竞态，以及 running map/reader/timer 的完整清理证据。
- 非 2xx 受限错误正文、错误分类和不会泄漏请求 Header/Query/Body 的诊断边界。

### Phase 2B：通用流式管道加固

状态：`verified`（2026-07-27）

#### 退出证据

- Rust 以 30ms、64 个 data 事件或 256 KiB UTF-8 data payload 为具名边界有序合批；正常 EOF 总是先 flush 最后一个非空 batch，再发送唯一 `done`。
- 增量 SSE decoder 覆盖单字节和确定性随机分片、同 chunk 多事件、LF/CRLF 跨 chunk、多行/空 data、注释和 heartbeat；超过单事件上限时以 `stream` 失败，不制造超限 batch。
- request id 注册、重复 ID、未知 ID 取消、连接前/首包前/流中取消、cancel/EOF 竞态和完成后取消均有自动化证据；取消优先于尚未发送的大 batch，终态只产生一次。
- 成功、无效请求、网络错误、非 2xx、超时、突然断流、取消和 Channel 关闭均清理 running map、response reader、生命周期 timer 和 cancellation token；Channel 关闭后不继续读取或尝试第二次发送。
- 非 2xx 正文最多读取并回传 16 KiB，错误只包含稳定类别、通用消息、HTTP 状态和经请求值消隐的受限正文；不记录或主动回传请求 Header、Query、Body、认证值或完整 URL。
- `timeoutMs` 从 attempt 开始覆盖连接、等待响应和活动流，request 阶段与 stream 阶段均使用 Tokio paused time 验证；错误类别为 `invalid_request`、`network`、`http`、`timeout`、`stream`、`cancelled` 和 `channel_closed`。
- `startStream()` 只有在 terminal `PipeEvent` 已交付且平台命令完成后才 resolve；平台 IPC/Channel 失败才 reject，fake 与真实 Tauri bridge 共用该生命周期语义。
- TypeScript/Rust golden JSON 未改变；22 个 Rust 测试、10 个 Vitest（其中 5 个契约测试）和 4 个 Playwright 场景通过，`pnpm verify`、`pnpm tauri build --debug --no-bundle`、`git diff --check`、Rust 业务词扫描和敏感信息扫描均通过。

## Phase 3: SQLite、消息块和可恢复状态

状态：`verified`（2026-07-27）

### 目标

先建立数据权威层，再接真实模型。

### 任务顺序

1. schema migration 框架。
2. provider_connection/protocol_profile/provider_endpoint/model/parameter_compatibility_probe/conversation/message/request_snapshot/artifact 表。
3. repository 和事务 use case。
4. pending assistant placeholder。
5. 启动恢复 interrupted。
6. 分支路径与 sibling。
7. 最近 50 条分页和 300 条 UI 窗口基础。

### 退出条件

- fixture round trip 不丢块。
- 同一连接可保存多个显式端口和协议 profile，模型引用具体 endpoint。
- 分支查询不混 sibling。
- 启动可恢复 pending。
- compatibility probe 与 endpoint/model/profile revision 精确关联。

### 退出证据

- tauri-plugin-sql 2.4.0 注册 `sqlite:eternal-chat.db` 和 migration `1 / phase_3_authoritative_schema`；同一 SQL 文件由 Rust migration 与 Node 24 临时 SQLite fixture 共用。
- migration 建立 10 张项目表、7 个显式索引、16 个完整性/原子写入 trigger 和 3 个无存储 command view；SQLite 计入主键/唯一约束自动索引后共有 19 个索引。
- repository 覆盖连接/profile/端点/模型/兼容探测/conversation/message/RequestSnapshot/artifact round trip；conversation+虚拟根、user+pending assistant+active leaf、assistant sibling 均以单条 SQLite 语句原子完成。
- 17 个数据库测试覆盖新库、重复 migration、checksum、迁移失败回滚、临时库清理、跨会话 parent、parent 环、虚拟根、首轮 sibling、active leaf、pending 恢复、500 条消息按 50 条稳定游标分页，以及 snapshot/probe 的 endpoint/model/profile revision 精确关联。
- 启动入口只在 Tauri 环境加载数据库并把遗留 `pending`/`waiting_retry`/`streaming` assistant 与关联 snapshot 标记为 `interrupted`；已有 blocks 保持，不发起网络或自动重试。
- `pnpm verify` 通过：27 个 Vitest、5 个契约测试、4 个 Playwright 场景和 22 个 Rust 测试全部成功；`pnpm tauri build --debug --no-bundle`、`git diff --check`、禁止路径检查和敏感信息扫描通过。
- Rust `pipeline.rs`、DesktopBridge/PipeEvent 契约和 `Other project references/` 无改动；真实 Provider、真实聊天、Protocol codec、ContextAssembler、自动重试、MCP、知识库、云同步、FTS 和导入导出均未提前实现。

## Phase 4: ContextAssembler 与工具连续性

状态：`verified`（2026-07-27）

### 目标

在任何真实 UI 打磨之前，完成当前项目最重要的 canary。

### 任务顺序

1. CanonicalContext 和 ContextManifest。
2. 当前分支读取。
3. tool_call/modelContent 校验。
4. OpenAI Chat 与 Responses serializer 基础。
5. 捕获线协议请求的本地 mock。
6. 两轮 canary 工具结果测试。
7. UI 内存窗口独立测试。
8. lossless 预算预检基础。

### 退出条件

- 第一轮助手不复述 canary，第二轮请求仍包含真实 tool result。
- 不完整工具和未知块显式失败。
- 500 条数据库历史不受 UI 50 条窗口影响。

未通过本阶段，不得进入真实多 Provider 扩展。

### 退出证据

- 建立 Provider 无关的 `CanonicalContext`、`CanonicalTurn`、`CanonicalBlock`、`ContextManifest`、稳定 SHA-256 与 `normal/risk/over_limit/uncertain` lossless 预算预检；预检不修改上下文、manifest 或数据库。
- `Phase3Repository` 使用单次 SQLite 递归 CTE 从 anchor 沿 `parent_id` 读取到虚拟根；ContextAssembler 排除根、按根到叶排序并显式拒绝缺父、环、跨会话、不可达/损坏根、重复 tool-call ID、未完成工具、缺失 `modelContent`、失败无错误内容、未知/不支持块和角色不兼容。
- OpenAI Chat Completions 与 Responses 仅实现本地最小 serializer；本地 capture boundary 在最终 wire request 层分别证明第二轮保留第一轮完全相同的 tool-call ID 和唯一 canary `modelContent`，没有 Provider/API 调用、parser、Rust 接入或自动重试。
- 真实临时 SQLite 的 500 条非根消息在模拟 UI 只加载最近 50 条时仍完整进入当前分支上下文，无重复、遗漏或 sibling 污染；RequestSnapshot 对 ContextManifest、context/body hash、connection/endpoint/model/profile revision 完成 round trip。
- Phase 4 新增 36 个测试；`pnpm verify` 通过 63 个 Vitest、13 个 contract、4 个 Playwright 场景和 22 个 Rust 测试；初始 web assets 为 455.8 KiB raw、143.0 KiB gzip，`pnpm tauri build --debug --no-bundle` 成功生成 debug 应用。
- migration 保持版本 1，仍为 10 张项目表、7 个显式索引、19 个总索引、16 个 trigger 和 3 个 command view；临时数据库、WAL、SHM 和测试产物已清理。
- `git diff --check`、敏感信息扫描和从 `ff56cca` 起的禁止路径检查通过；`pipeline.rs`、DesktopBridge/PipeEvent、Phase 3 migration、依赖/lockfile 与 `Other project references/` 无改动。

## Phase 5: OpenAI 兼容双端点最小聊天纵切

状态：`verified`（2026-07-28）

### 目标

打通“配置 -> 输入 -> 流式 -> 持久化 -> 重启读取”的最小真实链路，并同时证明 Chat Completions 与 Responses 两种 OpenAI 兼容基本聊天端点可用。

### 任务顺序

1. OpenAI Chat 与 Responses protocol profile preset、endpoint 路由和可编辑 mapping。
2. Chat Completions serializer/parser。
3. Responses input/output item serializer/parser 基础。
4. 两端点共用 text/reasoning/usage/done/error 领域事件。
5. 三栏基础布局和输入区。
6. history/streaming store 分离与 Markdown 轻量渲染。
7. stop、error 和手动重新生成。
8. 请求快照和开发者请求预览。

### 退出条件

- Chat Completions 与 Responses 假端点契约全过。
- 至少各有一个真实或明确兼容端点冒烟；若某中转站只支持其中一种，报告必须分开记录。
- 重启后历史一致。
- 流式期间历史消息不重渲染。

### 退出证据

- 内置 OpenAI-compatible Chat Completions 与 Responses protocol profile preset 已进入 SQLite；连接配置支持 base URL、显式端口、路径、Header、Query、模型 Body、会话内凭据和 Chat reasoning delta path 的用户 fork，显示名称与 `vendorHint` 不参与协议选择。
- 两种协议共用冻结的 `PreparedDispatch`、`ContextManifest`、请求快照、text/reasoning/usage/done/error 领域事件和应用根级 `ActiveRequestRegistry`；同一会话只允许一个 active request，页面 detach 不取消请求，停止、错误、终态竞争和手动重新生成均收敛到单一持久化终态。
- 本地随机显式端口 HTTP/SSE 兼容端点分别完成 Chat Completions 与 Responses 的确定性“配置 -> 发送 -> 流式 -> SQLite 终态 -> 重启读取”验证；两条链路分别断言最终 path、认证 Header、`messages`/`input` Body、模型、stream 标志、response id、usage 和快照脱敏。
- Responses 另于 2026-07-28 使用 `grok-4.5` 对第三方 OpenAI-compatible `/v1/responses` 端点完成真实流式冒烟：HTTP 200，`Content-Type: text/event-stream`，收到 11 个网络分片和 37 个 SSE 事件；reasoning、text、usage 与 response id 均成功解析，terminal、SQLite、RequestSnapshot 和重启读取均为 `done`，`attemptCount=1`，凭据未进入快照。Chat Completions 的验收证据是上述独立本地兼容端点，不与本次真实 Responses 证据混写或互相替代。
- 三栏工作区、响应式请求检查器、会话输入区、轻量安全 Markdown、结构化 reasoning、usage、错误和重新生成入口已接通；历史消息与流式消息使用独立状态和 memo 边界，组件测试证明 delta 更新不重渲染既有历史。
- Phase 5 退出时 SQLite migration 保持版本 1；终态写入对 snapshot/message 只认领一次，启动恢复可修复 message 已完成而 snapshot 尚未落终态的中断窗口，尚未包含 Phase 5A 的 `request_attempt` 表、自动重试、waiting_retry 和倒计时。
- Phase 5 退出基线的 `pnpm verify` 覆盖 91 个 Vitest、13 个 contract、10 个 Playwright 和 22 个 Rust 测试；初始 web assets 为 529.5 KiB raw、162.7 KiB gzip。`pnpm tauri build --debug --no-bundle` 成功生成 debug 应用，`git diff --check`、敏感信息扫描、禁止路径检查及 1280×800/900×700 浏览器视觉核对均通过。

## Phase 5A: 自动重试与请求尝试

### 目标

在继续扩展参数和 Provider 前，完成适合 NewAPI 等中转站的有界自动重试，并证明重试不会改变请求、重复工具或污染分支。

### 任务顺序

1. 定义 RetryPolicy、logical request 和 request attempt。
2. 建立 transport/provider 错误分类与 codec/profile 扩展点。
3. 实现 `Retry-After`、指数退避、full jitter 和总时间预算。
4. 保存 request_attempt，并在 RequestSnapshot 固定 context/body hash 与 policy。
5. 实现 waiting_retry、倒计时、停止和尝试详情 UI。
6. 覆盖 429、408、5xx、网络失败、HTTP 200 内嵌结构化错误。
7. 覆盖收到 response id/reasoning/text/tool/source 后禁止自动从头重试。
8. 覆盖 continuation 中已完成客户端工具不重复执行。

### 退出条件

- 连续两次 429 后成功只产生一个 assistant、一个 logical request 和三个 attempts。
- `Retry-After` 不被提前绕过，总预算包含等待和尝试耗时。
- 自动 attempt 的 ContextManifest、参数和 body hash 完全相同。
- 等待期间取消不遗留 timer，不会多启动一次请求。
- 收到任何有价值输出后断流不会自动从头重发。
- 参数/鉴权/模型错误不会重试，也不会自动降级。

详细契约见 [自动重试与请求尝试](./features/16-automatic-retry.md)。

### 退出证据

- `RetryPolicy` 已实现应用默认与 endpoint 覆盖、408/429/500/502/503/504、network/timeout/stream 和 HTTP 200 内嵌结构化错误分类；合法/非法 `Retry-After`、指数退避、full jitter、attempt 上限与总时间预算均有确定性测试。
- migration v2 仅新增 `request_attempt`、`application_retry_policy` 及原子 command view/trigger，未改写已发布的 v1；logical request 启动、retry schedule、下一 attempt、终态、等待中断和启动恢复均在 SQLite 中保持一致。
- 自动 attempt 只替换 transport request id，固定 ContextManifest、参数、认证解析后的 wire 请求、context hash、body hash 和发送时生效的 policy；等待期间修改设置不会改变旧 logical request。
- 本地真实 HTTP/SSE + SQLite fixture 连续两次返回 429 后成功，得到一个 assistant、一个 logical request、三个 attempts；三次请求除 transport id 外完全相同。手动重新生成仍创建新的 sibling 与 snapshot，已完成客户端工具在 continuation retry 中只执行一次。
- response id、reasoning、text、tool、source、usage 等有价值输出均越过安全边界并禁止从头自动重试；参数、鉴权、模型和明确不可重试错误不会触发删字段、降级或重发。停止与 timer 竞态最多启动零次或一次下一 attempt。
- waiting_retry、attempt 详情、HTTP/provider 原因、倒计时和停止操作已进入主聊天 UI 与请求检查器；1280×800 和 900×700 Playwright/截图检查确认无空白、横向溢出、遮挡或弹层裁切，设置与 inspector 内容可滚动。
- `pnpm verify` 通过 131 个 Vitest、13 个 contract、12 个 Playwright 和 23 个 Rust 测试；初始 web assets 为 564.4 KiB raw、170.0 KiB gzip。`pnpm tauri build --debug --no-bundle`、Prettier、ESLint、TypeScript、clippy、license、`git diff --check`、migration checksum、敏感信息和临时产物检查均通过。
- Phase 5 已记录的真实 Responses 冒烟继续作为独立补充证据；Phase 5A 的重试、协议错误和竞态结论来自可重复的本地 fixture，不把外部 HTTP 200 当作 retry policy 生效证明。

## Phase 6: 全量端点、能力、参数与工具目录

状态：`verified`（2026-07-28）

### 目标

完成五层配置模型与全量字段目录：所有官方请求字段、能力、参数、工具 descriptor、错误行为和响应 mapping 都能落入可编辑 schema；没有专用控件的字段仍可通过高级 schema 或 raw override 设置。建立 GPT、Grok、Gemini、Claude 的来源化 preset，并专门验证用户关心的 Grok 多代理 `xhigh`。

### 任务顺序

1. 落地 ProviderConnection -> EndpointConfig -> ProtocolProfile -> ModelConfig -> ConversationOverride 五层模型。
2. 建立 capability/parameter/tool/endpoint 字段目录、schema 校验和表单渲染。
3. 官方 preset registry：source URL、checkedAt、revision、用户 fork。
4. 用户 schema 编辑/复制/重置、点路径和可预测深合并。
5. endpoint/model/conversation 的 Body/Header/Query/path override 与逐字段来源追踪。
6. OpenAI Chat/Responses reasoning path 与 web search tool。
7. Grok 4.20 multi-agent 4/16 agents、`web_search`、`x_search` 和 Responses-only 检查。
8. Gemini Interactions/generateContent 与 Anthropic Messages 的官方 golden fixture；实际网络接入在 Phase 9 完成。
9. unknown model + 自定义 `xhigh`/未知值契约和 E2E。
10. ignored/rejected/unknown/translated 兼容 fixture、最小参数探测和 profile revision 失效规则。
11. Provider 错误不自动删字段或降级，临时错误只由 Phase 5A policy 处理。

### 退出条件

- 目录外模型完整可用。
- 最终 Body 与预览一致。
- `xhigh` 不会变成 `high` 或被删除。
- “努力程度/思考预算”的语义标签可映射到用户指定的任意 placement/path，不自动识别厂商字段名。
- GPT/Grok/Gemini/Claude preset 的实际 path 和 endpoint 不混用，用户 fork 不被官方更新覆盖。
- 工具 off/auto/required 与最终 descriptor 一致；不支持 required 时显式不可用。
- HTTP 200 不自动判定参数有效，`accepted_ignored` 与 `accepted_effective` 有独立证据。

### 退出证据

- `ProviderConnection -> ProviderEndpoint -> ProtocolProfile -> Model -> ConversationOverride` 五层配置进入同一请求装配链；protocol、endpoint、model schema/raw 和 conversation schema/raw 按固定顺序合并，Body 递归合并、数组整体替换，Header 大小写不敏感，Body 点路径与 Header/Query/path override 均保留逐字段 winner/overridden 来源。
- `RequestSnapshot`、请求预览和 transport 使用同一个冻结最终请求；未知参数、目录外模型、自定义枚举与 `xhigh` 不被删除或降级，Provider 422 不触发删字段重试，临时错误继续只由 Phase 5A RetryPolicy 处理。
- 官方 registry 记录 `sourceUrl`、`checkedAt=2026-07-28` 和 revision，提供 OpenAI Chat/Responses、xAI Grok、Gemini generateContent/Interactions 与 Anthropic Messages 的协议隔离 preset 和 golden fixture。endpoint request field catalog 使用结构化 `OfficialFieldRecord`；capability、parameter 和 tool schema 均有校验、动态呈现和 raw JSON 入口。
- tracked ProtocolProfile、Endpoint 和 Model 在 revision 更新时投影新默认并保留 `overridePatch`；detached fork 不自动变化，Copy/Reset 与全部 raw override 清理有 UI/E2E 证据。migration v3 持久化 source、preset binding、parameter/tool values 和 path override，checksum 为 `sha256:05286a7302da65f4c18531b756bbb24dab316d9135a53934d18ad76821296a51`，v1/v2 未改写。
- compatibility evidence 支持 `unknown/accepted_effective/accepted_ignored/rejected/translated`、Current/Stale、SQLite 查询和用户触发的单参数最小探测。最小探测只对已经实现网络 codec 的 OpenAI Chat/Responses 开放；HTTP 200 保持 `unknown`，4xx 才可形成 `rejected`，5xx/网络故障不误判参数无效。
- mixed relay fixture 在同一 Connection 下验证显式 `port 443` 的 Responses 与 `port 8443` 的 Anthropic Messages；显示名称不决定协议。unknown Responses model 完成浏览器 fixture 对话；Grok `reasoning.effort=xhigh`、`web_search`、`x_search` 及 tool off/auto/required 均由 wire fixture 覆盖。
- `pnpm verify` 通过 35 个 Vitest 文件、157 个测试；`test:contracts` 独立复跑 5 个文件、17 个测试；16 个 Playwright 和 23 个 Rust 测试通过。初始 web assets 为 615.9 KiB raw、181.8 KiB gzip；`pnpm tauri build --debug --no-bundle` 成功生成 `src-tauri/target/debug/eternal-chat.exe`。
- 1280×800 与 900×700 的仓库外截图经实际查看：document、sheet 均无横向 overflow，sheet 内容可滚动，Current/Stale、结构化字段目录、capability/parameter/tool、advanced schema、conversation override 与 mixed relay 双端口均可达。格式、ESLint、TypeScript、clippy、license、`git diff --check`、Markdown links/anchors、migration checksum、敏感信息和临时产物卫生门禁通过。
- 本轮没有重复真实第三方 Responses 请求，主要依据确定性本地 fixture；Phase 5 已有的 `grok-4.5` 真实 Responses 证据继续单独保留，但请求装配链在 Phase 6 发生过变化，因此不能把旧 HTTP 200 单独当作本轮参数有效性证明。Anthropic/Gemini 实际网络 codec/parser 仍明确属于 Phase 9。

## Phase 7: 结构化思考、搜索和信源

### 目标

吸收 NBSearch 的优秀思路，但用本项目统一事件与数据模型从零实现。

### 任务顺序

1. 扩展 StreamEvent/reducer。
2. thinking lifecycle 和计时。
3. tool usage/result/source/citation。
4. Grok Responses/兼容事件 fixture，以及 web/X search 结构化事件。
5. 结构化思考面板、详情抽屉和信源。
6. 持久化/reload 一致性。
7. Provider anchor 能力测试。

### 退出条件

- 搜索、工具、来源和最终文本不互相丢失。
- 取消/断流保留部分轨迹。
- UI 不声称展示未返回的内部思维。
- 下一轮连续性有显式 replay 或可靠 anchor。

## Phase 8: 核心聊天交互与长对话性能

### 目标

完成现代、可中断、可客制化的核心聊天交互和长对话性能基线。

### 任务顺序

1. virtua 动态高度虚拟列表。
2. Markdown 缓存、节流、shiki/KaTeX 懒加载。
3. 上滑暂停吸底和回到底部。
4. 编辑、重新生成和 sibling 切换。
5. 会话搜索、归档和快捷键。
6. 1000 条 seed 性能测试。
7. 长时间内存与 listener 清理。
8. pointer-down 即时反馈、1:1 拖拽、速度继承 spring、空间一致进出和 reduced motion 验收。

### 退出条件

- 性能预算核心指标通过。
- 分支路径正确。
- 5 万字/20 代码块布局稳定。
- 内存不随会话长度和切换次数单调增长。

## Phase 9: 多协议 codec 与跨品牌兼容验证

### 目标

在核心语义稳定后完善 Anthropic、Gemini 和自定义 codec，并证明模型显示品牌与 wire 协议完全解耦，而不是为每个厂商重写聊天主链。

### 任务顺序

1. Anthropic serializer/parser、effort/adaptive/legacy thinking、tool/signature。
2. Anthropic 版本化 web search descriptor 与 source/citation。
3. Gemini generateContent serializer/parser、thinkingLevel/thinkingBudget、functionCall/functionResponse 和 thought signature。
4. 可选 Gemini Interactions preset 实现；未实现时保持明确 `specified` 而不在 UI 中伪装可用。
5. Gemini Google Search descriptor、search call/result 和 citation。
6. OpenAI Responses explicit items/anchor 策略收口。
7. custom_json/custom_json_sse 声明式 profile 的最小可用实现。
8. 各协议图片能力基础，为 V1 预留。
9. 所有协议共用 canary、重试边界和错误矩阵。
10. 跨品牌场景：Gemini/Claude 显示模型经 OpenAI profile；任意模型经 Anthropic Messages profile；同一连接多端口混合协议。

### 退出条件

- OpenAI Chat、Responses、Anthropic Messages、Gemini 和自定义 profile 的工具历史回放测试通过。
- Provider 特有 opaque state 可持久化。
- 同一 CanonicalContext 可生成全部已支持协议 fixture。
- 更改连接名、模型显示名或 `vendorHint` 不改变 wire request。

## Phase 10: MVP 收口与发布准备

### 任务

- 导入导出。
- FTS/LIKE 搜索能力状态。
- 完整错误、空状态和无障碍。
- 确定项目开源许可证并加入 `LICENSE`。
- 生成第三方许可证/NOTICE 清单，保留 NBSearch 鸣谢并复核参考源码零复制边界。
- Windows 打包。
- macOS/Linux 冒烟，或明确不在首发支持矩阵。
- README 与功能状态校对。
- 发布门禁全部通过。

### 退出条件

满足 [测试策略的发布门禁](./TEST_STRATEGY.md#16-发布门禁)。

## Phase 11: V1 分支树与用量可观测性

### 目标

先完成不改变 Provider 线协议的 V1 增强，进一步验证分支和 RequestSnapshot 是否可靠。

### 任务顺序

1. 完整分支树 UI、懒加载和键盘导航。
2. 当前分支/全部分支的请求归属查询。
3. usage 规范字段和 Provider fixture 补全。
4. 用户价格 revision、费用计算和本地统计页。
5. 1000 节点树与大范围统计性能测试。

### 退出条件

- 树选中路径、聊天可见路径和 ContextManifest 一致。
- Provider 实际 usage、客户端估算和未知值明确区分。
- 未知模型可以配置价格，不影响发送能力。

## Phase 12: V1 附件与视觉模型

### 目标

在 Phase 9 已预留的图片 codec/profile 能力上，打通 artifact 到真实端点请求的完整链路。

### 任务顺序

1. 文件选择、拖放、粘贴和 artifact hash 存储。
2. 输入区缩略图、预检和缺失状态。
3. 已支持协议 profile 的图片 serializer fixture。
4. 远端文件 ID/上传模式与本地 artifact 兜底。
5. 导入导出、重试、分支和长会话资源测试。

### 退出条件

- 捕获的实际请求包含所选图片。
- 未知模型可确认尝试，不受目录门控。
- 缺失、不支持和超限附件不会被静默丢弃。

## Phase 13: V1 提示词、国际化与桌面集成

### 目标

完成 V1 的复用、语言和桌面使用体验，同时保持核心聊天可独立运行。

### 任务顺序

1. 提示词 revision、助手预设和解析快照。
2. 中文/英文消息目录、locale 格式与伪本地化门禁。
3. 托盘、关闭窗口语义和 single-instance 整合。
4. 少量可配置全局快捷键和通知。
5. 全部 V1 功能状态、导入导出和平台冒烟收口。

### 退出条件

- 模板更新不改变历史请求。
- 两个 locale 与伪本地化布局通过。
- 托盘/快捷键禁用后资源释放。
- V1 deferred 状态只在全部验收通过后更新。

## Phase 14: V2 内置模块运行时硬化

### 目标

用已有内置模块需求验证 FeatureModule 契约，但暂不开放任意第三方代码。

### 任务顺序

1. 动态 import、贡献点、依赖和生命周期。
2. 模块权限、任务所有权和资源诊断。
3. 模块 migration、备份命名空间和历史 fallback。
4. 反复启停与全部模块关闭性能门禁。

### 退出条件

- 关闭模块时主体代码、连接、timer、listener 和扫描均不存在。
- 模块不能绕过核心 ContextAssembler 和 ToolExchange。
- migration 失败不破坏核心 schema。

## Phase 15: V2 MCP 工具

### 目标

在已验证模块与工具连续性基础上接入 MCP tools。

### 任务顺序

1. 远程标准 transport、能力协商和工具发现。
2. server/tool 权限与用户确认。
3. 调用、取消、超时、大结果和继续生成快照链。
4. MCP 跨轮 canary 和恶意 server fixture。
5. 本地 stdio 的权限与生命周期在进入该 V2 模块时单独设计，不作为当前 MVP 前置条件。

### 退出条件

- MCP 结果后续轮次可靠回放。
- secret 和本地执行权限不进入普通前端状态。
- 禁用模块后无 server 连接和残留进程。

## Phase 16: V2 知识库

### 目标

先以文本/Markdown 和可验证 embedding fixture 完成本地 RAG 最小闭环。

### 任务顺序

1. collection/document/version/chunk 数据与 artifact。
2. embedding 配置、维度分区和 sqlite-vec 索引。
3. 检索预览、knowledge tool result 和 citation。
4. 更新、重建、中断恢复和隐私检查。
5. 知识库跨轮 canary 与性能基准。

### 退出条件

- 引用能定位准确文档版本和片段。
- 模型实际请求包含 UI 声称纳入的片段。
- 模块关闭时零扫描、零 embedding 请求。

## Phase 17: V2 WebDAV 加密快照同步

### 目标

在模块数据和备份格式稳定后加入可恢复、可冲突检测的远端快照。

### 任务顺序

1. 备份格式兼容与密码学 ADR/测试向量。
2. WebDAV 凭据、连接测试和临时上传。
3. generation、下载、恢复预览和冲突保留。
4. 计划同步、取消、保留策略和关闭清理。

### 退出条件

- 远端不能读取会话正文或标题。
- 双设备分叉不发生静默覆盖。
- API Key 不进入任何同步对象。

## Phase 18: V2 外部插件 API

### 目标

根据真实内置模块经验冻结最小外部 API，而不是提前公开内部 React 接口。

### 任务顺序

1. 选择首批声明式贡献点和 API 版本策略。
2. manifest、权限、完整性、签名和开发模式。
3. 数据命名空间、兼容、升级和卸载。
4. 外部 UI/运行隔离 ADR；未通过时不开放任意脚本。
5. 恶意包、权限扩大和供应链测试。

### 退出条件

- 插件不能获得未声明权限或 API Key 明文。
- 不兼容/损坏插件保持禁用且不影响核心启动。
- 在真实隔离证据前不宣称支持任意第三方 UI 代码。

## 3. 当前里程碑映射

| 产品里程碑 | 本文阶段 |
|---|---|
| 技术纵切 | Phase 1-5：脚手架、传输、数据、上下文与 OpenAI 双端点 |
| 可靠性加固 | Phase 5A，必须在参数与多协议扩展前完成 |
| 完整配置与现代交互 | Phase 6-8：全量字段目录、结构化事件、UI 与性能 |
| MVP | Phase 9-10 |
| V1 | Phase 11-13：附件/视觉、完整分支树、提示词、统计、i18n、托盘 |
| V2 | Phase 14-18：模块运行时、MCP、知识库、WebDAV、插件 API |

## 4. 并行开发限制

以下工作不应过早并行：

- 数据 schema 未稳定前同时实现多个 Provider。
- ContextAssembler 未通过 canary 前实现 MCP。
- 统一事件未稳定前为每个 Provider单独写搜索 UI。
- 性能基线未建立前加入大量 Markdown 插件。
- 备份格式和冲突模型未稳定前实现云同步。

可以安全并行的例子：在协议和数据契约已固定后，UI 组件测试与 Provider fixture 可以分工，但文件所有权必须明确。

## 5. 每阶段工作模板

```text
目标
不做什么
涉及文档
数据变化
接口变化
实现顺序
自动化测试
人工验收
性能/兼容性影响
Cherry 参考文档与差异说明
退出证据
下一阶段前置条件
```

## 6. 当前下一步

Phase 5、Phase 5A 与 Phase 6 已完成并验证。当前按要求停在 Phase 6，Phase 7 未开始；等待用户新指令，不自动进入结构化搜索/信源时间线、Anthropic/Gemini 完整网络 parser、MCP、知识库或其他后续模块。
