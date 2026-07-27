# Eternal Chat 文档中心

本目录是 Eternal Chat 当前唯一的产品、架构、协议、数据、UI、测试和开发规范集合。旧版单体设计文档已经删除；现有拆分文档共同构成可执行基线。Cherry Studio 的用户文档和开发者 `docs` 通过 [双文档参考指南](./CHERRY_STUDIO_REFERENCE_GUIDE.md) 作为长期外部参考，不直接取代本目录的规范。

## 权威级别

当文档之间存在冲突时，按以下顺序处理：

1. 用户最新、明确的指令。
2. 本目录中的当前规范与已接受决策。
3. 与模型、API、端点、参数和工具有关的官方最新文档。
4. Cherry Studio 当前任务相关的用户文档和开发者 `docs`，用于非差异化的产品/工程参考。
5. 已接受的 ADR 或明确记录的验证结论。
6. `REFERENCE_PROJECT_AUDIT.md`、其他参考项目和可观察外部资料。
7. 代码注释、测试名称和实现细节。

实现不能通过“代码已经这样写了”反向改变产品规范。发现冲突时应先停止扩散，在文档中记录差异并获得明确决策。

## 推荐阅读顺序

### 第一次进入项目

1. [根 README](../README.md)
2. [基线与决策治理](./BASELINE_AND_DECISIONS.md)
3. [Cherry Studio 双文档参考指南](./CHERRY_STUDIO_REFERENCE_GUIDE.md)
4. [产品需求](./PRODUCT_REQUIREMENTS.md)
5. [技术选型与依赖策略](./TECHNOLOGY_SELECTION.md)
6. [总体架构](./ARCHITECTURE.md)
7. [开发路线](./DEVELOPMENT_ROADMAP.md)

### 实现聊天主链

1. [上下文与工具连续性](./CONVERSATION_CONTEXT_AND_TOOLS.md)
2. [Provider、端点与模型参数](./PROVIDER_AND_MODEL_PARAMETERS.md)
3. [官方 API 参数与工具兼容矩阵](./OFFICIAL_API_COMPATIBILITY.md)
4. [自动重试与请求尝试](./features/16-automatic-retry.md)
5. [流式、思考与搜索事件](./STREAMING_AND_REASONING.md)
6. [数据模型](./DATA_MODEL.md)
7. [测试策略](./TEST_STRATEGY.md)

### 实现界面与性能

1. [UI/UX 规格](./UI_UX_SPEC.md)
2. [性能预算](./PERFORMANCE_BUDGET.md)
3. [功能规格库](./features/README.md)
4. [安全与隐私](./SECURITY_AND_PRIVACY.md)（当前 `deferred`）

## 人工审阅与开工确认

第一次人工审阅不需要从头到尾一次读完全部文件，也不需要逐篇阅读 Cherry 的 105 份文档。先阅读 [双文档参考指南](./CHERRY_STUDIO_REFERENCE_GUIDE.md)，再按当前任务映射进入 `Other project references/`。建议分三轮进行：

### 第一轮：确认产品边界

依次阅读根 [README](../README.md)、[基线与决策治理](./BASELINE_AND_DECISIONS.md)、[双文档参考指南](./CHERRY_STUDIO_REFERENCE_GUIDE.md)、[产品需求](./PRODUCT_REQUIREMENTS.md) 和 [开发路线](./DEVELOPMENT_ROADMAP.md)。这一轮只判断四件事：项目要解决的问题是否正确、MVP 是否过大或遗漏、明确不做的内容是否能接受、Phase 0 之后的开发顺序是否符合预期。

### 第二轮：确认核心正确性

依次阅读 [上下文与工具连续性](./CONVERSATION_CONTEXT_AND_TOOLS.md)、[Provider、端点与模型参数](./PROVIDER_AND_MODEL_PARAMETERS.md)、[官方 API 兼容矩阵](./OFFICIAL_API_COMPATIBILITY.md)、[自动重试](./features/16-automatic-retry.md)、[流式、思考与搜索](./STREAMING_AND_REASONING.md)、[数据模型](./DATA_MODEL.md) 和 [测试策略](./TEST_STRATEGY.md)。重点检查客户端是否会偷偷裁剪上下文、删除或改写参数、重复执行工具、掩盖中转站错误，以及验收条件能否证明这些行为没有发生。

