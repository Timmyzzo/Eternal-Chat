# 核心聊天与分支

## 状态

- 里程碑：MVP / V1
- 当前状态：MVP 核心分支为 `specified`；V1 完整分支树 UI 为 `deferred`
- 核心依赖：Provider、SQLite、ContextAssembler、流式管道

## 用户问题

用户需要一个稳定、易读、可停止、可回退的桌面对话体验。编辑、重新生成和模型切换不能覆盖原历史，也不能让后续上下文混入错误分支。

## 目标

- 创建和持续使用会话。
- 流式显示 AI 文本、思考、工具、来源、usage 和错误。
- 支持停止、重试、编辑、重新生成和 sibling 切换。
- 重启后历史和分支保持。
- 长对话仍保持输入、滚动和切换流畅。

## 非目标

- MVP 不提供多人协作。
- MVP 不支持同一会话同时运行多个模型回答。
- MVP 不支持中途 steering 当前请求。
- MVP 不执行代码块。
- MVP 不做复杂消息级永久删除和分支合并。

## 用户流程

### 新会话

1. 用户点击新建。
2. 使用默认模型，或在顶部选择模型。
3. 输入消息并发送。
4. 应用创建 conversation 时已在同一事务建立无内容虚拟根；首条 user message 挂在该根下，并写入 pending assistant。
5. 流式事件更新 assistant。
6. 完成后保存并生成/更新标题。

标题生成不得阻塞首轮回答，也不得覆盖用户已手工修改的标题。

### 停止

用户在连接、思考、工具或文本阶段点击停止。已收到内容保存为 `interrupted`，同一请求不能同时落成 `done`。

### 重新生成

从目标 user message 创建新的 assistant sibling。旧 assistant 和后代保留，UI 显示 sibling 计数。

### 编辑用户消息

若该消息已有后代，创建新 user 分支节点并从新节点生成。原消息不原地覆盖。

### 重试失败

这里指用户手动“重新生成”：保留失败 assistant 和 RequestSnapshot，新建 sibling 和新的 logical request。用户可以在发送前更换模型或参数。

网络自动重试是另一种行为：在同一 assistant placeholder 和 RequestSnapshot 下创建新的 request attempt，不创建 sibling，不读取等待期间的新设置。详细规则见 [自动重试与请求尝试](./16-automatic-retry.md)。

## 功能规则

- 同一会话默认只允许一个 active request。
- active request 由应用根级 registry 持有；切换会话、路由变化或消息组件卸载只解除 UI 订阅，不等同于停止。
- 发送按钮在 active request 时变为停止。
- 空白文本且无附件时不可发送。
- user message 先落库，再发网络请求。
- assistant placeholder 在请求前创建。
- 同一 logical request 的自动 attempts 复用 placeholder；手动重新生成才创建 sibling。
- 终态只能写一次。
- 模型切换只影响后续生成，不改写历史 message.model_ref。
- 复制默认复制最终正文；工具/思考可单独复制。
- 分支切换改变 active leaf，并重新计算后续可见路径。

## 数据

使用 conversation 的唯一无内容虚拟根、`conversation.active_leaf_message_id`、`message.parent_id` 和 `sibling_order`。第一轮 user message 与其编辑 sibling 都挂在虚拟根下；根不渲染、不进入上下文、不能成为 active leaf。每条 AI 消息保存实际模型、状态、块、usage、Provider response id 和 request snapshot id；RequestSnapshot 下保存零个或多个后续自动 request attempts。

## UI 状态

- 空会话。
- preparing/connecting。
- waiting_retry：显示 attempt、原因、倒计时和停止。
- thinking/searching/tool running。
- streaming text。
- completed。
- interrupted。
- error。
- branch selector。
- history loading 和 load more。

输入区不得因消息状态变化移动位置。用户上滑后暂停吸底并显示回到底部控件。

## 错误

- 配置缺失：打开 Provider/模型入口。
- 网络/Provider：保留 user message 和失败 assistant。
- 可重试的发送前网络/Provider 故障：同一消息进入 waiting_retry；收到有价值输出后默认不自动从头重发。
- 数据库存储失败：不继续发送或明确标记持久化失败。
- parser 错误：保留已解析内容和兼容性详情。
- 切换会话时流仍运行：MVP 默认继续并由 conversation/logical request id 隔离；返回时先附着 registry 当前快照。只有显式停止、退出选择或策略 abort 才取消上游。

## 性能

- 历史和 streaming store 分离。
- 虚拟列表。
- 50 条分页、约 300 条内存窗口。
- completed Markdown 缓存。
- 一次 delta 不重渲染全部历史。

## V1：完整分支树 UI

MVP 只要求在当前节点附近切换 assistant sibling，并保证上下文分支隔离。V1 增加完整分支树视图，但不改变 `parent_id` 数据语义。

### 目标

- 展示会话全部 user/assistant 节点、父子关系、sibling 和当前 active path。
- 从树上切换 active leaf，并准确重建当前可见消息路径。
- 显示节点角色、时间、模型、终态、短预览和子分支数量。
- 支持折叠、搜索定位、键盘导航和返回当前分支。
- 大型树按需加载节点，不为打开面板读取全部 message blocks。

### 规则

- 树是现有 Message 关系的投影，不维护第二套分支数据。
- 选择任意节点作为 leaf 时，当前路径为根到该节点的唯一 parent 链。
- 有 active request 时切换分支必须先停止、等待完成或取消操作，不能把流式块写到新分支。
- V1 不做分支合并、批量重排或拖动改变 parent。
- 删除/隐藏分支是后续独立能力；树 UI 不借机物理删除历史。
- 搜索结果定位后必须高亮目标节点及其祖先路径，不把 sibling 内容混入聊天主区。

### 测试与验收

- 深链、宽 sibling、编辑后再生成和失败节点的树结构。
- 树节点与 `parent_id`/`active_leaf_message_id` 一致。
- 切换 active leaf 后 ContextManifest 不包含其他 sibling。
- 1000 节点树的打开、搜索、折叠和切换性能。
- 键盘方向键、展开/折叠、选择和焦点返回。
- reload 后展开状态可以重置，但 active path 必须一致。

## 测试

- 新建/发送/完成/reload。
- 连接、思考、文本阶段取消。
- done/cancel 竞态。
- 重试形成 sibling。
- 自动 retry attempt 不形成 sibling，参数/context/body hash 不变。
- waiting_retry 中取消和 timer 到期竞态只启动零次或一次下一 attempt。
- 编辑形成新分支且旧分支保留。
- 分支切换后上下文不混入其他 sibling。
- 失败后保留可重试状态。
- 1000 条虚拟列表性能。
- 键盘和焦点。

## 验收标准

- 用户可以从零配置后的首个会话持续完成至少 20 轮。
- 任意一轮停止后可继续新消息或重试。
- 自动重试成功后历史只出现一条 assistant，尝试详情可审计。
- 编辑/重新生成不会覆盖原历史。
- 重启后内容、状态、分支和模型信息一致。
- 工具和思考块保持原顺序。
- 长会话通过性能预算。
- V1 分支树中的选中节点、聊天可见路径和模型上下文路径完全一致。
