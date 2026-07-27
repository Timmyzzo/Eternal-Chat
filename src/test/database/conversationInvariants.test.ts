// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Conversation, MessageBlocks, RequestSnapshot } from "@/domain/chat";
import { EMPTY_MESSAGE_BLOCKS } from "@/domain/chat";
import {
  Phase3Repository,
  rootMessageId,
  type PendingTurn,
} from "@/infrastructure/db/phase3Repository";
import { initializePersistence } from "@/infrastructure/db/startup";
import { FIXTURE_TIME, seedProviderGraph } from "@/test/database/phase3Seed";
import { createTempDatabase, type TempDatabaseFixture } from "@/test/database/tempDatabase";

describe("conversation persistence invariants", () => {
  let fixture: TempDatabaseFixture;
  let repository: Phase3Repository;

  beforeEach(async () => {
    fixture = await createTempDatabase();
    repository = new Phase3Repository(fixture.database);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("creates the virtual root atomically and rolls back the conversation if root creation fails", async () => {
    const base = await createConversation(repository, "conversation-base");
    const root = await repository.getConversationRoot(base.id);
    expect(root).toMatchObject({
      id: rootMessageId(base.id),
      conversationId: base.id,
      role: "root",
      parentId: null,
      blocks: EMPTY_MESSAGE_BLOCKS,
      status: "done",
    });

    await createTurn(
      repository,
      base.id,
      rootMessageId(base.id),
      "conversation-collision:root",
      "assistant-collision-holder",
      FIXTURE_TIME + 1,
    );

    await expect(createConversation(repository, "conversation-collision")).rejects.toThrow();
    expect(await repository.getConversation("conversation-collision")).toBeNull();
  });

  it("rolls back user, placeholder, and active leaf when a pending turn cannot complete", async () => {
    const conversation = await createConversation(repository, "conversation-turn-rollback");
    const valid = await createTurn(
      repository,
      conversation.id,
      rootMessageId(conversation.id),
      "user-valid",
      "assistant-valid",
      FIXTURE_TIME + 1,
    );
    const activeLeafBefore = (await repository.getConversation(conversation.id))
      ?.activeLeafMessageId;

    await expect(
      createTurn(
        repository,
        conversation.id,
        valid.assistantMessage.id,
        "user-must-roll-back",
        valid.assistantMessage.id,
        FIXTURE_TIME + 2,
      ),
    ).rejects.toThrow();

    expect(await repository.getMessage("user-must-roll-back")).toBeNull();
    expect((await repository.getConversation(conversation.id))?.activeLeafMessageId).toBe(
      activeLeafBefore,
    );
  });

  it("uses one parent rule for first-turn user siblings and assistant siblings", async () => {
    const conversation = await createConversation(repository, "conversation-siblings");
    const rootId = rootMessageId(conversation.id);
    const first = await createTurn(
      repository,
      conversation.id,
      rootId,
      "user-first",
      "assistant-first",
      FIXTURE_TIME + 1,
    );
    const editedFirstTurn = await createTurn(
      repository,
      conversation.id,
      rootId,
      "user-first-edited",
      "assistant-first-edited",
      FIXTURE_TIME + 2,
    );
    const regenerated = await repository.createAssistantSibling({
      conversationId: conversation.id,
      parentUserMessageId: editedFirstTurn.userMessage.id,
      assistantMessageId: "assistant-first-regenerated",
      assistantBlocks: EMPTY_MESSAGE_BLOCKS,
      assistantModelRef: null,
      createdAt: FIXTURE_TIME + 3,
    });

    expect(first.userMessage.parentId).toBe(rootId);
    expect(editedFirstTurn.userMessage.parentId).toBe(rootId);
    expect(first.userMessage.siblingOrder).toBe(0);
    expect(editedFirstTurn.userMessage.siblingOrder).toBe(1);
    expect(editedFirstTurn.assistantMessage.siblingOrder).toBe(0);
    expect(regenerated.siblingOrder).toBe(1);
    expect((await repository.getConversation(conversation.id))?.activeLeafMessageId).toBe(
      regenerated.id,
    );

    const branch = await repository.listActiveBranchPage(conversation.id);
    expect(new Set(branch.messages.map((message) => message.id))).toEqual(
      new Set([editedFirstTurn.userMessage.id, regenerated.id]),
    );
  });

  it("rejects cross-conversation parents, parent cycles, roots, and foreign active leaves", async () => {
    const firstConversation = await createConversation(repository, "conversation-integrity-a");
    const firstTurn = await createTurn(
      repository,
      firstConversation.id,
      rootMessageId(firstConversation.id),
      "user-integrity-a1",
      "assistant-integrity-a1",
      FIXTURE_TIME + 1,
    );
    const secondTurn = await createTurn(
      repository,
      firstConversation.id,
      firstTurn.assistantMessage.id,
      "user-integrity-a2",
      "assistant-integrity-a2",
      FIXTURE_TIME + 2,
    );
    const secondConversation = await createConversation(repository, "conversation-integrity-b");
    const foreignTurn = await createTurn(
      repository,
      secondConversation.id,
      rootMessageId(secondConversation.id),
      "user-integrity-b1",
      "assistant-integrity-b1",
      FIXTURE_TIME + 3,
    );

    await expect(
      fixture.database.execute("UPDATE message SET parent_id = ? WHERE id = ?", [
        foreignTurn.assistantMessage.id,
        firstTurn.userMessage.id,
      ]),
    ).rejects.toThrow(/message_parent_cross_conversation/);

    await expect(
      fixture.database.execute("UPDATE message SET parent_id = ? WHERE id = ?", [
        secondTurn.assistantMessage.id,
        firstTurn.userMessage.id,
      ]),
    ).rejects.toThrow(/message_parent_cycle/);

    await expect(
      repository.setActiveLeaf(
        firstConversation.id,
        rootMessageId(firstConversation.id),
        FIXTURE_TIME + 4,
      ),
    ).rejects.toThrow(/conversation_active_leaf_root/);

    await expect(
      repository.setActiveLeaf(
        firstConversation.id,
        foreignTurn.assistantMessage.id,
        FIXTURE_TIME + 4,
      ),
    ).rejects.toThrow(/conversation_active_leaf_cross_conversation/);
  });

  it("recovers pending states through the startup path while preserving blocks and snapshots", async () => {
    const graph = await seedProviderGraph(repository);
    const conversation = await createConversation(
      repository,
      "conversation-recovery",
      graph.model.id,
    );
    const initial = await createTurn(
      repository,
      conversation.id,
      rootMessageId(conversation.id),
      "user-recovery",
      "assistant-pending",
      FIXTURE_TIME + 1,
      graph.model.id,
    );
    const waiting = await repository.createAssistantSibling({
      conversationId: conversation.id,
      parentUserMessageId: initial.userMessage.id,
      assistantMessageId: "assistant-waiting",
      assistantBlocks: EMPTY_MESSAGE_BLOCKS,
      assistantModelRef: graph.model.id,
      createdAt: FIXTURE_TIME + 2,
    });
    const waitingBlocks: MessageBlocks = {
      version: 1,
      blocks: [{ type: "text", text: "Persisted before retry wait" }],
    };
    await repository.updateMessage(waiting.id, "waiting_retry", waitingBlocks, FIXTURE_TIME + 3);

    const streaming = await repository.createAssistantSibling({
      conversationId: conversation.id,
      parentUserMessageId: initial.userMessage.id,
      assistantMessageId: "assistant-streaming",
      assistantBlocks: EMPTY_MESSAGE_BLOCKS,
      assistantModelRef: graph.model.id,
      createdAt: FIXTURE_TIME + 4,
    });
    const streamingBlocks: MessageBlocks = {
      version: 1,
      blocks: [{ type: "thinking", text: "Persisted partial", visibility: "provider_returned" }],
    };
    await repository.updateMessage(streaming.id, "streaming", streamingBlocks, FIXTURE_TIME + 5);

    const done = await repository.createAssistantSibling({
      conversationId: conversation.id,
      parentUserMessageId: initial.userMessage.id,
      assistantMessageId: "assistant-done",
      assistantBlocks: EMPTY_MESSAGE_BLOCKS,
      assistantModelRef: graph.model.id,
      createdAt: FIXTURE_TIME + 6,
    });
    await repository.updateMessage(
      done.id,
      "done",
      { version: 1, blocks: [{ type: "text", text: "Already complete" }] },
      FIXTURE_TIME + 7,
    );

    for (const [index, assistant] of [initial.assistantMessage, waiting, streaming].entries()) {
      await repository.createRequestSnapshot(
        createSnapshot(
          `snapshot-recovery-${index}`,
          conversation.id,
          initial.userMessage.id,
          assistant.id,
          graph,
          index === 0 ? "pending" : "running",
        ),
      );
    }

    const recoveredAt = FIXTURE_TIME + 100;
    const startupRepository = await initializePersistence(
      recoveredAt,
      async () => fixture.database,
    );

    expect(await startupRepository.getMessage(initial.assistantMessage.id)).toMatchObject({
      status: "interrupted",
      blocks: EMPTY_MESSAGE_BLOCKS,
      updatedAt: recoveredAt,
    });
    expect(await startupRepository.getMessage(waiting.id)).toMatchObject({
      status: "interrupted",
      blocks: waitingBlocks,
      updatedAt: recoveredAt,
    });
    expect(await startupRepository.getMessage(streaming.id)).toMatchObject({
      status: "interrupted",
      blocks: streamingBlocks,
      updatedAt: recoveredAt,
    });
    expect((await startupRepository.getMessage(done.id))?.status).toBe("done");

    for (const index of [0, 1, 2]) {
      expect(
        await startupRepository.getRequestSnapshot(`snapshot-recovery-${index}`),
      ).toMatchObject({
        status: "interrupted",
        errorCode: "app_restart",
        completedAt: recoveredAt,
      });
    }
  });

  it("paginates 500 active-branch messages in stable pages of 50 without duplicates or omissions", async () => {
    const conversation = await createConversation(repository, "conversation-pagination");
    const expectedIds: string[] = [];
    let parentId = rootMessageId(conversation.id);

    fixture.database.execScript("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 250; index += 1) {
        const suffix = index.toString().padStart(3, "0");
        const userMessageId = `pagination-user-${suffix}`;
        const assistantMessageId = `pagination-assistant-${suffix}`;
        const turn = await createTurn(
          repository,
          conversation.id,
          parentId,
          userMessageId,
          assistantMessageId,
          FIXTURE_TIME + Math.floor(index / 5),
        );
        expectedIds.push(turn.userMessage.id, turn.assistantMessage.id);
        parentId = turn.assistantMessage.id;
      }
      fixture.database.execScript("COMMIT");
    } catch (error) {
      fixture.database.execScript("ROLLBACK");
      throw error;
    }

    const actualIds: string[] = [];
    let cursor = null;
    let pageCount = 0;
    do {
      const page = await repository.listActiveBranchPage(conversation.id, cursor, 50);
      expect(page.messages).toHaveLength(50);
      actualIds.push(...page.messages.map((message) => message.id));
      cursor = page.nextCursor;
      pageCount += 1;
    } while (cursor);

    expect(pageCount).toBe(10);
    expect(actualIds).toHaveLength(500);
    expect(new Set(actualIds)).toHaveLength(500);
    expect([...actualIds].sort()).toEqual([...expectedIds].sort());
    expect(actualIds).not.toContain(rootMessageId(conversation.id));
  });
});

async function createConversation(
  repository: Phase3Repository,
  id: string,
  modelRef: string | null = null,
): Promise<Conversation> {
  return repository.createConversation({
    id,
    title: "Fixture conversation",
    modelRef,
    systemPrompt: "",
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
}

function createTurn(
  repository: Phase3Repository,
  conversationId: string,
  parentId: string,
  userMessageId: string,
  assistantMessageId: string,
  createdAt: number,
  modelRef: string | null = null,
): Promise<PendingTurn> {
  return repository.createPendingTurn({
    conversationId,
    parentId,
    userMessageId,
    userBlocks: { version: 1, blocks: [{ type: "text", text: userMessageId }] },
    assistantMessageId,
    assistantBlocks: EMPTY_MESSAGE_BLOCKS,
    assistantModelRef: modelRef,
    createdAt,
  });
}

function createSnapshot(
  id: string,
  conversationId: string,
  userMessageId: string,
  assistantMessageId: string,
  graph: Awaited<ReturnType<typeof seedProviderGraph>>,
  status: RequestSnapshot["status"],
): RequestSnapshot {
  return {
    id,
    conversationId,
    userMessageId,
    assistantMessageId,
    connectionId: graph.connection.id,
    endpointId: graph.endpoint.id,
    modelRef: graph.model.id,
    protocolProfileId: graph.profile.id,
    protocolProfileRevision: graph.profile.revision,
    codecVersion: "fixture-codec/0",
    requestMethod: "POST",
    requestUrl: "https://fixture.invalid:8443/v1/primary/messages",
    requestHeaders: null,
    requestQuery: null,
    requestBody: null,
    params: {},
    contextManifest: { version: 1, items: [] },
    contextHash: `sha256:context-${id}`,
    requestBodyHash: `sha256:body-${id}`,
    retryPolicy: { mode: "none" },
    attemptCount: 0,
    providerAnchor: null,
    status,
    finishReason: null,
    errorCode: null,
    startedAt: FIXTURE_TIME + 10,
    firstEventAt: null,
    completedAt: null,
  };
}