### 第三轮：确认实现成本与体验

依次阅读 [技术选型](./TECHNOLOGY_SELECTION.md)、[总体架构](./ARCHITECTURE.md)、[UI/UX 规格](./UI_UX_SPEC.md)、[性能预算](./PERFORMANCE_BUDGET.md) 和 [功能规格索引](./features/README.md)。重点检查技术栈是否能接受、界面工作流是否符合预期、MVP 是否混入不必要模块，以及性能门槛是否现实。

阅读时可以按以下格式记录问题，不需要先提出解决方案：

```text
文档与章节：
结论：通过 / 需要修改 / 不确定
问题或不同意见：
期望行为：
是否阻断开工：是 / 否
```

发现问题时先修改文档基线，再开始实现。只有项目所有者明确回复“文档基线确认，可以进入 Phase 1”或表达同等明确授权后，才能初始化脚手架、安装依赖或编写业务代码；一般讨论、阅读完成或单篇文档通过都不视为开工授权。

## 持续权威来源

以下入口从设计、实现、测试到发布都必须持续参考。只读取当前任务需要的官方章节，不要求每次完整遍历；任何模型能力、参数值域、端点、工具版本或兼容性结论在落地前都要重新核对。

| 体系 | 官方入口 | 主要用途 |
|---|---|---|
| Claude / Anthropic | <https://platform.claude.com/docs/zh-CN/get-started> | Messages、模型、thinking/effort、工具、流式、错误与版本变化 |
| OpenAI API | <https://developers.openai.com/api/docs> | Responses、Chat Completions、模型、参数、工具、流式和 API reference |
| ChatGPT 产品 | <https://learn.chatgpt.com/docs> | ChatGPT/Codex 等产品能力与交互参考，不替代 API reference |
| Grok / xAI | <https://docs.x.ai/overview> | 模型、Responses/Chat 兼容、reasoning、搜索、工具和错误行为 |
| Gemini / Google | <https://ai.google.dev/gemini-api/docs> | generateContent/Interactions、thinking、工具、模型和错误行为 |
| Cherry 用户文档 | <https://docs.cherryai.com.cn/> | 用户流程、配置、默认值解释和功能发现；不替代官方 API 文档 |
| Cherry 开发者文档 | <https://github.com/CherryHQ/cherry-studio/tree/main/docs> | AI 主链、数据、流式、Provider、测试和工程边界；按双文档指南映射使用 |

每个内置 preset 或能力记录至少保存 `sourceUrl`、`checkedAt`、`revision` 和适用的 endpoint/model 范围。官方资料更新只能产生新 revision；用户编辑版本不被覆盖。

## 文档清单

