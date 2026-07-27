# 技术选型与依赖策略

## 1. 文档状态

- 当前状态：`specified`；Phase 1 工具链与脚手架已于 2026-07-27 验证
- 权威来源：[基线与决策治理](./BASELINE_AND_DECISIONS.md)、当前专题规范与[官方 API 兼容矩阵](./OFFICIAL_API_COMPATIBILITY.md)
- 目的：把已定技术栈、责任边界、采用理由、未定事项和验证门禁集中为开发入口
- 当前仓库已有 Phase 1 脚手架、唯一 pnpm/Cargo lockfile 和精确工具链记录；后续业务依赖仍按对应 Phase 决定

发现实现困难时，先按 [基线与决策治理](./BASELINE_AND_DECISIONS.md) 提供证据，不得通过临时换栈掩盖问题。模型、端点、参数和工具事实以官方最新文档为准，技术栈不能把这些变化重新硬编码成厂商分支。

## 2. 选择原则

所有依赖和框架必须服务于以下约束：

1. 核心聊天低常驻内存，长对话不随消息数量持续退化。
2. Provider、模型参数、上下文和流式解析能够在 TypeScript 中快速迭代。
3. 连接、端点、显式端口、协议 profile、模型和会话覆盖保持独立。
4. 工具结果、思考、搜索和来源保持结构化并可跨轮回放。
5. 可选功能关闭后不加载主体代码或后台任务。
6. 桌面壳可替换，业务层不被 Tauri API 散落绑定。
7. 优先采用小型、可测试、可替换的库，不为未来假设引入重型框架。

## 3. 已锁定技术栈

| 层 | 选型 | 状态 | 主要责任 |
|---|---|---|---|
| 桌面壳 | Tauri 2 | `baseline` | 窗口、IPC、权限、插件、打包、更新 |
| 前端运行时 | React 19 | `baseline` | UI 与交互组件 |
| 语言 | TypeScript | `baseline` | UI、应用、领域、Provider 和数据业务 |
| 构建 | Vite | `baseline` | 开发服务器与前端构建 |
| 样式 | Tailwind CSS | `baseline` | token、响应式布局和实用样式 |
| 组件 | shadcn/ui + Radix | `baseline` | 可定制组件与无障碍基础 |
| 图标/反馈 | lucide-react + sonner + cmdk | `baseline` | 图标、通知反馈和命令面板 |
| 客户端状态 | Zustand | `baseline` | selector 精准订阅、历史/流式/UI 状态分离 |
| 长列表 | virtua | `baseline` | 动态高度聊天虚拟化；失败时评估备选 |
| Markdown | markdown-it | `baseline` | 可控解析、按消息缓存和流式节流 |
| 代码高亮 | shiki | `baseline` | 消息完成后按需加载高亮 |
| 数学公式 | KaTeX | `baseline` | 消息完成后按需渲染公式 |
| 关系数据 | SQLite + tauri-plugin-sql | `baseline` | 会话、消息、Provider、快照、迁移和索引 |
| 网络 | Rust reqwest + Tauri Channel | `baseline` | 接收最终请求、执行 HTTP/SSE、取消、超时和 30ms 合批 |
| 协议层 | TypeScript ProtocolProfile + 薄 codec | `baseline` | buildRequest、parseEvent、工具/上下文序列化与声明式映射 |
| V2 向量检索 | sqlite-vec + embedding | `baseline` | 可关闭知识库模块的本地向量索引 |

表中的“已锁定”表示技术方向不可随意替换，不表示依赖已经安装或具体版本已经验证。

## 4. 桌面架构

### 4.1 采用 Tauri 2

采用原因：

- 相比大型 Electron 客户端，预期安装体积和空闲内存更低。
- React/TypeScript 渲染层保持完整，不牺牲成熟 UI 生态。
- 原生能力通过明确 command/plugin/capability 暴露，桌面边界集中。
- Rust 仅实现小型通用传输管道，日常业务不要求开发者在 Rust 中实现 Provider、协议或认证规则。

风险与验证：

- Windows WebView2、macOS WebKit 和 Linux WebKitGTK 必须按发布矩阵冒烟。
- 高频 SSE 不能逐 token IPC，必须验证 Channel 30ms 合批和顺序。
- Tauri 原生 E2E 能力可能不如浏览器成熟，应保持可替换 DesktopBridge 和 Web 层测试。

### 4.2 Electron 只作为退路

Electron 不是并行维护方案。只有 Phase 1 证据证明 Tauri 在目标平台、开发复杂度或关键能力上不可接受时，才启用退路。切换只能替换 DesktopBridge、网络和桌面注册层，不能重写协议 profile、上下文、数据语义或 React UI。

