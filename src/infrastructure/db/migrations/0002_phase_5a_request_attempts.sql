CREATE TABLE request_attempt (
  id TEXT PRIMARY KEY,
  request_snapshot_id TEXT NOT NULL
    REFERENCES request_snapshot(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  trigger TEXT NOT NULL CHECK (trigger IN ('initial', 'automatic_retry')),
  transport_request_id TEXT NOT NULL UNIQUE,
  request_body_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'running',
      'retryable_failed',
      'non_retryable_failed',
      'completed',
      'cancelled'
    )
  ),
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  retry_reason TEXT,
  http_status INTEGER,
  provider_error_code TEXT,
  retry_after_ms INTEGER CHECK (retry_after_ms IS NULL OR retry_after_ms >= 0),
  scheduled_delay_ms INTEGER CHECK (
    scheduled_delay_ms IS NULL OR scheduled_delay_ms >= 0
  ),
  started_at INTEGER NOT NULL,
  first_byte_at INTEGER,
  first_semantic_event_at INTEGER,
  completed_at INTEGER,
  bytes_received INTEGER NOT NULL DEFAULT 0 CHECK (bytes_received >= 0),
  semantic_event_count INTEGER NOT NULL DEFAULT 0 CHECK (semantic_event_count >= 0),
  UNIQUE(request_snapshot_id, attempt_no)
);

CREATE INDEX idx_request_attempt_snapshot_no
  ON request_attempt(request_snapshot_id, attempt_no);

CREATE TABLE application_retry_policy (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  policy_json TEXT NOT NULL CHECK (
    json_valid(policy_json) AND json_type(policy_json) = 'object'
  ),
  updated_at INTEGER NOT NULL
);

CREATE TRIGGER trg_request_attempt_insert
BEFORE INSERT ON request_attempt
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM request_snapshot
      WHERE id = NEW.request_snapshot_id
        AND attempt_count = NEW.attempt_no
        AND request_body_hash = NEW.request_body_hash
        AND status = 'running'
    )
    THEN RAISE(ABORT, 'request_attempt_snapshot_mismatch')
  END;
  SELECT CASE
    WHEN (NEW.attempt_no = 1 AND NEW.trigger <> 'initial')
      OR (NEW.attempt_no > 1 AND NEW.trigger <> 'automatic_retry')
    THEN RAISE(ABORT, 'request_attempt_trigger_mismatch')
  END;
END;

CREATE TRIGGER trg_request_attempt_association_immutable
BEFORE UPDATE OF
  request_snapshot_id,
  attempt_no,
  trigger,
  transport_request_id,
  request_body_hash,
  started_at
ON request_attempt
WHEN NEW.request_snapshot_id IS NOT OLD.request_snapshot_id
  OR NEW.attempt_no IS NOT OLD.attempt_no
  OR NEW.trigger IS NOT OLD.trigger
  OR NEW.transport_request_id IS NOT OLD.transport_request_id
  OR NEW.request_body_hash IS NOT OLD.request_body_hash
  OR NEW.started_at IS NOT OLD.started_at
BEGIN
  SELECT RAISE(ABORT, 'request_attempt_association_immutable');
END;

CREATE VIEW start_logical_request_command AS
SELECT
  NULL AS snapshot_id,
  NULL AS conversation_id,
  NULL AS user_message_id,
  NULL AS assistant_message_id,
  NULL AS connection_id,
  NULL AS endpoint_id,
  NULL AS model_ref,
  NULL AS protocol_profile_id,
  NULL AS protocol_profile_revision,
  NULL AS codec_version,
  NULL AS request_method,
  NULL AS request_url,
  NULL AS request_headers_json,
  NULL AS request_query_json,
  NULL AS request_body_json,
  NULL AS params_json,
  NULL AS context_manifest_json,
  NULL AS context_hash,
  NULL AS request_body_hash,
  NULL AS retry_policy_json,
  NULL AS started_at,
  NULL AS attempt_id,
  NULL AS transport_request_id
WHERE 0;

