# Cherry Studio 双文档参考指南

## 1. 定位

本文件把 Cherry Studio 的两套文档纳入 Eternal Chat 的长期外部参考制度：

- 用户向文档用于观察成熟客户端的用户任务、术语、配置流程、默认值解释、错误提示和功能发现路径。
- GitHub `docs` 开发者文档用于工程架构、AI 调用链、流式生命周期、消息树、数据边界、测试和诊断设计，是当前最重要的外部工程参考。

它们是参考生命线，不是 Eternal Chat 的上位规范。Eternal Chat 的产品差异化、明确的 MVP 边界、`deferred` 决定和用户最新指令仍然优先。Cherry 文档中的 Electron、AI SDK、IoC、数据系统和现有产品命名不能直接替换本项目已经接受的 Tauri、Rust 管道、协议解耦和本地优先设计。

## 2. 参考来源

| 来源 | 地址/路径 | 主要用途 | 使用规则 |
|---|---|---|---|
| Cherry 用户文档 | <https://docs.cherryai.com.cn/> | 用户流程、功能发现、配置说明、默认值解释和可观察体验 | 产品流程或 UI 设计有重叠时优先阅读相关页面；不把页面中的 Provider 事实替代官方 API 文档 |
| Cherry 开发者文档（在线） | <https://github.com/CherryHQ/cherry-studio/tree/main/docs> | 核心工程和架构参考 | 当前任务涉及相同领域时先查 `docs/README.md` 和对应 reference，再查源码验证细节 |
| Cherry 开发者文档（本地） | `D:\code\Eternal Chat\Other project references\cherry-studio-main\docs` | 离线快速阅读、全文检索和稳定快照 | 本地副本只读；没有 Git 元数据时不能把它假定为某个确定 commit |

### 2.1 当前快照记录

- 本地 `package.json` 版本：`2.0.0-beta.1`。
- 本地 `docs` 文件数量：105 份 Markdown/MDX 文档。
- 核对日期：2026-07-27。
- 本地副本未发现 `.git` 元数据；不能从本地确认精确 commit。
- 同日最终在线复核到的 `main` commit：`33fe2d579ca5f029b99eaab8a81936576cd3a055`；它比本轮较早读取的 `517d5086ff17c3e28747bc5170a4a81d3a14e134` 前进 2 个提交，比较结果未包含 `docs/` 或 `AGENTS.md` 变更。
- 本地 `docs/README.md` 与在线 `main` 版本存在轻微差异；当任务依赖最新规则时，必须重新读取在线版本并记录核对日期。

## 3. 权威边界

按任务类型应用以下顺序：

1. 用户最新、明确的要求。
2. Eternal Chat 当前规范、已接受决定和明确的 Phase 范围。
3. Provider、模型、API、端点和错误行为的官方最新文档。
4. 与当前任务直接相关的 Cherry 开发者文档和用户文档。
5. Cherry 源码、其他参考项目和一般外部资料，仅用于验证或补充，不得自动变成规范。
6. Eternal Chat 当前实现，不能反向授权改变上层决定。

Cherry 开发者文档在工程设计上是首要外部范本，Cherry 用户文档在用户流程和产品体验上是首要外部范本；两者都不能覆盖第 1 至 3 项。若 Cherry 的可观察行为与 Eternal Chat 的差异化决定冲突，记录差异并按 Eternal Chat 决定实现。

## 4. 每个任务的参考流程

开始实现前按以下顺序执行：

1. 阅读 Eternal Chat 的基线、相关功能规格、架构/数据/测试门禁，明确本任务的目标、不做什么和验收标准。
2. 在本指南的映射表中找到对应 Cherry 开发者文档；先读该文档入口和相关子文档，不要无目的遍历整个目录。
3. 若任务改变用户流程、设置、按钮、默认值或错误文案，再读取 Cherry 用户文档的对应页面。
4. 将观察结果分成四栏：`共同契约`、`Eternal Chat 差异`、`可采用改进`、`明确拒绝/后续`。
5. 对可采用改进先更新 Eternal Chat 规范和测试，再写代码；不得先复制实现再让文档追认。
6. 实现从零完成，只借鉴行为契约、边界、不变量和验证方法。不得复制源码、组件、图标、样式、图片、品牌、文案或专有实现。
7. 在完成报告中记录本次实际读取的 Cherry 路径、在线核对日期、采用的原则和保留的差异。

推荐记录格式：

```text
Eternal Chat 文档：
Cherry 用户文档：
Cherry 开发者文档：
共同契约：
Eternal Chat 差异：
本次采用：
本次拒绝或后续：
是否需要更新测试/路线：
```

## 5. 当前核心映射

