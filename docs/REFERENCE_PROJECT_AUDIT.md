# 参考项目审阅

## 1. 审阅目的

本文件记录对 `Other project references` 中两套源码及 Cherry Studio 双文档的实际审阅。结论用于改进本项目的行为契约和开发顺序，不代表复制其实现，也不把参考项目当前快照的状态当作永久事实。长期使用规则和任务映射见 [Cherry Studio 双文档参考指南](./CHERRY_STUDIO_REFERENCE_GUIDE.md)。

用户已确认 Eternal Chat 计划开源：Cherry Studio 的用户文档和开发者 `docs` 是长期主要外部参考，NBSearch 可以作为相关体验的默认设计参考；二者都只提供可观察行为、设计思想和工程契约，不授权复制实现。发布 README 必须鸣谢，具体鸣谢文本见 [鸣谢与参考说明](../ACKNOWLEDGEMENTS.md)。

审阅重点：

- 消息与工具结果如何进入下一轮请求。
- 模型能力和推理参数如何决定。
- 流式思考、搜索、工具和信源如何解析与展示。
- 数据持久化、取消、恢复和性能复杂度。
- 测试和许可证边界。

## 2. Cherry Studio 快照

路径：`Other project references/cherry-studio-main`

审阅到的 package 版本为 `2.0.0-beta.1`，本地 `docs` 有 105 份文档，同时存在 v1 与 v2 重构结构。它是大型 Electron 应用，包含多窗口、AI runtime、Provider registry、MCP、知识库、调度、数据系统和大量依赖。本地副本没有 `.git` 元数据；2026-07-27 最终在线复核到 `main` 为 `33fe2d579ca5f029b99eaab8a81936576cd3a055`，比本轮较早读取的 `517d5086ff17c3e28747bc5170a4a81d3a14e134` 前进 2 个提交且未改动 `docs/` 或 `AGENTS.md`。本地 docs 索引与在线版本仍存在轻微差异，后续以任务相关在线章节复核。

### 2.1 用户文档与开发者文档的职责

- 用户文档入口：<https://docs.cherryai.com.cn/>，用于用户任务、设置流程、默认值解释和功能发现。
- 开发者文档入口：<https://github.com/CherryHQ/cherry-studio/tree/main/docs>，尤其用于 AI 主链、stream manager、Provider/adapter、消息树、数据、UI 语义和测试。
- 开发者 docs 是本项目首要外部工程范本；用户文档是首要外部体验范本；官方 API 文档仍然优先决定 Provider wire 事实。
- 本项目先完成已经确定的核心聊天、工具连续性、参数透传、请求尝试和数据真实性，再按路线吸收 Cherry-only 内容。

### 2.2 值得借鉴

- 成熟三栏信息架构和消息操作密度。
- Provider/模型配置对普通用户较友好。
- 消息块、分支、流管理、错误和多模型等问题有大量工程经验。
- 当前 v2 源码把 UIMessage 转换为 ModelMessage 的链路集中在可测试函数中。
- 当前快照已经有“回放已完成工具结果”的自动化测试。
- 当前 Provider registry 中已出现 Grok 4.20 多代理模型及 `xhigh` 等 effort 数据。
- 文档对主进程、renderer、数据、stream manager 和测试有明确分区。

重点审阅入口：

- `src/main/ai/messages/messageRules.ts`
- `src/main/ai/messages/__tests__/messageRules.test.ts`
- `src/main/ai/runtime/aiSdk/Agent.ts`
- `src/main/ai/streamManager/context/PersistentChatContextProvider.ts`
- `src/main/ai/utils/options.ts`
- `src/main/ai/runtime/aiSdk/params/buildAgentParams.ts`
- `src/shared/utils/model.ts`
- `packages/provider-registry/data/models.json`
- `docs/references/architecture-overview.md`
- `docs/references/ai/stream-manager.md`

### 2.3 用户实际遇到的关键问题

用户描述的已安装版本曾出现：工具结果在调用当轮返回，但后续请求没有把历史 tool block 转成模型可见 tool result；UI/数据库看起来保留，模型却只看到助手文本。该问题的危险性成立，与当前参考快照是否已经修复无关。

当前 2.0 beta 源码已经出现相关重构和测试，因此本审阅**不能证明最新版仍有同一缺陷**。正确结论是：

- 该缺陷曾在真实使用中出现，且仅靠 UI 无法发现。
- 依赖第三方 SDK 默认转换并不足够。
- Eternal Chat 必须有自己的线协议 canary 测试，不能以参考项目“看起来修了”为验收。

### 2.4 第一轮共同规范审阅

与 Eternal Chat 当前文档重叠后，确认以下原则值得写入本项目规范：

