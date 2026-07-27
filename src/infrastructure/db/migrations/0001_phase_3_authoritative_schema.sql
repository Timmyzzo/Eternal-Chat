CREATE TABLE schema_migration (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL,
  checksum TEXT NOT NULL
);

CREATE TABLE provider_connection (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vendor_hint TEXT,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE protocol_profile (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  codec_id TEXT NOT NULL,
  request_mapping_json TEXT NOT NULL CHECK (json_valid(request_mapping_json)),
  response_mapping_json TEXT NOT NULL CHECK (json_valid(response_mapping_json)),
  tools_mapping_json TEXT NOT NULL CHECK (json_valid(tools_mapping_json)),
  continuation_mapping_json TEXT CHECK (
    continuation_mapping_json IS NULL OR json_valid(continuation_mapping_json)
  ),
  source_json TEXT CHECK (source_json IS NULL OR json_valid(source_json)),
  user_edited INTEGER NOT NULL DEFAULT 0 CHECK (user_edited IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE provider_endpoint (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL
    REFERENCES provider_connection(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  explicit_port INTEGER CHECK (
    explicit_port IS NULL OR explicit_port BETWEEN 1 AND 65535
  ),
  path_template TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'POST',
  api_version TEXT,
  protocol_profile_id TEXT NOT NULL REFERENCES protocol_profile(id),
  auth_bindings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(auth_bindings_json)),
  headers_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(headers_json)),
  query_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(query_json)),
  body_defaults_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(body_defaults_json)),
  timeout_ms INTEGER CHECK (timeout_ms IS NULL OR timeout_ms > 0),
  retry_policy_json TEXT CHECK (
    retry_policy_json IS NULL OR json_valid(retry_policy_json)
  ),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_provider_endpoint_connection
  ON provider_endpoint(connection_id, enabled, name);

CREATE TABLE model (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES provider_endpoint(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capability_schema_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(capability_schema_json)),
  params_schema_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(params_schema_json)),
  built_in_tools_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(built_in_tools_json)),
  extra_body_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_body_json)),
  extra_headers_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_headers_json)),
  extra_query_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_query_json)),
  context_window INTEGER CHECK (context_window IS NULL OR context_window > 0),
  max_output_tokens INTEGER CHECK (
    max_output_tokens IS NULL OR max_output_tokens > 0
  ),
  protocol_profile_override_id TEXT REFERENCES protocol_profile(id),
  schema_origin TEXT NOT NULL DEFAULT 'user',
  schema_revision INTEGER NOT NULL DEFAULT 1 CHECK (schema_revision > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(endpoint_id, model_id)
);

CREATE TABLE parameter_compatibility_probe (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES provider_endpoint(id) ON DELETE CASCADE,
  model_ref TEXT NOT NULL REFERENCES model(id) ON DELETE CASCADE,
  protocol_profile_id TEXT NOT NULL REFERENCES protocol_profile(id),
  protocol_profile_revision INTEGER NOT NULL CHECK (protocol_profile_revision > 0),
  api_version TEXT,
  parameter_id TEXT NOT NULL,
  placement TEXT NOT NULL,
  wire_path TEXT NOT NULL,
  tested_value_json TEXT CHECK (
    tested_value_json IS NULL OR json_valid(tested_value_json)
  ),
  status TEXT NOT NULL CHECK (
    status IN (
      'unknown',
      'accepted_effective',
      'accepted_ignored',
      'rejected',
      'translated'
    )
  ),
  evidence_type TEXT NOT NULL,
  request_fingerprint TEXT,
  http_status INTEGER,
  provider_error_code TEXT,
  note TEXT,
  checked_at INTEGER NOT NULL
);

CREATE INDEX idx_parameter_probe_lookup
  ON parameter_compatibility_probe(
    endpoint_id,
    model_ref,
    protocol_profile_id,
    protocol_profile_revision,
    api_version,
    parameter_id,
    checked_at DESC
  );

