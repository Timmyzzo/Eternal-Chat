# 用量与费用统计

## 状态

- 里程碑：V1
- 当前状态：`deferred`
- 依赖：usage 消息块、RequestSnapshot、RequestAttempt、Provider parser、模型配置、SQLite 聚合查询

## 用户问题

用户需要知道一次请求和长期使用消耗了多少 token、是否命中缓存、是否包含 reasoning token，以及费用大致是多少。客户端不能在 Provider 没有返回数据时把估算值伪装成实际账单，也不能因为模型不在内置目录中就无法统计。

## 目标

- 保存 Provider 实际返回的 usage 和可选 billed cost。
- 在 Provider 未返回完整数据时提供明确标注的本地估算。
- 支持用户为任意模型维护有版本的价格规则。
- 展示单请求、单会话、Provider/模型和时间范围统计。
- 记录费用计算所用价格版本、币种和字段来源。
- 统计功能完全本地运行，默认不上传遥测。

## 非目标

- 不声称替代 Provider 官方账单。
- 不根据模型名称猜测价格并当作事实。
- 不因缺少价格规则而阻止模型请求。
- 不把客户端估算反向修改 Provider 返回的原始 usage。
- V1 不做团队预算、发票、支付、额度购买或自动停用账号。

## 数据来源与可信级别

统计值必须标注来源：

1. `provider_reported`：Provider 响应明确返回的计数或费用。
2. `client_estimated`：客户端按已知 tokenizer/字符策略估算。
3. `user_configured`：用户手工录入或修正的价格规则。
4. `unknown`：无法可靠获得，不显示为零。

端点原始 usage 字段应以 codec/profile 可追踪的形式保留，同时映射到规范字段。规范字段可包括 input、output、cached input、reasoning、total 等；端点没有某字段时使用 unknown，而不是自动填 0。

## 请求级流程

1. 请求开始时保存 Provider、模型、参数和价格规则引用。
2. 流式过程中 usage 事件按 transport request/attempt ID 合并，不因重复尾包重复累计。
3. 请求完成、失败或中断时冻结本次已知 usage。
4. 若 Provider 未返回 usage，可在完成后异步生成本地估算并标明算法/版本。
5. 费用计算引用当时有效的价格 revision，不读取后来修改的当前价格覆盖历史。
6. UI 展示实际值、估算值、未知项和计算说明。

中断请求只统计已收到或 Provider 最终报告的数据。不能用“计划最大输出 token”代替实际输出。

## 价格规则

用户可以为任意 Provider/模型 ID 创建价格规则，不依赖内置目录。规则至少表达：

- 稳定 revision 和生效时间。
- 币种。
- 输入、输出、缓存输入、reasoning 或 Provider 特有计费项的单价。
- 计价单位，例如每百万 token 或每次请求。
- 来源说明、更新时间和是否由用户确认。
- 可选的最小计费、分层价格或其他 Provider 特有字段；不支持的复杂规则应标为无法估算。

内置价格只能作为可更新建议数据，不覆盖用户 revision。模型名称相似不能自动共用价格。未知模型没有价格时仍正常发送，只显示“费用未知”。

## 费用计算规则

- 只对来源明确的 usage 字段应用对应价格。
- 计算使用定点十进制或整数最小货币单位，不能依赖二进制浮点累积账务值。
- 保留计算输入、价格 revision、公式版本和舍入规则。
- Provider 返回 billed cost 时单独显示，并可与客户端估算对比，不互相覆盖。
- 汇总中混合币种时分币种显示；没有用户选择的汇率来源时不自动换算。
- 退款、免费额度、批处理折扣和税费只有 Provider 明确返回或用户配置规则时才纳入。

## 展示范围

### 消息/请求

- 输入、输出、缓存和 reasoning token。
- Provider 报告费用与本地估算费用。
- 模型、结束原因、耗时和来源标签。
- 缺失字段和价格规则入口。

### 会话

- 当前分支和全部分支分别统计，避免 sibling 重复含义不清。
- 请求数量、成功/失败/中断、token 和费用。
- 点击汇总可定位到构成请求。

### 统计页

- 按日期、Provider、模型和状态筛选。
- 趋势使用表格或克制的图表，显示币种与数据完整度。
- 支持导出脱敏 CSV/JSON，不包含消息正文和密钥。

