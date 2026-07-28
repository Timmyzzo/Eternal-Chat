import { describe, expect, it, vi } from "vitest";

import {
  ActiveRequestRegistry,
  type ActiveRequestPersistence,
} from "@/application/chat/activeRequestRegistry";
import type { PreparedDispatch } from "@/application/chat/requestAssembler";
import { DEFAULT_RETRY_POLICY } from "@/application/chat/retryPolicy";
import type { MessageBlocks, MessageStatus, RequestAttempt, RequestSnapshot } from "@/domain/chat";
import type { FinalizeRequestAttemptInput } from "@/infrastructure/db/phase3Repository";
import { FakeDesktopBridge } from "@/infrastructure/desktop/fakeDesktopBridge";
import { ChatCompletionsStreamParser } from "@/infrastructure/providers/openai/streamParsers";

describe("ActiveRequestRegistry", () => {
  it("streams, isolates subscriber failures, persists once, and tolerates transport EOF", async () => {
    const bridge = new FakeDesktopBridge();
    const persistence = new CapturePersistence();
    let now = 100;
    const registry = new ActiveRequestRegistry(bridge, persistence, () => ++now);
    const dispatch = createDispatch("request-done");
    registry.start(dispatch);

    const snapshots: string[] = [];
    registry.subscribe(dispatch.transportRequest.requestId, () => {
      throw new Error("subscriber failure");
    });
    registry.subscribe(dispatch.transportRequest.requestId, (state) => {
      snapshots.push(state.status);
    });
    await vi.waitFor(() => expect(bridge.startedRequests).toHaveLength(1));

    bridge.emit({
      type: "data",
      requestId: dispatch.transportRequest.requestId,
      data: [
        JSON.stringify({
          id: "provider-response",
          choices: [{ delta: { content: "hello" }, finish_reason: "stop" }],
        }),
        "[DONE]",
      ],
    });
    const terminal = await registry.whenTerminal(dispatch.transportRequest.requestId);
    bridge.emit({ type: "done", requestId: dispatch.transportRequest.requestId });

    expect(terminal).toMatchObject({
      status: "done",
      responseId: "provider-response",
      finishReason: "stop",
      blocks: { blocks: [{ type: "text", text: "hello" }] },
    });
    expect(persistence.running).toEqual([
      [dispatch.requestSnapshot.id, dispatch.assistantPlaceholder.id, 50],
    ]);
    expect(persistence.finalized).toHaveLength(1);
    expect(persistence.finalized[0]).toMatchObject({
      status: "done",
      providerResponseId: "provider-response",
    });
    expect(persistence.checkpoints[0]).toMatchObject({
      status: "streaming",
      blocks: { timeline: [expect.objectContaining({ type: "started" })] },
    });
    expect(snapshots).toContain("streaming");
    expect(snapshots.at(-1)).toBe("done");
  });

  it("stops before text and after partial text without duplicate finalization", async () => {
    const noTextBridge = new FakeDesktopBridge();
    const noTextPersistence = new CapturePersistence();
    const noTextRegistry = new ActiveRequestRegistry(noTextBridge, noTextPersistence, () => 60);
    const noTextDispatch = createDispatch("request-stop-empty");
    noTextRegistry.start(noTextDispatch);
    await vi.waitFor(() => expect(noTextBridge.startedRequests).toHaveLength(1));
    noTextRegistry.stop(noTextDispatch.transportRequest.requestId);
    expect(
      (await noTextRegistry.whenTerminal(noTextDispatch.transportRequest.requestId)).status,
    ).toBe("interrupted");
    expect(noTextPersistence.finalized).toHaveLength(1);

    const bridge = new FakeDesktopBridge();
    const persistence = new CapturePersistence();
    const registry = new ActiveRequestRegistry(bridge, persistence, () => 70);
    const dispatch = createDispatch("request-stop-partial");
    registry.start(dispatch);
    await vi.waitFor(() => expect(bridge.startedRequests).toHaveLength(1));
    bridge.emit({
      type: "data",
      requestId: dispatch.transportRequest.requestId,
      data: [JSON.stringify({ choices: [{ delta: { content: "partial" } }] })],
    });
    await vi.waitFor(() =>
      expect(registry.get(dispatch.transportRequest.requestId)?.blocks.blocks[0]).toMatchObject({
        type: "text",
        text: "partial",
      }),
    );
    registry.stop(dispatch.transportRequest.requestId);
    const terminal = await registry.whenTerminal(dispatch.transportRequest.requestId);
    bridge.emit({
      type: "error",
      requestId: dispatch.transportRequest.requestId,
      error: { kind: "cancelled", message: "cancelled" },
    });

    expect(terminal.status).toBe("interrupted");
    expect(terminal.blocks.blocks[0]).toMatchObject({ type: "text", text: "partial" });
    expect(bridge.cancelledRequestIds).toEqual([dispatch.transportRequest.requestId]);
    expect(persistence.finalized).toHaveLength(1);
  });

  it("continues in the background and allows a terminal reattach", async () => {
    const bridge = new FakeDesktopBridge();
    const persistence = new CapturePersistence();
    const registry = new ActiveRequestRegistry(bridge, persistence, () => 80);
    const dispatch = createDispatch("request-background");
    registry.start(dispatch);
    await vi.waitFor(() => expect(bridge.startedRequests).toHaveLength(1));

    const detachedStates: string[] = [];
    const detach = registry.subscribe(dispatch.transportRequest.requestId, (state) => {
      detachedStates.push(state.status);
    });
    detach();
    bridge.emit({
      type: "data",
      requestId: dispatch.transportRequest.requestId,
      data: [
        JSON.stringify({ choices: [{ delta: { content: "background" }, finish_reason: "stop" }] }),
        "[DONE]",
      ],
    });
    await registry.whenTerminal(dispatch.transportRequest.requestId);

    const reattached: string[] = [];
    registry.subscribe(dispatch.transportRequest.requestId, (state) => {
      reattached.push(state.status);
    });
    expect(detachedStates).toEqual(["pending"]);
    expect(reattached).toEqual(["done"]);
    expect(registry.latestForConversation("conversation-1")?.status).toBe("done");
  });

  it("throttles failed checkpoints without aborting the stream", async () => {
    const bridge = new FakeDesktopBridge();
    const persistence = new CapturePersistence(true);
    let now = 100;
    const registry = new ActiveRequestRegistry(bridge, persistence, () => ++now);
    const dispatch = createDispatch("request-checkpoint-failure");
    registry.start(dispatch);
    await vi.waitFor(() => expect(bridge.startedRequests).toHaveLength(1));

    bridge.emit({
      type: "data",
      requestId: dispatch.transportRequest.requestId,
      data: [
        ...Array.from({ length: 17 }, () =>
          JSON.stringify({ choices: [{ delta: { content: "x" } }] }),
        ),
        "[DONE]",
      ],
    });

    const terminal = await registry.whenTerminal(dispatch.transportRequest.requestId);
    expect(terminal).toMatchObject({ status: "done" });
    expect(terminal.blocks.blocks[0]).toMatchObject({ text: "x".repeat(17), type: "text" });
    expect(persistence.checkpointAttempts).toBe(2);
    expect(persistence.finalized).toHaveLength(1);
  });
});

