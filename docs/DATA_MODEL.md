# 数据模型与迁移规范

## 1. 目标

数据层必须支持本地优先、消息分支、工具结果跨轮回放、流式恢复、请求审计、分页、全文搜索和未来模块扩展。TypeScript 通过 tauri-plugin-sql 直接操作 SQLite，Rust 不承载数据库业务。

连接显示身份、实际端点、协议 profile 和模型必须分别存储，避免用模型公司或 Provider 名称反推 wire format。

## 2. 存储分类

| 数据 | 存储 | 原因 |
|---|---|---|
| 连接、端点、协议 profile、模型、会话、消息、快照 | SQLite | 事务、查询、迁移和索引 |
| 认证绑定和值引用 | 配置层 | 字段名、位置、前缀和值来源必须可编辑；具体凭据持久化方案后续决定 |
| 附件与大型工具结果 | 应用数据目录的内容哈希文件 | 避免 SQLite 大 blob 和重复文件 |
| UI 临时状态 | 内存，必要时 store/plugin | 不污染领域数据 |
| 原始流追踪 | 可选、限额的诊断目录 | 默认关闭，便于删除和轮换 |
| FTS | SQLite 派生索引 | 可重建，不作为权威数据 |

## 3. schema 版本

数据库必须有独立 schema 版本表：

```sql
CREATE TABLE schema_migration (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  checksum TEXT NOT NULL
);
```

应用启动时只允许按版本顺序向前迁移。不得在运行时根据列是否存在散落执行临时修补。

## 4. 核心表

以下是当前数据模型草案。最终 SQL 可按 SQLite 约束微调，但分层语义不得改变。

### 4.1 provider_connection

