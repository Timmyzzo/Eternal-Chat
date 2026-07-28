// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Conversation, RequestSnapshot } from "@/domain/chat";
import { Phase3Repository, rootMessageId } from "@/infrastructure/db/phase3Repository";
import { initializePersistence } from "@/infrastructure/db/startup";
import { FIXTURE_TIME, seedProviderGraph } from "@/test/database/phase3Seed";
import { createTempDatabase, type TempDatabaseFixture } from "@/test/database/tempDatabase";

describe("Phase 5 chat persistence", () => {
  let fixture: TempDatabaseFixture;
  let repository: Phase3Repository;

  beforeEach(async () => {
    fixture = await createTempDatabase();
    repository = new Phase3Repository(fixture.database);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("claims and finalizes assistant blocks, usage, response id, and snapshot exactly once", async () => {
    const setup = await createPendingSnapshot(repository);
    await repository.markRequestRunning(
      setup.snapshot.id,
      setup.turn.assistantMessage.id,
      FIXTURE_TIME + 3,
    );

    const finalized = await repository.finalizeChatRequest({
      assistantMessageId: setup.turn.assistantMessage.id,
      blocks: { version: 1, blocks: [{ type: "text", text: "complete" }] },
      completedAt: FIXTURE_TIME + 5,
      errorCode: null,
      finishReason: "stop",
      firstEventAt: FIXTURE_TIME + 4,
      providerAnchor: { responseId: "provider-response" },
      providerResponseId: "provider-response",
      snapshotId: setup.snapshot.id,
      status: "done",
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    });
    const duplicate = await repository.finalizeChatRequest({
      assistantMessageId: setup.turn.assistantMessage.id,
      blocks: { version: 1, blocks: [{ type: "text", text: "must-not-win" }] },
      completedAt: FIXTURE_TIME + 6,
      errorCode: "late_error",
      finishReason: "error",
      firstEventAt: FIXTURE_TIME + 4,
      providerAnchor: null,
      providerResponseId: null,
      snapshotId: setup.snapshot.id,
      status: "error",
      usage: null,
    });

    expect(finalized).toBe(true);
    expect(duplicate).toBe(false);
    expect(await repository.getMessage(setup.turn.assistantMessage.id)).toMatchObject({
      status: "done",
      blocks: { blocks: [{ type: "text", text: "complete" }] },
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      providerResponseId: "provider-response",
    });
    expect(await repository.getRequestSnapshot(setup.snapshot.id)).toMatchObject({
      status: "done",
      attemptCount: 1,
      finishReason: "stop",
      firstEventAt: FIXTURE_TIME + 4,
      completedAt: FIXTURE_TIME + 5,
      providerAnchor: { responseId: "provider-response" },
    });
  });

  it("reconciles a crash between message finalization and snapshot terminal status", async () => {
    const setup = await createPendingSnapshot(repository, "crash");
    await repository.markRequestRunning(
      setup.snapshot.id,
      setup.turn.assistantMessage.id,
      FIXTURE_TIME + 3,
    );
    await fixture.database.execute(
      `UPDATE request_snapshot
      SET attempt_count = 1, finish_reason = 'stop', completed_at = ?
      WHERE id = ?`,
      [FIXTURE_TIME + 5, setup.snapshot.id],
    );
    await fixture.database.execute(
      `UPDATE message
      SET status = 'done', blocks_json = ?, usage_json = ?, provider_response_id = ?, updated_at = ?
      WHERE id = ?`,
      [
        JSON.stringify({ version: 1, blocks: [{ type: "text", text: "durable" }] }),
        JSON.stringify({ total_tokens: 3 }),
        "response-after-crash",
        FIXTURE_TIME + 5,
        setup.turn.assistantMessage.id,
      ],
    );

    const restarted = await initializePersistence(FIXTURE_TIME + 10, async () => fixture.database);
    expect(await restarted.getMessage(setup.turn.assistantMessage.id)).toMatchObject({
      status: "done",
      providerResponseId: "response-after-crash",
      usage: { total_tokens: 3 },
    });
    expect(await restarted.getRequestSnapshot(setup.snapshot.id)).toMatchObject({
      status: "done",
      attemptCount: 1,
      finishReason: "stop",
    });
  });
});

async function createPendingSnapshot(repository: Phase3Repository, suffix = "complete") {
  const graph = await seedProviderGraph(repository, suffix);
  const conversation: Conversation = await repository.createConversation({
    id: `conversation-${suffix}`,
    title: "Phase 5 persistence",
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
    params: {},
    contextManifest: { version: 1, items: [] },
    contextHash: "sha256:context",
    requestBodyHash: "sha256:body",
    retryPolicy: { mode: "none" },
    attemptCount: 0,
    providerAnchor: null,
    status: "pending",
    finishReason: null,
    errorCode: null,
    startedAt: FIXTURE_TIME + 2,
    firstEventAt: null,
    completedAt: null,
  };
  await repository.createRequestSnapshot(snapshot);
  return { conversation, graph, snapshot, turn };
}
