# 测试与验收策略

## 1. 测试目标

测试的首要任务是锁死用户无法从 UI 直接发现的行为：模型实际上下文、工具结果回放、最终协议请求、参数透传、兼容性差异、终态竞争和长时间资源增长。只验证“页面上出现文字”不足以证明客户端可靠。

## 2. 测试层级

| 层级 | 覆盖 | 运行频率 |
|---|---|---|
| 纯函数单元测试 | merge、serializer、parser、reducer、分支路径、迁移 helper | 每次改动 |
| 契约测试 | Provider 请求/响应 fixture、ContextManifest、工具回放 | 每次改动 |
| 集成测试 | SQLite + application use case + 假 DesktopBridge | 每次 PR/阶段 |
| Rust 测试 | 最终请求透传、SSE 合批、取消、超时和资源清理 | Rust 改动时 |
| 组件测试 | 表单、工具块、状态、无障碍 | UI 改动时 |
| E2E | 配置、聊天、停止、重启、分支、导出 | 每个里程碑 |
| 性能测试 | 1000 条、长流、切换、内存 | 性能相关改动和发布候选 |
| 平台冒烟 | Windows/macOS/Linux | 发布候选 |

## 3. 计划工具

具体版本在脚手架阶段锁定，建议：

- Vitest：TypeScript 单元、契约和组件测试。
- Testing Library：React 行为与无障碍。
- Playwright：桌面 WebView 可替代层/E2E，Tauri 原生部分按可用驱动补充。
- Rust 内置 test + tokio test：管道和取消。
- MSW、自建本地 HTTP/SSE fixture server 或等价工具：Provider mock。
- SQLite 临时数据库 fixture：迁移和 repository。

不使用真实付费 API 作为 CI 的唯一证据。真实 API 冒烟是发布前补充，核心协议必须有本地确定性 fixture。

## 4. Fixture 规范

每个 Provider fixture 包含：

- connection/endpoint/profile/model 组合、显式端口和 profile revision。
- 原始请求预期。
- 分片方式不同的流式响应。
- reasoning、工具、来源、usage 和 done。
- HTTP 错误和 Provider error body。
- 可重复执行的 429/5xx/连接中断序列、`Retry-After` 和 HTTP 200 内嵌错误。
- 未知字段。
- 参数被有效接受、接受但忽略、拒绝、转换和无法判断的独立样例。
- 不完整/断流场景。
- fixture 来源、官方核对日期、codec/profile revision 和适用 API version。

需要认证字段时使用明显的虚构占位值，不把真实凭据放进 fixture 或报告。

## 5. 核心契约测试

### 5.1 工具结果跨轮 canary