CREATE TRIGGER trg_start_logical_request_command
INSTEAD OF INSERT ON start_logical_request_command
BEGIN
  INSERT INTO request_snapshot (
    id,
    conversation_id,
    user_message_id,
    assistant_message_id,
    connection_id,
    endpoint_id,
    model_ref,
    protocol_profile_id,
    protocol_profile_revision,
    codec_version,
    request_method,
    request_url,
    request_headers_json,
    request_query_json,
    request_body_json,
    params_json,
    context_manifest_json,
    context_hash,
    request_body_hash,
    retry_policy_json,
    attempt_count,
    provider_anchor_json,
    status,
    finish_reason,
    error_code,
    started_at,
    first_event_at,
    completed_at
  ) VALUES (
    NEW.snapshot_id,
    NEW.conversation_id,
    NEW.user_message_id,
    NEW.assistant_message_id,
    NEW.connection_id,
    NEW.endpoint_id,
    NEW.model_ref,
    NEW.protocol_profile_id,
    NEW.protocol_profile_revision,
    NEW.codec_version,
    NEW.request_method,
    NEW.request_url,
    NEW.request_headers_json,
    NEW.request_query_json,
    NEW.request_body_json,
    NEW.params_json,
    NEW.context_manifest_json,
    NEW.context_hash,
    NEW.request_body_hash,
    NEW.retry_policy_json,
    1,
    NULL,
    'running',
    NULL,
    NULL,
    NEW.started_at,
    NULL,
    NULL
  );

  INSERT INTO request_attempt (
    id,
    request_snapshot_id,
    attempt_no,
    trigger,
    transport_request_id,
    request_body_hash,
    status,
    retryable,
    started_at
  ) VALUES (
    NEW.attempt_id,
    NEW.snapshot_id,
    1,
    'initial',
    NEW.transport_request_id,
    NEW.request_body_hash,
    'running',
    0,
    NEW.started_at
  );

  UPDATE message
  SET status = 'streaming', updated_at = NEW.started_at
  WHERE id = NEW.assistant_message_id
    AND request_snapshot_id = NEW.snapshot_id
    AND role = 'assistant'
    AND status = 'pending';

  SELECT CASE
    WHEN changes() <> 1
    THEN RAISE(ABORT, 'start_logical_request_assistant_not_pending')
  END;
END;

CREATE VIEW schedule_retry_command AS
SELECT
  NULL AS snapshot_id,
  NULL AS assistant_message_id,
  NULL AS attempt_id,
  NULL AS retry_reason,
  NULL AS http_status,
  NULL AS provider_error_code,
  NULL AS retry_after_ms,
  NULL AS scheduled_delay_ms,
  NULL AS completed_at,
  NULL AS first_byte_at,
  NULL AS first_semantic_event_at,
  NULL AS bytes_received,
  NULL AS semantic_event_count
WHERE 0;

CREATE TRIGGER trg_schedule_retry_command
INSTEAD OF INSERT ON schedule_retry_command
BEGIN
  UPDATE request_attempt
  SET
    status = 'retryable_failed',
    retryable = 1,
    retry_reason = NEW.retry_reason,
    http_status = NEW.http_status,
    provider_error_code = NEW.provider_error_code,
    retry_after_ms = NEW.retry_after_ms,
    scheduled_delay_ms = NEW.scheduled_delay_ms,
    completed_at = NEW.completed_at,
    first_byte_at = NEW.first_byte_at,
    first_semantic_event_at = NEW.first_semantic_event_at,
    bytes_received = NEW.bytes_received,
    semantic_event_count = NEW.semantic_event_count
  WHERE id = NEW.attempt_id
    AND request_snapshot_id = NEW.snapshot_id
    AND status = 'running';

  SELECT CASE
    WHEN changes() <> 1
    THEN RAISE(ABORT, 'schedule_retry_attempt_not_running')
  END;

  UPDATE message
  SET status = 'waiting_retry', updated_at = NEW.completed_at
  WHERE id = NEW.assistant_message_id
    AND request_snapshot_id = NEW.snapshot_id
    AND role = 'assistant'
    AND status IN ('pending', 'streaming');

  SELECT CASE
    WHEN changes() <> 1
    THEN RAISE(ABORT, 'schedule_retry_assistant_not_active')
  END;
END;

CREATE VIEW start_retry_attempt_command AS
SELECT
  NULL AS snapshot_id,
  NULL AS assistant_message_id,
  NULL AS attempt_id,
  NULL AS attempt_no,
  NULL AS transport_request_id,
  NULL AS request_body_hash,
  NULL AS started_at
WHERE 0;

CREATE TRIGGER trg_start_retry_attempt_command
INSTEAD OF INSERT ON start_retry_attempt_command
BEGIN
  UPDATE request_snapshot
  SET attempt_count = NEW.attempt_no
  WHERE id = NEW.snapshot_id
    AND assistant_message_id = NEW.assistant_message_id
    AND status = 'running'
    AND attempt_count = NEW.attempt_no - 1
    AND request_body_hash = NEW.request_body_hash;

  SELECT CASE
    WHEN changes() <> 1
    THEN RAISE(ABORT, 'start_retry_snapshot_mismatch')
  END;

  INSERT INTO request_attempt (
    id,
    request_snapshot_id,
    attempt_no,
    trigger,
    transport_request_id,
    request_body_hash,
    status,
    retryable,
    started_at
  ) VALUES (
    NEW.attempt_id,
    NEW.snapshot_id,
    NEW.attempt_no,
    'automatic_retry',
    NEW.transport_request_id,
    NEW.request_body_hash,
    'running',
    0,
    NEW.started_at
  );

  UPDATE message
  SET status = 'streaming', updated_at = NEW.started_at
  WHERE id = NEW.assistant_message_id
    AND request_snapshot_id = NEW.snapshot_id
    AND role = 'assistant'
    AND status = 'waiting_retry';

  SELECT CASE
    WHEN changes() <> 1
    THEN RAISE(ABORT, 'start_retry_assistant_not_waiting')
  END;
END;

