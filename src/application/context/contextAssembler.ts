import type { Conversation, Message, MessageBlock } from "@/domain/chat";
import type {
  CanonicalBlock,
  CanonicalContext,
  CanonicalTextBlock,
  CanonicalToolCallBlock,
  CanonicalTurn,
  ContextManifestItem,
  LosslessBudgetPreflightInput,
  LosslessBudgetPreflightResult,
} from "@/domain/context";
import { ContextContractError } from "@/domain/context";
import type { JsonObject, JsonValue } from "@/domain/json";
import { hashStableJson } from "@/domain/stableJson";
import type { MessageParentChain } from "@/infrastructure/db/phase3Repository";
import { rootMessageId } from "@/infrastructure/db/phase3Repository";

const KNOWN_MESSAGE_BLOCK_TYPES = new Set([
  "text",
  "thinking",
  "tool_call",
  "source",
  "citation",
  "image",
  "file",
  "error",
  "provider_state",
]);

const TOOL_TERMINAL_STATUSES = new Set(["succeeded", "failed", "denied", "cancelled"]);
const DEFAULT_RISK_THRESHOLD = 0.9;

export interface ContextBuildInput {
  anchorMessageId: string;
  conversationId: string;
}

export interface ContextRepository {
  getConversation(id: string): Promise<Conversation | null>;
  readMessageParentChain(anchorMessageId: string): Promise<MessageParentChain>;
}

export class ContextAssembler {
  constructor(private readonly repository: ContextRepository) {}

  async assemble(input: ContextBuildInput): Promise<CanonicalContext> {
    const conversation = await this.repository.getConversation(input.conversationId);
    if (!conversation) {
      throw contractError(
        "context_conversation_not_found",
        `Conversation ${input.conversationId} does not exist`,
        { conversationId: input.conversationId },
      );
    }

    const chain = await this.repository.readMessageParentChain(input.anchorMessageId);
    const anchor = chain.messages[0];
    if (!anchor) {
      throw contractError(
        "context_anchor_not_found",
        `Anchor ${input.anchorMessageId} does not exist`,
        {
          anchorMessageId: input.anchorMessageId,
        },
      );
    }
    if (anchor.conversationId !== input.conversationId) {
      throw contractError(
        "context_anchor_cross_conversation",
        `Anchor ${input.anchorMessageId} belongs to another conversation`,
        { anchorMessageId: input.anchorMessageId, conversationId: input.conversationId },
      );
    }
    if (anchor.role === "root") {
      throw contractError(
        "context_anchor_is_virtual_root",
        "The virtual root cannot be used as context content",
        { anchorMessageId: input.anchorMessageId },
      );
    }
    if (chain.cycleMessageId) {
      throw contractError("context_parent_cycle", "The parent chain contains a cycle", {
        messageId: chain.cycleMessageId,
      });
    }
    if (chain.missingParentId) {
      throw contractError("context_parent_missing", "A parent message is missing", {
        parentMessageId: chain.missingParentId,
      });
    }

    const seenMessageIds = new Set<string>();
    for (const message of chain.messages) {
      if (seenMessageIds.has(message.id)) {
        throw contractError("context_duplicate_message_id", "The parent chain repeats a message", {
          messageId: message.id,
        });
      }
      seenMessageIds.add(message.id);
      if (message.conversationId !== input.conversationId) {
        throw contractError(
          "context_parent_cross_conversation",
          "The parent chain crosses conversation boundaries",
          { messageId: message.id, conversationId: message.conversationId },
        );
      }
    }

    const root = chain.messages.at(-1);
    const expectedRootId = rootMessageId(input.conversationId);
    if (!root || root.id !== expectedRootId || root.parentId !== null || root.role !== "root") {
      throw contractError(
        "context_root_unreachable",
        "The parent chain does not reach the current conversation virtual root",
        { expectedRootId, terminalMessageId: root?.id ?? null },
      );
    }
    if (
      root.status !== "done" ||
      root.blocks.version !== 1 ||
      root.blocks.blocks.length !== 0 ||
      root.modelRef !== null
    ) {
      throw contractError(
        "context_invalid_virtual_root",
        "The conversation virtual root is damaged",
        {
          rootMessageId: root.id,
        },
      );
    }

    const system: CanonicalBlock[] = [];
    const turns: CanonicalTurn[] = [];
    const manifestItems: ContextManifestItem[] = [];
    const seenToolCallIds = new Set<string>();

    if (conversation.systemPrompt !== "") {
      const block: CanonicalTextBlock = {
        provenance: { messageId: root.id, blockIndex: 0 },
        text: conversation.systemPrompt,
        type: "text",
      };
      system.push(block);
      manifestItems.push({
        blockIndex: 0,
        blockType: "system_prompt",
        contentHash: await hashStableJson({ type: "text", text: conversation.systemPrompt }),
        decision: "included",
        messageId: root.id,
        reason: "conversation_system_prompt",
        toolCallId: null,
      });
    }

    const orderedMessages = chain.messages.slice(0, -1).reverse();
    for (const message of orderedMessages) {
      const canonicalBlocks: CanonicalBlock[] = [];
      for (const [blockIndex, block] of message.blocks.blocks.entries()) {
        const canonical = await canonicalizeBlock(message, block, blockIndex, seenToolCallIds);
        canonicalBlocks.push(canonical.block);
        manifestItems.push(canonical.manifestItem);
      }

      if (canonicalBlocks.length === 0) {
        throw contractError(
          "context_invalid_message_block",
          `Message ${message.id} has no context blocks`,
          { messageId: message.id, reason: "empty_message" },
        );
      }

      if (message.role === "system") {
        system.push(...canonicalBlocks);
      } else if (message.role === "user" || message.role === "assistant") {
        turns.push({ messageId: message.id, role: message.role, blocks: canonicalBlocks });
      } else {
        throw contractError(
          "context_incompatible_role_block",
          `Role ${message.role} cannot be included as a canonical turn`,
          { messageId: message.id, role: message.role },
        );
      }
    }

    const manifestCore = {
      anchorMessageId: input.anchorMessageId,
      conversationId: input.conversationId,
      items: manifestItems,
      policy: "lossless",
      version: 1,
    } as const;
    const manifest = {
      ...manifestCore,
      hash: await hashStableJson(manifestCore),
    };
    const contextCore = {
      anchorMessageId: input.anchorMessageId,
      conversationId: input.conversationId,
      system,
      turns,
      version: 1,
    } as const;

    return {
      ...contextCore,
      contextHash: await hashStableJson(contextCore),
      manifest,
    };
  }
}

