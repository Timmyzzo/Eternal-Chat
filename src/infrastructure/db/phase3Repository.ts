import type {
  Conversation,
  Message,
  MessageBlocks,
  MessageCursor,
  MessagePage,
  MessageStatus,
  RequestAttempt,
  RequestSnapshot,
} from "@/domain/chat";
import { parseMessageBlocks, serializeMessageBlocks } from "@/domain/chat";
import type { JsonValue } from "@/domain/json";
import type {
  Artifact,
  Model,
  ParameterCompatibilityProbe,
  PresetBinding,
  ProtocolProfile,
  ProviderConnection,
  ProviderEndpoint,
} from "@/domain/provider";
import type { SqlDatabase } from "@/infrastructure/db/sqlDatabase";

export interface PendingTurnInput {
  conversationId: string;
  parentId: string;
  userMessageId: string;
  userBlocks: MessageBlocks;
  assistantMessageId: string;
  assistantBlocks: MessageBlocks;
  assistantModelRef: string | null;
  createdAt: number;
}

export interface AssistantSiblingInput {
  conversationId: string;
  parentUserMessageId: string;
  assistantMessageId: string;
  assistantBlocks: MessageBlocks;
  assistantModelRef: string | null;
  createdAt: number;
}

export interface PendingTurn {
  userMessage: Message;
  assistantMessage: Message;
}

export interface MessageParentChain {
  cycleMessageId: string | null;
  messages: Message[];
  missingParentId: string | null;
}

export interface FinalizeChatRequestInput {
  assistantMessageId: string;
  blocks: MessageBlocks;
  completedAt: number;
  errorCode: string | null;
  finishReason: string | null;
  firstEventAt: number | null;
  providerAnchor: JsonValue | null;
  providerResponseId: string | null;
  snapshotId: string;
  status: "done" | "interrupted" | "error";
  usage: JsonValue | null;
}

export interface ScheduleRetryInput {
  assistantMessageId: string;
  attemptId: string;
  bytesReceived: number;
  completedAt: number;
  firstByteAt: number | null;
  firstSemanticEventAt: number | null;
  httpStatus: number | null;
  providerErrorCode: string | null;
  retryAfterMs: number | null;
  retryReason: string;
  scheduledDelayMs: number;
  semanticEventCount: number;
  snapshotId: string;
}

export interface FinalizeRequestAttemptInput extends FinalizeChatRequestInput {
  attemptId: string;
  attemptStatus: Extract<
    RequestAttempt["status"],
    "completed" | "non_retryable_failed" | "cancelled"
  >;
  bytesReceived: number;
  firstByteAt: number | null;
  firstSemanticEventAt: number | null;
  httpStatus: number | null;
  providerErrorCode: string | null;
  retryReason: string | null;
  semanticEventCount: number;
}

export interface InterruptWaitingRetryInput {
  assistantMessageId: string;
  blocks: MessageBlocks;
  completedAt: number;
  errorCode: string;
  finishReason: string;
  snapshotId: string;
  status: "interrupted" | "error";
}

export class Phase3Repository {
  constructor(private readonly database: SqlDatabase) {}

  async getApplicationRetryPolicy(): Promise<JsonValue | null> {
    const row = await selectOptional<{ policy_json: string }>(
      this.database,
      "SELECT policy_json FROM application_retry_policy WHERE singleton = 1",
      [],
    );
    return row ? decodeJson(row.policy_json) : null;
  }

  async setApplicationRetryPolicy(policy: JsonValue, updatedAt: number): Promise<void> {
    await this.database.execute(
      `INSERT INTO application_retry_policy (singleton, policy_json, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        policy_json = excluded.policy_json,
        updated_at = excluded.updated_at`,
      [encodeJson(policy), updatedAt],
    );
  }