| 文件 | 主要问题 | 状态 |
|---|---|---|
| [BASELINE_AND_DECISIONS.md](./BASELINE_AND_DECISIONS.md) | 哪些决定不能随意改，如何处理冲突 | 规范性 |
| [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md) | 为谁解决什么问题，MVP 做到什么程度 | 规范性 |
| [TECHNOLOGY_SELECTION.md](./TECHNOLOGY_SELECTION.md) | 采用哪些技术、哪些尚未锁定、如何准入依赖 | 规范性 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 模块如何分层，数据如何流动 | 规范性 |
| [CONVERSATION_CONTEXT_AND_TOOLS.md](./CONVERSATION_CONTEXT_AND_TOOLS.md) | 下一轮模型如何继续看到真实工具结果 | 核心规范 |
| [PROVIDER_AND_MODEL_PARAMETERS.md](./PROVIDER_AND_MODEL_PARAMETERS.md) | 未知模型如何透传任意参数 | 核心规范 |
| [OFFICIAL_API_COMPATIBILITY.md](./OFFICIAL_API_COMPATIBILITY.md) | 各家官方 reasoning、thinking 和内置工具如何映射 | 核心规范 |
| [features/16-automatic-retry.md](./features/16-automatic-retry.md) | 中转站临时故障如何有界、可见地自动重试 | 核心规范 |
| [STREAMING_AND_REASONING.md](./STREAMING_AND_REASONING.md) | 如何展示并保存思考、搜索和信源事件 | 核心规范 |
| [DATA_MODEL.md](./DATA_MODEL.md) | 如何持久化会话、分支、工具和审计信息 | 规范性 |
| [UI_UX_SPEC.md](./UI_UX_SPEC.md) | 页面、交互和状态应如何表现 | 规范性 |
| [PERFORMANCE_BUDGET.md](./PERFORMANCE_BUDGET.md) | 如何证明长对话不卡且不泄漏内存 | 门禁 |
| [SECURITY_AND_PRIVACY.md](./SECURITY_AND_PRIVACY.md) | 后续安全与隐私专题范围 | `deferred` |
| [TEST_STRATEGY.md](./TEST_STRATEGY.md) | 哪些行为必须由自动化测试锁死 | 门禁 |
| [DEVELOPMENT_ROADMAP.md](./DEVELOPMENT_ROADMAP.md) | 应按什么顺序开发，何时算完成 | 执行计划 |
| [REFERENCE_PROJECT_AUDIT.md](./REFERENCE_PROJECT_AUDIT.md) | 参考项目哪些可借鉴，哪些不可照搬 | 参考性 |
| [CHERRY_STUDIO_REFERENCE_GUIDE.md](./CHERRY_STUDIO_REFERENCE_GUIDE.md) | Cherry 用户/开发者双文档的长期参考规则与任务映射 | 基线 |
| [features/README.md](./features/README.md) | 独立功能规格和实现状态 | 规范性 |
| [../ACKNOWLEDGEMENTS.md](../ACKNOWLEDGEMENTS.md) | 开源鸣谢、参考来源和许可边界 | 发布门禁 |

## 规范词

本文档使用以下关键词：

- **必须**：违反即视为缺陷，不能以实现成本为由忽略。
- **不得**：被明确禁止的行为。
- **应该**：默认执行，只有记录充分理由后才能偏离。
- **可以**：允许但非强制。
- **后续**：不进入当前里程碑，但应保留兼容边界。

## 状态词

功能文档必须使用以下状态之一，避免把规划写成已完成：

| 状态 | 含义 |
|---|---|
| `baseline` | 当前已接受的项目级决定，不应被实现细节静默改变 |
| `specified` | 已完成详细规格，尚未实现 |
| `in_progress` | 正在实现，不能对外宣称完成 |
| `implemented` | 已实现但尚未完成全部验证 |
| `verified` | 已通过该功能文档要求的自动化和人工验收 |
| `deferred` | 明确延后，不应偷偷进入当前范围 |

## 需求可追踪性

每个实现任务至少应能追踪到：

```text
用户问题
  -> 产品需求或功能规格
  -> 架构/数据/协议约束
  -> 自动化测试
  -> 发布验收证据
```

核心聊天链路还必须记录反向追踪：每个数据库字段、流式事件和请求参数都应能说明服务于哪条产品行为，避免形成只因参考项目存在而照搬的复杂结构。

## 文档修改规则

- 不得通过改实现或删测试来掩盖与当前规范的偏差。
- 改变已接受的项目级决定时，必须更新受影响规范并说明验证方式。
- 改动工具结果、上下文、参数优先级、密钥、数据迁移和性能预算时，必须同步更新测试策略。
- 改动自动重试、错误分类、退避或请求 attempt 语义时，必须同步更新数据模型、流式生命周期和测试策略。
- 改动官方 Provider/模型/协议 preset 时，必须从上述官方入口重新核对，记录来源 URL、核对日期和 schema revision，且不得覆盖用户编辑版本。
- 改动用户流程、页面职责或功能状态时，必须同步更新对应功能规格和根 README。
- 参考项目升级后，不能默认认为旧结论仍然成立。必须注明快照和重新审阅的范围。
- 文档中的命令在脚手架建立前只能标记为“计划命令”，不得伪装成已经可运行。

## 当前结论

当前文档基线已经按“现代交互、高度客制化、协议与厂商解耦、官方资料持续更新”完成重整。Phase 1 工程骨架和 Phase 2A 本地假 SSE 成功链路已验证；下一次明确实现应按 [开发路线](./DEVELOPMENT_ROADMAP.md) 只完成 Phase 2B 的合批、取消、错误和资源清理，不提前进入真实 Provider 或 SQLite。