## 分支、重试与工具循环

- 每个 RequestSnapshot 独立计数，包括工具继续生成产生的后续请求。
- 手动重新生成是新的 RequestSnapshot 和实际消耗，不覆盖旧请求。
- 自动 retry attempts 属于同一 logical request，但每次都可能已经被上游计费；按 attempt 展示已知 usage/cost，未知 attempt 不推断为零或免费。
- logical request 汇总不能把多个 attempts 合并成“确定只计费一次”，应显示 attempt 数和数据完整度。
- 当前分支汇总只计算该路径关联请求；“全部分支”明确包含所有 sibling。
- 本地 MCP/知识库计算时间不伪装成 Provider token；它们可有独立工具耗时统计。
- server-side anchor 请求仍保存本轮 usage，不把前序总量重复累计，除非端点明确返回累计值且 codec/profile 有测试。

## 数据与迁移

核心 Message/RequestSnapshot 已保存 usage 语义。V1 可增加价格 revision 和聚合所需索引，但不能建立与请求脱节的可变总计作为唯一数据源。

- 请求级原始/规范 usage 是权威记录。
- 聚合表或缓存是派生数据，可重建。
- 价格 revision 被历史计算引用后保留。
- parser 或计算公式升级不自动改写旧显示；重新计算是用户可见操作并生成新计算版本。

## UI

- 默认消息底部只显示简洁 usage，详情按需展开。
- `实际`、`估算`、`未知` 使用文字标签，不只靠颜色。
- 价格编辑器支持任意模型 ID 和 Provider 特有字段，不隐藏高级项。
- 缺价格时提供“添加价格”，不弹出阻断聊天的对话框。
- 有自动重试时，请求详情显示 attempts 和“可能重复计费”提示；只对 Provider 实际报告的数据使用“实际”标签。
- 汇总查询运行时显示稳定 loading 状态，不阻塞聊天流。

## 隐私与安全

- 统计默认只在本地数据库计算。
- 不为价格更新自动上传模型使用历史。
- 导出统计默认不含 prompt、response、tool result、URL、文件名和 secret。
- 价格导入按不可信 JSON 校验大小、字段和十进制范围。
- Provider 错误正文中的余额信息按普通敏感错误处理，不自动纳入统计。

## 错误与恢复

- usage 事件重复/乱序：按 request ID 和 codec/profile 规则幂等合并。
- total 与分项不一致：保留原值并显示兼容性警告，不擅自修正。
- tokenizer 不可用：显示估算不可用，不回退到伪精确数字。
- 价格规则损坏：历史 Provider usage 仍可查看，费用标未知。
- 币种不一致：分组显示，不自动相加。
- 聚合索引损坏：从请求级记录重建。

## 性能

- 为 request time、Provider、模型和 conversation 建立必要索引。
- 大范围统计使用 SQL 聚合和分页，不加载消息正文/blocks。
- 图表按可见时间范围查询，避免启动时扫描全库。
- 派生聚合可增量维护，但必须能从权威请求记录重建。

## 自动化测试

- 流式 usage 多事件、重复尾包、乱序和完成后到达。
- OpenAI 兼容、Anthropic、Gemini/Grok usage fixture。
- unknown 与 0 的区别。
- 中断、失败、手动重新生成、自动 attempts、分支和工具多请求计数。
- 定点费用、舍入、缓存/reasoning 价格和多币种。
- 价格 revision 修改不改变历史计算。
- 未知模型手工价格和无价格正常发送。
- Provider billed cost 与本地 estimate 并存。
- 聚合缓存删除后可重建。
- 统计导出默认聚焦模型、token、价格 revision、费用和时间；其他字段范围由导出设置决定。

## 验收标准

- 任意显示数字都能追踪到 Provider 字段、本地估算算法或用户价格 revision。
- Provider 未返回 usage 时 UI 不显示伪造的“实际 0 token”。
- 修改当前价格不会无提示改变历史费用。
- 未知模型可以记录 usage 和配置价格，不受目录门控。
- 统计查询不会改变请求、上下文或聊天性能主链。
- 用户能清楚区分 Provider 账单值、客户端估算和未知项。