CREATE TABLE conversation (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model_ref TEXT REFERENCES model(id),
  system_prompt TEXT NOT NULL DEFAULT '',
  params_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params_json)),
  extra_body_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_body_json)),
  extra_headers_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_headers_json)),
  extra_query_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_query_json)),
  tools_override_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(tools_override_json)),
  context_policy_json TEXT NOT NULL DEFAULT '{"mode":"lossless"}'
    CHECK (json_valid(context_policy_json)),
  active_leaf_message_id TEXT REFERENCES message(id) ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('root', 'system', 'user', 'assistant')),
  blocks_json TEXT NOT NULL CHECK (json_valid(blocks_json)),
  status TEXT NOT NULL DEFAULT 'done' CHECK (
    status IN ('pending', 'waiting_retry', 'streaming', 'done', 'interrupted', 'error')
  ),
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  model_ref TEXT REFERENCES model(id),
  parent_id TEXT REFERENCES message(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  sibling_order INTEGER NOT NULL DEFAULT 0 CHECK (sibling_order >= 0),
  provider_response_id TEXT,
  provider_previous_response_id TEXT,
  request_snapshot_id TEXT REFERENCES request_snapshot(id) ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (role = 'root' AND parent_id IS NULL) OR
    (role <> 'root' AND parent_id IS NOT NULL)
  ),
  CHECK (
    role <> 'root' OR (
      status = 'done' AND
      model_ref IS NULL AND
      json_extract(blocks_json, '$.version') = 1 AND
      json_array_length(json_extract(blocks_json, '$.blocks')) = 0
    )
  )
);

CREATE INDEX idx_message_conversation_created
  ON message(conversation_id, created_at, id);

CREATE UNIQUE INDEX idx_message_parent_sibling
  ON message(parent_id, sibling_order)
  WHERE parent_id IS NOT NULL;

CREATE UNIQUE INDEX idx_message_one_root_per_conversation
  ON message(conversation_id)
  WHERE parent_id IS NULL;

CREATE TABLE request_snapshot (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  user_message_id TEXT REFERENCES message(id),
  assistant_message_id TEXT REFERENCES message(id),
  connection_id TEXT NOT NULL REFERENCES provider_connection(id),
  endpoint_id TEXT NOT NULL REFERENCES provider_endpoint(id),
  model_ref TEXT REFERENCES model(id),
  protocol_profile_id TEXT NOT NULL REFERENCES protocol_profile(id),
  protocol_profile_revision INTEGER NOT NULL CHECK (protocol_profile_revision > 0),
  codec_version TEXT NOT NULL,
  request_method TEXT NOT NULL,
  request_url TEXT NOT NULL,
  request_headers_json TEXT CHECK (
    request_headers_json IS NULL OR json_valid(request_headers_json)
  ),
  request_query_json TEXT CHECK (
    request_query_json IS NULL OR json_valid(request_query_json)
  ),
  request_body_json TEXT CHECK (
    request_body_json IS NULL OR json_valid(request_body_json)
  ),
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),
  context_manifest_json TEXT NOT NULL CHECK (json_valid(context_manifest_json)),
  context_hash TEXT NOT NULL,
  request_body_hash TEXT NOT NULL,
  retry_policy_json TEXT NOT NULL CHECK (json_valid(retry_policy_json)),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provider_anchor_json TEXT CHECK (
    provider_anchor_json IS NULL OR json_valid(provider_anchor_json)
  ),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'done', 'interrupted', 'error')
  ),
  finish_reason TEXT,
  error_code TEXT,
  started_at INTEGER NOT NULL,
  first_event_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX idx_request_snapshot_conversation_started
  ON request_snapshot(conversation_id, started_at DESC, id);

CREATE INDEX idx_request_snapshot_endpoint_profile_revision
  ON request_snapshot(
    endpoint_id,
    protocol_profile_id,
    protocol_profile_revision,
    started_at DESC
  );

CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  relative_path TEXT NOT NULL,
  mime_type TEXT,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  kind TEXT NOT NULL,
  original_name TEXT,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER
);

CREATE TRIGGER trg_protocol_profile_revision_forward
BEFORE UPDATE OF revision ON protocol_profile
WHEN NEW.revision <= OLD.revision
BEGIN
  SELECT RAISE(ABORT, 'protocol_profile_revision_not_forward');
END;

CREATE TRIGGER trg_conversation_active_leaf_insert
BEFORE INSERT ON conversation
WHEN NEW.active_leaf_message_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'conversation_active_leaf_must_start_null');
END;

CREATE TRIGGER trg_conversation_create_root
AFTER INSERT ON conversation
BEGIN
  INSERT INTO message (
    id,
    conversation_id,
    role,
    blocks_json,
    status,
    parent_id,
    sibling_order,
    created_at,
    updated_at
  ) VALUES (
    NEW.id || ':root',
    NEW.id,
    'root',
    '{"version":1,"blocks":[]}',
    'done',
    NULL,
    0,
    NEW.created_at,
    NEW.updated_at
  );