- 发送准备与网络执行分离，准备结果可独立测试且在执行前冻结。
- active stream 的执行所有权不属于 React 页面；订阅者可以 attach/detach，终态持久化不依赖窗口仍存在。
- conversation 状态、assistant message 状态和网络 attempt 状态分别建模，单个 listener 失败不能阻断其他 listener 或持久化。
- 消息树需要统一根语义、parent 链和当前 active leaf 不变量，不能从分页结果猜测首轮消息。
- preset 需要区分跟踪内置 revision 的用户覆盖和脱离 preset 的完整 fork。
- 核心 UI 应有稳定的语义选择器，测试不能依赖 CSS class、偶然 DOM 层级或可本地化文本。

这些原则写入 Eternal Chat 当前核心规范时，不采用 Cherry 的 Electron、IoC 或 SDK 具体实现。

### 2.5 需要规避

- 体量和依赖过重，不适合本项目早期复制。
- 多套新旧 runtime 并存会增加理解和回归成本。
- 使用 registry/capability 数据驱动 reasoning 是好方向，但如果 UI 完全由目录条目决定，目录外模型仍可能失去参数入口。
- `ignoreIncompleteToolCalls` 等 SDK 选项可能方便兼容，却也可能把损坏历史静默删除；本项目必须先有产品策略再调用。
- 大型 IoC、调度器、知识库、agent 和多窗口系统不应进入核心 MVP。

### 2.6 许可证

根目录 `LICENSE` 是 GNU AGPL v3。设计思想和公开协议可以研究，但源码、组件、图标和素材不得直接复制到本项目并忽略许可后果。本项目应从零实现。

即使 Eternal Chat 后续选择兼容的许可证，也不自动授权复制 Cherry Studio 的品牌、素材或任意实现。若未来确需代码层复用，必须单独取得法律/许可结论和用户明确决定；当前范围不允许。

## 3. NBSearch Tauri migration 快照

路径：`Other project references/NBSearch-feat-tauri-migration`

审阅到的 package 版本为 `0.2.5`，技术栈为 Tauri 2、React 19、TypeScript、Zustand 和 SQLite。项目明显针对特定 Grok 网关和产品体验构建，完成度与通用客户端不同。

### 3.1 值得借鉴

- 将 reasoning layout、tool usage、tool result、card attachment、source 和 response id 建模为结构化事件。
- 流式 accumulator 不只拼最终文本，还收集搜索元数据、来源、研究步骤和计时。
- UI 区分流式思考状态与完成后的历史详情。
- 搜索来源支持标题、URL、预览、favicon、作者、X handle 和时间。
- response id、previous response id 和 session anchor 被显式持久化。
- 有断流、空闲超时、恢复、幂等键和 pending message 恢复测试。
- reasoning/search 事件刷新后仍能从 SQLite 恢复。

这些方向可以作为 Eternal Chat Grok 体验的默认设计参考，不要求每个相同交互都重新论证；但任何采用仍须映射到本项目的统一 StreamEvent、MessageBlock、RequestSnapshot 和性能预算。

重点审阅入口：

- `src/domain/chat/types.ts`
- `src/infrastructure/chat/chunk-parsers-reasoning-events.ts`
- `src/infrastructure/chat/gateway-stream-accumulator.ts`
- `src/infrastructure/chat/gateway-stream-transport.ts`
- `src/infrastructure/chat/gateway-turn-request-builder.ts`
- `src/features/chat/chat-stream-runtime.ts`
- `src/components/markdown-content/structured-reasoning-panel.tsx`
- `src/components/markdown-content/structured-reasoning-tools.ts`
- `src/components/chat-message-citations.ts`
- `src/infrastructure/storage/sqlite/repository.ts`

### 3.2 需要规避

- 很多逻辑和字段针对特定网关，不能直接当作通用 Provider 协议。
- 部分模型显示名称通过 model id、description 和字符串包含关系推断，历史 memo 也记录过 Grok 4.20 Expert/Max 被误映射的问题。这证明显示和能力不能依赖粗粒度名称启发式。
- 使用 Provider `previous_response_id` 很适合特定网关，但通用客户端必须同时维护本地规范历史，并验证 anchor 失效行为。
- 项目包含 feed、语音、图片和网关恢复等较多产品特有功能，不进入 Eternal Chat MVP。
- 一些复杂时间线和 UI 组合可以后续迭代，第一版先保证事件不丢和状态正确。

### 3.3 许可证与鸣谢

根目录未发现 `LICENSE`、`COPYING` 或 `NOTICE` 文件。没有许可证不等于可以自由复制，默认视为保留全部权利。本项目不得复制其源码、样式、SVG 或品牌素材。

