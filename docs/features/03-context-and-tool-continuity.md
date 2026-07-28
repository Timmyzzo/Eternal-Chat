# 上下文与工具连续性

## 状态

- 里程碑：MVP
- 当前状态：`in_progress`；Phase 4 已验证 SQLite parent 链、分支隔离、ContextManifest、OpenAI Chat/Responses serializer、最终 wire canary、UI 50/DB 500 隔离和 lossless 预算预检。Anthropic/Gemini/custom codec 的同等连续性仍属于 Phase 9，完整跨协议 MVP 尚未完成
- 发布级别：P0 阻断能力

## 用户问题

用户在搜索、数据库、文件或 MCP 任务中依赖真实工具结果。若下一轮只发送助手总结，模型会在缺少事实时继续推断，而 UI 无法暴露这一缺陷。

## 目标

- 当前分支的消息和工具交换可重复构造。
- 下一轮按 Provider 协议回放工具调用与结果。
- 默认不静默裁剪。
- 用户能查看模型实际上下文。
- Provider anchor 失效时不做危险降级。

## 非目标

- MVP 不自动总结旧历史。
- MVP 不自动判断哪些事实“不重要”。
- 不保证任何超出模型窗口的内容都能无损发送。
- 不把 UI 卡片等同于模型可见工具内容。

## 核心流程

1. 沿 `parent_id` 读取当前分支。
2. 校验消息、块和工具配对。
3. 构造 CanonicalContext。
4. 应用 lossless 策略和预算预检。
5. 生成 ContextManifest。
6. Provider serializer 生成实际线协议。
7. 保存请求快照与 hash。
8. 创建 initial request attempt 并发送。
9. 若发生安全可重试故障，后续 attempt 复用同一 manifest/hash。

## 工具结果规则

- `tool_call.id` 稳定。
- `result.modelContent` 是回放权威内容。
- raw artifact 只用于审计/查看，不自动替代 modelContent。
- 工具失败、拒绝和取消都保留状态。
- 不完整工具交换不能被静默删除。
- 第一轮 assistant final text 不能替代工具结果。
- continuation 自动重试不得再次执行已经完成的客户端工具，只能重发持久化 result。

## Provider anchor

- 只有 codec/profile 声明并通过测试时使用。
- 本地仍保存完整规范历史。
- anchor 失效只允许回退到经过验证的 explicit replay。
- final-text-only 回退被禁止。

## 上下文检查器

显示内容、工具和请求三个视图：

- included/excluded/summarized/provider_anchor。
- 块 hash。
- 工具配对与 modelContent。
- 脱敏协议预览。
- token 估算和超限项。

## 上下文超限

默认暂停发送，提供更换模型、手动排除、后续可选摘要或仍尝试发送。不能自动 `slice(-N)`。

## 数据

依赖 message blocks、artifact、request_snapshot、request_attempt 和 context_manifest。UI 内存窗口不是输入数据源。

## 错误

- tool result 缺失。
- tool id 冲突。
- unknown block 不可序列化。
- provider anchor 无效。
- context 估算超限。
- artifact 缺失。

所有错误应定位具体 message/block/tool id。

## 测试

- 跨轮 canary 捕获真实请求。
- UI 50 条、DB 500 条独立。
- 分支隔离。
- incomplete tool。
- anchor 失效。
- 超限不裁剪。
- OpenAI Chat、Responses、Anthropic Messages、Gemini 与自定义 profile 的 serializer fixture。
- manifest/hash 稳定。
- 多个自动 attempts 的 ContextManifest/body hash 完全一致，工具执行次数不增加。

## 验收标准

- 第一轮最终回答不复述 canary 时，第二轮仍能基于 tool result 正确请求。
- UI、DB、manifest 和线协议能追踪同一 tool call id。
- 关闭上下文检查器不改变实际请求。
- 分页、虚拟化和性能优化不改变 ContextManifest。
- 自动重试不改变 ContextManifest、参数、模型或工具结果，也不创建 sibling。
- 无可靠续接路径时明确失败。

详细技术契约见 [对话上下文与工具连续性](../CONVERSATION_CONTEXT_AND_TOOLS.md)。
