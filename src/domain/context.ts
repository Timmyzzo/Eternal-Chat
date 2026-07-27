import type { JsonObject, JsonValue } from "@/domain/json";

export type CanonicalTurnRole = "user" | "assistant";
export type CanonicalToolStatus = "succeeded" | "failed" | "denied" | "cancelled";

export interface CanonicalBlockProvenance extends JsonObject {
  blockIndex: number;
  messageId: string;
}

export interface CanonicalTextBlock extends JsonObject {
  provenance: CanonicalBlockProvenance;
  text: string;
  type: "text";
}

export interface CanonicalToolCallBlock extends JsonObject {
  args: JsonValue;
  error: JsonObject | null;
  id: string;
  modelContent: JsonValue;
  name: string;
  provenance: CanonicalBlockProvenance;
  status: CanonicalToolStatus;
  toolSource: "client" | "mcp" | "provider";
  type: "tool_call";
}

export type CanonicalBlock = CanonicalTextBlock | CanonicalToolCallBlock;

export interface CanonicalTurn extends JsonObject {
  blocks: CanonicalBlock[];
  messageId: string;
  role: CanonicalTurnRole;
}

export type ContextManifestDecision = "included" | "excluded" | "summarized" | "provider_anchor";

export interface ContextManifestItem extends JsonObject {
  blockIndex: number;
  blockType: string;
  contentHash: string;
  decision: ContextManifestDecision;
  messageId: string;
  reason: string;
  toolCallId: string | null;
}

export interface ContextManifest extends JsonObject {
  anchorMessageId: string;
  conversationId: string;
  hash: string;
  items: ContextManifestItem[];
  policy: "lossless";
  version: 1;
}

export interface CanonicalContext extends JsonObject {
  anchorMessageId: string;
  contextHash: string;
  conversationId: string;
  manifest: ContextManifest;
  system: CanonicalBlock[];
  turns: CanonicalTurn[];
  version: 1;
}

export type BudgetPreflightStatus = "normal" | "risk" | "over_limit" | "uncertain";

export interface LosslessBudgetPreflightInput {
  contextWindow: number | null;
  estimatedInputTokens: number | null;
  reservedOutputTokens: number | null;
  riskThreshold?: number;
}

export interface LosslessBudgetPreflightResult {
  contextWindow: number | null;
  estimatedInputTokens: number | null;
  remainingTokens: number | null;
  reservedOutputTokens: number | null;
  riskThreshold: number;
  status: BudgetPreflightStatus;
  totalEstimatedTokens: number | null;
  uncertaintyReason: string | null;
}

export type ContextContractErrorCode =
  | "context_conversation_not_found"
  | "context_anchor_not_found"
  | "context_anchor_cross_conversation"
  | "context_anchor_is_virtual_root"
  | "context_parent_missing"
  | "context_parent_cycle"
  | "context_parent_cross_conversation"
  | "context_root_unreachable"
  | "context_invalid_virtual_root"
  | "context_duplicate_message_id"
  | "context_duplicate_tool_call_id"
  | "context_tool_incomplete"
  | "context_tool_result_missing_model_content"
  | "context_tool_failure_missing_error_content"
  | "context_unknown_message_block"
  | "context_unsupported_message_block"
  | "context_invalid_message_block"
  | "context_incompatible_role_block"
  | "serializer_invalid_model"
  | "serializer_unsupported_block"
  | "serializer_incompatible_role_block";

export class ContextContractError extends Error {
  readonly name = "ContextContractError";

  constructor(
    readonly code: ContextContractErrorCode,
    message: string,
    readonly details: JsonObject = {},
  ) {
    super(message);
  }
}
