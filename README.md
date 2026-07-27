# Eternal Chat

[GitHub：Timmyzzo/Eternal-Chat](https://github.com/Timmyzzo/Eternal-Chat)

Eternal Chat 是一个以“模型能力不被客户端偷偷削弱”为首要原则的现代 AI 对话桌面客户端。它同时强调高自由度：中转站、端口、协议、端点、模型能力、参数名、参数路径、工具描述和界面体验都可以由用户配置。项目使用 Tauri 2 作为桌面壳，React + TypeScript 负责界面和业务逻辑，Rust 仅承担通用流式网络管道。

当前仓库已完成 **Phase 1 工程脚手架与质量门禁**、**Phase 2 Rust 通用流式管道**、**Phase 3 SQLite、消息块与可恢复状态**和 **Phase 4 ContextAssembler 与工具连续性**：除 Tauri 2 + React 19 + TypeScript + Vite 工作区和通用 HTTP/SSE 管道外，现已建立 migration v1、10 张项目权威表、MessageBlock v1、权威 SQLite 当前分支读取、Provider 无关规范上下文、ContextManifest、OpenAI Chat/Responses 最小 serializer、最终请求 capture canary 和 lossless 预算预检。真实 Provider/API 调用、聊天纵切、流式 parser/reducer 和自动重试仍未开始，安全与隐私专题继续为 `deferred`。

## 项目要解决的问题

普通聊天客户端往往把“界面上保存了历史”误当成“模型下一轮真的看到了完整历史”。对于搜索、文件分析、数据库查询、MCP 和多步骤研究，这两者一旦不一致，模型就可能只根据上一轮回答里的残缺摘要继续推断，并以流畅、自信的方式产生难以察觉的错误。

Eternal Chat 将以下原则作为产品契约，而不是实现细节：

- 历史工具调用与工具结果必须在后续轮次中按 Provider 协议重新序列化，不能只保留在 UI 或数据库中。
- 默认不进行隐形上下文裁剪、自动摘要或无提示降级。超过模型限制时必须给出可见、可解释的处理选择。
- 内置模型目录只提供默认值，不能成为能力开关。未知模型同样可以配置 `reasoning_effort: xhigh` 等任意参数。
- Provider 的显示身份不决定协议。同一个名为 Gemini、Claude 或其他品牌的模型，可以由中转站通过 OpenAI Chat Completions、Responses、Anthropic Messages、Gemini 原生接口或用户自定义协议暴露。
- 每个端点独立配置 URL、显式端口、路径、协议 preset、认证、Header、Query、请求体、参数 schema、工具调用格式和响应映射；不能依赖模型名白名单或一套伪通用参数。
- 参数的“温度”“Top K”“努力程度/思考预算”等名称只是 UI 语义提示，实际 wire key、path、类型、值域和是否发送完全由用户或端点 preset 决定。
- 对 429、临时 5xx、连接失败和首包超时提供可配置自动重试；重试过程可见、可取消，收到有价值输出后默认不自动从头重发。
- 保存并展示 Provider 实际返回的思考、搜索、工具、信源、计时和用量事件，但不把未返回的内部思维过程伪装成“完整思考链”。
- 长对话的 UI 内存窗口与模型上下文是两套独立机制。UI 可以分页释放 DOM，模型上下文不能因此被偷偷删减。
- UI 与交互采用现代、克制、响应直接的设计：即时反馈、可中断动效、稳定空间关系、清晰层级和充分的个性化设置。

## 文档与决策优先级

旧版单体设计文档已经完成拆分使命并删除。当前权威顺序是：用户最新明确要求、当前拆分规范、与外部 API 事实相关的官方最新文档、已接受的决策记录、参考资料、最后才是实现细节。

Claude、OpenAI API、ChatGPT、Grok 和 Gemini 官方文档是持续更新模型、能力、参数、工具和端点 preset 的权威来源。内置资料必须记录来源、核对日期和 revision，但不能覆盖用户修改版本。完整规则见 [基线与决策治理](./docs/BASELINE_AND_DECISIONS.md) 与 [官方 API 兼容矩阵](./docs/OFFICIAL_API_COMPATIBILITY.md)。

Cherry Studio 的[用户文档](https://docs.cherryai.com.cn/)和 [GitHub 开发者文档](https://github.com/CherryHQ/cherry-studio/tree/main/docs)是本项目长期外部参考生命线：前者用于用户流程与体验，后者尤其用于 AI 主链、数据、流式、Provider、测试和工程边界。当前任务的适用范围、差异化决定和官方 API 事实仍然优先，完整使用规则见 [Cherry Studio 双文档参考指南](./docs/CHERRY_STUDIO_REFERENCE_GUIDE.md)。

- [Claude / Anthropic 官方文档](https://platform.claude.com/docs/zh-CN/get-started)
- [OpenAI API 官方文档](https://developers.openai.com/api/docs)
- [ChatGPT 产品文档](https://learn.chatgpt.com/docs)
- [Grok / xAI 官方文档](https://docs.x.ai/overview)
- [Gemini API 官方文档](https://ai.google.dev/gemini-api/docs)

## 当前实现优先级

在用户明确要求开始编码后，核心开发顺序为：

1. 按官方协议打通 OpenAI 兼容 Chat Completions 与 Responses 的基本聊天、流式、持久化和工具历史回放。
2. 完成适合 NewAPI 等中转站的[自动重试与请求尝试](./docs/features/16-automatic-retry.md)，优先处理 429、临时 5xx 和网络抖动。
3. 完成连接、端点和协议 profile 的解耦，以及全量动态参数、能力和工具 schema；GPT、Grok、Gemini、Claude preset 只是可编辑示例。
4. 完成结构化 reasoning、搜索链、信源和计时展示，再继续长对话 UI 打磨与其他 Provider 完整适配。

各家字段以 [官方 API 参数与工具兼容矩阵](./docs/OFFICIAL_API_COMPATIBILITY.md) 为当前内置 preset 依据，但用户 schema 和原始覆盖始终优先。

## 计划技术栈

| 层 | 选型 | 责任边界 |
|---|---|---|
| 桌面壳 | Tauri 2 | 窗口、插件、权限、打包与更新 |
| UI | React 19 + TypeScript + Vite | 全部界面和业务逻辑 |
| 样式与组件 | Tailwind CSS + shadcn/ui + Radix + lucide-react | 主题、无障碍和交互组件 |
| 状态 | Zustand | 按 selector 精准订阅，拆分历史与流式状态 |
| 数据 | SQLite + tauri-plugin-sql | 连接、端点、协议 profile、模型、会话、消息、快照和迁移 |
| 网络 | Rust reqwest + SSE 通用管道 | 发送最终 URL/Header/Query/Body、取消、超时、合批、回传原始事件 |
| Markdown | markdown-it + shiki + KaTeX | 缓存、节流和懒加载 |
| 长列表 | virtua | 动态高度虚拟化和分页窗口 |

技术选型、依赖准入和待验证项见 [技术选型与依赖策略](./docs/TECHNOLOGY_SELECTION.md)，详细分层和运行时边界见 [总体架构](./docs/ARCHITECTURE.md)。

## MVP 范围

MVP 必须形成一个可靠的完整闭环：

- 配置任意中转站及多个独立端点，包括不同协议、显式端口、路径、认证、Header 和 Query。
- 自定义模型、能力 schema、参数 wire key/path、模型级和会话级 `extra_body`、工具 descriptor 与响应映射。
- 创建会话并进行稳定的流式对话，支持停止、重试、编辑和分支。
- 对发送前阶段的临时故障执行有界自动重试，展示 attempt 次数、原因、`Retry-After` 和倒计时。
- 为 GPT、Grok、Gemini、Claude 提供可编辑的思考控制和 Provider 内置工具开关，不因模型不在目录中而禁用。
- 持久化文本、思考、工具调用、工具结果、信源、用量、错误和请求审计信息。
- 在下一轮请求中可靠回放当前分支的历史工具结果。
- 展示 Provider 返回的结构化思考、Grok 搜索过程、工具进度、信源和耗时。
- 对长会话进行分页、虚拟化、Markdown 缓存和 IPC 合批。
- 提供导入导出、搜索、主题、快捷键和基础诊断能力。

知识库、MCP、同步、语音和插件 API 作为后续可关闭模块，不进入最初的核心运行时。

## 文档导航

| 文档 | 用途 |
|---|---|
| [文档中心](./docs/README.md) | 全部文档索引、阅读顺序与权威级别 |
| [产品需求](./docs/PRODUCT_REQUIREMENTS.md) | 用户问题、范围、流程、功能优先级与产品验收 |
| [技术选型](./docs/TECHNOLOGY_SELECTION.md) | 已锁定技术栈、采用理由、未定事项、依赖准入和替换边界 |
| [总体架构](./docs/ARCHITECTURE.md) | 运行时边界、目录规划、依赖方向和端到端数据流 |
| [上下文与工具连续性](./docs/CONVERSATION_CONTEXT_AND_TOOLS.md) | 防止工具结果在下一轮消失的核心规范 |
| [Provider、端点与模型参数](./docs/PROVIDER_AND_MODEL_PARAMETERS.md) | 多端口/协议、动态 schema、未知模型、`xhigh` 和请求合并规则 |
| [官方 API 兼容矩阵](./docs/OFFICIAL_API_COMPATIBILITY.md) | GPT、Grok、Gemini、Claude 的思考字段、工具 descriptor 和官方来源 |
| [流式、思考与搜索事件](./docs/STREAMING_AND_REASONING.md) | SSE 事件、Grok 搜索链、信源、计时、取消与恢复 |
| [数据模型](./docs/DATA_MODEL.md) | SQLite、消息块、附件、迁移、导入导出和审计快照 |
| [UI/UX 规格](./docs/UI_UX_SPEC.md) | 三栏布局、关键页面、交互、无障碍和状态设计 |
| [性能预算](./docs/PERFORMANCE_BUDGET.md) | 长对话、内存、帧率、IPC、Markdown 和基准场景 |
| [安全与隐私](./docs/SECURITY_AND_PRIVACY.md) | 当前暂缓，记录后续恢复专题设计时的范围 |
| [测试策略](./docs/TEST_STRATEGY.md) | 单元、契约、集成、E2E、性能和发布门禁 |
| [开发路线](./docs/DEVELOPMENT_ROADMAP.md) | 从脚手架到 MVP/V1/V2 的依赖顺序和退出条件 |
| [参考项目审阅](./docs/REFERENCE_PROJECT_AUDIT.md) | Cherry Studio 与 NBSearch 的借鉴、风险和许可边界 |
| [Cherry Studio 双文档参考指南](./docs/CHERRY_STUDIO_REFERENCE_GUIDE.md) | 用户文档、开发者 docs 的长期参考规则、映射和采用边界 |
| [功能规格库](./docs/features/README.md) | 每项当前或规划功能的独立规格与状态 |
| [自动重试](./docs/features/16-automatic-retry.md) | 中转站 429/5xx/网络错误的 attempt、退避、重试边界和 UI |
| [贡献规范](./CONTRIBUTING.md) | 未来实现时的开发、测试、文档和 Git 工作流 |
| [鸣谢与参考说明](./ACKNOWLEDGEMENTS.md) | NBSearch、Cherry Studio 的参考范围与发布鸣谢 |

## 当前目录

```text
Eternal Chat/
├── README.md                         # 项目入口
├── ACKNOWLEDGEMENTS.md               # 开源鸣谢与参考边界
├── CONTRIBUTING.md                   # 开发协作规范
├── package.json                      # 前端、测试与统一质量命令
├── src/                              # React 应用与 TypeScript 平台边界
├── src-tauri/                        # 最小 Tauri 2 桌面壳
├── tests/                            # Web 层 E2E
├── docs/                             # 本项目详细文档与决策记录
└── Other project references/         # 只读参考源码，已从 Git 排除
```

## 参考项目边界

日常产品、协议、参数和 UI 设计应按 [Cherry Studio 双文档参考指南](./docs/CHERRY_STUDIO_REFERENCE_GUIDE.md) 读取当前任务相关的 Cherry 文档；不要求无目的遍历 105 份文档。`Other project references/` 中的参考源码仍只读，只有需要验证文档行为或比较具体实现时才进入源码目录。

- `cherry-studio-main` 的 `docs/` 是本项目长期核心工程参考，源码只用于验证文档与行为。当前快照使用 AGPL-3.0，不能把源码直接复制进本项目并假定没有许可影响。
- `NBSearch-feat-tauri-migration` 可用于研究 Grok 流式搜索、思考事件和信源展示。仓库根目录未发现许可证文件，因此默认不得复制其源码或素材。
- 本项目只吸收通用思想、行为契约和公开协议知识，所有实现必须从零完成。

## 开源计划

Eternal Chat 的本地 `main` 仓库已经初始化并关联 [Timmyzzo/Eternal-Chat](https://github.com/Timmyzzo/Eternal-Chat)，Phase 1 基线已经提交并推送。具体许可证尚未由项目所有者确定，因此当前不得擅自添加或宣称使用 MIT、Apache-2.0、GPL/AGPL 等许可证。Phase 1 已生成工程用 [第三方许可证清单](./THIRD_PARTY_LICENSES.md)，但发布前仍须完成最终 `LICENSE`、NOTICE 与分发义务审阅，并在 README 与 About 页面保留对 NBSearch 的鸣谢。详细边界见 [鸣谢与参考说明](./ACKNOWLEDGEMENTS.md)。

## 当前状态

| 项目 | 状态 |
|---|---|
| 当前拆分规范 baseline | 已建立，作为唯一设计基线 |
| 官方文档持续追踪规则 | 已建立 |
| 应用脚手架 | Phase 1 已验证：Windows 启动、深浅主题、小窗口、MSI/NSIS 打包 |
| 通用网络管道 | Phase 2 已验证：请求透传、增量 SSE、30ms/64 事件/256 KiB 合批、取消/超时/错误、Channel 与资源清理 |
| 数据权威层 | Phase 3 已验证：migration v1、10 张项目表、MessageBlock、分支/恢复/分页与 RequestSnapshot revision 关联 |
| 上下文与工具连续性 | Phase 4 已验证：SQLite parent 链、虚拟根排除、sibling 隔离、ContextManifest、双 OpenAI serializer、最终 wire canary、500/50 隔离与预算预检 |
| 业务代码 | 真实聊天、Provider 网络调用、流式 parser/reducer 和自动重试未开始 |
| 自动化测试 | 63 个 Vitest、13 个 contract、4 个 Playwright、22 个 Rust 测试，以及 SQLite 临时库清理、clippy、bundle 和 Tauri debug build 门禁 |
| Git 仓库 | 本地 `main` 已关联 `origin/main`，Phase 1 基线已经提交并推送 |
| 开源许可证 | 待项目所有者在发布前决定 |

Phase 1 的工具链、依赖与 Motion 决定见 [ADR 0001](./docs/decisions/0001-phase-1-toolchain-and-motion.md)。Phase 4 已完成且没有进入真实网络；下一次明确实现请求应按 [开发路线](./docs/DEVELOPMENT_ROADMAP.md#phase-5-openai-兼容双端点最小聊天纵切) 只进入 Phase 5，Phase 5A 自动重试和后续模块仍未开始。
