// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Conversation, RequestAttempt, RequestSnapshot } from "@/domain/chat";
import { Phase3Repository, rootMessageId } from "@/infrastructure/db/phase3Repository";
import { initializePersistence } from "@/infrastructure/db/startup";
import { FIXTURE_TIME, seedProviderGraph } from "@/test/database/phase3Seed";
import { createTempDatabase, type TempDatabaseFixture } from "@/test/database/tempDatabase";

describe("Phase 5A retry persistence", () => {
  let fixture: TempDatabaseFixture;
  let repository: Phase3Repository;

  beforeEach(async () => {
    fixture = await createTempDatabase();
    repository = new Phase3Repository(fixture.database);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("persists one logical request while attempts move through retry to success", async () => {
    const setup = await createPreparedRequest(repository, "success");
    await repository.startLogicalRequest(setup.snapshot, setup.initialAttempt);

    expect(await repository.getRequestSnapshot(setup.snapshot.id)).toMatchObject({
      status: "running",
      attemptCount: 1,
      contextHash: "sha256:context-success",
      requestBodyHash: "sha256:body-success",
    });
    expect(await repository.getMessage(setup.assistantMessageId)).toMatchObject({
      status: "streaming",
    });
    expect(await repository.getRequestAttempt(setup.initialAttempt.id)).toMatchObject({
      attemptNo: 1,
      trigger: "initial",
      status: "running",
      requestBodyHash: "sha256:body-success",
    });

    await repository.scheduleRetry({
      assistantMessageId: setup.assistantMessageId,
      attemptId: setup.initialAttempt.id,
      bytesReceived: 0,
      completedAt: FIXTURE_TIME + 20,
      firstByteAt: FIXTURE_TIME + 19,
      firstSemanticEventAt: null,
      httpStatus: 429,
      providerErrorCode: null,
      retryAfterMs: 2_000,
      retryReason: "http_429",
      scheduledDelayMs: 2_000,
      semanticEventCount: 0,
      snapshotId: setup.snapshot.id,
    });
    expect(await repository.getMessage(setup.assistantMessageId)).toMatchObject({
      status: "waiting_retry",
    });
    expect(await repository.getRequestAttempt(setup.initialAttempt.id)).toMatchObject({
      status: "retryable_failed",
      retryable: true,
      httpStatus: 429,
      retryAfterMs: 2_000,
      scheduledDelayMs: 2_000,
    });

    const secondAttempt = attempt(setup.snapshot, 2, "automatic_retry");
    await repository.startRetryAttempt(setup.assistantMessageId, secondAttempt);
    expect(await repository.getRequestSnapshot(setup.snapshot.id)).toMatchObject({
      status: "running",
      attemptCount: 2,
    });
    expect(await repository.getMessage(setup.assistantMessageId)).toMatchObject({
      status: "streaming",
    });

    expect(
      await repository.finalizeRequestAttempt({
        assistantMessageId: setup.assistantMessageId,
        attemptId: secondAttempt.id,
        attemptStatus: "completed",
        blocks: { version: 1, blocks: [{ type: "text", text: "complete" }] },
        bytesReceived: 42,
        completedAt: FIXTURE_TIME + 30,
        errorCode: null,
        finishReason: "stop",
        firstByteAt: FIXTURE_TIME + 21,
        firstEventAt: FIXTURE_TIME + 22,
        firstSemanticEventAt: FIXTURE_TIME + 22,
        httpStatus: null,
        providerAnchor: { responseId: "response-success" },
        providerErrorCode: null,
        providerResponseId: "response-success",
        retryReason: null,
        semanticEventCount: 3,
        snapshotId: setup.snapshot.id,
        status: "done",
        usage: { total_tokens: 5 },
      }),
    ).toBe(true);

    expect(await repository.getMessage(setup.assistantMessageId)).toMatchObject({
      status: "done",
      providerResponseId: "response-success",
      blocks: { blocks: [{ type: "text", text: "complete" }] },
    });
    expect(await repository.getRequestSnapshot(setup.snapshot.id)).toMatchObject({
      status: "done",
      attemptCount: 2,
      finishReason: "stop",
    });
    expect(await repository.listRequestAttempts(setup.snapshot.id)).toMatchObject([
      { attemptNo: 1, status: "retryable_failed" },
      { attemptNo: 2, status: "completed" },
    ]);
  });

  it("rejects a retry whose body hash differs and keeps the waiting state intact", async () => {
    const setup = await createPreparedRequest(repository, "hash");
    await repository.startLogicalRequest(setup.snapshot, setup.initialAttempt);
    await repository.scheduleRetry({
      assistantMessageId: setup.assistantMessageId,
      attemptId: setup.initialAttempt.id,
      bytesReceived: 0,
      completedAt: FIXTURE_TIME + 20,
      firstByteAt: FIXTURE_TIME + 19,
      firstSemanticEventAt: null,
      httpStatus: 503,
      providerErrorCode: null,
      retryAfterMs: null,
      retryReason: "http_503",
      scheduledDelayMs: 500,
      semanticEventCount: 0,
      snapshotId: setup.snapshot.id,
    });

    await expect(
      repository.startRetryAttempt(setup.assistantMessageId, {
        ...attempt(setup.snapshot, 2, "automatic_retry"),
        requestBodyHash: "sha256:changed",
      }),
    ).rejects.toThrow();
    expect(await repository.getRequestSnapshot(setup.snapshot.id)).toMatchObject({
      attemptCount: 1,
      status: "running",
    });
    expect(await repository.getMessage(setup.assistantMessageId)).toMatchObject({
      status: "waiting_retry",
    });
  });

  it("cancels waiting retries and recovers running attempts without resending", async () => {
    const waiting = await createPreparedRequest(repository, "cancel");
    await repository.startLogicalRequest(waiting.snapshot, waiting.initialAttempt);
    await repository.scheduleRetry({
      assistantMessageId: waiting.assistantMessageId,
      attemptId: waiting.initialAttempt.id,
      bytesReceived: 0,
      completedAt: FIXTURE_TIME + 20,
      firstByteAt: FIXTURE_TIME + 19,
      firstSemanticEventAt: null,
      httpStatus: 429,
      providerErrorCode: null,
      retryAfterMs: 2_000,
      retryReason: "http_429",
      scheduledDelayMs: 2_000,
      semanticEventCount: 0,
      snapshotId: waiting.snapshot.id,
    });
    await repository.interruptWaitingRetry({
      assistantMessageId: waiting.assistantMessageId,
      blocks: {
        version: 1,
        blocks: [{ type: "error", code: "retry_cancelled", message: "Stopped.", retryable: false }],
      },
      completedAt: FIXTURE_TIME + 21,
      errorCode: "retry_cancelled",
      finishReason: "cancelled",
      snapshotId: waiting.snapshot.id,
      status: "interrupted",
    });
    expect(await repository.getMessage(waiting.assistantMessageId)).toMatchObject({
      status: "interrupted",
    });
    expect(await repository.getRequestSnapshot(waiting.snapshot.id)).toMatchObject({
      status: "interrupted",
      errorCode: "retry_cancelled",
    });

    const running = await createPreparedRequest(repository, "restart");
    await repository.startLogicalRequest(running.snapshot, running.initialAttempt);
    const restarted = await initializePersistence(FIXTURE_TIME + 50, async () => fixture.database);
    expect(await restarted.getMessage(running.assistantMessageId)).toMatchObject({
      status: "interrupted",
    });
    expect(await restarted.getRequestSnapshot(running.snapshot.id)).toMatchObject({
      status: "interrupted",
      errorCode: "app_restart",
    });
    expect(await restarted.getRequestAttempt(running.initialAttempt.id)).toMatchObject({
      status: "cancelled",
      retryReason: "app_restart",
    });
  });
});

async function createPreparedRequest(repository: Phase3Repository, suffix: string) {
  const graph = await seedProviderGraph(repository, suffix);
  const conversation: Conversation = await repository.createConversation({
    id: `conversation-${suffix}`,
    title: `Retry ${suffix}`,
    modelRef: graph.model.id,
    systemPrompt: "",
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
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  });
  const turn = await repository.createPendingTurn({
    conversationId: conversation.id,
    parentId: rootMessageId(conversation.id),
    userMessageId: `user-${suffix}`,
    userBlocks: { version: 1, blocks: [{ type: "text", text: "hello" }] },
    assistantMessageId: `assistant-${suffix}`,
    assistantBlocks: { version: 1, blocks: [] },
    assistantModelRef: graph.model.id,
    createdAt: FIXTURE_TIME + 1,
  });
  const snapshot: RequestSnapshot = {
    id: `snapshot-${suffix}`,
    conversationId: conversation.id,
    userMessageId: turn.userMessage.id,
    assistantMessageId: turn.assistantMessage.id,
    connectionId: graph.connection.id,
    endpointId: graph.endpoint.id,
    modelRef: graph.model.id,
    protocolProfileId: graph.profile.id,
    protocolProfileRevision: graph.profile.revision,
    codecVersion: "fixture/1",
    requestMethod: "POST",
    requestUrl: "https://fixture.invalid/v1/chat/completions",
    requestHeaders: [],
    requestQuery: [],
    requestBody: { model: graph.model.modelId, stream: true },
    params: { temperature: 0.2 },
    contextManifest: { version: 1, items: [] },
    contextHash: `sha256:context-${suffix}`,
    requestBodyHash: `sha256:body-${suffix}`,
    retryPolicy: { enabled: true, maxRetries: 3 },
    attemptCount: 0,
    providerAnchor: null,
    status: "pending",
    finishReason: null,
    errorCode: null,
    startedAt: FIXTURE_TIME + 2,
    firstEventAt: null,
    completedAt: null,
  };
  return {
    assistantMessageId: turn.assistantMessage.id,
    initialAttempt: attempt(snapshot, 1, "initial"),
    snapshot,
  };
}

function attempt(
  snapshot: RequestSnapshot,
  attemptNo: number,
  trigger: RequestAttempt["trigger"],
): RequestAttempt {
  return {
    id: `attempt-${snapshot.id}-${attemptNo}`,
    requestSnapshotId: snapshot.id,
    attemptNo,
    trigger,
    transportRequestId: `transport-${snapshot.id}-${attemptNo}`,
    requestBodyHash: snapshot.requestBodyHash,
    status: "running",
    retryable: false,
    retryReason: null,
    httpStatus: null,
    providerErrorCode: null,
    retryAfterMs: null,
    scheduledDelayMs: null,
    startedAt: snapshot.startedAt + attemptNo,
    firstByteAt: null,
    firstSemanticEventAt: null,
    completedAt: null,
    bytesReceived: 0,
    semanticEventCount: 0,
  };
}