END;

CREATE TRIGGER trg_message_parent_insert
BEFORE INSERT ON message
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM message WHERE id = NEW.parent_id)
    THEN RAISE(ABORT, 'message_parent_missing')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM message
      WHERE id = NEW.parent_id
        AND conversation_id <> NEW.conversation_id
    )
    THEN RAISE(ABORT, 'message_parent_cross_conversation')
  END;
END;

CREATE TRIGGER trg_message_parent_update
BEFORE UPDATE OF parent_id ON message
WHEN NEW.parent_id IS NOT OLD.parent_id
BEGIN
  SELECT CASE
    WHEN NEW.parent_id IS NULL AND NEW.role <> 'root'
    THEN RAISE(ABORT, 'message_parent_required')
  END;
  SELECT CASE
    WHEN NEW.parent_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM message WHERE id = NEW.parent_id)
    THEN RAISE(ABORT, 'message_parent_missing')
  END;
  SELECT CASE
    WHEN NEW.parent_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM message
        WHERE id = NEW.parent_id
          AND conversation_id <> NEW.conversation_id
      )
    THEN RAISE(ABORT, 'message_parent_cross_conversation')
  END;
  SELECT CASE
    WHEN NEW.parent_id = NEW.id
    THEN RAISE(ABORT, 'message_parent_cycle')
  END;
  SELECT CASE
    WHEN NEW.parent_id IS NOT NULL AND EXISTS (
      WITH RECURSIVE ancestors(id, parent_id, visited) AS (
        SELECT id, parent_id, ',' || id || ','
        FROM message
        WHERE id = NEW.parent_id
        UNION ALL
        SELECT parent.id, parent.parent_id, ancestors.visited || parent.id || ','
        FROM message AS parent
        JOIN ancestors ON parent.id = ancestors.parent_id
        WHERE instr(ancestors.visited, ',' || parent.id || ',') = 0
      )
      SELECT 1 FROM ancestors WHERE id = NEW.id
    )
    THEN RAISE(ABORT, 'message_parent_cycle')
  END;
END;

CREATE TRIGGER trg_message_conversation_immutable
BEFORE UPDATE OF conversation_id ON message
WHEN NEW.conversation_id <> OLD.conversation_id
BEGIN
  SELECT RAISE(ABORT, 'message_conversation_immutable');
END;

CREATE TRIGGER trg_message_root_immutable
BEFORE UPDATE OF role, parent_id, blocks_json ON message
WHEN OLD.role = 'root' AND (
  NEW.role IS NOT OLD.role OR
  NEW.parent_id IS NOT OLD.parent_id OR
  NEW.blocks_json IS NOT OLD.blocks_json
)
BEGIN
  SELECT RAISE(ABORT, 'message_root_immutable');
END;

CREATE TRIGGER trg_conversation_active_leaf_update
BEFORE UPDATE OF active_leaf_message_id ON conversation
WHEN NEW.active_leaf_message_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM message WHERE id = NEW.active_leaf_message_id
    )
    THEN RAISE(ABORT, 'conversation_active_leaf_missing')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM message
      WHERE id = NEW.active_leaf_message_id
        AND conversation_id <> NEW.id
    )
    THEN RAISE(ABORT, 'conversation_active_leaf_cross_conversation')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM message
      WHERE id = NEW.active_leaf_message_id
        AND role = 'root'
    )
    THEN RAISE(ABORT, 'conversation_active_leaf_root')
  END;
END;

CREATE TRIGGER trg_parameter_probe_insert
BEFORE INSERT ON parameter_compatibility_probe
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM model
      WHERE id = NEW.model_ref
        AND endpoint_id = NEW.endpoint_id
    )
    THEN RAISE(ABORT, 'parameter_probe_model_endpoint_mismatch')
  END;
  SELECT CASE
    WHEN COALESCE(
      (
        SELECT protocol_profile_override_id
        FROM model
        WHERE id = NEW.model_ref
      ),
      (
        SELECT protocol_profile_id
        FROM provider_endpoint
        WHERE id = NEW.endpoint_id
      )
    ) IS NOT NEW.protocol_profile_id
    THEN RAISE(ABORT, 'parameter_probe_profile_mismatch')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM protocol_profile
      WHERE id = NEW.protocol_profile_id
        AND revision = NEW.protocol_profile_revision
    )
    THEN RAISE(ABORT, 'parameter_probe_profile_revision_mismatch')
  END;