## 5. 前端与 UI

### 5.1 React 19 + TypeScript + Vite

- React 负责视图和局部交互，不承担 Provider serializer 或 SQL 业务。
- TypeScript 在脚手架阶段启用严格检查，运行时边界仍需 schema 校验。
- Vite 只作为开发/构建工具，不引入 Node 后端运行时依赖。
- React 组件通过 application use case 和 repository/bridge 接口工作，不直接散落调用 `invoke` 或拼接请求体。

### 5.2 Tailwind + shadcn/ui + Radix

- shadcn/ui 组件代码归项目所有，可按 UI 规范细化而不受封闭主题限制。
- Radix 提供 dialog、menu、tabs、tooltip 等无障碍交互基础。
- Tailwind 配置应以设计 token 为中心，避免每个功能发明独立色板和圆角。
- 不再引入第二套完整组件库；个别缺失能力优先用 Radix primitive 或小型专用库。
- 手势驱动的 sheet、拖拽和可中断过渡可以评估 Motion 等支持 spring、速度继承和 retarget 的小型库；在 Phase 1 spike 前不锁定具体依赖。

### 5.3 lucide-react、sonner、cmdk

- lucide-react 是统一图标来源，不在项目中散落手绘 SVG。
- sonner 只用于短期反馈；持久错误和恢复状态必须在页面内展示。
- cmdk 用于命令面板/快速搜索，不成为业务权限绕过入口。

## 6. 状态与数据流

### 6.1 Zustand

Zustand 只保存客户端需要响应式订阅的状态：

- 历史消息窗口。
- 当前流式消息和 request 状态。
- 会话/页面 UI 状态。
- 轻量设置缓存。

领域规则、ContextAssembler、serializer、费用计算和 migration 不写成 store action 堆叠。历史 store 与 streaming store 分离，流式 delta 只更新最小订阅者。

### 6.2 SQLite + tauri-plugin-sql

- TypeScript repository 通过 tauri-plugin-sql 操作 SQLite。
- 不在 Rust 建第二套数据库业务层。
- 不预先引入 ORM；当前 schema 需要显式 SQL、迁移和精确查询控制。
- FTS5 优先，但必须先确认目标 SQLite 构建支持；否则 MVP 用 LIKE 并显示能力状态。
- artifact 大文件保存在应用数据目录，SQLite 保存 hash、元数据和引用。

若未来 SQL 规模证明需要 query builder，只能在不隐藏 SQL、事务和 migration 的前提下单独评估，不能在脚手架阶段预装。

## 7. 网络、端点与协议

### 7.1 Rust 通用管道

Rust 只负责：

- 接收 TypeScript 已装配完成的 URL、method、Header、Query 和 Body。
- 执行 HTTP/SSE、超时和取消。
- 将原始事件按约 30ms 有序合批回传。
- 返回稳定 transport 错误并清理运行资源。

Rust 不识别 OpenAI、Anthropic、Gemini、Grok、reasoning、tool、source、参数 schema、认证类型或模型公司。新增连接、端点、协议 profile、模型或认证字段不得修改 Rust 管道。

Rust 每次只负责一个 request attempt。是否自动重试、哪些错误可重试、`Retry-After`、full jitter、总预算和“是否已经收到有价值输出”都由 TypeScript RetryCoordinator 决定。这样既保持 Rust 通用，也便于用 fake clock 和 Provider fixture 验证策略。

### 7.2 TypeScript profile runtime 与薄 codec

不使用会吞未知字段、隐式裁剪工具历史或隐藏请求体的大型官方 SDK 作为核心主链。`ProviderConnection -> EndpointConfig -> ProtocolProfile -> ModelConfig -> ConversationOverride` 五层在 TypeScript 中合并，每个 codec 保持小而显式：

- 按 profile 构建最终 URL/Header/Query/Body。
- 把 CanonicalContext 序列化为线协议。
- 解析原始 SSE/JSON 为统一 StreamEvent。
- 读取 profile 中经过测试的 anchor、工具、图片和 reasoning mapping。
- 把参数和工具意图映射到当前 profile 声明的精确 wire path，不从厂商名猜测。
- 对 HTTP 200 内嵌上游错误做结构化、可配置分类，不搜索自然语言猜测。

SDK 可以在后续被某个孤立模块用于非核心能力，但不能绕过 RequestSnapshot、ContextManifest 和实际请求 fixture。

### 7.3 动态参数