class CapturePersistence implements ActiveRequestPersistence {
  checkpointAttempts = 0;
  readonly checkpoints: Array<{ blocks: MessageBlocks; status: MessageStatus }> = [];
  readonly finalized: FinalizeRequestAttemptInput[] = [];
  readonly running: Array<[string, string, number]> = [];

  constructor(private readonly failCheckpoints = false) {}

  async finalizeRequestAttempt(input: FinalizeRequestAttemptInput): Promise<boolean> {
    this.finalized.push(structuredClone(input));
    return true;
  }

  async interruptWaitingRetry(): Promise<void> {
    throw new Error("waiting retry is not expected in this test");
  }

  async scheduleRetry(): Promise<void> {
    throw new Error("automatic retry is not expected in this test");
  }

  async startLogicalRequest(snapshot: RequestSnapshot, attempt: RequestAttempt): Promise<void> {
    this.running.push([snapshot.id, snapshot.assistantMessageId ?? "", attempt.startedAt]);
  }

  async startRetryAttempt(): Promise<void> {
    throw new Error("automatic retry is not expected in this test");
  }

  async updateMessage(_id: string, status: MessageStatus, blocks: MessageBlocks): Promise<void> {
    this.checkpointAttempts += 1;
    if (this.failCheckpoints) throw new Error("checkpoint unavailable");
    this.checkpoints.push({ blocks: structuredClone(blocks), status });
  }
}