这是发布阻断测试，详细步骤见 [上下文规范](./CONVERSATION_CONTEXT_AND_TOOLS.md#131-canary-工具结果跨轮测试)。必须捕获第二轮实际线协议请求，而不是只断言数据库中存在结果。

### 5.2 未知模型 `xhigh`

- 模型不在内置目录。
- 用户 schema 或 extra_body 设置 `xhigh`。
- 最终请求体包含精确值和路径。
- Provider 拒绝时不自动降级。

### 5.3 分支隔离

创建 sibling 分支，确保 ContextAssembler 只选当前路径，工具结果和 response anchor 不跨分支污染。

### 5.4 UI 窗口与上下文分离

UI 只加载最后 50 条，数据库有 500 条。请求构造仍按策略读取完整当前分支。

### 5.5 最终请求与来源追踪

- 请求预览、RequestSnapshot 和 mock server 捕获到的 URL、显式端口、method、Header、Query、Body 完全一致。
- 每个字段能追踪到 protocol、endpoint、model、conversation 或 raw override。
- 更改 Provider 显示名、模型显示名或 `vendorHint` 不改变 wire request。

### 5.6 PreparedDispatch 冻结

- `prepareDispatch` 使用假 repository/config 生成完整 user/placeholder 引用、ContextManifest、RequestSnapshot 和 WireRequest，但不启动网络。
- `ActiveRequestRegistry.start` 只接受 PreparedDispatch；开始后修改 UI、tracked preset 当前 revision、Provider 显示名或会话表单都不改变本 logical request。
- 请求预览、RequestSnapshot、每个自动 attempt 和 mock server 捕获的 URL/Header/Query/Body 来自同一冻结对象并具有相同 hash。

### 5.7 执行所有权与订阅

- 会话切换、路由切换和消息组件卸载只 detach subscriber，不调用 cancel。
- 没有聊天页面订阅时，registry 仍消费事件并持久化唯一终态；返回会话时恢复当前快照或 SQLite 结果。
- 一个 subscriber 抛错、销毁或重复 attach 不影响其他 subscriber 和持久化。
- conversation active status、assistant message status 和 request attempt status 分别断言，不能由一个状态推断另一个状态。

### 5.6 自动重试不变量

- 一个 logical request 可以有多个 request attempt，但只关联一个 assistant placeholder。
- 429 `Retry-After` 秒数和 HTTP-date 均被尊重；不存在 header 时使用 full jitter。
- 总预算包含 initial attempt、后续尝试、排队、退避和 `Retry-After`。
- 每次自动 attempt 的 connection、endpoint、protocol profile revision、模型、ContextManifest、context hash 和 body hash 相同。
- 400/401/403/404/422、参数错误、模型不存在和用户取消不重试。
- HTTP 200 内嵌错误只有精确结构化规则/allowlist 命中时重试。
- response id、reasoning、text、tool、source/citation 任一出现后断流，不自动从头重发。
- 等待中取消不会多启动一次 attempt，不遗留 timer。
- 已完成客户端工具不会因 continuation 重试再次执行。
- 用户手动重新生成创建新 sibling/snapshot，自动 attempt 不创建。

退避测试使用 fake clock 和确定性随机源；断言 full jitter 的合法范围和调用次数，不把生产随机值硬编码进 snapshot。

## 6. 协议 codec 与 profile 测试

每个内置 codec/profile 至少覆盖：

- 最小文本请求。
- system prompt。
- 多轮文本。
- 工具调用/结果历史。
- 多个并行工具调用。
- thinking/reasoning 参数。
- 图片/附件能力不支持时的显式错误或规范转换。
- text delta、thinking delta、usage、finish reason。
- Provider response id/anchor。
- 非 2xx、流内 error、未知事件、JSON 分片。
- retryable 分类、`Retry-After` 解析和 Provider 特有内嵌错误映射。
- 用户取消。

跨品牌和混合端点必须额外覆盖：

- 同一连接的 `:443` 使用 OpenAI Responses，`:8443` 使用 Anthropic Messages。
- 名为 Gemini 或 Claude 的模型通过 OpenAI Chat/Responses profile。
- 任意模型通过 Anthropic Messages 或 Gemini profile。
- 自定义 JSON/SSE profile 的声明式请求、事件和工具 mapping。
- endpoint/profile/model 名称变化不改变 wire format，只有显式配置变化才改变请求。

序列化测试使用 golden fixture 时，应允许通过明确审阅更新，不能随依赖升级自动重写全部预期。

## 7. 流式测试

- 1 byte 或随机边界分片。
- 多事件合并在一个 chunk。
- 空 data、注释和 heartbeat。
- reasoning/text/tool/source 交错。
- tool args delta 的不完整 JSON。
- done 与 HTTP EOF 不同顺序。
- 取消与 done 同时发生，终态只写一次。
- 错误后 Channel、timer、reader 和 running map 清理。
- `timeoutMs` 对连接/首包和活动流使用 paused/fake time 分别验证，测试不依赖长时间真实 sleep。
- fake 与真实 Tauri bridge 的 `startStream()` 在 terminal 事件和平台命令都完成前保持 pending；结构化错误 resolve，IPC/Channel 失败 reject。
- waiting_retry 倒计时、停止和下一 attempt 与 done/cancel 竞态只收敛一次。
- 30ms 批处理不改变事件顺序。
- 大 batch 不阻塞停止操作。

## 8. 数据库测试

- 新库初始化。
- 每个历史 schema fixture 迁移。
- 事务回滚。
- parent 环和跨会话 parent 检测。
- conversation 与唯一虚拟根同事务创建；内容节点 parent 非空，active leaf 不能指向根。
- 首轮 user sibling 共享虚拟根，分页结果不影响首轮识别；根不进入上下文、FTS 或正文导出。
- 分页无重复/遗漏。
- pending 恢复。
- artifact hash 和缺失。
- 导入导出 round trip。
- FTS 与回退。
- provider_connection、provider_endpoint、protocol_profile、model 和 compatibility probe round trip。

## 9. 组件与无障碍测试

- 模型名超长、未知 Provider、窄窗口。
- 参数 schema 控件和覆盖标记。
- 多端口端点比较、协议 profile 编辑、显示品牌与协议不一致状态。
- compatibility 的 unknown/effective/ignored/rejected/translated 状态和证据入口。
- 思考块流式/完成/无内容。
- 工具 pending/success/failure/denied/cancelled。
- source/citation 去重和链接。
- 上下文超限面板。
- 键盘导航、焦点返回、`aria-expanded`、`aria-live`。
- reduced motion。
- 深浅主题。
- 核心 `data-ui`/`data-slot` token 存在且唯一职责清楚；定位不依赖 Tailwind class、偶然 DOM 层级或本地化文案。

组件测试关注用户行为，不对大量 Tailwind class 做脆弱快照。

## 10. E2E 场景

### E1 首次配置

启动干净数据目录，添加一个连接及两个不同端口的假端点，分别绑定 OpenAI 与 Anthropic profile，配置虚构认证值，添加未知模型并开始会话。

### E2 基础流式

发送消息，看到 thinking/text 流，停止按钮可用，完成后重启应用历史仍在。

### E3 工具连续性

第一轮 mock 工具返回 canary，第二轮请求由 mock server 断言工具结果存在，再返回基于 canary 的答案。

### E4 参数

设置 schema `xhigh`，把“努力程度”映射到自定义 path，再用会话 `extra_body` 覆盖模型值；请求预览和 mock server 同时验证值、路径和来源。

### E5 取消与恢复

在 reasoning、tool 和 text 三个不同阶段取消，重启后消息为 interrupted，可重试形成新分支。

### E6 搜索与来源

流式返回多次搜索、重复来源和引用。完成后 reload，时间线与来源保持。

### E7 长会话

加载 seed 会话，滚动、切换、继续生成并检查无明显卡顿和 DOM 数量上限。

### E8 导出导入

导出包含连接/端点/profile revision、模型 schema、兼容探测、分支/工具/附件清单的会话，在新数据目录导入并可继续上下文构造。

### E9 自动重试

mock server 先返回两次 429，再返回成功流。断言 UI 显示 attempt、原因和倒计时；最终只有一条 assistant 消息和一个 RequestSnapshot，但存在三个 request_attempt。再分别验证等待中停止、超过总预算、部分 reasoning 后断流和客户端工具 continuation 不重复执行。

### E10 后台会话与重新附着

会话 A 开始流式后切换到会话 B，确认 A 没有收到 cancel；A 在无页面订阅时继续并完成持久化。再次打开 A 时显示 registry 当前快照或 SQLite 完成结果，且 conversation/message/attempt 三层状态一致。

## 11. 性能测试

遵循 [性能预算](./PERFORMANCE_BUDGET.md)。自动输出至少包括：

- 启动/打开/切换耗时。
- 输入延迟。
- DOM 节点和 render 次数。
- stream batch 频率。
- 内存采样。
- SQLite 查询耗时。

开发构建与发布构建分开记录，不能把 DevTools 打开的内存直接和发布阻断线比较。

## 12. 参数兼容性与探测测试

至少覆盖：

- endpoint 明确返回 400/422 的 `rejected` 参数。
- endpoint 返回成功但官方明确说明无效的 `accepted_ignored` 参数。
- 中转站将字段改写为上游字段且有证据的 `translated` 参数。
- 请求成功但无法观察效果时保持 `unknown`，不误标 `accepted_effective`。
- 相同 model id 在不同端点、端口、API version 和 profile revision 上保存独立结果。
- profile 或 API version 更新后旧探测被标记为可能过期。
- 默认发送遇到参数错误时不自动删字段重试；自动 retry 的 wire request hash 保持不变。
- tracked preset 升级只更新未覆盖字段并显示冲突 diff；detached fork 不随内置 revision 改变，重新跟踪必须经过预览。

## 13. 真实 API 冒烟

发布候选使用用户自有测试配置执行，不把 key 提交到仓库。至少验证：

- 一个 OpenAI Chat Completions 兼容端点。
- 一个 Responses 兼容端点，若该模式进入当前发布。
- 一个 Anthropic Messages profile 端点。
- 一个 Gemini generateContent 或 Interactions profile 端点。
- 一个未知模型或私有网关。
- 一个显示品牌与协议不一致的端点，例如 Gemini 模型经 OpenAI 兼容 profile。
- 一个启用自动重试的 OpenAI 兼容中转站场景；记录 endpoint/profile、attempts 和结构化错误结果。
- 一个 Grok reasoning/search 场景。
- 至少一个参数拒绝探测；若官方文档明确存在忽略行为，再验证其状态不会被误记为 effective。

报告记录 endpoint/profile/API version、模型 ID、参数 wire path、结果、证据类型和时间。

## 14. 质量命令

Phase 1 已在根 `package.json` 提供以下命令：

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm test:contracts
pnpm test:performance
pnpm build
pnpm verify
```

Rust 验证至少包含：

```text
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

`pnpm verify` 当前串联 format、lint、typecheck、Vitest、`DesktopBridge` 契约、前端构建、初始 bundle 门禁、Playwright、Rust fmt/clippy/test 和第三方许可证清单一致性。Tauri 原生窗口和安装包仍单独用 `pnpm tauri dev --no-watch` 与 `pnpm tauri build --debug` 验证，避免把长时间平台打包强制塞进每次本地增量检查。

## 15. Definition of Done

一个功能只有同时满足以下条件才算完成：

- 规格中的主流程和错误流程已实现。
- 关键逻辑有自动化测试。
- 与 Provider/上下文/数据相关的行为有线协议或数据库级证据。
- 自动重试相关行为有 attempt 级数据库记录、fake-clock 契约和线协议 body hash 证据。
- 相关文档状态更新。
- 已按 Cherry 双文档参考指南记录本任务实际读取的用户/开发者文档、采用项和 Eternal Chat 差异。
- lint、typecheck、测试和构建通过。
- 无真实凭据、未审阅依赖和无关改动进入共享开发资产。
- 性能或兼容性风险按影响运行对应门禁。
- 用户可见错误和空状态完成。

## 16. 发布门禁

MVP 发布前必须全部通过：

- 工具结果跨轮 canary。
- 未知模型 `xhigh`。
- Chat Completions 与 Responses 双端点基础聊天。
- 同一连接多端口、多协议和显示品牌/协议不一致场景。
- 自动重试 429/5xx/网络矩阵、`Retry-After`、取消、总预算和部分输出禁重试。
- GPT/Grok/Gemini/Claude reasoning/tool preset fixture。
- OpenAI Chat、Responses、Anthropic Messages、Gemini 和自定义 profile 基础契约。
- ignored/rejected/unknown/translated 参数兼容 fixture 与最小探测。
- 数据迁移和导入导出。
- 取消/断流/重启恢复。
- PreparedDispatch 冻结、页面 detach 不取消、重新 attach 和 subscriber 故障隔离。
- 虚拟根、首轮 sibling 和 active leaf 数据不变量。
- tracked preset/detached fork 更新与迁移 fixture。
- 核心 UI 语义 token 契约。
- 1000 条性能场景。
- Windows 主平台完整 E2E。
- 计划支持的其他平台冒烟。
- 当前文档基线、相对链接、标题锚点和官方来源检查。

任何“仅人工看起来正常”的结果不能替代上述阻断测试。