```sql
CREATE TABLE provider_connection (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vendor_hint TEXT,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`vendor_hint` 只用于图标、筛选和官方资料建议，不参与协议、参数或能力判定。

### 4.2 protocol_profile

```sql
CREATE TABLE protocol_profile (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  codec_id TEXT NOT NULL,
  request_mapping_json TEXT NOT NULL,
  response_mapping_json TEXT NOT NULL,
  tools_mapping_json TEXT NOT NULL,
  continuation_mapping_json TEXT,
  source_json TEXT,
  user_edited INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`codec_id` 描述 wire 状态机，例如 OpenAI Chat、Responses、Anthropic Messages、Gemini generateContent/Interactions 或通用 JSON/SSE；它不表示模型厂商。内置 profile 更新产生新 revision，不能覆盖用户 fork。

### 4.3 provider_endpoint

```sql
CREATE TABLE provider_endpoint (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL
    REFERENCES provider_connection(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  explicit_port INTEGER,
  path_template TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'POST',
  api_version TEXT,
  protocol_profile_id TEXT NOT NULL REFERENCES protocol_profile(id),
  auth_bindings_json TEXT NOT NULL DEFAULT '[]',
  headers_json TEXT NOT NULL DEFAULT '{}',
  query_json TEXT NOT NULL DEFAULT '{}',
  body_defaults_json TEXT NOT NULL DEFAULT '{}',
  timeout_ms INTEGER,
  retry_policy_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_provider_endpoint_connection
  ON provider_endpoint(connection_id, enabled, name);
```

`base_url + explicit_port + path_template + method + api_version` 必须足以重建最终目标，不能只保存经过丢失信息的规范化 URL。一个连接可以有任意数量的端点、端口和协议组合。

`retry_policy_json = NULL` 表示继承应用默认；非空值为 endpoint 覆盖。每个 logical request 仍需把最终生效 policy 复制到 RequestSnapshot，避免设置变化改写历史。

### 4.4 model

```sql
CREATE TABLE model (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES provider_endpoint(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capability_schema_json TEXT NOT NULL DEFAULT '{}',
  params_schema_json TEXT NOT NULL DEFAULT '[]',
  built_in_tools_json TEXT NOT NULL DEFAULT '[]',
  extra_body_json TEXT NOT NULL DEFAULT '{}',
  extra_headers_json TEXT NOT NULL DEFAULT '{}',
  extra_query_json TEXT NOT NULL DEFAULT '{}',
  context_window INTEGER,
  max_output_tokens INTEGER,
  protocol_profile_override_id TEXT REFERENCES protocol_profile(id),
  schema_origin TEXT NOT NULL DEFAULT 'user',
  schema_revision INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(endpoint_id, model_id)
);
```

同一个远程 model id 在不同端点上是不同 `model` 记录，能力、参数和兼容结论不互相继承。`display_name` 和连接的 `vendor_hint` 变化不改变最终请求。

### 4.5 parameter_compatibility_probe

```sql
CREATE TABLE parameter_compatibility_probe (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES provider_endpoint(id) ON DELETE CASCADE,
  model_ref TEXT NOT NULL REFERENCES model(id) ON DELETE CASCADE,
  protocol_profile_id TEXT NOT NULL REFERENCES protocol_profile(id),
  protocol_profile_revision INTEGER NOT NULL,
  api_version TEXT,
  parameter_id TEXT NOT NULL,
  placement TEXT NOT NULL,
  wire_path TEXT NOT NULL,
  tested_value_json TEXT,
  status TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  request_fingerprint TEXT,
  http_status INTEGER,
  provider_error_code TEXT,
  note TEXT,
  checked_at INTEGER NOT NULL
);

CREATE INDEX idx_parameter_probe_lookup
  ON parameter_compatibility_probe(
    endpoint_id, model_ref, protocol_profile_id,
    protocol_profile_revision, api_version, parameter_id, checked_at DESC
  );
```

`status` 只允许 `unknown`、`accepted_effective`、`accepted_ignored`、`rejected` 或 `translated`。HTTP 200 不能单独把状态提升为 `accepted_effective`。端点、模型、API version 或 profile revision 变化后，旧证据只能作为历史参考。

### 4.6 conversation

```sql
CREATE TABLE conversation (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model_ref TEXT REFERENCES model(id),
  system_prompt TEXT NOT NULL DEFAULT '',
  params_json TEXT NOT NULL DEFAULT '{}',
  extra_body_json TEXT NOT NULL DEFAULT '{}',
  extra_headers_json TEXT NOT NULL DEFAULT '{}',
  extra_query_json TEXT NOT NULL DEFAULT '{}',
  tools_override_json TEXT NOT NULL DEFAULT '{}',
  context_policy_json TEXT NOT NULL DEFAULT '{"mode":"lossless"}',
  active_leaf_message_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

这些覆盖列构成持久化的 `ConversationOverride`。发送时仍必须从 `model.endpoint_id` 解析连接、端点和协议 profile；不得从模型名猜测。

### 4.7 message

```sql
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done',
  usage_json TEXT,
  model_ref TEXT REFERENCES model(id),
  parent_id TEXT REFERENCES message(id) ON DELETE CASCADE,
  sibling_order INTEGER NOT NULL DEFAULT 0,
  provider_response_id TEXT,
  provider_previous_response_id TEXT,
  request_snapshot_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (role = 'root' AND parent_id IS NULL) OR
    (role <> 'root' AND parent_id IS NOT NULL)
  )
);

CREATE INDEX idx_message_conversation_created
  ON message(conversation_id, created_at, id);

CREATE INDEX idx_message_parent
  ON message(parent_id, sibling_order);

CREATE UNIQUE INDEX idx_message_one_root_per_conversation
  ON message(conversation_id)
  WHERE parent_id IS NULL;