由于用户明确要求发布时鸣谢，根 README、About 页面和发行归档应保留 NBSearch 名称及本项目鸣谢链接；鸣谢不等同于代码许可证，也不表示双方存在隶属关系。

## 4. 采用与拒绝矩阵

| 参考思想 | 结论 | Eternal Chat 做法 |
|---|---|---|
| 三栏聊天布局 | 采用 | 按本项目当前 UI/UX 规范重新设计和实现 |
| 消息块与分支 | 采用 | 建立本地规范块和 parent 分支 |
| 发送准备与网络执行分离 | 采用 | 先冻结不可变 `PreparedDispatch`，再由唯一执行协调器启动请求 |
| active request 脱离页面生命周期 | 采用 | 应用根级 registry 持有执行与持久化；页面只 attach/detach subscriber |
| conversation/message/attempt 状态分层 | 采用 | 分别建模会话活动、assistant 消息和网络 attempt，listener 失败相互隔离 |
| 消息树虚拟根 | 采用 | 每个会话创建无内容唯一根，统一首轮、sibling、分支和路径查询语义 |
| preset 跟踪与脱离 | 采用 | 用 `tracked` binding 保存 revision + override，用 `detached` 保存完整 fork |
| 稳定 UI 语义契约 | 采用 | 核心边界使用显式 `data-ui`/`data-slot`，测试不依赖 class 或可见文案 |
| 动态 Provider 参数 | 采用并加强 | 用户 schema 和 extra_body，不由目录门控 |
| 工具结果回放测试 | 强制采用 | 跨轮 canary 捕获实际请求 |
| 结构化 reasoning/search | 采用 | 统一 StreamEvent + 持久化块 |
| response anchor | 条件采用 | 仅 codec/profile 验证后启用，禁止 final-text-only 回退 |
| 断流、幂等和 pending 恢复思路 | 条件采用 | 用 logical request / request attempt 从零实现，不复制网关专有代码 |
| 大型 Electron/IoC/调度架构 | 拒绝 | Tauri + 小型 TS 分层 |
| 全部功能一次进入 MVP | 拒绝 | 先核心聊天，后续模块化 |
| 模型 ID 硬编码能力 | 拒绝 | 用户配置优先，目录只是建议 |
| UI 工具卡片代替模型 tool result | 拒绝 | UI 与线协议都来自同一权威块 |
| 复制源码、组件、图标或素材 | 拒绝 | 只吸收思想、行为契约和公开协议 |

## 5. 由审阅导出的本项目要求

1. 工具连续性必须在 codec/profile 序列化之后捕获线协议请求验证。
2. Provider 目录和模型识别不允许禁用用户参数。
3. reasoning/search 事件从 transport 到 SQLite 全链路结构化。
4. UI 必须区分 Provider 返回内容、本地计时和推断信息。
5. server-side anchor 是优化/能力，不是本地历史的替代品。
6. 错误不能吞成空答案。
7. 参考实现中的恢复和幂等思路可以按需要采用，但不提前引入特定网关复杂度。
8. 性能问题通过虚拟化、合批和所有权清理解决，不通过隐藏裁剪模型上下文解决。
9. NBSearch 的 Grok 流式/搜索展示可以作为默认参考，但所有代码、样式和素材从零实现。
10. 开源发布必须完成 NBSearch 鸣谢、项目许可证决定和第三方许可/NOTICE 审阅。
11. 请求准备必须输出可独立测试、执行期间不可变的 `PreparedDispatch`；执行层不得重新读取 UI 或可变 preset 组装请求。
12. active request、终态持久化和自动 attempt 必须由应用根级 registry 管理；路由或组件卸载只解除订阅，不构成停止。
13. conversation、assistant message 和 request attempt 的状态、错误与诊断分别持久化；单个订阅者异常不得阻断其他订阅者或终态写入。
14. 每个 conversation 必须有唯一无内容虚拟根；所有内容消息都有 parent，根不进入 UI、上下文、FTS 或正文导出。
15. preset 必须区分 `tracked` 与 `detached`；内置 revision 更新不能覆盖 tracked override，也不能静默修改 detached fork。
16. 核心页面、消息、工具、状态和动作建立稳定的 `data-ui`/`data-slot` 契约，自动化测试不得依赖样式 class、偶然 DOM 层级或本地化文本。

## 6. 快照漂移

参考项目会继续变化。以后重新审阅时应记录：

- 当前 commit/tag。
- 相关文件是否重构。
- 用户实际安装版本与源码快照是否一致。
- 许可证是否变化。
- 旧结论哪些仍成立，哪些已被修复或取代。

不能用未来快照反向否定用户在旧版本中的真实问题，也不能用旧问题永久指控新版本仍存在缺陷。