END;

CREATE TRIGGER trg_parameter_probe_association_immutable
BEFORE UPDATE OF endpoint_id, model_ref, protocol_profile_id, protocol_profile_revision
ON parameter_compatibility_probe
WHEN NEW.endpoint_id IS NOT OLD.endpoint_id
  OR NEW.model_ref IS NOT OLD.model_ref
  OR NEW.protocol_profile_id IS NOT OLD.protocol_profile_id
  OR NEW.protocol_profile_revision IS NOT OLD.protocol_profile_revision
BEGIN
  SELECT RAISE(ABORT, 'parameter_probe_association_immutable');
END;

CREATE TRIGGER trg_request_snapshot_insert
BEFORE INSERT ON request_snapshot
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM provider_endpoint
      WHERE id = NEW.endpoint_id
        AND connection_id = NEW.connection_id
    )
    THEN RAISE(ABORT, 'request_snapshot_connection_endpoint_mismatch')
  END;
  SELECT CASE
    WHEN NEW.model_ref IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM model
      WHERE id = NEW.model_ref
        AND endpoint_id = NEW.endpoint_id
    )
    THEN RAISE(ABORT, 'request_snapshot_model_endpoint_mismatch')
  END;
  SELECT CASE
    WHEN COALESCE(
      (
        SELECT protocol_profile_override_id
        FROM model
        WHERE id = NEW.model_ref
      ),
      (
        SELECT protocol_profile_id
        FROM provider_endpoint
        WHERE id = NEW.endpoint_id
      )
    ) IS NOT NEW.protocol_profile_id
    THEN RAISE(ABORT, 'request_snapshot_profile_mismatch')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM protocol_profile
      WHERE id = NEW.protocol_profile_id
        AND revision = NEW.protocol_profile_revision
    )
    THEN RAISE(ABORT, 'request_snapshot_profile_revision_mismatch')
  END;
  SELECT CASE
    WHEN NEW.user_message_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM message
      WHERE id = NEW.user_message_id
        AND conversation_id = NEW.conversation_id
        AND role = 'user'
    )
    THEN RAISE(ABORT, 'request_snapshot_user_message_mismatch')
  END;
  SELECT CASE
    WHEN NEW.assistant_message_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM message
      WHERE id = NEW.assistant_message_id
        AND conversation_id = NEW.conversation_id
        AND role = 'assistant'
        AND request_snapshot_id IS NULL
    )
    THEN RAISE(ABORT, 'request_snapshot_assistant_message_mismatch')
  END;
  SELECT CASE
    WHEN NEW.user_message_id IS NOT NULL
      AND NEW.assistant_message_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM message
        WHERE id = NEW.assistant_message_id
          AND parent_id = NEW.user_message_id
      )
    THEN RAISE(ABORT, 'request_snapshot_message_pair_mismatch')
  END;
END;

CREATE TRIGGER trg_request_snapshot_link_assistant
AFTER INSERT ON request_snapshot
WHEN NEW.assistant_message_id IS NOT NULL
BEGIN
  UPDATE message
  SET request_snapshot_id = NEW.id
  WHERE id = NEW.assistant_message_id;
END;

CREATE TRIGGER trg_request_snapshot_association_immutable
BEFORE UPDATE OF
  conversation_id,
  user_message_id,
  assistant_message_id,
  connection_id,
  endpoint_id,
  model_ref,
  protocol_profile_id,
  protocol_profile_revision
ON request_snapshot
WHEN NEW.conversation_id IS NOT OLD.conversation_id
  OR NEW.user_message_id IS NOT OLD.user_message_id
  OR NEW.assistant_message_id IS NOT OLD.assistant_message_id
  OR NEW.connection_id IS NOT OLD.connection_id
  OR NEW.endpoint_id IS NOT OLD.endpoint_id
  OR NEW.model_ref IS NOT OLD.model_ref
  OR NEW.protocol_profile_id IS NOT OLD.protocol_profile_id
  OR NEW.protocol_profile_revision IS NOT OLD.protocol_profile_revision
BEGIN
  SELECT RAISE(ABORT, 'request_snapshot_association_immutable');
END;

