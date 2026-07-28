# 思考、搜索与信源

## 状态

- 里程碑：MVP
- 当前状态：`in_progress`；Phase 5 已验证两种 OpenAI-compatible 协议的基础 reasoning/usage 流式块，Phase 6 仅完成 Provider 内置搜索工具 descriptor 与 wire fixture。搜索过程、来源、计时和完整结构化事件属于 Phase 7，当前尚未开始
- 参考方向：NBSearch 的结构化事件思路，从零实现

## 用户问题

长推理和网络搜索如果只显示最终答案，用户无法判断模型查了什么、引用了什么、工具是否失败或中途切换。另一方面，客户端也不能把普通等待动画伪装成完整思考链。

## 目标

- 保存并展示 Provider 实际返回的 reasoning、工具、搜索、来源和计时。
- 区分思考内容、思考摘要、搜索过程和本地等待。
- 流式和 reload 后结构一致。
- 信源可去重、定位和安全打开。
- 相关 Provider 状态可用于后续上下文续接。
- 用户可以按 Provider/endpoint 开关 `web_search`、`x_search`、Google Search、Anthropic web search 并配置其高级参数。

## 非目标

- 不推断 Provider 未返回的隐藏思维。
- 不保证所有模型都返回 reasoning。
- 不根据模型名称伪造 agent 数量。
- 不把 Grok leader output 或任何 thought summary 标成全部子代理/模型的隐藏思维。
- 不在 MVP 做复杂研究报告编辑器。

## 事件范围

- stream started/heartbeat。
- thinking start/delta/end。
- tool call start/delta/complete。
- tool result。
- source/citation。
- agent/rollout status。
- usage/metadata/done/error。

## 用户流程

1. 在会话参数中选择思考档位和内置工具 `off | auto | required`；不支持 required 时 UI 明确说明。
2. 发送长推理/搜索请求。
3. 思考区域出现本地计时和 Provider 事件。
4. 工具 query 与状态流式更新。
5. 来源逐步出现并去重。
6. 最终文本开始后继续接收引用/usage。
7. 完成后折叠为摘要，详情保留全时间线。
8. reload 后仍能展开。

## UI

- 流式中显示最近事件和稳定状态区。
- 完成后显示 `思考了 N 秒` 或更准确标签。
- 工具条目有参数、模型可见结果、来源和错误。
- 详情抽屉提供全时间线。
- 引用 pill 显示域名/编号，外链用系统浏览器。

## 数据

思考和工具进入 message blocks，来源可作为独立 block 或 tool result 子项。记录本地接收时间、Provider response id、rollout/agent id 和关联 toolCallId。

## 真实性规则

- Provider 返回 summary 时标为 summary。
- 没有 reasoning content 时只显示等待/工具状态。
- 代理数量只来源于 Provider 可关联事件。
- Grok 多代理默认只展示 leader 可见输出；未返回的子代理状态不得由客户端补写。
- 本地计时和远端时间分开保存。

## 错误与恢复

- 解析未知事件：保留兼容性警告。
- 搜索失败：工具块失败，最终回答仍可能继续，但不能把来源计为成功。
- 断流：保留部分时间线并标 interrupted。
- URL 过期：保留历史来源并标不可访问。
- source 无 URL：可展示 Provider 标题/ID，不生成假链接。

## 性能

- 事件 reducer 按稳定 ID 更新。
- 流式详情只显示最近少量项，全量在内部有界列表/抽屉。
- 来源、favicon 和预览懒加载。
- 计时器只更新局部组件。

## 测试

- reasoning/text/tool/source 交错。
- 多工具并行和重复来源。
- source 在正文后到达。
- 多 agent/rollout 事件。
- 四家内置搜索工具 off/auto/required 的 descriptor 和 UI 状态。
- Grok leader-only、Gemini/Anthropic/OpenAI summary 标识。
- 未知事件和断流。
- cancel 后计时冻结。
- reload 顺序一致。
- 无 reasoning 时不显示假内容。
- 安全 URL 协议。

## 验收标准

- 用户能看到实际搜索 query、结果数量、来源和耗时。
- 最终回答不会覆盖或删除搜索过程。
- 完成/reload 后详情相同。
- UI 文案不声称展示 Provider 未返回的内部链。
- 相关工具结果可进入下一轮上下文或由可靠 anchor 续接。

详细事件协议见 [流式、思考与搜索事件规范](../STREAMING_AND_REASONING.md)。