CREATE VIEW finalize_request_attempt_command AS
SELECT
  NULL AS snapshot_id,
  NULL AS assistant_message_id,
  NULL AS attempt_id,
  NULL AS attempt_status,
  NULL AS message_status,
  NULL AS blocks_json,
  NULL AS usage_json,
  NULL AS provider_response_id,
  NULL AS provider_anchor_json,
  NULL AS finish_reason,
  NULL AS error_code,
  NULL AS retry_reason,
  NULL AS http_status,
  NULL AS provider_error_code,
  NULL AS completed_at,
  NULL AS first_event_at,
  NULL AS first_byte_at,
  NULL AS first_semantic_event_at,
  NULL AS bytes_received,
  NULL AS semantic_event_count
WHERE 0;

CREATE TRIGGER trg_finalize_request_attempt_command
INSTEAD OF INSERT ON finalize_request_attempt_command
BEGIN
  SELECT CASE
    WHEN NEW.attempt_status NOT IN ('completed', 'non_retryable_failed', 'cancelled')
    THEN RAISE(ABORT, 'finalize_request_attempt_status_invalid')
  END;

  UPDATE request_attempt
  SET
    status = NEW.attempt_status,
    retryable = 0,
    retry_reason = NEW.retry_reason,
    http_status = NEW.http_status,
    provider_error_code = NEW.provider_error_code,
    completed_at = NEW.completed_at,
    first_byte_at = NEW.first_byte_at,
    first_semantic_event_at = NEW.first_semantic_event_at,
    bytes_received = NEW.bytes_received,
    semantic_event_count = NEW.semantic_event_count
  WHERE id = NEW.attempt_id
    AND request_snapshot_id = NEW.snapshot_id
    AND status = 'running';

  SELECT CASE
    WHEN changes() <> 1
    THEN RAISE(ABORT, 'finalize_request_attempt_not_running')
  END;

  UPDATE message
  SET
    status = NEW.message_status,
    blocks_json = NEW.blocks_json,
    usage_json = NEW.usage_json,
    provider_response_id = NEW.provider_response_id,
    updated_at = NEW.completed_at
  WHERE id = NEW.assistant_message_id
    AND request_snapshot_id = NEW.snapshot_id
    AND role = 'assistant'
    AND status IN ('pending', 'waiting_retry', 'streaming');

  SELECT CASE
    WHEN changes() <> 1
    THEN RAISE(ABORT, 'finalize_request_assistant_not_active')
  END;

  UPDATE request_snapshot
  SET
    status = NEW.message_status,
    finish_reason = NEW.finish_reason,
    error_code = NEW.error_code,
    provider_anchor_json = NEW.provider_anchor_json,
    first_event_at = NEW.first_event_at,
    completed_at = NEW.completed_at
  WHERE id = NEW.snapshot_id
    AND assistant_message_id = NEW.assistant_message_id
    AND status = 'running';

  SELECT CASE
    WHEN changes() <> 1
    THEN RAISE(ABORT, 'finalize_request_snapshot_not_running')
  END;
END;

CREATE VIEW interrupt_waiting_retry_command AS
SELECT
  NULL AS snapshot_id,
  NULL AS assistant_message_id,
  NULL AS blocks_json,
  NULL AS completed_at,
  NULL AS error_code,
  NULL AS finish_reason,
  NULL AS message_status
WHERE 0;

CREATE TRIGGER trg_interrupt_waiting_retry_command
INSTEAD OF INSERT ON interrupt_waiting_retry_command
BEGIN
  SELECT CASE
    WHEN NEW.message_status NOT IN ('interrupted', 'error')
    THEN RAISE(ABORT, 'interrupt_retry_status_invalid')
  END;

  UPDATE message
  SET
    status = NEW.message_status,
    blocks_json = NEW.blocks_json,
    updated_at = NEW.completed_at
  WHERE id = NEW.assistant_message_id
    AND request_snapshot_id = NEW.snapshot_id
    AND role = 'assistant'
    AND status = 'waiting_retry';

  SELECT CASE
    WHEN changes() <> 1
    THEN RAISE(ABORT, 'interrupt_retry_assistant_not_waiting')
  END;

  UPDATE request_snapshot
  SET
    status = NEW.message_status,
    finish_reason = NEW.finish_reason,
    error_code = NEW.error_code,
    completed_at = NEW.completed_at
  WHERE id = NEW.snapshot_id
    AND assistant_message_id = NEW.assistant_message_id
    AND status = 'running';

  SELECT CASE
    WHEN changes() <> 1
    THEN RAISE(ABORT, 'interrupt_retry_snapshot_not_running')
  END;
END;

DROP TRIGGER trg_recover_interrupted_command;

CREATE TRIGGER trg_recover_interrupted_command
INSTEAD OF INSERT ON recover_interrupted_command
BEGIN
  UPDATE request_attempt
  SET
    status = 'cancelled',
    retryable = 0,
    retry_reason = COALESCE(retry_reason, 'app_restart'),
    completed_at = COALESCE(completed_at, NEW.recovered_at)
  WHERE status = 'running';

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
  2,
  'phase_5a_request_attempts',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  'sha256:1481a6b29f8f2b1a74c06addb7aea3bde49a2ffed563000ad89753a93ec2e744'
);
