// @vitest-environment node

import { describe, expect, it } from "vitest";

import { ContextAssembler, preflightLosslessBudget } from "@/application/context/contextAssembler";
import type { Conversation, Message, MessageBlock, MessageBlocks } from "@/domain/chat";
import type { ContextContractError } from "@/domain/context";
import type { JsonValue } from "@/domain/json";
import type { ContextRepository } from "@/application/context/contextAssembler";
import type { MessageParentChain } from "@/infrastructure/db/phase3Repository";
import { rootMessageId } from "@/infrastructure/db/phase3Repository";

const CONVERSATION_ID = "conversation-context-unit";
const ROOT_ID = rootMessageId(CONVERSATION_ID);

describe("ContextAssembler", () => {
  it("builds a stable root-to-leaf canonical context and manifest", async () => {
    const repository = new StaticContextRepository(baseConversation("Follow the evidence."), {
      cycleMessageId: null,
      missingParentId: null,
      messages: [
        message("user-second", "user", "assistant-first", [text("What did it show?")]),
        message("assistant-first", "assistant", "user-first", [
          toolCall("call-unit", "succeeded", "unit evidence"),
          text("I checked the source."),
        ]),
        message("user-first", "user", ROOT_ID, [text("Check the source")]),
        rootMessage(),
      ],
    });
    const assembler = new ContextAssembler(repository);

    const first = await assembler.assemble({
      anchorMessageId: "user-second",
      conversationId: CONVERSATION_ID,
    });
    const second = await assembler.assemble({
      anchorMessageId: "user-second",
      conversationId: CONVERSATION_ID,
    });

    expect(second).toEqual(first);
    expect(first.turns.map((turn) => turn.messageId)).toEqual([
      "user-first",
      "assistant-first",
      "user-second",
    ]);
    expect(first.turns.map((turn) => turn.messageId)).not.toContain(ROOT_ID);
    expect(first.system).toEqual([
      {
        provenance: { messageId: ROOT_ID, blockIndex: 0 },
        text: "Follow the evidence.",
        type: "text",
      },
    ]);
    expect(first.manifest.items).toHaveLength(5);
    expect(first.manifest.items[2]).toMatchObject({
      blockType: "tool_call",
      decision: "included",
      messageId: "assistant-first",
      reason: "lossless_policy",
      toolCallId: "call-unit",
    });
    expect(first.contextHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.manifest.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    first.manifest.items.forEach((item) => {
      expect(item.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  it.each(["requested", "running"] as const)(
    "rejects an incomplete %s tool call",
    async (status) => {
      await expectAssemblerError("context_tool_incomplete", "assistant-incomplete", "assistant", [
        toolCall("call-incomplete", status, undefined),
      ]);
    },
  );

  it.each(["denied", "cancelled"] as const)(
    "accepts a terminal %s tool call when modelContent is preserved",
    async (status) => {
      const context = await assembleSingleMessage("assistant-terminal", "assistant", [
        toolCall("call-terminal", status, `${status} by user`),
      ]);
      expect(context.turns[0]?.blocks[0]).toMatchObject({
        id: "call-terminal",
        modelContent: `${status} by user`,
        status,
      });
    },
  );

  it("rejects duplicate tool-call IDs in the current branch", async () => {
    await expectAssemblerError(
      "context_duplicate_tool_call_id",
      "assistant-duplicate",
      "assistant",
      [
        toolCall("call-duplicate", "succeeded", "first"),
        toolCall("call-duplicate", "succeeded", "second"),
      ],
    );
  });

  it("rejects a succeeded tool without result.modelContent", async () => {
    await expectAssemblerError(
      "context_tool_result_missing_model_content",
      "assistant-missing-result",
      "assistant",
      [
        {
          type: "tool_call",
          id: "call-missing-result",
          name: "fixture_tool",
          args: {},
          status: "succeeded",
          source: "client",
          result: {},
        } as unknown as MessageBlock,
      ],
    );
  });

  it("rejects a failed tool without an explicit error message", async () => {
    await expectAssemblerError(
      "context_tool_failure_missing_error_content",
      "assistant-failed-result",
      "assistant",
      [
        {
          type: "tool_call",
          id: "call-failed-result",
          name: "fixture_tool",
          args: {},
          status: "failed",
          source: "client",
          result: { modelContent: "The tool failed", error: { code: "fixture_error" } },
        } as MessageBlock,
      ],
    );
  });

  it("rejects a failed tool whose model-visible error content is empty", async () => {
    await expectAssemblerError(
      "context_tool_failure_missing_error_content",
      "assistant-empty-failure",
      "assistant",
      [
        {
          type: "tool_call",
          id: "call-empty-failure",
          name: "fixture_tool",
          args: {},
          status: "failed",
          source: "client",
          result: {
            modelContent: "",
            error: { code: "fixture_error", message: "Fixture failure" },
          },
        },
      ],
    );
  });

  it("accepts a failed tool with modelContent and an explicit error message", async () => {
    const context = await assembleSingleMessage("assistant-failed", "assistant", [
      {
        type: "tool_call",
        id: "call-failed",
        name: "fixture_tool",
        args: {},
        status: "failed",
        source: "client",
        result: {
          modelContent: "ERROR fixture failure",
          error: { code: "fixture_error", message: "Fixture failure" },
        },
      },
    ]);
    expect(context.turns[0]?.blocks[0]).toMatchObject({
      error: { code: "fixture_error", message: "Fixture failure" },
      modelContent: "ERROR fixture failure",
      status: "failed",
    });
  });

  it.each([
    ["context_unknown_message_block", { type: "future_block", value: "preserved" }],
    ["context_invalid_message_block", { type: "text", value: "missing text" }],
  ] as const)("returns %s instead of silently dropping a bad block", async (code, block) => {
    await expectAssemblerError(code, "assistant-bad-block", "assistant", [
      block as unknown as MessageBlock,
    ]);
  });

  it("excludes display-only process blocks while retaining replayable tool results and text", async () => {
    const context = await assembleSingleMessage("assistant-display-only", "assistant", [
      { type: "thinking", text: "summary", visibility: "summary" },
      toolCall("search-1", "succeeded", { sources: ["source-1"] }),
      { type: "source", id: "source-1", url: "https://example.com" },
      { type: "citation", sourceId: "source-1", marker: "1" },
      { type: "provider_state", provider: "fixture", purpose: "response_id", data: "resp-1" },
      { type: "text", text: "Final answer" },
    ]);

    expect(context.turns[0]?.blocks.map((block) => block.type)).toEqual(["tool_call", "text"]);
    expect(context.turns[0]?.blocks[0]).toMatchObject({
      id: "search-1",
      modelContent: { sources: ["source-1"] },
    });
    expect(context.manifest.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ blockType: "thinking", decision: "excluded" }),
        expect.objectContaining({ blockType: "source", decision: "excluded" }),
        expect.objectContaining({ blockType: "citation", decision: "excluded" }),
        expect.objectContaining({ blockType: "provider_state", decision: "excluded" }),
      ]),
    );
  });

  it("rejects a tool block on a user message", async () => {
    await expectAssemblerError("context_incompatible_role_block", "user-with-tool", "user", [
      toolCall("call-user", "succeeded", "result"),
    ]);
  });
});

describe("lossless budget preflight", () => {
  it.each([
    [{ estimatedInputTokens: 500, contextWindow: 1_000, reservedOutputTokens: 100 }, "normal"],
    [{ estimatedInputTokens: 850, contextWindow: 1_000, reservedOutputTokens: 50 }, "risk"],
    [{ estimatedInputTokens: 950, contextWindow: 1_000, reservedOutputTokens: 100 }, "over_limit"],
    [{ estimatedInputTokens: null, contextWindow: 1_000, reservedOutputTokens: 100 }, "uncertain"],
  ] as const)("reports %s without mutating its input", (input, expectedStatus) => {
    const before = structuredClone(input);
    const result = preflightLosslessBudget(input);

    expect(result.status).toBe(expectedStatus);
    expect(input).toEqual(before);
  });
});

class StaticContextRepository implements ContextRepository {
  constructor(
    private readonly conversation: Conversation | null,
    private readonly chain: MessageParentChain,
  ) {}

  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversation?.id === id ? this.conversation : null;
  }

  async readMessageParentChain(anchorMessageId: string): Promise<MessageParentChain> {
    if (this.chain.messages[0]?.id !== anchorMessageId) {
      return { cycleMessageId: null, messages: [], missingParentId: null };
    }
    return this.chain;
  }
}

async function assembleSingleMessage(id: string, role: Message["role"], blocks: MessageBlock[]) {
  return new ContextAssembler(
    new StaticContextRepository(baseConversation(), {
      cycleMessageId: null,
      missingParentId: null,
      messages: [message(id, role, ROOT_ID, blocks), rootMessage()],
    }),
  ).assemble({ anchorMessageId: id, conversationId: CONVERSATION_ID });
}

async function expectAssemblerError(
  code: ContextContractError["code"],
  id: string,
  role: Message["role"],
  blocks: MessageBlock[],
): Promise<void> {
  await expect(assembleSingleMessage(id, role, blocks)).rejects.toMatchObject({ code });
}

function baseConversation(systemPrompt = ""): Conversation {
  return {
    id: CONVERSATION_ID,
    title: "Context fixture",
    modelRef: null,
    systemPrompt,
    params: {},
    extraBody: {},
    extraHeaders: {},
    extraQuery: {},
    extraPath: {},
    toolsOverride: {},
    contextPolicy: { mode: "lossless" },
    activeLeafMessageId: null,
    archived: false,
    starred: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function rootMessage(): Message {
  return message(ROOT_ID, "root", null, []);
}

function message(
  id: string,
  role: Message["role"],
  parentId: string | null,
  blocks: MessageBlock[],
): Message {
  return {
    id,
    conversationId: CONVERSATION_ID,
    role,
    blocks: { version: 1, blocks } satisfies MessageBlocks,
    status: "done",
    usage: null,
    modelRef: null,
    parentId,
    siblingOrder: 0,
    providerResponseId: null,
    providerPreviousResponseId: null,
    requestSnapshotId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function text(value: string): MessageBlock {
  return { type: "text", text: value };
}

function toolCall(
  id: string,
  status: "requested" | "running" | "succeeded" | "failed" | "denied" | "cancelled",
  modelContent: JsonValue | undefined,
): MessageBlock {
  return {
    type: "tool_call",
    id,
    name: "fixture_tool",
    args: { query: "fixture" },
    status,
    source: "client",
    ...(modelContent === undefined ? {} : { result: { modelContent } }),
  } as MessageBlock;
}