CREATE VIEW create_pending_turn_command AS
SELECT
  NULL AS conversation_id,
  NULL AS parent_id,
  NULL AS user_message_id,
  NULL AS user_blocks_json,
  NULL AS assistant_message_id,
  NULL AS assistant_blocks_json,
  NULL AS assistant_model_ref,
  NULL AS created_at
WHERE 0;

CREATE TRIGGER trg_create_pending_turn_command
INSTEAD OF INSERT ON create_pending_turn_command
BEGIN
  INSERT INTO message (
    id,
    conversation_id,
    role,
    blocks_json,
    status,
    parent_id,
    sibling_order,
    created_at,
    updated_at
  ) VALUES (
    NEW.user_message_id,
    NEW.conversation_id,
    'user',
    NEW.user_blocks_json,
    'done',
    NEW.parent_id,
    COALESCE(
      (
        SELECT MAX(sibling_order) + 1
        FROM message
        WHERE parent_id = NEW.parent_id
      ),
      0
    ),
    NEW.created_at,
    NEW.created_at
  );

  INSERT INTO message (
    id,
    conversation_id,
    role,
    blocks_json,
    status,
    model_ref,
    parent_id,
    sibling_order,
    created_at,
    updated_at
  ) VALUES (
    NEW.assistant_message_id,
    NEW.conversation_id,
    'assistant',
    NEW.assistant_blocks_json,
    'pending',
    NEW.assistant_model_ref,
    NEW.user_message_id,
    0,
    NEW.created_at,
    NEW.created_at
  );

  UPDATE conversation
  SET
    active_leaf_message_id = NEW.assistant_message_id,
    updated_at = NEW.created_at
  WHERE id = NEW.conversation_id;

  SELECT CASE
    WHEN changes() <> 1
    THEN RAISE(ABORT, 'pending_turn_conversation_missing')
  END;
END;

CREATE VIEW create_assistant_sibling_command AS
SELECT
  NULL AS conversation_id,
  NULL AS parent_user_message_id,
  NULL AS assistant_message_id,
  NULL AS assistant_blocks_json,
  NULL AS assistant_model_ref,
  NULL AS created_at
WHERE 0;

CREATE TRIGGER trg_create_assistant_sibling_command
INSTEAD OF INSERT ON create_assistant_sibling_command
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM message
      WHERE id = NEW.parent_user_message_id
        AND conversation_id = NEW.conversation_id
        AND role = 'user'
    )
    THEN RAISE(ABORT, 'assistant_sibling_parent_invalid')
  END;

  INSERT INTO message (
    id,
    conversation_id,
    role,
    blocks_json,
    status,
    model_ref,
    parent_id,
    sibling_order,
    created_at,
    updated_at
  ) VALUES (
    NEW.assistant_message_id,
    NEW.conversation_id,
    'assistant',
    NEW.assistant_blocks_json,
    'pending',
    NEW.assistant_model_ref,
    NEW.parent_user_message_id,
    COALESCE(
      (
        SELECT MAX(sibling_order) + 1
        FROM message
        WHERE parent_id = NEW.parent_user_message_id
      ),
      0
    ),
    NEW.created_at,
    NEW.created_at
  );

  UPDATE conversation
  SET
    active_leaf_message_id = NEW.assistant_message_id,
    updated_at = NEW.created_at
  WHERE id = NEW.conversation_id;
END;

CREATE VIEW recover_interrupted_command AS
SELECT NULL AS recovered_at WHERE 0;

CREATE TRIGGER trg_recover_interrupted_command
INSTEAD OF INSERT ON recover_interrupted_command
BEGIN
  UPDATE request_snapshot
  SET
    status = 'interrupted',
    error_code = COALESCE(error_code, 'app_restart'),
    completed_at = COALESCE(completed_at, NEW.recovered_at)
  WHERE assistant_message_id IN (
    SELECT id
    FROM message
    WHERE role = 'assistant'
      AND status IN ('pending', 'waiting_retry', 'streaming')
  )
    AND status IN ('pending', 'running');

  UPDATE message
  SET
    status = 'interrupted',
    updated_at = NEW.recovered_at
  WHERE role = 'assistant'
    AND status IN ('pending', 'waiting_retry', 'streaming');
END;

INSERT INTO schema_migration (version, name, applied_at, checksum)
VALUES (
  1,
  'phase_3_authoritative_schema',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  'sha256:71d89fafbb08fd0f1fa04d6a0c5b258afdc9c13abdb1dd1d28f8ffb1036502e1'
);