  async insertProviderConnection(value: ProviderConnection): Promise<void> {
    await this.database.execute(
      `INSERT INTO provider_connection (
        id, name, vendor_hint, description, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        value.id,
        value.name,
        value.vendorHint,
        value.description,
        toInteger(value.enabled),
        value.createdAt,
        value.updatedAt,
      ],
    );
  }

  async getProviderConnection(id: string): Promise<ProviderConnection | null> {
    const row = await selectOptional<ProviderConnectionRow>(
      this.database,
      "SELECT * FROM provider_connection WHERE id = ?",
      [id],
    );
    return row ? mapProviderConnection(row) : null;
  }

  async listProviderConnections(): Promise<ProviderConnection[]> {
    const rows = await this.database.select<ProviderConnectionRow>(
      "SELECT * FROM provider_connection ORDER BY enabled DESC, name, id",
    );
    return rows.map(mapProviderConnection);
  }

  async insertProtocolProfile(value: ProtocolProfile): Promise<void> {
    await this.database.execute(
      `INSERT INTO protocol_profile (
        id, name, codec_id, request_mapping_json, response_mapping_json,
        tools_mapping_json, continuation_mapping_json, source_json, preset_binding_json,
        user_edited, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      protocolProfileBindings(value),
    );
  }

  async updateProtocolProfile(value: ProtocolProfile): Promise<void> {
    const result = await this.database.execute(
      `UPDATE protocol_profile SET
        name = ?, codec_id = ?, request_mapping_json = ?, response_mapping_json = ?,
        tools_mapping_json = ?, continuation_mapping_json = ?, source_json = ?,
        preset_binding_json = ?, user_edited = ?, revision = ?, updated_at = ?
      WHERE id = ?`,
      [
        value.name,
        value.codecId,
        encodeJson(value.requestMapping),
        encodeJson(value.responseMapping),
        encodeJson(value.toolsMapping),
        encodeNullableJson(value.continuationMapping),
        encodeNullableJson(value.source),
        encodeNullableJson(value.presetBinding as unknown as JsonValue | null),
        toInteger(value.userEdited),
        value.revision,
        value.updatedAt,
        value.id,
      ],
    );
    requireChanged(result.rowsAffected, "protocol profile");
  }

  async getProtocolProfile(id: string): Promise<ProtocolProfile | null> {
    const row = await selectOptional<ProtocolProfileRow>(
      this.database,
      "SELECT * FROM protocol_profile WHERE id = ?",
      [id],
    );
    return row ? mapProtocolProfile(row) : null;
  }

  async listProtocolProfiles(): Promise<ProtocolProfile[]> {
    const rows = await this.database.select<ProtocolProfileRow>(
      "SELECT * FROM protocol_profile ORDER BY name, id",
    );
    return rows.map(mapProtocolProfile);
  }

  async insertProviderEndpoint(value: ProviderEndpoint): Promise<void> {
    await this.database.execute(
      `INSERT INTO provider_endpoint (
        id, connection_id, name, base_url, explicit_port, path_template, method,
        api_version, protocol_profile_id, auth_bindings_json, headers_json,
        query_json, body_defaults_json, path_defaults_json, source_json,
        preset_binding_json, timeout_ms, retry_policy_json, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        value.id,
        value.connectionId,
        value.name,
        value.baseUrl,
        value.explicitPort,
        value.pathTemplate,
        value.method,
        value.apiVersion,
        value.protocolProfileId,
        encodeJson(value.authBindings),
        encodeJson(value.headers),
        encodeJson(value.query),
        encodeJson(value.bodyDefaults),
        encodeJson(value.pathDefaults),
        encodeNullableJson(value.source),
        encodeNullableJson(value.presetBinding as unknown as JsonValue | null),
        value.timeoutMs,
        encodeNullableJson(value.retryPolicy),
        toInteger(value.enabled),
        value.createdAt,
        value.updatedAt,
      ],
    );
  }

  async updateProviderEndpoint(value: ProviderEndpoint): Promise<void> {
    const result = await this.database.execute(
      `UPDATE provider_endpoint SET
        connection_id = ?, name = ?, base_url = ?, explicit_port = ?, path_template = ?,
        method = ?, api_version = ?, protocol_profile_id = ?, auth_bindings_json = ?,
        headers_json = ?, query_json = ?, body_defaults_json = ?, path_defaults_json = ?,
        source_json = ?, preset_binding_json = ?, timeout_ms = ?, retry_policy_json = ?,
        enabled = ?, updated_at = ?
      WHERE id = ?`,
      [
        value.connectionId,
        value.name,
        value.baseUrl,
        value.explicitPort,
        value.pathTemplate,
        value.method,
        value.apiVersion,
        value.protocolProfileId,
        encodeJson(value.authBindings),
        encodeJson(value.headers),
        encodeJson(value.query),
        encodeJson(value.bodyDefaults),
        encodeJson(value.pathDefaults),
        encodeNullableJson(value.source),
        encodeNullableJson(value.presetBinding as unknown as JsonValue | null),
        value.timeoutMs,
        encodeNullableJson(value.retryPolicy),
        toInteger(value.enabled),
        value.updatedAt,
        value.id,
      ],
    );
    requireChanged(result.rowsAffected, "provider endpoint");
  }

  async getProviderEndpoint(id: string): Promise<ProviderEndpoint | null> {
    const row = await selectOptional<ProviderEndpointRow>(
      this.database,
      "SELECT * FROM provider_endpoint WHERE id = ?",
      [id],
    );
    return row ? mapProviderEndpoint(row) : null;
  }

  async updateProviderEndpointRetryPolicy(
    endpointId: string,
    retryPolicy: JsonValue | null,
    updatedAt: number,
  ): Promise<void> {
    const result = await this.database.execute(
      `UPDATE provider_endpoint
      SET retry_policy_json = ?, updated_at = ?
      WHERE id = ?`,
      [encodeNullableJson(retryPolicy), updatedAt, endpointId],
    );
    requireChanged(result.rowsAffected, "provider endpoint");
  }

  async listProviderEndpoints(connectionId?: string): Promise<ProviderEndpoint[]> {
    const rows = await this.database.select<ProviderEndpointRow>(
      connectionId
        ? "SELECT * FROM provider_endpoint WHERE connection_id = ? ORDER BY enabled DESC, name, id"
        : "SELECT * FROM provider_endpoint ORDER BY enabled DESC, name, id",
      connectionId ? [connectionId] : [],
    );
    return rows.map(mapProviderEndpoint);
  }

  async insertModel(value: Model): Promise<void> {
    await this.database.execute(
      `INSERT INTO model (
        id, endpoint_id, model_id, display_name, capability_schema_json,
        params_schema_json, parameter_values_json, built_in_tools_json, tool_settings_json,
        extra_body_json, extra_headers_json, extra_query_json, extra_path_json,
        context_window, max_output_tokens,
        protocol_profile_override_id, schema_origin, schema_revision, enabled,
        source_json, preset_binding_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        value.id,
        value.endpointId,
        value.modelId,
        value.displayName,
        encodeJson(value.capabilitySchema),
        encodeJson(value.paramsSchema),
        encodeJson(value.parameterValues),
        encodeJson(value.builtInTools),
        encodeJson(value.toolSettings),
        encodeJson(value.extraBody),
        encodeJson(value.extraHeaders),
        encodeJson(value.extraQuery),
        encodeJson(value.extraPath),
        value.contextWindow,
        value.maxOutputTokens,
        value.protocolProfileOverrideId,
        value.schemaOrigin,
        value.schemaRevision,
        toInteger(value.enabled),
        encodeNullableJson(value.source),
        encodeNullableJson(value.presetBinding as unknown as JsonValue | null),
        value.createdAt,
        value.updatedAt,
      ],
    );
  }

  async updateModel(value: Model): Promise<void> {
    const result = await this.database.execute(
      `UPDATE model SET
        endpoint_id = ?, model_id = ?, display_name = ?, capability_schema_json = ?,
        params_schema_json = ?, parameter_values_json = ?, built_in_tools_json = ?,
        tool_settings_json = ?, extra_body_json = ?, extra_headers_json = ?,
        extra_query_json = ?, extra_path_json = ?, context_window = ?, max_output_tokens = ?,
        protocol_profile_override_id = ?, schema_origin = ?, schema_revision = ?, enabled = ?,
        source_json = ?, preset_binding_json = ?, updated_at = ?
      WHERE id = ?`,
      [
        value.endpointId,
        value.modelId,
        value.displayName,
        encodeJson(value.capabilitySchema),
        encodeJson(value.paramsSchema),
        encodeJson(value.parameterValues),
        encodeJson(value.builtInTools),
        encodeJson(value.toolSettings),
        encodeJson(value.extraBody),
        encodeJson(value.extraHeaders),
        encodeJson(value.extraQuery),
        encodeJson(value.extraPath),
        value.contextWindow,
        value.maxOutputTokens,
        value.protocolProfileOverrideId,
        value.schemaOrigin,
        value.schemaRevision,
        toInteger(value.enabled),
        encodeNullableJson(value.source),
        encodeNullableJson(value.presetBinding as unknown as JsonValue | null),
        value.updatedAt,
        value.id,
      ],
    );
    requireChanged(result.rowsAffected, "model");
  }

  async getModel(id: string): Promise<Model | null> {
    const row = await selectOptional<ModelRow>(this.database, "SELECT * FROM model WHERE id = ?", [
      id,
    ]);
    return row ? mapModel(row) : null;
  }

  async listModels(endpointId?: string): Promise<Model[]> {
    const rows = await this.database.select<ModelRow>(
      endpointId
        ? "SELECT * FROM model WHERE endpoint_id = ? ORDER BY enabled DESC, display_name, id"
        : "SELECT * FROM model ORDER BY enabled DESC, display_name, id",
      endpointId ? [endpointId] : [],
    );
    return rows.map(mapModel);
  }

  async insertCompatibilityProbe(value: ParameterCompatibilityProbe): Promise<void> {
    await this.database.execute(
      `INSERT INTO parameter_compatibility_probe (
        id, endpoint_id, model_ref, protocol_profile_id, protocol_profile_revision,
        api_version, parameter_id, placement, wire_path, tested_value_json, status,
        evidence_type, request_fingerprint, http_status, provider_error_code, note,
        checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        value.id,
        value.endpointId,
        value.modelRef,
        value.protocolProfileId,
        value.protocolProfileRevision,
        value.apiVersion,
        value.parameterId,
        value.placement,
        value.wirePath,
        encodeNullableJson(value.testedValue),
        value.status,
        value.evidenceType,
        value.requestFingerprint,
        value.httpStatus,
        value.providerErrorCode,
        value.note,
        value.checkedAt,
      ],
    );
  }

  async getCompatibilityProbe(id: string): Promise<ParameterCompatibilityProbe | null> {
    const row = await selectOptional<CompatibilityProbeRow>(
      this.database,
      "SELECT * FROM parameter_compatibility_probe WHERE id = ?",
      [id],
    );
    return row ? mapCompatibilityProbe(row) : null;
  }

  async listCompatibilityProbes(modelRef?: string): Promise<ParameterCompatibilityProbe[]> {
    const rows = await this.database.select<CompatibilityProbeRow>(
      `SELECT * FROM parameter_compatibility_probe
       ${modelRef === undefined ? "" : "WHERE model_ref = ?"}
       ORDER BY checked_at DESC, id`,
      modelRef === undefined ? [] : [modelRef],
    );
    return rows.map(mapCompatibilityProbe);
  }

  async insertArtifact(value: Artifact): Promise<void> {
    await this.database.execute(
      `INSERT INTO artifact (
        id, content_hash, relative_path, mime_type, byte_size, kind, original_name,
        created_at, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        value.id,
        value.contentHash,
        value.relativePath,
        value.mimeType,
        value.byteSize,
        value.kind,
        value.originalName,
        value.createdAt,
        value.lastAccessedAt,
      ],
    );
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    const row = await selectOptional<ArtifactRow>(
      this.database,
      "SELECT * FROM artifact WHERE id = ?",
      [id],
    );
    return row ? mapArtifact(row) : null;
  }

  async createConversation(value: Conversation): Promise<Conversation> {
    if (value.activeLeafMessageId !== null) {
      throw new Error("A new conversation cannot start with an active leaf");
    }

    await this.database.execute(
      `INSERT INTO conversation (
        id, title, model_ref, system_prompt, params_json, extra_body_json,
        extra_headers_json, extra_query_json, extra_path_json, tools_override_json,
        context_policy_json, active_leaf_message_id, archived, starred,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      [
        value.id,
        value.title,
        value.modelRef,
        value.systemPrompt,
        encodeJson(value.params),
        encodeJson(value.extraBody),
        encodeJson(value.extraHeaders),
        encodeJson(value.extraQuery),
        encodeJson(value.extraPath),
        encodeJson(value.toolsOverride),
        encodeJson(value.contextPolicy),
        toInteger(value.archived),
        toInteger(value.starred),
        value.createdAt,
        value.updatedAt,
      ],
    );

    return requireEntity(await this.getConversation(value.id), "conversation");
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const row = await selectOptional<ConversationRow>(
      this.database,
      "SELECT * FROM conversation WHERE id = ?",
      [id],
    );
    return row ? mapConversation(row) : null;
  }

  async updateConversationConfiguration(value: Conversation): Promise<void> {
    const result = await this.database.execute(
      `UPDATE conversation SET
        params_json = ?, extra_body_json = ?, extra_headers_json = ?, extra_query_json = ?,
        extra_path_json = ?, tools_override_json = ?, updated_at = ?
      WHERE id = ?`,
      [
        encodeJson(value.params),
        encodeJson(value.extraBody),
        encodeJson(value.extraHeaders),
        encodeJson(value.extraQuery),
        encodeJson(value.extraPath),
        encodeJson(value.toolsOverride),
        value.updatedAt,
        value.id,
      ],
    );
    requireChanged(result.rowsAffected, "conversation configuration");
  }

  async listConversations(): Promise<Conversation[]> {
    const rows = await this.database.select<ConversationRow>(
      "SELECT * FROM conversation WHERE archived = 0 ORDER BY updated_at DESC, id DESC",
    );
    return rows.map(mapConversation);
  }

  async getMessage(id: string): Promise<Message | null> {
    const row = await selectOptional<MessageRow>(
      this.database,
      "SELECT * FROM message WHERE id = ?",
      [id],
    );
    return row ? mapMessage(row) : null;
  }

  async readMessageParentChain(anchorMessageId: string): Promise<MessageParentChain> {
    const rows = await this.database.select<MessageParentChainRow>(
      `WITH RECURSIVE parent_chain AS (
        SELECT
          message.*,
          0 AS depth,
          json_array(message.id) AS visited_ids,
          NULL AS cycle_message_id
        FROM message
        WHERE message.id = ?
        UNION ALL
        SELECT
          parent.*,
          child.depth + 1,
          json_insert(child.visited_ids, '$[#]', parent.id),
          CASE
            WHEN EXISTS (
              SELECT 1 FROM json_each(child.visited_ids) WHERE value = parent.id
            ) THEN parent.id
            ELSE NULL
          END
        FROM message AS parent
        JOIN parent_chain AS child ON parent.id = child.parent_id
        WHERE child.cycle_message_id IS NULL
      )
      SELECT * FROM parent_chain ORDER BY depth`,
      [anchorMessageId],
    );
    const cycleRow = rows.find((row) => row.cycle_message_id !== null);
    const pathRows = rows.filter((row) => row.cycle_message_id === null);
    const terminal = pathRows.at(-1);

    return {
      cycleMessageId: cycleRow?.cycle_message_id ?? null,
      messages: pathRows.map(mapMessage),
      missingParentId: cycleRow === undefined && terminal?.parent_id ? terminal.parent_id : null,
    };
  }

  async getConversationRoot(conversationId: string): Promise<Message | null> {
    return this.getMessage(rootMessageId(conversationId));
  }

  async createPendingTurn(input: PendingTurnInput): Promise<PendingTurn> {
    // The command view keeps all three writes in one SQLite statement and one transaction.
    await this.database.execute(
      `INSERT INTO create_pending_turn_command (
        conversation_id, parent_id, user_message_id, user_blocks_json,
        assistant_message_id, assistant_blocks_json, assistant_model_ref, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.conversationId,
        input.parentId,
        input.userMessageId,
        serializeMessageBlocks(input.userBlocks),
        input.assistantMessageId,
        serializeMessageBlocks(input.assistantBlocks),
        input.assistantModelRef,
        input.createdAt,
      ],
    );

    return {
      userMessage: requireEntity(await this.getMessage(input.userMessageId), "user message"),
      assistantMessage: requireEntity(
        await this.getMessage(input.assistantMessageId),
        "assistant message",
      ),
    };
  }

  async createAssistantSibling(input: AssistantSiblingInput): Promise<Message> {
    await this.database.execute(
      `INSERT INTO create_assistant_sibling_command (
        conversation_id, parent_user_message_id, assistant_message_id,
        assistant_blocks_json, assistant_model_ref, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.conversationId,
        input.parentUserMessageId,
        input.assistantMessageId,
        serializeMessageBlocks(input.assistantBlocks),
        input.assistantModelRef,
        input.createdAt,
      ],
    );
    return requireEntity(await this.getMessage(input.assistantMessageId), "assistant message");
  }

  async updateMessage(
    id: string,
    status: MessageStatus,
    blocks: MessageBlocks,
    updatedAt: number,
  ): Promise<void> {
    const result = await this.database.execute(
      `UPDATE message
      SET status = ?, blocks_json = ?, updated_at = ?
      WHERE id = ? AND role <> 'root'`,
      [status, serializeMessageBlocks(blocks), updatedAt, id],
    );
    requireChanged(result.rowsAffected, "message");
  }

  async setActiveLeaf(conversationId: string, messageId: string, updatedAt: number): Promise<void> {
    const result = await this.database.execute(
      `UPDATE conversation
      SET active_leaf_message_id = ?, updated_at = ?
      WHERE id = ?`,
      [messageId, updatedAt, conversationId],
    );
    requireChanged(result.rowsAffected, "conversation");
  }

  async listActiveBranchPage(
    conversationId: string,
    cursor: MessageCursor | null = null,
    limit = 50,
  ): Promise<MessagePage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("Message page limit must be between 1 and 50");
    }

    const rows = await this.database.select<MessageRow>(
      `WITH RECURSIVE branch AS (
        SELECT message.*
        FROM message
        JOIN conversation
          ON conversation.active_leaf_message_id = message.id
        WHERE conversation.id = ?
        UNION
        SELECT parent.*
        FROM message AS parent
        JOIN branch AS child ON child.parent_id = parent.id
      )
      SELECT *
      FROM branch
      WHERE role <> 'root'
        AND (
          ? IS NULL OR
          created_at < ? OR
          (created_at = ? AND id < ?)
        )
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
      [
        conversationId,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).map(mapMessage);
    const oldest = messages.at(-1);
    return {
      messages,
      nextCursor: hasMore && oldest ? { createdAt: oldest.createdAt, id: oldest.id } : null,
    };
  }

  async createRequestSnapshot(value: RequestSnapshot): Promise<void> {
    await this.database.execute(
      `INSERT INTO request_snapshot (
        id, conversation_id, user_message_id, assistant_message_id, connection_id,
        endpoint_id, model_ref, protocol_profile_id, protocol_profile_revision,
        codec_version, request_method, request_url, request_headers_json,
        request_query_json, request_body_json, params_json, context_manifest_json,
        context_hash, request_body_hash, retry_policy_json, attempt_count,
        provider_anchor_json, status, finish_reason, error_code, started_at,
        first_event_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        value.id,
        value.conversationId,
        value.userMessageId,
        value.assistantMessageId,
        value.connectionId,
        value.endpointId,
        value.modelRef,
        value.protocolProfileId,
        value.protocolProfileRevision,
        value.codecVersion,
        value.requestMethod,
        value.requestUrl,
        encodeNullableJson(value.requestHeaders),
        encodeNullableJson(value.requestQuery),
        encodeNullableJson(value.requestBody),
        encodeJson(value.params),
        encodeJson(value.contextManifest),
        value.contextHash,
        value.requestBodyHash,
        encodeJson(value.retryPolicy),
        value.attemptCount,
        encodeNullableJson(value.providerAnchor),
        value.status,
        value.finishReason,
        value.errorCode,
        value.startedAt,
        value.firstEventAt,
        value.completedAt,
      ],
    );
  }

  async startLogicalRequest(snapshot: RequestSnapshot, attempt: RequestAttempt): Promise<void> {
    await this.database.execute(
      `INSERT INTO start_logical_request_command (
        snapshot_id, conversation_id, user_message_id, assistant_message_id,
        connection_id, endpoint_id, model_ref, protocol_profile_id,
        protocol_profile_revision, codec_version, request_method, request_url,
        request_headers_json, request_query_json, request_body_json, params_json,
        context_manifest_json, context_hash, request_body_hash, retry_policy_json,
        started_at, attempt_id, transport_request_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.id,
        snapshot.conversationId,
        snapshot.userMessageId,
        snapshot.assistantMessageId,
        snapshot.connectionId,
        snapshot.endpointId,
        snapshot.modelRef,
        snapshot.protocolProfileId,
        snapshot.protocolProfileRevision,
        snapshot.codecVersion,
        snapshot.requestMethod,
        snapshot.requestUrl,
        encodeNullableJson(snapshot.requestHeaders),
        encodeNullableJson(snapshot.requestQuery),
        encodeNullableJson(snapshot.requestBody),
        encodeJson(snapshot.params),
        encodeJson(snapshot.contextManifest),
        snapshot.contextHash,
        snapshot.requestBodyHash,
        encodeJson(snapshot.retryPolicy),
        attempt.startedAt,
        attempt.id,
        attempt.transportRequestId,
      ],
    );
  }

  async getRequestAttempt(id: string): Promise<RequestAttempt | null> {
    const row = await selectOptional<RequestAttemptRow>(
      this.database,
      "SELECT * FROM request_attempt WHERE id = ?",
      [id],
    );
    return row ? mapRequestAttempt(row) : null;
  }

  async listRequestAttempts(snapshotId: string): Promise<RequestAttempt[]> {
    const rows = await this.database.select<RequestAttemptRow>(
      "SELECT * FROM request_attempt WHERE request_snapshot_id = ? ORDER BY attempt_no",
      [snapshotId],
    );
    return rows.map(mapRequestAttempt);
  }

  async scheduleRetry(input: ScheduleRetryInput): Promise<void> {
    await this.database.execute(
      `INSERT INTO schedule_retry_command (
        snapshot_id, assistant_message_id, attempt_id, retry_reason, http_status,
        provider_error_code, retry_after_ms, scheduled_delay_ms, completed_at,
        first_byte_at, first_semantic_event_at, bytes_received, semantic_event_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.snapshotId,
        input.assistantMessageId,
        input.attemptId,
        input.retryReason,
        input.httpStatus,
        input.providerErrorCode,
        input.retryAfterMs,
        input.scheduledDelayMs,
        input.completedAt,
        input.firstByteAt,
        input.firstSemanticEventAt,
        input.bytesReceived,
        input.semanticEventCount,
      ],
    );
  }

  async startRetryAttempt(assistantMessageId: string, attempt: RequestAttempt): Promise<void> {
    await this.database.execute(
      `INSERT INTO start_retry_attempt_command (
        snapshot_id, assistant_message_id, attempt_id, attempt_no,
        transport_request_id, request_body_hash, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        attempt.requestSnapshotId,
        assistantMessageId,
        attempt.id,
        attempt.attemptNo,
        attempt.transportRequestId,
        attempt.requestBodyHash,
        attempt.startedAt,
      ],
    );
  }

  async finalizeRequestAttempt(input: FinalizeRequestAttemptInput): Promise<boolean> {
    try {
      await this.database.execute(
        `INSERT INTO finalize_request_attempt_command (
          snapshot_id, assistant_message_id, attempt_id, attempt_status,
          message_status, blocks_json, usage_json, provider_response_id,
          provider_anchor_json, finish_reason, error_code, retry_reason,
          http_status, provider_error_code, completed_at, first_event_at,
          first_byte_at, first_semantic_event_at, bytes_received, semantic_event_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.snapshotId,
          input.assistantMessageId,
          input.attemptId,
          input.attemptStatus,
          input.status,
          serializeMessageBlocks(input.blocks),
          encodeNullableJson(input.usage),
          input.providerResponseId,
          encodeNullableJson(input.providerAnchor),
          input.finishReason,
          input.errorCode,
          input.retryReason,
          input.httpStatus,
          input.providerErrorCode,
          input.completedAt,
          input.firstEventAt,
          input.firstByteAt,
          input.firstSemanticEventAt,
          input.bytesReceived,
          input.semanticEventCount,
        ],
      );
      return true;
    } catch (error) {
      if (hasSqliteCode(error, "finalize_request_attempt_not_running")) {
        return false;
      }
      throw error;
    }
  }

  async interruptWaitingRetry(input: InterruptWaitingRetryInput): Promise<void> {
    await this.database.execute(
      `INSERT INTO interrupt_waiting_retry_command (
        snapshot_id, assistant_message_id, blocks_json, completed_at,
        error_code, finish_reason, message_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.snapshotId,
        input.assistantMessageId,
        serializeMessageBlocks(input.blocks),
        input.completedAt,
        input.errorCode,
        input.finishReason,
        input.status,
      ],
    );
  }

  async getRequestSnapshot(id: string): Promise<RequestSnapshot | null> {
    const row = await selectOptional<RequestSnapshotRow>(
      this.database,
      "SELECT * FROM request_snapshot WHERE id = ?",
      [id],
    );
    return row ? mapRequestSnapshot(row) : null;
  }

  async getRequestSnapshotByAssistant(assistantMessageId: string): Promise<RequestSnapshot | null> {
    const row = await selectOptional<RequestSnapshotRow>(
      this.database,
      "SELECT * FROM request_snapshot WHERE assistant_message_id = ? ORDER BY started_at DESC LIMIT 1",
      [assistantMessageId],
    );
    return row ? mapRequestSnapshot(row) : null;
  }

  async markRequestRunning(
    snapshotId: string,
    assistantMessageId: string,
    startedAt: number,
  ): Promise<void> {
    const snapshot = await this.database.execute(
      `UPDATE request_snapshot
      SET status = 'running', started_at = ?
      WHERE id = ? AND assistant_message_id = ? AND status = 'pending' AND attempt_count = 0`,
      [startedAt, snapshotId, assistantMessageId],
    );
    requireChanged(snapshot.rowsAffected, "request snapshot");

    const message = await this.database.execute(
      `UPDATE message
      SET status = 'streaming', updated_at = ?
      WHERE id = ? AND status = 'pending' AND role = 'assistant'`,
      [startedAt, assistantMessageId],
    );
    requireChanged(message.rowsAffected, "assistant message");
  }

  async finalizeChatRequest(input: FinalizeChatRequestInput): Promise<boolean> {
    const claim = await this.database.execute(
      `UPDATE request_snapshot
      SET
        attempt_count = 1,
        finish_reason = ?,
        error_code = ?,
        provider_anchor_json = ?,
        first_event_at = ?,
        completed_at = ?
      WHERE id = ?
        AND assistant_message_id = ?
        AND attempt_count = 0
        AND status IN ('pending', 'running')`,
      [
        input.finishReason,
        input.errorCode,
        encodeNullableJson(input.providerAnchor),
        input.firstEventAt,
        input.completedAt,
        input.snapshotId,
        input.assistantMessageId,
      ],
    );
    if (claim.rowsAffected === 0) {
      return false;
    }

    const message = await this.database.execute(
      `UPDATE message
      SET
        status = ?,
        blocks_json = ?,
        usage_json = ?,
        provider_response_id = ?,
        updated_at = ?
      WHERE id = ?
        AND role = 'assistant'
        AND status IN ('pending', 'waiting_retry', 'streaming')`,
      [
        input.status,
        serializeMessageBlocks(input.blocks),
        encodeNullableJson(input.usage),
        input.providerResponseId,
        input.completedAt,
        input.assistantMessageId,
      ],
    );
    if (message.rowsAffected !== 1) {
      await this.failClaimedSnapshot(input.snapshotId, input.completedAt);
      throw new Error("storage_finalize_failed: assistant message was not active");
    }

    const snapshot = await this.database.execute(
      `UPDATE request_snapshot
      SET status = ?
      WHERE id = ? AND attempt_count = 1 AND status IN ('pending', 'running')`,
      [input.status, input.snapshotId],
    );
    if (snapshot.rowsAffected !== 1) {
      throw new Error("storage_finalize_failed: request snapshot was not active");
    }
    return true;
  }

  async recoverInterrupted(recoveredAt: number): Promise<void> {
    await this.database.execute(
      "INSERT INTO recover_interrupted_command (recovered_at) VALUES (?)",
      [recoveredAt],
    );

    await this.database.execute(
      `UPDATE request_snapshot
      SET status = (
        SELECT message.status
        FROM message
        WHERE message.id = request_snapshot.assistant_message_id
      )
      WHERE status IN ('pending', 'running')
        AND attempt_count = 1
        AND assistant_message_id IN (
          SELECT id FROM message WHERE status IN ('done', 'interrupted', 'error')
        )`,
    );
  }

  private async failClaimedSnapshot(snapshotId: string, completedAt: number): Promise<void> {
    await this.database.execute(
      `UPDATE request_snapshot
      SET status = 'error', error_code = 'storage_finalize_failed', completed_at = ?
      WHERE id = ? AND attempt_count = 1 AND status IN ('pending', 'running')`,
      [completedAt, snapshotId],
    );
  }
}

export function rootMessageId(conversationId: string): string {
  return `${conversationId}:root`;
}

interface ProviderConnectionRow {
  id: string;
  name: string;
  vendor_hint: string | null;
  description: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface ProtocolProfileRow {
  id: string;
  name: string;
  codec_id: string;
  request_mapping_json: string;
  response_mapping_json: string;
  tools_mapping_json: string;
  continuation_mapping_json: string | null;
  source_json: string | null;
  preset_binding_json: string | null;
  user_edited: number;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface ProviderEndpointRow {
  id: string;
  connection_id: string;
  name: string;
  base_url: string;
  explicit_port: number | null;
  path_template: string;
  method: string;
  api_version: string | null;
  protocol_profile_id: string;
  auth_bindings_json: string;
  headers_json: string;
  query_json: string;
  body_defaults_json: string;
  path_defaults_json: string;
  source_json: string | null;
  preset_binding_json: string | null;
  timeout_ms: number | null;
  retry_policy_json: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface ModelRow {
  id: string;
  endpoint_id: string;
  model_id: string;
  display_name: string;
  capability_schema_json: string;
  params_schema_json: string;
  parameter_values_json: string;
  built_in_tools_json: string;
  tool_settings_json: string;
  extra_body_json: string;
  extra_headers_json: string;
  extra_query_json: string;
  extra_path_json: string;
  context_window: number | null;
  max_output_tokens: number | null;
  protocol_profile_override_id: string | null;
  schema_origin: string;
  schema_revision: number;
  enabled: number;
  source_json: string | null;
  preset_binding_json: string | null;
  created_at: number;
  updated_at: number;
}

interface CompatibilityProbeRow {
  id: string;
  endpoint_id: string;
  model_ref: string;
  protocol_profile_id: string;
  protocol_profile_revision: number;
  api_version: string | null;
  parameter_id: string;
  placement: string;
  wire_path: string;
  tested_value_json: string | null;
  status: ParameterCompatibilityProbe["status"];
  evidence_type: string;
  request_fingerprint: string | null;
  http_status: number | null;
  provider_error_code: string | null;
  note: string | null;
  checked_at: number;
}

interface ArtifactRow {
  id: string;
  content_hash: string;
  relative_path: string;
  mime_type: string | null;
  byte_size: number;
  kind: string;
  original_name: string | null;
  created_at: number;
  last_accessed_at: number | null;
}

interface ConversationRow {
  id: string;
  title: string;
  model_ref: string | null;
  system_prompt: string;
  params_json: string;
  extra_body_json: string;
  extra_headers_json: string;
  extra_query_json: string;
  extra_path_json: string;
  tools_override_json: string;
  context_policy_json: string;
  active_leaf_message_id: string | null;
  archived: number;
  starred: number;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: Message["role"];
  blocks_json: string;
  status: Message["status"];
  usage_json: string | null;
  model_ref: string | null;
  parent_id: string | null;
  sibling_order: number;
  provider_response_id: string | null;
  provider_previous_response_id: string | null;
  request_snapshot_id: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageParentChainRow extends MessageRow {
  cycle_message_id: string | null;
  depth: number;
  visited_ids: string;
}

interface RequestSnapshotRow {
  id: string;
  conversation_id: string;
  user_message_id: string | null;
  assistant_message_id: string | null;
  connection_id: string;
  endpoint_id: string;
  model_ref: string | null;
  protocol_profile_id: string;
  protocol_profile_revision: number;
  codec_version: string;
  request_method: string;
  request_url: string;
  request_headers_json: string | null;
  request_query_json: string | null;
  request_body_json: string | null;
  params_json: string;
  context_manifest_json: string;
  context_hash: string;
  request_body_hash: string;
  retry_policy_json: string;
  attempt_count: number;
  provider_anchor_json: string | null;
  status: RequestSnapshot["status"];
  finish_reason: string | null;
  error_code: string | null;
  started_at: number;
  first_event_at: number | null;
  completed_at: number | null;
}

interface RequestAttemptRow {
  id: string;
  request_snapshot_id: string;
  attempt_no: number;
  trigger: RequestAttempt["trigger"];
  transport_request_id: string;
  request_body_hash: string;
  status: RequestAttempt["status"];
  retryable: number;
  retry_reason: string | null;
  http_status: number | null;
  provider_error_code: string | null;
  retry_after_ms: number | null;
  scheduled_delay_ms: number | null;
  started_at: number;
  first_byte_at: number | null;
  first_semantic_event_at: number | null;
  completed_at: number | null;
  bytes_received: number;
  semantic_event_count: number;
}

function mapProviderConnection(row: ProviderConnectionRow): ProviderConnection {
  return {
    id: row.id,
    name: row.name,
    vendorHint: row.vendor_hint,
    description: row.description,
    enabled: fromInteger(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function protocolProfileBindings(value: ProtocolProfile): unknown[] {
  return [
    value.id,
    value.name,
    value.codecId,
    encodeJson(value.requestMapping),
    encodeJson(value.responseMapping),
    encodeJson(value.toolsMapping),
    encodeNullableJson(value.continuationMapping),
    encodeNullableJson(value.source),
    encodeNullableJson(value.presetBinding as unknown as JsonValue | null),
    toInteger(value.userEdited),
    value.revision,
    value.createdAt,
    value.updatedAt,
  ];
}

function mapProtocolProfile(row: ProtocolProfileRow): ProtocolProfile {
  return {
    id: row.id,
    name: row.name,
    codecId: row.codec_id,
    requestMapping: decodeJson(row.request_mapping_json),
    responseMapping: decodeJson(row.response_mapping_json),
    toolsMapping: decodeJson(row.tools_mapping_json),
    continuationMapping: decodeNullableJson(row.continuation_mapping_json),
    source: decodeNullableJson(row.source_json),
    presetBinding: decodePresetBinding(row.preset_binding_json),
    userEdited: fromInteger(row.user_edited),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProviderEndpoint(row: ProviderEndpointRow): ProviderEndpoint {
  return {
    id: row.id,
    connectionId: row.connection_id,
    name: row.name,
    baseUrl: row.base_url,
    explicitPort: row.explicit_port,
    pathTemplate: row.path_template,
    method: row.method,
    apiVersion: row.api_version,
    protocolProfileId: row.protocol_profile_id,
    authBindings: decodeJson(row.auth_bindings_json),
    headers: decodeJson(row.headers_json),
    query: decodeJson(row.query_json),
    bodyDefaults: decodeJson(row.body_defaults_json),
    pathDefaults: decodeJson(row.path_defaults_json),
    source: decodeNullableJson(row.source_json),
    presetBinding: decodePresetBinding(row.preset_binding_json),
    timeoutMs: row.timeout_ms,
    retryPolicy: decodeNullableJson(row.retry_policy_json),
    enabled: fromInteger(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapModel(row: ModelRow): Model {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    modelId: row.model_id,
    displayName: row.display_name,
    capabilitySchema: decodeJson(row.capability_schema_json),
    paramsSchema: decodeJson(row.params_schema_json),
    parameterValues: decodeJson(row.parameter_values_json),
    builtInTools: decodeJson(row.built_in_tools_json),
    toolSettings: decodeJson(row.tool_settings_json),
    extraBody: decodeJson(row.extra_body_json),
    extraHeaders: decodeJson(row.extra_headers_json),
    extraQuery: decodeJson(row.extra_query_json),
    extraPath: decodeJson(row.extra_path_json),
    contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    protocolProfileOverrideId: row.protocol_profile_override_id,
    schemaOrigin: row.schema_origin,
    schemaRevision: row.schema_revision,
    source: decodeNullableJson(row.source_json),
    presetBinding: decodePresetBinding(row.preset_binding_json),
    enabled: fromInteger(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCompatibilityProbe(row: CompatibilityProbeRow): ParameterCompatibilityProbe {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    modelRef: row.model_ref,
    protocolProfileId: row.protocol_profile_id,
    protocolProfileRevision: row.protocol_profile_revision,
    apiVersion: row.api_version,
    parameterId: row.parameter_id,
    placement: row.placement,
    wirePath: row.wire_path,
    testedValue: decodeNullableJson(row.tested_value_json),
    status: row.status,
    evidenceType: row.evidence_type,
    requestFingerprint: row.request_fingerprint,
    httpStatus: row.http_status,
    providerErrorCode: row.provider_error_code,
    note: row.note,
    checkedAt: row.checked_at,
  };
}

function mapArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    contentHash: row.content_hash,
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    kind: row.kind,
    originalName: row.original_name,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
  };
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    modelRef: row.model_ref,
    systemPrompt: row.system_prompt,
    params: decodeJson(row.params_json),
    extraBody: decodeJson(row.extra_body_json),
    extraHeaders: decodeJson(row.extra_headers_json),
    extraQuery: decodeJson(row.extra_query_json),
    extraPath: decodeJson(row.extra_path_json),
    toolsOverride: decodeJson(row.tools_override_json),
    contextPolicy: decodeJson(row.context_policy_json),
    activeLeafMessageId: row.active_leaf_message_id,
    archived: fromInteger(row.archived),
    starred: fromInteger(row.starred),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    blocks: parseMessageBlocks(row.blocks_json),
    status: row.status,
    usage: decodeNullableJson(row.usage_json),
    modelRef: row.model_ref,
    parentId: row.parent_id,
    siblingOrder: row.sibling_order,
    providerResponseId: row.provider_response_id,
    providerPreviousResponseId: row.provider_previous_response_id,
    requestSnapshotId: row.request_snapshot_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRequestSnapshot(row: RequestSnapshotRow): RequestSnapshot {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    connectionId: row.connection_id,
    endpointId: row.endpoint_id,
    modelRef: row.model_ref,
    protocolProfileId: row.protocol_profile_id,
    protocolProfileRevision: row.protocol_profile_revision,
    codecVersion: row.codec_version,
    requestMethod: row.request_method,
    requestUrl: row.request_url,
    requestHeaders: decodeNullableJson(row.request_headers_json),
    requestQuery: decodeNullableJson(row.request_query_json),
    requestBody: decodeNullableJson(row.request_body_json),
    params: decodeJson(row.params_json),
    contextManifest: decodeJson(row.context_manifest_json),
    contextHash: row.context_hash,
    requestBodyHash: row.request_body_hash,
    retryPolicy: decodeJson(row.retry_policy_json),
    attemptCount: row.attempt_count,
    providerAnchor: decodeNullableJson(row.provider_anchor_json),
    status: row.status,
    finishReason: row.finish_reason,
    errorCode: row.error_code,
    startedAt: row.started_at,
    firstEventAt: row.first_event_at,
    completedAt: row.completed_at,
  };
}

function mapRequestAttempt(row: RequestAttemptRow): RequestAttempt {
  return {
    id: row.id,
    requestSnapshotId: row.request_snapshot_id,
    attemptNo: row.attempt_no,
    trigger: row.trigger,
    transportRequestId: row.transport_request_id,
    requestBodyHash: row.request_body_hash,
    status: row.status,
    retryable: fromInteger(row.retryable),
    retryReason: row.retry_reason,
    httpStatus: row.http_status,
    providerErrorCode: row.provider_error_code,
    retryAfterMs: row.retry_after_ms,
    scheduledDelayMs: row.scheduled_delay_ms,
    startedAt: row.started_at,
    firstByteAt: row.first_byte_at,
    firstSemanticEventAt: row.first_semantic_event_at,
    completedAt: row.completed_at,
    bytesReceived: row.bytes_received,
    semanticEventCount: row.semantic_event_count,
  };
}

async function selectOptional<T extends object>(
  database: SqlDatabase,
  query: string,
  bindValues: unknown[],
): Promise<T | null> {
  const rows = await database.select<T>(query, bindValues);
  return rows[0] ?? null;
}

function requireEntity<T>(value: T | null, name: string): T {
  if (value === null) {
    throw new Error(`Expected ${name} to exist`);
  }
  return value;
}

function requireChanged(rowsAffected: number, name: string): void {
  if (rowsAffected !== 1) {
    throw new Error(`Expected one ${name} row to change`);
  }
}

function encodeJson(value: JsonValue): string {
  return JSON.stringify(value);
}

function encodeNullableJson(value: JsonValue | null): string | null {
  return value === null ? null : encodeJson(value);
}

function decodeJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

function decodeNullableJson(value: string | null): JsonValue | null {
  return value === null ? null : decodeJson(value);
}

function decodePresetBinding(value: string | null): PresetBinding | null {
  return decodeNullableJson(value) as unknown as PresetBinding | null;
}

function toInteger(value: boolean): number {
  return value ? 1 : 0;
}

function fromInteger(value: number): boolean {
  return value === 1;
}

function hasSqliteCode(error: unknown, code: string): boolean {
  return error instanceof Error && error.message.includes(code);
}