```

`blocks_json` 是消息语义的权威数据。不得另建一套 UI tool card 数据而不同步回 blocks。

每个 conversation 在创建事务中同时创建一个 `role = 'root'`、`parent_id IS NULL`、`blocks_json = '[]'` 的无内容虚拟根。所有 user/assistant/system 内容消息都必须拥有非空 parent；第一轮 user message 的 parent 就是虚拟根。根节点不渲染、不进入模型上下文、不能成为 `active_leaf_message_id`，只能随整个 conversation 删除。

### 4.8 request_snapshot

```sql
CREATE TABLE request_snapshot (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  user_message_id TEXT REFERENCES message(id),
  assistant_message_id TEXT REFERENCES message(id),
  connection_id TEXT NOT NULL REFERENCES provider_connection(id),
  endpoint_id TEXT NOT NULL REFERENCES provider_endpoint(id),
  model_ref TEXT REFERENCES model(id),
  protocol_profile_id TEXT NOT NULL REFERENCES protocol_profile(id),
  protocol_profile_revision INTEGER NOT NULL,
  codec_version TEXT NOT NULL,
  request_method TEXT NOT NULL,
  request_url TEXT NOT NULL,
  request_headers_json TEXT,
  request_query_json TEXT,
  request_body_json TEXT,
  params_json TEXT NOT NULL,
  context_manifest_json TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  request_body_hash TEXT NOT NULL,
  retry_policy_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  provider_anchor_json TEXT,
  status TEXT NOT NULL,
  finish_reason TEXT,
  error_code TEXT,
  started_at INTEGER NOT NULL,
  first_event_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX idx_request_snapshot_conversation_started
  ON request_snapshot(conversation_id, started_at DESC);
```

`request_snapshot` 表示一个 logical request，保存“本轮如何构造”和最终终态；自动重试不会新建 snapshot。Header/Query/Body 的具体保留范围与凭据处理属于后续安全专题，当前 schema 只保留表达完整请求所需的可选字段。

- `request_body_hash` 对最终序列化 Body 计算，用于证明自动 attempts 没有改变参数或上下文。
- `retry_policy_json` 保存发送瞬间生效的 policy，等待期间设置变化不回写。
- 用户手动重新生成创建新的 assistant sibling 和新的 snapshot。

### 4.9 request_attempt

```sql
CREATE TABLE request_attempt (
  id TEXT PRIMARY KEY,
  request_snapshot_id TEXT NOT NULL
    REFERENCES request_snapshot(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  transport_request_id TEXT NOT NULL UNIQUE,
  request_body_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  retryable INTEGER NOT NULL DEFAULT 0,
  retry_reason TEXT,
  http_status INTEGER,
  provider_error_code TEXT,
  retry_after_ms INTEGER,
  scheduled_delay_ms INTEGER,
  started_at INTEGER NOT NULL,
  first_byte_at INTEGER,
  first_semantic_event_at INTEGER,
  completed_at INTEGER,
  bytes_received INTEGER NOT NULL DEFAULT 0,
  semantic_event_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(request_snapshot_id, attempt_no)
);

CREATE INDEX idx_request_attempt_snapshot_no
  ON request_attempt(request_snapshot_id, attempt_no);
```

规则：

- `trigger` 在 MVP 只允许 `initial` 或 `automatic_retry`；手动重新生成不写入旧 snapshot。
- 每次网络开始前先写 running attempt，再调用 Rust 管道，便于崩溃恢复和竞态审计。
- `request_body_hash` 必须与父 snapshot 一致；不一致视为完整性错误并阻止自动发送。
- `first_semantic_event_at` 一旦存在，默认禁止从头自动重试。
- 错误正文、响应片段和请求明细的保留策略后续决定；attempt 核心字段只要求能证明请求是否变化以及如何结束。
- Provider 返回 usage/cost 时按实际 attempt 关联保存或聚合；没有证据时不得推断重试是否重复计费。

### 4.10 artifact

```sql
CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  relative_path TEXT NOT NULL,
  mime_type TEXT,
  byte_size INTEGER NOT NULL,
  kind TEXT NOT NULL,
  original_name TEXT,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER
);
```

消息块和工具结果通过 artifact id/ref 引用文件。文件名不得使用不可信输入直接拼路径。

### 4.11 app_setting

```sql
CREATE TABLE app_setting (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

保存长期设置。窗口状态也可以由 tauri-plugin-store/window-state 管理，不要求全部进入此表。

## 5. MessageBlock 版本

`blocks_json` 顶层建议保存版本：

```json
{
  "version": 1,
  "blocks": [
    { "type": "thinking", "text": "...", "visibility": "provider_returned" },
    { "type": "text", "text": "最终回答" },
    {
      "type": "tool_call",
      "id": "call_1",
      "name": "web_search",
      "args": { "query": "..." },
      "status": "succeeded",
      "result": {
        "modelContent": { "type": "json", "value": { "items": [] } },
        "rawRef": "artifact_123"
      }
    }
  ]
}
```

块 schema 变更优先通过读取时迁移和写回新版本完成。不能让 UI 同时长期维护多套不兼容块结构。

## 6. 块类型

MVP 允许的核心块：

| 类型 | 关键字段 | 是否进入模型上下文 |
|---|---|---|
| `text` | text | 是 |
| `thinking` | text、visibility、signature/meta | 按 Provider 策略 |
| `tool_call` | id、name、args、status、result | 是，按协议展开 |
| `source` | id、URL、title、toolCallId | 按 Provider/工具结果结构 |
| `citation` | sourceId、range/marker | 通常随文本或 Provider item |
| `image` | artifactRef、mime、alt | 模型支持时 |
| `file` | artifactRef、name、mime | 模型支持或提取后 |
| `error` | code、message、retryable | 通常不进入，除非工具失败结果 |
| `provider_state` | provider、opaque data、purpose | 仅 codec/profile 按明确策略使用 |

未知块必须保留原始 JSON，不能在读取时删除。ContextAssembler 遇到未知块应显式报告是否能忽略。

## 7. 分支模型

### 7.1 虚拟根与首轮语义

虚拟根让首轮输入、首轮编辑和后续任意 sibling 使用完全相同的 parent 规则。判断“是否为第一轮”必须比较 `message.parent_id === conversationRootId`，不得因为 parent 没出现在当前分页结果中就猜测。路径查询从 active leaf 回溯到虚拟根，并在返回 UI/ContextAssembler 前排除根节点。

数据库唯一索引保证至多一个根；创建 conversation 的事务和完整性检查保证恰好一个根。缺失根是需要停止写入的结构错误，不能在普通读取时静默补建。

### 7.2 重新生成

旧 assistant 消息保持不变，新 assistant 使用相同 parent user message，并增加 `sibling_order`。conversation 的 active leaf 指向新分支。

### 7.3 编辑用户消息

不原地修改已经有后代的 user message。创建新的 user sibling 或替代节点，并从此节点生成新 assistant，保留旧分支。

### 7.4 删除

普通“删除消息”应明确是隐藏分支、删除子树还是仅从当前视图移除。MVP 可以只支持删除整个会话，消息级破坏性删除延后，避免破坏 parent 图。

### 7.5 路径查询

ContextAssembler 必须按 parent 链读取到虚拟根并排除根本身。需要检测环、跨会话 parent、缺失父节点和 active leaf 指向根节点。

## 8. 状态

消息状态：

- `pending`：placeholder 已创建，尚未收到事件。
- `waiting_retry`：当前 attempt 已失败，logical request 正在等待下一次自动尝试。
- `streaming`：正在生成。
- `done`：正常完成。
- `interrupted`：用户取消、应用退出或可恢复断流。
- `error`：失败并具有错误块/快照。

启动恢复：所有上次进程留下的 `pending`/`waiting_retry`/`streaming` 消息转为 `interrupted`，保留现有块并记录恢复时间；running attempt 同时转为 `cancelled` 或 `interrupted` 诊断终态，不在重启后静默重发。

## 9. 事务

必须在事务中完成的操作：

- 创建 conversation 与其唯一虚拟根。
- 创建 user message、assistant placeholder 和更新 active leaf。
- 创建 logical request snapshot 与 initial attempt。
- attempt 终态、下一次 retry schedule 与 message `waiting_retry` 的一致更新。
- 完成 assistant message、usage、response id 和 request snapshot 终态。
- 创建分支节点与会话 active leaf 更新。
- 删除会话及其消息引用。
- 应用一次 schema migration。

流式增量不应每 token 写 SQLite。可以按较低频率保存检查点，正常完成时一次写最终块；检查点频率需符合性能预算。

## 10. 分页

- 初次加载最近 50 条当前分支或当前视图消息。
- 上滑使用稳定游标 `(created_at, id)`，不使用 offset 作为长期分页。
- 内存窗口约 300 条，释放远端页时保留滚动锚点。
- 分支切换后重新计算当前路径，不在一个扁平数组中混入 sibling。
- 数据库上下文读取不受 UI 页大小限制。

## 11. 全文搜索

优先 FTS5：

- 索引 user/assistant text 和可配置的工具结果文本。
- 不索引连接配置、请求 Header/Query、二进制或 raw trace；全文搜索只服务会话内容发现。
- 搜索结果保存 message id 和片段，点击后定位会话与分支。
- FTS 表可从权威 message 表重建。

若目标 SQLite 未启用 FTS5，MVP 可以使用受限 LIKE 搜索，但必须在诊断中显示能力状态，不伪装成高性能全文索引。

## 12. 导入导出

导出包至少包含：

- manifest 版本。
- 连接、端点、协议 profile 及其 revision。
- 模型、能力、参数、工具 schema 和兼容性探测记录。
- 会话、消息块、分支和快照的可选部分。
- 附件清单和校验哈希。

是否包含认证值、完整请求和原始诊断 trace 属于后续安全与隐私专题；当前数据规范不把它们设为 MVP 门禁。导入流程仍应先校验格式版本、文件清单和哈希，再事务写入，避免半导入状态。

## 13. 迁移规则

- 每个迁移有唯一递增版本、名称和 checksum。
- 迁移在事务中执行，失败则回滚并停止应用进入写模式。
- 大型数据重写先备份或建立可恢复副本。
- 迁移函数可在 fixture 数据库上重复验证，但实际数据库同一版本只执行一次。
- 不能修改已经发布迁移的内容，应新增后续修复迁移。
- 每次 schema 变更必须更新导入导出版本和测试 fixture。

## 14. 数据完整性检查

开发者诊断应能检查：

- orphan message、跨会话 parent、parent 环。
- conversation 缺少虚拟根、存在多个根、内容消息 parent 为空或根节点含内容。
- active leaf 不存在、跨会话或指向虚拟根。
- succeeded tool call 缺少 modelContent。
- artifact 引用不存在或 hash 不符。
- request snapshot 指向不存在的消息。
- request attempt 缺少父 snapshot、attempt_no 重复或 body hash 与父 snapshot 不一致。
- snapshot attempt_count 与实际 attempt 数量不一致。
- model 引用不存在的 endpoint，或 endpoint 引用不存在的 protocol profile。
- compatibility probe 的 endpoint/model/profile 组合不一致，或 profile revision 已过期。
- JSON 字段解析失败或 schema 版本未知。

默认只报告，不自动删除。修复操作必须可预览并备份。

## 15. 保留与清理

- 会话默认永久保留，直到用户删除。
- 删除会话后，未被其他消息引用的 artifact 可进入延迟垃圾回收。
- 原始 trace 的保留期和容量上限由后续诊断与安全专题决定。
- 搜索索引在删除后同步清理。

## 16. 测试要求

- 空数据库创建到最新 schema。
- 每个历史版本 fixture 逐级迁移。
- 迁移中断回滚。
- 创建 conversation 时虚拟根与 conversation 同事务提交；失败时二者都不存在。
- 首轮 user message、首轮编辑 sibling 和普通分支都以同一虚拟根/parent 规则工作，分页不影响首轮判断。
- 根节点不进入 UI、FTS、导出正文或 ContextAssembler，且不能单独删除。
- 分支路径和 sibling 隔离。
- 500/1000 条消息游标分页无重复无遗漏。
- tool block 序列化/反序列化保持 modelContent 和 ID。
- 连接 -> 多端点 -> 多协议 profile -> 模型的 round trip 保持显式端口、路径和 revision。
- Endpoint RetryPolicy 继承/覆盖与模型 preset round trip 保持 `presetBinding` 的 `tracked`/`detached` 模式、`baseRevision`、`overridePatch` 和来源；`userEdited` 只作为显示字段验证，不能代替所有权语义。
- 同一 model id 在不同 endpoint 上的 capability、parameter 和 compatibility 记录互不串用。
- `unknown/accepted_effective/accepted_ignored/rejected/translated` 探测状态 round trip 不丢证据。
- 启动时 pending/waiting_retry/streaming 恢复为 interrupted。
- waiting_retry/running attempt 启动恢复后不会自动再次发送。
- 同一 snapshot 多个 attempt 的 context/body hash 一致。
- attempt_no 连续、计数正确，手动重新生成使用新的 snapshot/sibling。
- artifact 去重、缺失、hash 不符和垃圾回收。
- FTS 可用与不可用回退。
- 导入版本不兼容、清单/hash 不一致和损坏 JSON 被拒绝且不留下半写入数据。

## 17. 验收标准

在数据层标记 `verified` 前，应使用一个包含虚拟根、首轮 sibling、文本、思考、多个工具调用、来源、附件、分支、多个自动 retry attempts 和 interrupted 消息的 fixture 完成：写入、重启读取、上下文构造、导出、导入到新库、再次构造上下文，并验证根不泄漏到正文/上下文，关键块、context 和 request body hash 一致。
