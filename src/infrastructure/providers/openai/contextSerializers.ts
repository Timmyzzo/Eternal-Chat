import type {
  CanonicalBlock,
  CanonicalContext,
  CanonicalToolCallBlock,
  CanonicalTurn,
} from "@/domain/context";
import { ContextContractError } from "@/domain/context";
import type { JsonObject } from "@/domain/json";
import { stableJsonStringify } from "@/domain/stableJson";

export interface OpenAIChatFunctionCall extends JsonObject {
  arguments: string;
  name: string;
}

export interface OpenAIChatToolCall extends JsonObject {
  function: OpenAIChatFunctionCall;
  id: string;
  type: "function";
}

export interface OpenAIChatTextMessage extends JsonObject {
  content: string;
  role: "system" | "user" | "assistant";
}

export interface OpenAIChatToolCallMessage extends JsonObject {
  content: null;
  role: "assistant";
  tool_calls: OpenAIChatToolCall[];
}

export interface OpenAIChatToolResultMessage extends JsonObject {
  content: string;
  role: "tool";
  tool_call_id: string;
}

export type OpenAIChatMessage =
  OpenAIChatTextMessage | OpenAIChatToolCallMessage | OpenAIChatToolResultMessage;

export interface OpenAIChatCompletionsBody extends JsonObject {
  messages: OpenAIChatMessage[];
  model: string;
}

export interface OpenAIResponsesMessageItem extends JsonObject {
  content: string;
  role: "system" | "user" | "assistant";
  type: "message";
}

export interface OpenAIResponsesFunctionCallItem extends JsonObject {
  arguments: string;
  call_id: string;
  name: string;
  type: "function_call";
}

export interface OpenAIResponsesFunctionCallOutputItem extends JsonObject {
  call_id: string;
  output: string;
  type: "function_call_output";
}

export type OpenAIResponsesInputItem =
  | OpenAIResponsesMessageItem
  | OpenAIResponsesFunctionCallItem
  | OpenAIResponsesFunctionCallOutputItem;

export interface OpenAIResponsesBody extends JsonObject {
  input: OpenAIResponsesInputItem[];
  model: string;
}

export function serializeOpenAIChatCompletions(
  context: CanonicalContext,
  model: string,
): OpenAIChatCompletionsBody {
  validateModel(model);
  const messages: OpenAIChatMessage[] = [];
  appendChatTextMessage(messages, "system", context.system);
  context.turns.forEach((turn) => appendChatTurn(messages, turn));
  return { messages, model };
}

export function serializeOpenAIResponses(
  context: CanonicalContext,
  model: string,
): OpenAIResponsesBody {
  validateModel(model);
  const input: OpenAIResponsesInputItem[] = [];
  appendResponsesTextItem(input, "system", context.system);
  context.turns.forEach((turn) => appendResponsesTurn(input, turn));
  return { input, model };
}

function appendChatTurn(messages: OpenAIChatMessage[], turn: CanonicalTurn): void {
  assertNonEmptyTurn(turn);
  if (turn.role === "user") {
    appendChatTextMessage(messages, "user", turn.blocks);
    return;
  }
  if (turn.role !== "assistant") {
    throw incompatibleRole(turn.messageId, turn.role);
  }

  for (let index = 0; index < turn.blocks.length;) {
    const block = turn.blocks[index];
    assertSupportedBlock(block);
    if (block.type === "text") {
      const run = takeBlockRun(turn.blocks, index, "text");
      appendChatTextMessage(messages, "assistant", run.blocks);
      index = run.nextIndex;
      continue;
    }

    const run = takeToolRun(turn.blocks, index);
    messages.push({
      content: null,
      role: "assistant",
      tool_calls: run.blocks.map((tool) => ({
        function: { arguments: stableJsonStringify(tool.args), name: tool.name },
        id: tool.id,
        type: "function",
      })),
    });
    run.blocks.forEach((tool) => {
      messages.push({
        content: serializeModelContent(tool),
        role: "tool",
        tool_call_id: tool.id,
      });
    });
    index = run.nextIndex;
  }
}