export function preflightLosslessBudget(
  input: LosslessBudgetPreflightInput,
): LosslessBudgetPreflightResult {
  const riskThreshold = input.riskThreshold ?? DEFAULT_RISK_THRESHOLD;
  if (riskThreshold <= 0 || riskThreshold >= 1) {
    throw new RangeError("Budget risk threshold must be greater than 0 and less than 1");
  }
  validateTokenCount(input.estimatedInputTokens, "estimatedInputTokens");
  validateTokenCount(input.contextWindow, "contextWindow");
  validateTokenCount(input.reservedOutputTokens, "reservedOutputTokens");

  const uncertaintyReason =
    input.estimatedInputTokens === null
      ? "input_estimate_unavailable"
      : input.contextWindow === null
        ? "context_window_unknown"
        : input.reservedOutputTokens === null
          ? "output_reserve_unknown"
          : null;
  if (uncertaintyReason) {
    return {
      contextWindow: input.contextWindow,
      estimatedInputTokens: input.estimatedInputTokens,
      remainingTokens: null,
      reservedOutputTokens: input.reservedOutputTokens,
      riskThreshold,
      status: "uncertain",
      totalEstimatedTokens: null,
      uncertaintyReason,
    };
  }

  const estimatedInputTokens = input.estimatedInputTokens as number;
  const contextWindow = input.contextWindow as number;
  const reservedOutputTokens = input.reservedOutputTokens as number;
  const totalEstimatedTokens = estimatedInputTokens + reservedOutputTokens;
  const remainingTokens = contextWindow - totalEstimatedTokens;
  const status =
    totalEstimatedTokens > contextWindow
      ? "over_limit"
      : totalEstimatedTokens >= contextWindow * riskThreshold
        ? "risk"
        : "normal";

  return {
    contextWindow,
    estimatedInputTokens,
    remainingTokens,
    reservedOutputTokens,
    riskThreshold,
    status,
    totalEstimatedTokens,
    uncertaintyReason: null,
  };
}

