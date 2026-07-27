// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContextAssembler } from "@/application/context/contextAssembler";
import type { MessageBlocks, RequestSnapshot } from "@/domain/chat";
import type { CanonicalContext, CanonicalToolCallBlock } from "@/domain/context";
import {
  serializeOpenAIChatCompletions,
  serializeOpenAIResponses,
  type OpenAIChatCompletionsBody,
  type OpenAIChatToolCallMessage,
  type OpenAIChatToolResultMessage,
  type OpenAIResponsesBody,
  type OpenAIResponsesFunctionCallItem,
  type OpenAIResponsesFunctionCallOutputItem,
  type OpenAIResponsesMessageItem,
} from "@/infrastructure/providers/openai/contextSerializers";
import {
  handoffSerializedOpenAIRequest,
  type OpenAIContextProtocol,
  type SerializedOpenAIRequest,
} from "@/infrastructure/providers/openai/serializedRequestBoundary";
import { Phase3Repository, rootMessageId } from "@/infrastructure/db/phase3Repository";
import { FIXTURE_TIME, seedProviderGraph } from "@/test/database/phase3Seed";
import { createTempDatabase, type TempDatabaseFixture } from "@/test/database/tempDatabase";
import { CaptureSerializedRequestBoundary } from "@/test/fixtures/captureSerializedRequestBoundary";

const CANARY = "EVIDENCE_PHASE4_7f3ac921";
const TOOL_CALL_ID = "call_phase4_continuity";