参数 UI 来自可编辑 schema，最终请求按 protocol、endpoint、model、conversation 和 raw override 层级合并。字段的语义标签与实际 placement/path 分离，不做 snake_case/camelCase 或厂商字段名自动猜测。内置模型目录只提供建议，不作为能力白名单。JSON schema/运行时校验库的具体选择尚未锁定，见第 11 节。

官方 GPT、Grok、Gemini、Claude preset 同样只是带来源和核对日期的数据。Provider 内置工具 descriptor 复用动态 schema；不为每家厂商引入大型官方 SDK 或独立表单框架。当前没有证据需要为重试新增生产依赖，Phase 5A 优先使用平台计时器、可注入时钟和小型纯函数。

## 8. Markdown、代码与长列表

### 8.1 markdown-it

- 默认禁用原始 HTML。
- completed 消息按 `messageId + blocks hash + renderer version` 缓存。
- streaming 文本节流解析，不逐 token 全量重建。
- 插件集合按真实需求最小化，新增插件经过性能和兼容性测试。

### 8.2 shiki 与 KaTeX

- 都在消息完成后懒加载和处理。
- shiki 语言/主题缓存有上限。
- KaTeX 使用受控输出配置，并在消息完成后渲染。
- 不为首屏聊天加载全部语言、高亮主题或数学资源。

### 8.3 virtua

优先选择 virtua 是因为聊天消息高度动态。Phase 8 必须用真实 Markdown、思考块、工具块和图片场景验证滚动锚点、上滑暂停吸底和快速跳转。若出现不可修复问题，备选 `@tanstack/react-virtual`；替换只影响列表基础设施，不改变消息分页和上下文。

## 9. 测试工具

当前测试策略已经指定以下方向，具体版本在 Phase 1 锁定：

| 范围 | 工具 |
|---|---|
| TypeScript 单元/契约/组件 | Vitest |
| React 行为与无障碍 | Testing Library |
| Web 层 E2E | Playwright |
| Rust 管道 | Rust test + tokio test |
| HTTP/SSE fixture | MSW、自建本地 server 或等价小型工具 |
| SQLite | 临时数据库与版本化 fixture |

Playwright 不能单独证明 Tauri 原生窗口、托盘、快捷键和 updater 正确；这些能力需要平台集成测试或真实安装包冒烟。

## 10. 明确不采用

| 方向 | 当前结论 | 原因 |
|---|---|---|
| Electron 作为主方案 | 不采用 | 当前基线选择 Tauri；仅保留证据充分时的退路 |
| Node 后端/本地服务作为核心 | 不采用 | 增加常驻进程、打包和端口复杂度 |
| 大型官方 Provider SDK 主导请求 | 不采用 | 可能吞未知参数、隐藏上下文转换和增加体积 |
| 重型 IoC/DI 容器 | 不采用 | 当前模块和 codec 数量无需该复杂度 |
| ORM 作为数据前置 | 不采用 | 显式 SQLite schema/migration 更可审计 |
| 把业务迁入 Rust | 不采用 | 破坏快速迭代与 Electron 退路 |
| 独立向量数据库 | 不采用 | V2 使用可关闭的 sqlite-vec，避免常驻服务 |
| 全量 Markdown/代码插件包 | 不采用 | 首屏、内存和攻击面不可控 |
| 模型 ID 硬编码能力 | 不采用 | 不适配未知模型、私有网关和实验参数 |

## 11. 尚未锁定的选择

以下问题需要在对应阶段用小型 ADR 或 spike 决定，不能在文档阶段假装已经选定：

- 后续 Phase 尚未安装的业务 npm/crate 具体版本；Phase 1 直接依赖已锁定。
- 前端路由库；若简单路由足够，不为路由引入重型框架。
- params schema 与运行时校验库。
- 结构化日志库及生产日志格式。
- 凭据保存与认证值注入的最终方案；当前不作为脚手架或 MVP 前置条件。
- 压缩/归档实现和 V2 加密库。
- i18n 库。
- PDF/Office 等附件和知识库解析器。
- 外部插件的 sandbox、签名和分发方式。
- Tauri 原生自动化驱动和 macOS/Linux 首发级别。

选择时至少比较：维护状态、许可证、bundle/二进制大小、运行时内存、TypeScript/Rust 类型质量、取消/流式支持、测试可控性和替换成本。

## 12. 版本与锁定策略

Phase 1 已完成：