async function canonicalizeBlock(
  message: Message,
  block: MessageBlock,
  blockIndex: number,
  seenToolCallIds: Set<string>,
): Promise<{ block: CanonicalBlock; manifestItem: ContextManifestItem }> {
  if (!isRecord(block) || typeof block.type !== "string") {
    throw invalidBlock(message.id, blockIndex, "Block must be an object with a string type");
  }

  if (block.type === "text") {
    if (typeof block.text !== "string") {
      throw invalidBlock(message.id, blockIndex, "Text block is missing text");
    }
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") {
      throw incompatibleBlock(message, blockIndex, block.type);
    }
    const canonical: CanonicalTextBlock = {
      provenance: { messageId: message.id, blockIndex },
      text: block.text,
      type: "text",
    };
    return {
      block: canonical,
      manifestItem: await manifestItem(message.id, blockIndex, "text", canonicalContent(canonical)),
    };
  }

  if (block.type === "tool_call") {
    if (message.role !== "assistant") {
      throw incompatibleBlock(message, blockIndex, block.type);
    }
    if (
      typeof block.id !== "string" ||
      block.id.trim() === "" ||
      typeof block.name !== "string" ||
      block.name.trim() === "" ||
      !isJsonValue(block.args) ||
      typeof block.status !== "string" ||
      typeof block.source !== "string"
    ) {
      throw invalidBlock(message.id, blockIndex, "Tool call fields are invalid");
    }
    if (seenToolCallIds.has(block.id)) {
      throw contractError(
        "context_duplicate_tool_call_id",
        `Tool call ID ${block.id} is duplicated in the current branch`,
        { messageId: message.id, blockIndex, toolCallId: block.id },
      );
    }
    seenToolCallIds.add(block.id);
    if (!TOOL_TERMINAL_STATUSES.has(block.status)) {
      throw contractError(
        "context_tool_incomplete",
        `Tool call ${block.id} is not in a completed state`,
        { messageId: message.id, blockIndex, status: block.status, toolCallId: block.id },
      );
    }
    if (
      !isRecord(block.result) ||
      !Object.prototype.hasOwnProperty.call(block.result, "modelContent") ||
      !isJsonValue(block.result.modelContent)
    ) {
      throw contractError(
        "context_tool_result_missing_model_content",
        `Tool call ${block.id} has no replayable modelContent`,
        { messageId: message.id, blockIndex, toolCallId: block.id },
      );
    }
    const error = isRecord(block.result.error) ? (block.result.error as JsonObject) : null;
    if (
      block.status === "failed" &&
      (!hasExplicitError(error) || !hasModelVisibleErrorContent(block.result.modelContent))
    ) {
      throw contractError(
        "context_tool_failure_missing_error_content",
        `Failed tool call ${block.id} has no explicit model-visible error`,
        { messageId: message.id, blockIndex, toolCallId: block.id },
      );
    }
    if (block.source !== "client" && block.source !== "mcp" && block.source !== "provider") {
      throw invalidBlock(message.id, blockIndex, "Tool call source is invalid");
    }

    const canonical: CanonicalToolCallBlock = {
      args: block.args,
      error,
      id: block.id,
      modelContent: block.result.modelContent,
      name: block.name,
      provenance: { messageId: message.id, blockIndex },
      status: block.status as CanonicalToolCallBlock["status"],
      toolSource: block.source,
      type: "tool_call",
    };
    return {
      block: canonical,
      manifestItem: await manifestItem(
        message.id,
        blockIndex,
        "tool_call",
        canonicalContent(canonical),
        block.id,
      ),
    };
  }

  const code = KNOWN_MESSAGE_BLOCK_TYPES.has(block.type)
    ? "context_unsupported_message_block"
    : "context_unknown_message_block";
  throw contractError(code, `Message block type ${block.type} is not supported by Phase 4`, {
    blockIndex,
    blockType: block.type,
    messageId: message.id,
  });
}

async function manifestItem(
  messageId: string,
  blockIndex: number,
  blockType: string,
  content: JsonValue,
  toolCallId: string | null = null,
): Promise<ContextManifestItem> {
  return {
    blockIndex,
    blockType,
    contentHash: await hashStableJson(content),
    decision: "included",
    messageId,
    reason: "lossless_policy",
    toolCallId,
  };
}

function canonicalContent(block: CanonicalBlock): JsonValue {
  if (block.type === "text") {
    return { text: block.text, type: block.type };
  }
  return {
    args: block.args,
    error: block.error,
    id: block.id,
    modelContent: block.modelContent,
    name: block.name,
    status: block.status,
    toolSource: block.toolSource,
    type: block.type,
  };
}

function hasExplicitError(error: JsonObject | null): boolean {
  return error !== null && typeof error.message === "string" && error.message.trim() !== "";
}

function hasModelVisibleErrorContent(value: JsonValue): boolean {
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value !== null && typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return false;
}

function invalidBlock(
  messageId: string,
  blockIndex: number,
  message: string,
): ContextContractError {
  return contractError("context_invalid_message_block", message, { blockIndex, messageId });
}

function incompatibleBlock(message: Message, blockIndex: number, blockType: string) {
  return contractError(
    "context_incompatible_role_block",
    `Role ${message.role} is incompatible with block type ${blockType}`,
    { blockIndex, blockType, messageId: message.id, role: message.role },
  );
}

function contractError(
  code: ConstructorParameters<typeof ContextContractError>[0],
  message: string,
  details: JsonObject,
): ContextContractError {
  return new ContextContractError(code, message, details);
}

function validateTokenCount(value: number | null, name: string): void {
  if (value !== null && (!Number.isInteger(value) || value < 0)) {
    throw new RangeError(`${name} must be a non-negative integer or null`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