function createDispatch(requestId: string): PreparedDispatch {
  const userMessage = {
    id: `${requestId}-user`,
    conversationId: "conversation-1",
    role: "user" as const,
    blocks: { version: 1 as const, blocks: [{ type: "text" as const, text: "hello" }] },
    status: "done" as const,
    usage: null,
    modelRef: "model-1",
    parentId: "conversation-1:root",
    siblingOrder: 0,
    providerResponseId: null,
    providerPreviousResponseId: null,
    requestSnapshotId: null,
    createdAt: 50,
    updatedAt: 50,
  };
  const assistantPlaceholder = {
    ...userMessage,
    id: `${requestId}-assistant`,
    role: "assistant" as const,
    blocks: { version: 1 as const, blocks: [] },
    status: "pending" as const,
    parentId: userMessage.id,
  };
  const manifest = {
    version: 1 as const,
    conversationId: "conversation-1",
    anchorMessageId: userMessage.id,
    hash: "sha256:manifest",
    items: [],
    policy: "lossless" as const,
  };
  const context = {
    version: 1 as const,
    conversationId: "conversation-1",
    anchorMessageId: userMessage.id,
    contextHash: "sha256:context",
    system: [],
    turns: [],
    manifest,
  };
  const request = {
    requestId,
    url: "https://fixture.invalid/v1/chat/completions",
    method: "POST",
    headers: [],
    query: [],
    body: "{}",
  };
  return {
    assistantPlaceholder,
    canonicalContext: context,
    contextManifest: manifest,
    modelRevision: 1,
    parser: () => new ChatCompletionsStreamParser(),
    preview: {
      body: {},
      headers: [],
      method: "POST",
      query: [],
      sources: { body: {}, headers: {}, path: {}, query: {} },
      timeoutMs: null,
      url: request.url,
    },
    profileRevision: 1,
    redactedRequest: request,
    requestSnapshot: {
      id: `${requestId}-snapshot`,
      conversationId: "conversation-1",
      userMessageId: userMessage.id,
      assistantMessageId: assistantPlaceholder.id,
      connectionId: "connection-1",
      endpointId: "endpoint-1",
      modelRef: "model-1",
      protocolProfileId: "profile-1",
      protocolProfileRevision: 1,
      codecVersion: "openai_chat_completions/1",
      requestMethod: "POST",
      requestUrl: request.url,
      requestHeaders: [],
      requestQuery: [],
      requestBody: {},
      params: {},
      contextManifest: manifest,
      contextHash: "sha256:context",
      requestBodyHash: "sha256:body",
      retryPolicy: DEFAULT_RETRY_POLICY,
      attemptCount: 0,
      providerAnchor: null,
      status: "pending",
      finishReason: null,
      errorCode: null,
      startedAt: 50,
      firstEventAt: null,
      completedAt: null,
    },
    retryPolicy: DEFAULT_RETRY_POLICY,
    transportRequest: request,
    userMessage,
  };
}