| Eternal Chat 领域 | 首读 Cherry 开发者文档 | 用户向补充 | 当前吸收方向 |
|---|---|---|---|
| 总体架构与边界 | `docs/references/architecture-overview.md`、`main-process-architecture.md`、`renderer-architecture.md`、`shared-layer-architecture.md` | 视具体流程选择 | 分层、依赖方向、跨进程边界；不复制 Electron/IoC |
| AI 主链 | `docs/references/ai/README.md`、`core-architecture.md`、`agent-loop.md` | 对话界面页面 | 发送准备、执行所有权、持久化与 UI 订阅分离 |
| 流式与恢复 | `docs/references/ai/stream-manager.md`、`ipc-transport.md`、`observability.md` | 对话界面、设置页面 | active request、attach/detach、终态一次性收敛和可诊断性 |
| Provider/端点 | `docs/references/ai/provider-resolution.md`、`adapter-family.md`、`params-pipeline.md` | 模型服务、模型服务设置 | endpoint 级协议身份、分阶段参数管线、用户覆盖优先 |
| preset 与覆盖 | `docs/references/data/best-practice-layered-preset-pattern.md`、`preference-overview.md` | 模型服务设置 | tracked preset 与 detached fork 分离，更新不覆盖用户决定 |
| 消息与分支 | `docs/references/chat/message-tree.md`、`message-system.md`、`chat/adapters.md` | 对话界面 | 根语义、parent 链、sibling 和当前路径不变量 |
| 数据与事务 | `docs/references/data/README.md`、`database-patterns.md`、`data-ordering-guide.md`、`data-pagination-guide.md` | 需要具体数据流程时读取 | 权威数据源、事务边界、稳定游标和可恢复修复 |
| UI 稳定契约 | `docs/references/ui-semantic-contract.md`、`chat/conventions.md` | 对话界面、个性化设置 | 显式 `data-ui`/`data-slot` 语义边界；不依赖 class 或可见文案测试 |
| 测试与发布 | `docs/guides/test-plan.md`、`docs/references/testing/database-testing.md` | 反馈与设置页面 | 行为证据、数据库 fixture、发布门禁；命令以 Eternal Chat 为准 |
| 诊断与日志 | `docs/guides/diagnostics.md`、`docs/guides/logging.md`、`docs/references/ai/observability.md` | 诊断相关页面 | 结构化诊断和资源清理；安全专题仍按 Eternal Chat 路线 |

## 6. 第一轮已经吸收的改进

本轮文档优化只吸收与当前 MVP 直接相交的原则：

- 发送流程先产生可独立测试的不可变 `PreparedDispatch`，再交给唯一执行协调器；UI 不直接启动或拼接 Provider 请求。
- 流执行、持久化和 UI 订阅分离。路由切换或组件卸载只解除订阅，不等同于用户点击停止；终态持久化不依赖页面仍然存在。
- 会话消息使用统一的虚拟根语义，首轮消息、重发和分支查询不再依赖“父节点是否加载到当前页面”猜测。
- preset 明确区分跟踪内置 revision 的用户覆盖和完全脱离的用户 fork；更新、重置和冲突预览有可追踪语义。
- 核心页面和动作使用稳定的显式 `data-ui`/`data-slot` 语义标记，测试和未来个性化不依赖 CSS class、DOM 偶然结构或本地化文案。
- 请求状态、消息状态和 attempt 状态分开，单个订阅者或渲染错误不能阻断持久化和其他消费者。

## 7. 当前不自动采用的内容

以下内容即使在 Cherry 文档中成熟，也不会因为参考关系自动进入当前 MVP：

- Electron 主进程、preload、窗口池和 Cherry 专用 IoC/lifecycle 容器。
- `@ai-sdk/*` 作为 Eternal Chat 核心协议主链的强制依赖。
- Cherry 的助手/话题层级、Agent session、频道适配器、知识库、插件市场、调度器、托盘和多窗口完整产品。
- 由模型目录或 Provider 名称自动隐藏参数、能力或工具。
- 复制 Cherry 的源码、测试、SVG、图标、样式、图片、品牌或用户文案。

这些内容可以在后续路线中按用户明确优先级建立独立规格；在此之前只作为参考资料，不得改变当前 Phase 1 和 MVP 退出条件。

## 8. 漂移与许可

Cherry `main`、用户文档和本地快照都会变化。每次采用新的外部结论时记录来源路径、核对日期和适用版本；发现本地与在线文档不一致时，以在线相关章节复核后再更新 Eternal Chat 文档。Cherry Studio 使用 AGPL-3.0；参考文档和公开行为可以研究，但不因此获得复制代码或素材的许可。详细许可边界见 [参考项目审阅](./REFERENCE_PROJECT_AUDIT.md) 和 [鸣谢与参考说明](../ACKNOWLEDGEMENTS.md)。
