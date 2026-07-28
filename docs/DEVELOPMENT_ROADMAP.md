# 开发顺序与路线图

本文只保留当前阶段状态、退出条件和下一步。Phase 0-7 的逐轮任务、测试数量和历史退出证据已归档到 [Phase 8 审计前路线图快照](./archive/DEVELOPMENT_ROADMAP_PRE_PHASE_8_AUDIT.md)，需要追溯时再读取。规范性要求仍以各专题文档为准。

## 阶段状态

| 阶段 | 状态 | 当前证据 |
|---|---|---|
| Phase 0 文档与契约基线 | `verified` | 当前拆分规范、决策治理与功能规格库已建立 |
| Phase 1 工程脚手架与质量门禁 | `verified` | `c3326f3`；Windows/Tauri、统一质量命令和 ADR 0001 |
| Phase 2 Rust 通用流式管道 | `verified` | `cb1f6c6`、`d8989b2`；SSE、合批、取消、超时、错误与资源清理 |
| Phase 3 SQLite、消息块和可恢复状态 | `verified` | `ff56cca`；migration v1、repository、分支/恢复/分页 |
| Phase 4 ContextAssembler 与工具连续性 | `verified` | `d2d2c80`；parent 链、分支隔离、ContextManifest、双 OpenAI serializer 与 wire canary |
| Phase 5 OpenAI 兼容双端点最小聊天 | `verified` | `20029b1`；Chat/Responses 聊天、停止、恢复与本地 fixture，真实 Responses 冒烟另行记录 |
| Phase 5A 自动重试与请求尝试 | `verified` | `20029b1`；有界重试、attempt 持久化、冻结请求、取消与部分输出禁重试 |
| Phase 6 全量端点、能力、参数与工具目录 | `verified` | `20029b1`；五层配置、动态 schema、官方 preset、mixed relay 与兼容性证据 |
| Phase 7 结构化思考、搜索和信源 | `verified` | `7c20d22`；reasoning/tool/source/citation 时间线、取消保留与 reload |
| Phase 8 核心聊天交互与长对话性能 | `verified` | 179 项 Vitest、双视口 E2E、固定性能 seed、资源曲线与交互门禁通过 |

阶段状态描述技术纵切是否完成，不等于相邻功能规格的完整 MVP 已全部完成。例如 Phase 4 已验证，但跨所有协议的上下文连续性仍依赖 Phase 9；Phase 6 已验证，但 Provider 管理完整 MVP 仍有生命周期工作。

## Phase 8 当前范围

### 已实现并通过退出门禁

- `virtua` 动态高度列表、50 条分页、300 条 UI 内存窗口、加载旧页锚点和上滑暂停吸底。
- Markdown completed cache、约 50ms 流式节流，以及 Shiki/KaTeX 按内容动态加载。
- 编辑形成新分支、重新生成、user/assistant sibling 切换和 ContextAssembler 路径隔离。
- 会话搜索、归档/恢复、`Ctrl/Cmd+K` 搜索和 `Ctrl/Cmd+N` 新建。
- 确定性 1000 条 active path、20 个 branch、5 万字符、20 个代码块、50 个 thinking、100 个 tool call seed。
- 可拖拽侧栏的 pointer capture、1:1 跟随、释放速度传入 spring、动量投影、rubber-band、键盘替代和 reduced-motion 立即收敛。
- 100 次会话切换按 0/20/40/60/80/100 次分段回收采样；最终堆比基线低约 0.11 MiB，采样峰值增长约 0.79 MiB，远低于 20 MiB 阻断线。

### 2026-07-28 收口证据

- Vitest 全套连续两次为 41 个文件、179/179 通过；安全链接仍验证 raw HTML 转义、仅 HTTP(S) 可交互和 `javascript:` 不生成链接。此前 176/177 是异步渲染与重型 SQLite 用例在全套资源竞争下的等待预算过紧，不是安全行为失效。
- Playwright 为 21 通过、1 跳过；跳过项是小窗口重复执行精确堆采样，桌面项目已覆盖同一 100 次切换场景。最终 verify 的桌面/小窗口输入延迟 p95 约 40.0ms/27.5ms，均低于调整后的 60ms 工程目标和 150ms 阻断线。
- 快速滚动的中位帧间隔约 7.1ms/7.0ms，连续低于 40 FPS 的最长区间均为 2 帧；DOM 行数、元素上限、代码块边界和横向溢出门禁同时通过。
- 历史消息 `data-render-count` 在连续输入期间保持不变；Markdown LRU 上限、流式 timer 卸载清理、主题 media listener 清理、侧栏动画停止和请求 registry timer/订阅清理均有自动化断言。
- 100 次切换的 6 点曲线中 JS listener 始终为 275，document 数保持 2，最终 DOM node 仅比基线多 35；未出现随切换累积的 listener、DOM 或回收堆增长。
- `ResizeObserver loop completed with undelivered notifications` 只在 virtua 动态高度快速滚动时出现。E2E 在所有页面精确捕获并计数该 Chromium 延迟投递告警，阻止其污染未处理错误日志，同时仍让任何其他 `pageerror` 失败；出现告警后布局、DOM 上限、滚动和资源曲线均通过，因此不再作为 Phase 8 阻断项。
- 2 小时运行和 30 分钟长流属于发布候选 soak，不再作为阶段开发硬阻断；发布前仍须按性能规范执行，不能因 Phase 8 已验证而删除。

## Phase 8 退出条件

1. 完整 `pnpm verify` 稳定通过，不能依赖失败用例单独重跑：`passed`。
2. 双视口输入延迟 p95、DOM 上限、布局和初始包预算通过：`passed`。
3. 固定 seed 覆盖 1000 条、5 万字、20 代码块和分支路径，UI 窗口不改变 ContextManifest：`passed`。
4. 快速滚动和反复切换后，回收堆、listener、DOM、timer 和 Markdown LRU 不持续累积：`passed`；发布候选长时 soak 保留。
5. pointer-down、1:1 拖拽、速度继承、动画可打断、空间一致和 reduced motion 完成人工与自动化验收：`passed`。

## 后续阶段

| 阶段 | 目标 |
|---|---|
| Phase 9 | Anthropic、Gemini 与 custom codec；跨品牌/混合协议验证 |
| Phase 10 | MVP 收口、导入导出、平台与发布门禁 |
| Phase 11-13 | V1 分支树、附件/视觉、提示词、统计、i18n 与桌面集成 |
| Phase 14-18 | V2 模块运行时、MCP、知识库、加密同步与外部插件 API |

后续阶段的详细历史任务清单保留在归档快照中；恢复某阶段时，应先按当前规范重新审阅，不能把旧计划直接当作最新事实。

## Phase 5A: 自动重试与请求尝试

本节保留稳定锚点供功能规格引用。Phase 5A 已验证，当前规范与证据见 [自动重试与请求尝试](./features/16-automatic-retry.md)。