describe("OpenAI context serializer contracts", () => {
  let fixture: TempDatabaseFixture;
  let repository: Phase3Repository;

  beforeEach(async () => {
    fixture = await createTempDatabase();
    repository = new Phase3Repository(fixture.database);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("captures the Chat Completions second-turn request with the original tool result", async () => {
    const seeded = await seedCanaryConversation(repository, "chat");
    const capture = new CaptureSerializedRequestBoundary();
    const context = await new ContextAssembler(repository).assemble({
      anchorMessageId: seeded.userMessageId,
      conversationId: seeded.conversation.id,
    });
    const contextBefore = structuredClone(context);

    const handedOff = await handoffSerializedOpenAIRequest(
      "openai_chat_completions",
      context,
      seeded.graph.model.modelId,
      capture,
    );

    expect(context).toEqual(contextBefore);
    expect(capture.requests).toEqual([handedOff]);
    const captured = capture.requests[0];
    expect(captured?.protocol).toBe("openai_chat_completions");
    const body = captured?.body as OpenAIChatCompletionsBody | undefined;
    if (!body) {
      throw new Error("Expected a captured Chat Completions body");
    }

    const toolCallMessage = body.messages.find(
      (message): message is OpenAIChatToolCallMessage =>
        message.role === "assistant" && "tool_calls" in message,
    );
    const toolResultMessage = body.messages.find(
      (message): message is OpenAIChatToolResultMessage => message.role === "tool",
    );
    expect(toolCallMessage?.tool_calls).toEqual([
      {
        function: { arguments: '{"a":1,"z":2}', name: "fixture_lookup" },
        id: TOOL_CALL_ID,
        type: "function",
      },
    ]);
    expect(toolResultMessage).toEqual({
      content: CANARY,
      role: "tool",
      tool_call_id: TOOL_CALL_ID,
    });
    expect(
      body.messages
        .filter((message) => message.role === "assistant" && "content" in message)
        .every((message) => message.content === null || !message.content.includes(CANARY)),
    ).toBe(true);
    expect(countOccurrences(JSON.stringify(body), CANARY)).toBe(1);

    await assertSnapshotRoundTrip(repository, seeded, context, handedOff, "chat");
  });

  it("captures the Responses second-turn request with the original function call output", async () => {
    const seeded = await seedCanaryConversation(repository, "responses");
    const capture = new CaptureSerializedRequestBoundary();
    const context = await new ContextAssembler(repository).assemble({
      anchorMessageId: seeded.userMessageId,
      conversationId: seeded.conversation.id,
    });
    const contextBefore = structuredClone(context);

    const handedOff = await handoffSerializedOpenAIRequest(
      "openai_responses",
      context,
      seeded.graph.model.modelId,
      capture,
    );

    expect(context).toEqual(contextBefore);
    expect(capture.requests).toEqual([handedOff]);
    const captured = capture.requests[0];
    expect(captured?.protocol).toBe("openai_responses");
    const body = captured?.body as OpenAIResponsesBody | undefined;
    if (!body) {
      throw new Error("Expected a captured Responses body");
    }

    const functionCall = body.input.find(
      (item): item is OpenAIResponsesFunctionCallItem => item.type === "function_call",
    );
    const functionOutput = body.input.find(
      (item): item is OpenAIResponsesFunctionCallOutputItem => item.type === "function_call_output",
    );
    expect(functionCall).toEqual({
      arguments: '{"a":1,"z":2}',
      call_id: TOOL_CALL_ID,
      name: "fixture_lookup",
      type: "function_call",
    });
    expect(functionOutput).toEqual({
      call_id: TOOL_CALL_ID,
      output: CANARY,
      type: "function_call_output",
    });
    expect(
      body.input
        .filter(
          (item): item is OpenAIResponsesMessageItem =>
            item.type === "message" && item.role === "assistant",
        )
        .every((item) => !item.content.includes(CANARY)),
    ).toBe(true);
    expect(countOccurrences(JSON.stringify(body), CANARY)).toBe(1);

    await assertSnapshotRoundTrip(repository, seeded, context, handedOff, "responses");
  });

  it.each(["openai_chat_completions", "openai_responses"] as const)(
    "produces a stable final body hash for %s",
    async (protocol) => {
      const seeded = await seedCanaryConversation(repository, `stable-${protocol}`);
      const context = await new ContextAssembler(repository).assemble({
        anchorMessageId: seeded.userMessageId,
        conversationId: seeded.conversation.id,
      });
      const firstCapture = new CaptureSerializedRequestBoundary();
      const secondCapture = new CaptureSerializedRequestBoundary();

      const first = await handoffSerializedOpenAIRequest(
        protocol,
        context,
        seeded.graph.model.modelId,
        firstCapture,
      );
      const second = await handoffSerializedOpenAIRequest(
        protocol,
        context,
        seeded.graph.model.modelId,
        secondCapture,
      );

      expect(second.body).toEqual(first.body);
      expect(second.bodyHash).toBe(first.bodyHash);
      expect(firstCapture.requests[0]).toEqual(first);
      expect(secondCapture.requests[0]).toEqual(second);
    },
  );

  it.each(["openai_chat_completions", "openai_responses"] as const)(
    "returns serializer_unsupported_block for an unknown canonical block in %s",
    async (protocol) => {
      const seeded = await seedCanaryConversation(repository, `unknown-${protocol}`);
      const context = await new ContextAssembler(repository).assemble({
        anchorMessageId: seeded.userMessageId,
        conversationId: seeded.conversation.id,
      });
      const damaged = structuredClone(context);
      damaged.turns[0]!.blocks[0] = { type: "future_canonical_block" } as never;

      expect(() => serialize(protocol, damaged, seeded.graph.model.modelId)).toThrowError(
        expect.objectContaining({ code: "serializer_unsupported_block" }),
      );
    },
  );

  it.each(["openai_chat_completions", "openai_responses"] as const)(
    "returns serializer_incompatible_role_block for a user tool block in %s",
    async (protocol) => {
      const seeded = await seedCanaryConversation(repository, `role-${protocol}`);
      const context = await new ContextAssembler(repository).assemble({
        anchorMessageId: seeded.userMessageId,
        conversationId: seeded.conversation.id,
      });
      const damaged = structuredClone(context);
      const tool = damaged.turns
        .flatMap((turn) => turn.blocks)
        .find((block): block is CanonicalToolCallBlock => block.type === "tool_call");
      if (!tool) {
        throw new Error("Expected canonical tool fixture");
      }
      damaged.turns[0]!.blocks = [tool];

      expect(() => serialize(protocol, damaged, seeded.graph.model.modelId)).toThrowError(
        expect.objectContaining({ code: "serializer_incompatible_role_block" }),
      );
    },
  );
});

function serialize(protocol: OpenAIContextProtocol, context: CanonicalContext, modelId: string) {
  return protocol === "openai_chat_completions"
    ? serializeOpenAIChatCompletions(context, modelId)
    : serializeOpenAIResponses(context, modelId);
}

async function seedCanaryConversation(repository: Phase3Repository, suffix: string) {
  const graph = await seedProviderGraph(repository, suffix);
  const conversation = await repository.createConversation({
    id: `conversation-canary-${suffix}`,
    title: "Tool continuity fixture",
    modelRef: graph.model.id,
    systemPrompt: "Preserve tool evidence across turns.",
    params: {},
    extraBody: {},
    extraHeaders: {},
    extraQuery: {},
    toolsOverride: {},
    contextPolicy: { mode: "lossless" },
    activeLeafMessageId: null,
    archived: false,
    starred: false,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  });
  const first = await repository.createPendingTurn({
    conversationId: conversation.id,
    parentId: rootMessageId(conversation.id),
    userMessageId: `canary-user-first-${suffix}`,
    userBlocks: { version: 1, blocks: [{ type: "text", text: "Run the fixture lookup." }] },
    assistantMessageId: `canary-assistant-first-${suffix}`,
    assistantBlocks: { version: 1, blocks: [] },
    assistantModelRef: graph.model.id,
    createdAt: FIXTURE_TIME + 1,
  });
  const firstAssistantBlocks: MessageBlocks = {
    version: 1,
    blocks: [
      {
        type: "tool_call",
        id: TOOL_CALL_ID,
        name: "fixture_lookup",
        args: { z: 2, a: 1 },
        status: "succeeded",
        source: "client",
        result: { modelContent: CANARY },
      },
      { type: "text", text: "The lookup completed; ask a follow-up when ready." },
    ],
  };
  await repository.updateMessage(
    first.assistantMessage.id,
    "done",
    firstAssistantBlocks,
    FIXTURE_TIME + 2,
  );
  const second = await repository.createPendingTurn({
    conversationId: conversation.id,
    parentId: first.assistantMessage.id,
    userMessageId: `canary-user-second-${suffix}`,
    userBlocks: {
      version: 1,
      blocks: [{ type: "text", text: "What exact evidence did the lookup return?" }],
    },
    assistantMessageId: `canary-assistant-second-${suffix}`,
    assistantBlocks: { version: 1, blocks: [] },
    assistantModelRef: graph.model.id,
    createdAt: FIXTURE_TIME + 3,
  });

  return {
    assistantMessageId: second.assistantMessage.id,
    conversation,
    graph,
    userMessageId: second.userMessage.id,
  };
}

async function assertSnapshotRoundTrip(
  repository: Phase3Repository,
  seeded: Awaited<ReturnType<typeof seedCanaryConversation>>,
  context: CanonicalContext,
  request: SerializedOpenAIRequest,
  suffix: string,
): Promise<void> {
  const snapshot: RequestSnapshot = {
    id: `snapshot-phase4-${suffix}`,
    conversationId: seeded.conversation.id,
    userMessageId: seeded.userMessageId,
    assistantMessageId: seeded.assistantMessageId,
    connectionId: seeded.graph.connection.id,
    endpointId: seeded.graph.endpoint.id,
    modelRef: seeded.graph.model.id,
    protocolProfileId: seeded.graph.profile.id,
    protocolProfileRevision: seeded.graph.profile.revision,
    codecVersion: `phase4-${suffix}/1`,
    requestMethod: "POST",
    requestUrl: `https://fixture.invalid:${seeded.graph.endpoint.explicitPort}/phase4/${suffix}`,
    requestHeaders: { "x-test-mode": "capture" },
    requestQuery: { fixture: true },
    requestBody: request.body,
    params: {},
    contextManifest: context.manifest,
    contextHash: context.contextHash,
    requestBodyHash: request.bodyHash,
    retryPolicy: { mode: "none" },
    attemptCount: 0,
    providerAnchor: null,
    status: "pending",
    finishReason: null,
    errorCode: null,
    startedAt: FIXTURE_TIME + 4,
    firstEventAt: null,
    completedAt: null,
  };

  await repository.createRequestSnapshot(snapshot);
  const loaded = await repository.getRequestSnapshot(snapshot.id);
  expect(loaded).toEqual(snapshot);
  expect(loaded).toMatchObject({
    connectionId: seeded.graph.connection.id,
    endpointId: seeded.graph.endpoint.id,
    modelRef: seeded.graph.model.id,
    protocolProfileId: seeded.graph.profile.id,
    protocolProfileRevision: seeded.graph.profile.revision,
    contextHash: context.contextHash,
    requestBodyHash: request.bodyHash,
  });
  expect(loaded?.contextManifest).toEqual(context.manifest);
  expect(loaded?.requestBody).toEqual(request.body);
}

function countOccurrences(value: string, expected: string): number {
  return value.split(expected).length - 1;
}