1. 选择当前稳定的 Node LTS、pnpm 和 Rust stable。
2. 使用官方 Tauri 2 React TypeScript 脚手架。
3. 提交唯一包管理器 lockfile，并在 CI 使用 frozen lockfile。
4. 记录 Tauri CLI、Rust toolchain 和 WebView 运行前提。
5. 禁止宽泛的未锁定 git 依赖和生产分支依赖。
6. 自动化依赖更新一次只处理可审阅范围，Provider/SQLite/Tauri 大版本单独升级。
7. 生成第三方许可证清单并核对分发义务。
8. 记录 Eternal Chat 自身开源许可证仍待项目所有者决定，并把最终决定设为 Phase 10 发布门禁；在此之前不得生成或宣称候选许可证。

当前锁定基线为 Node `24.18.0`、pnpm `11.9.0`、Rust `1.97.1`、Tauri CLI `2.11.4` / crate `2.11.5`、React `19.2.8`、TypeScript `5.9.3` 和 Vite `8.1.5`。完整理由与 Motion 决定见 [ADR 0001](./decisions/0001-phase-1-toolchain-and-motion.md)。`pnpm-lock.yaml`、`src-tauri/Cargo.lock` 和 `THIRD_PARTY_LICENSES.md` 是对应退出证据；Eternal Chat 自身许可证仍未决定。

## 13. 新增依赖门禁

新增生产依赖前回答：

- 它解决哪条明确需求，标准库或已有依赖为什么不足？
- 是否进入启动路径、常驻内存或核心 bundle？
- 是否访问网络、文件、进程或剪贴板？
- 能否取消、卸载和释放资源？
- 许可证是否允许计划的分发方式？
- 有哪些维护和替换风险？
- 需要哪些单元、fixture、E2E 和性能测试？

仅开发依赖也要说明对 CI、安装时间和跨平台构建的影响。不能因参考项目已经使用某库就直接加入。

## 14. 分阶段技术验证清单

以下验证按开发路线分阶段执行，不把 Phase 2/3/8 的任务提前塞入 Phase 1：

- **Phase 1（已验证）**：Tauri 2 空应用在 Windows 启动、正常关闭、构建并生成 MSI/NSIS；深浅主题、900x700 小窗口、pointer-down、sheet 拖拽和 reduced motion 可用；`DesktopBridge` fake 不调用真实 IPC。
- **Phase 2A（已验证）**：共享 `PipeRequest`/`PipeEvent` fixture、真实 Tauri 流式 bridge、Rust HTTP/SSE 成功路径和随机端口本地 server 已建立；最终 URL、显式端口、Method、Header、Query 和 Body 原样发送，原始 SSE data 顺序不变。
- **Phase 2B（已验证）**：Rust Channel 高频假 SSE 以 30ms/64 事件/256 KiB payload 合批；cancel、timeout、非 2xx、断流和 Channel 关闭后的运行映射/reader/timer/token 清理，以及随机分片和大 batch 停止延迟均有确定性测试。
- **Phase 3**：tauri-plugin-sql migration、事务、临时数据库 fixture 与 FTS5 能力验证。
- **Phase 5-6**：多端口/多 profile 与显示品牌和协议不一致的构造请求验证。
- **Phase 8**：React/Zustand selector 重渲染、markdown-it 缓存和 virtua 动态高度滚动锚点验证。

Phase 1 只保留交互 spike、平台端口 fake 和质量基础设施；Phase 2 已完成通用传输、合批、取消、错误与资源清理，但没有加入 Provider codec、真实聊天或数据层。Phase 3 及后续条目仍是对应阶段的未完成任务。

## 15. 替换边界

- Tauri/Electron：只替换 DesktopBridge 和桌面基础设施。
- virtua/其他虚拟列表：只替换列表适配层。
- SQLite query helper：不得改变 repository、migration 和事务语义。
- Markdown renderer：必须保持 MessageBlock 输入、缓存和渲染策略。
- Provider transport：不得改变 CanonicalContext、RequestSnapshot 和 StreamEvent。
- i18n/validation/logging 库：调用集中在小型适配层，避免散落库特有 API。

替换边界的价值在于降低锁定，而不是同时维护两套实现。

## 16. 验收标准

- 每个已锁定技术都能追踪到当前基线和明确责任边界。
- 尚未选定的库没有在其他文档中被误写成已安装事实。
- Phase 1 已按本文件完成版本锁定、最小 spike、Windows 打包和质量门禁。
- 新增依赖必须通过性能、许可证和替换成本审阅。
- 技术选择不能削弱工具跨轮连续性、未知模型参数、协议与厂商解耦或 lossless 默认策略。

具体分层见 [总体架构](./ARCHITECTURE.md)，实施顺序见 [开发路线](./DEVELOPMENT_ROADMAP.md)。
