# 功能规格库

本目录为每项核心或规划功能提供独立规格。所有功能当前都尚未实现，状态不得根据文档完整度误标为 `implemented` 或 `verified`。

## 功能清单

| 编号 | 功能 | 里程碑 | 当前状态 |
|---|---|---|---|
| 01 | [核心聊天与分支](./01-core-chat-and-branching.md) | MVP/V1 | `specified` / `deferred` |
| 02 | [Provider 与模型管理](./02-provider-and-model-management.md) | MVP | `specified` |
| 03 | [上下文与工具连续性](./03-context-and-tool-continuity.md) | MVP | `specified` |
| 04 | [思考、搜索与信源](./04-reasoning-search-and-sources.md) | MVP | `specified` |
| 05 | [会话库与搜索](./05-conversation-library-and-search.md) | MVP | `specified` |
| 06 | [设置、个性化与本地数据](./06-settings-security-and-data.md) | MVP | `specified` |
| 07 | [附件与视觉模型](./07-attachments-and-vision.md) | V1 | `deferred` |
| 08 | [提示词与助手预设](./08-prompts-and-assistants.md) | V1 | `deferred` |
| 09 | [MCP 工具](./09-mcp-tools.md) | V2 | `deferred` |
| 10 | [知识库](./10-knowledge-base.md) | V2 | `deferred` |
| 11 | [备份与同步](./11-backup-and-sync.md) | MVP/V2 | `specified` / `deferred` |
| 12 | [模块与插件系统](./12-module-and-plugin-system.md) | V2 | `deferred` |
| 13 | [用量与费用统计](./13-usage-and-cost-statistics.md) | V1 | `deferred` |
| 14 | [国际化与本地化](./14-internationalization.md) | V1 | `deferred` |
| 15 | [托盘与全局快捷键](./15-tray-and-global-shortcuts.md) | V1 | `deferred` |
| 16 | [自动重试与请求尝试](./16-automatic-retry.md) | MVP | `specified` |

## 统一模板

新增功能文档至少包含：

1. 状态与里程碑。
2. 用户问题。
3. 目标和非目标。
4. 用户流程。
5. 功能规则。
6. 数据、上下文和 Provider 影响。
7. UI 状态。
8. 错误、隐私、安全和性能。
9. 自动化测试。
10. 验收标准。
11. 依赖和后续扩展。

## 状态更新规则

- `specified`：规格完整，未开始代码。
- `in_progress`：已有实现改动但未满足全部验收。
- `implemented`：主流程完成，仍缺测试、平台或性能证据。
- `verified`：对应自动化和人工验收全部通过。
- `deferred`：不进入当前里程碑，禁止偷偷作为依赖加入。

功能状态变更时应同步更新本索引、根 README 和开发路线。