function appendResponsesTurn(input: OpenAIResponsesInputItem[], turn: CanonicalTurn): void {
  assertNonEmptyTurn(turn);
  if (turn.role === "user") {
    appendResponsesTextItem(input, "user", turn.blocks);
    return;
  }
  if (turn.role !== "assistant") {
    throw incompatibleRole(turn.messageId, turn.role);
  }

  for (let index = 0; index < turn.blocks.length;) {
    const block = turn.blocks[index];
    assertSupportedBlock(block);
    if (block.type === "text") {
      const run = takeBlockRun(turn.blocks, index, "text");
      appendResponsesTextItem(input, "assistant", run.blocks);
      index = run.nextIndex;
      continue;
    }

    const run = takeToolRun(turn.blocks, index);
    run.blocks.forEach((tool) => {
      input.push({
        arguments: stableJsonStringify(tool.args),
        call_id: tool.id,
        name: tool.name,
        type: "function_call",
      });
    });
    run.blocks.forEach((tool) => {
      input.push({
        call_id: tool.id,
        output: serializeModelContent(tool),
        type: "function_call_output",
      });
    });
    index = run.nextIndex;
  }
}

function appendChatTextMessage(
  messages: OpenAIChatMessage[],
  role: "system" | "user" | "assistant",
  blocks: readonly CanonicalBlock[],
): void {
  if (blocks.length === 0) {
    return;
  }
  messages.push({ content: textContentForRole(blocks, role), role });
}

function appendResponsesTextItem(
  input: OpenAIResponsesInputItem[],
  role: "system" | "user" | "assistant",
  blocks: readonly CanonicalBlock[],
): void {
  if (blocks.length === 0) {
    return;
  }
  input.push({ content: textContentForRole(blocks, role), role, type: "message" });
}

function textContentForRole(
  blocks: readonly CanonicalBlock[],
  role: "system" | "user" | "assistant",
): string {
  return blocks
    .map((block) => {
      assertSupportedBlock(block);
      if (block.type !== "text") {
        throw new ContextContractError(
          "serializer_incompatible_role_block",
          `Role ${role} cannot contain canonical block ${block.type}`,
          { blockType: block.type, role },
        );
      }
      return block.text;
    })
    .join("\n\n");
}

function takeBlockRun(
  blocks: readonly CanonicalBlock[],
  start: number,
  type: "text",
): { blocks: CanonicalBlock[]; nextIndex: number } {
  const run: CanonicalBlock[] = [];
  let index = start;
  while (index < blocks.length) {
    const block = blocks[index];
    assertSupportedBlock(block);
    if (block.type !== type) {
      break;
    }
    run.push(block);
    index += 1;
  }
  return { blocks: run, nextIndex: index };
}

function takeToolRun(
  blocks: readonly CanonicalBlock[],
  start: number,
): { blocks: CanonicalToolCallBlock[]; nextIndex: number } {
  const run: CanonicalToolCallBlock[] = [];
  let index = start;
  while (index < blocks.length) {
    const block = blocks[index];
    assertSupportedBlock(block);
    if (block.type !== "tool_call") {
      break;
    }
    run.push(block);
    index += 1;
  }
  return { blocks: run, nextIndex: index };
}

function serializeModelContent(block: CanonicalToolCallBlock): string {
  return typeof block.modelContent === "string"
    ? block.modelContent
    : stableJsonStringify(block.modelContent);
}

function validateModel(model: string): void {
  if (model.trim() === "") {
    throw new ContextContractError("serializer_invalid_model", "A model ID is required");
  }
}

function assertNonEmptyTurn(turn: CanonicalTurn): void {
  if (turn.blocks.length === 0) {
    throw new ContextContractError(
      "serializer_unsupported_block",
      `Canonical turn ${turn.messageId} has no blocks`,
      { messageId: turn.messageId, reason: "empty_turn" },
    );
  }
}

function assertSupportedBlock(block: unknown): asserts block is CanonicalBlock {
  const blockType =
    block !== null && typeof block === "object" && "type" in block ? String(block.type) : "invalid";
  if (blockType !== "text" && blockType !== "tool_call") {
    throw new ContextContractError(
      "serializer_unsupported_block",
      "The serializer received an unsupported canonical block",
      { blockType },
    );
  }
}

function incompatibleRole(messageId: string, role: string): ContextContractError {
  return new ContextContractError(
    "serializer_incompatible_role_block",
    `Canonical turn role ${role} is not supported`,
    { messageId, role },
  );
}
