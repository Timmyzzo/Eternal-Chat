// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime, type ApplicationRuntime } from "@/application/chat/runtime";
import { ContextAssembler } from "@/application/context/contextAssembler";
import type { Conversation } from "@/domain/chat";
import { Phase3Repository } from "@/infrastructure/db/phase3Repository";
import { initializePersistence } from "@/infrastructure/db/startup";
import { FakeDesktopBridge } from "@/infrastructure/desktop/fakeDesktopBridge";
import { OPENAI_CHAT_COMPLETIONS_PROFILE_ID } from "@/infrastructure/providers/openai/protocolProfiles";
import { createTempDatabase, type TempDatabaseFixture } from "@/test/database/tempDatabase";

describe("Phase 5 SQLite chat lifecycle", () => {
  let bridge: FakeDesktopBridge;
  let fixture: TempDatabaseFixture;
  let repository: Phase3Repository;

  beforeEach(async () => {
    fixture = await createTempDatabase();
    repository = new Phase3Repository(fixture.database);
    bridge = new FakeDesktopBridge();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("regenerates an assistant sibling with a new snapshot and one active leaf", async () => {
    const { conversation, runtime } = await createConfiguredRuntime(
      repository,
      bridge,
      "regenerate",
    );
    const first = await runtime.service.sendMessage(conversation.id, "Regenerate this response");
    await waitForStarted(bridge, first.dispatch.transportRequest.requestId);
    finishChatRequest(
      bridge,
      first.dispatch.transportRequest.requestId,
      "response-original",
      "original answer",
    );
    await runtime.registry.whenTerminal(first.dispatch.transportRequest.requestId);

    const regenerated = await runtime.service.regenerate(first.dispatch.assistantPlaceholder.id);
    await waitForStarted(bridge, regenerated.dispatch.transportRequest.requestId);

    expect(regenerated.dispatch.userMessage.id).toBe(first.dispatch.userMessage.id);
    expect(regenerated.dispatch.assistantPlaceholder.id).not.toBe(
      first.dispatch.assistantPlaceholder.id,
    );
    expect(regenerated.dispatch.requestSnapshot.id).not.toBe(first.dispatch.requestSnapshot.id);
    expect((await repository.getConversation(conversation.id))?.activeLeafMessageId).toBe(
      regenerated.dispatch.assistantPlaceholder.id,
    );

    finishChatRequest(
      bridge,
      regenerated.dispatch.transportRequest.requestId,
      "response-regenerated",
      "regenerated answer",
    );
    await runtime.registry.whenTerminal(regenerated.dispatch.transportRequest.requestId);

    const activeBranch = await runtime.service.loadConversationMessages(conversation.id);
    expect(activeBranch.map((message) => message.id)).toEqual([
      first.dispatch.userMessage.id,
      regenerated.dispatch.assistantPlaceholder.id,
    ]);
    expect(activeBranch.at(-1)).toMatchObject({
      role: "assistant",
      status: "done",
      providerResponseId: "response-regenerated",
    });

    const messageCounts = await fixture.database.select<{ count: number; role: string }>(
      `SELECT role, COUNT(*) AS count
      FROM message
      WHERE conversation_id = ? AND role <> 'root'
      GROUP BY role
      ORDER BY role`,
      [conversation.id],
    );
    expect(messageCounts).toEqual([
      { role: "assistant", count: 2 },
      { role: "user", count: 1 },
    ]);
    const snapshotCount = await fixture.database.select<{ count: number }>(
      "SELECT COUNT(*) AS count FROM request_snapshot WHERE conversation_id = ?",
      [conversation.id],
    );
    const requestAttemptCount = await fixture.database.select<{ count: number }>(
      `SELECT COUNT(*) AS count
      FROM request_attempt
      WHERE request_snapshot_id IN (
        SELECT id FROM request_snapshot WHERE conversation_id = ?
      )`,
      [conversation.id],
    );
    expect(snapshotCount[0]?.count).toBe(2);
    expect(requestAttemptCount[0]?.count).toBe(2);
    expect(
      await runtime.service.getSnapshotForAssistant(first.dispatch.assistantPlaceholder.id),
    ).toMatchObject({ id: first.dispatch.requestSnapshot.id, status: "done", attemptCount: 1 });
    expect(
      await runtime.service.getSnapshotForAssistant(regenerated.dispatch.assistantPlaceholder.id),
    ).toMatchObject({
      id: regenerated.dispatch.requestSnapshot.id,
      status: "done",
      attemptCount: 1,
    });
  });

  it("continues after detach and remains readable from SQLite after restart", async () => {
    const { conversation, runtime, selection } = await createConfiguredRuntime(
      repository,
      bridge,
      "background",
    );
    const sent = await runtime.service.sendMessage(conversation.id, "Complete in the background");
    const requestId = sent.dispatch.transportRequest.requestId;
    await waitForStarted(bridge, requestId);

    const detachedStatuses: string[] = [];
    const detach = runtime.registry.subscribe(requestId, (state) => {
      detachedStatuses.push(state.status);
    });
    detach();
    const otherConversation = await runtime.service.createConversation(
      "Another conversation",
      selection.model.id,
    );
    expect(await runtime.service.loadConversationMessages(otherConversation.id)).toEqual([]);

    finishChatRequest(bridge, requestId, "response-background", "background answer");
    const terminal = await runtime.registry.whenTerminal(requestId);

    expect(terminal.status).toBe("done");
    expect(detachedStatuses).toEqual(["pending"]);
    expect(bridge.cancelledRequestIds).toEqual([]);
    const reattachedStatuses: string[] = [];
    runtime.registry.subscribe(requestId, (state) => {
      reattachedStatuses.push(state.status);
    });
    expect(reattachedStatuses).toEqual(["done"]);
    expect((await runtime.service.loadConversationMessages(conversation.id)).at(-1)).toMatchObject({
      role: "assistant",
      status: "done",
      providerResponseId: "response-background",
    });

    const restartedRepository = await initializePersistence(
      Date.now(),
      async () => fixture.database,
    );
    const restartedRuntime = await createApplicationRuntime(restartedRepository, bridge);
    expect(
      (await restartedRuntime.service.loadConversationMessages(conversation.id)).at(-1),
    ).toMatchObject({
      role: "assistant",
      status: "done",
      providerResponseId: "response-background",
    });
  });

  it("edits a user message into a new branch without overwriting its descendants", async () => {
    const { conversation, runtime } = await createConfiguredRuntime(repository, bridge, "edit");
    const first = await runtime.service.sendMessage(conversation.id, "Original user text");
    await waitForStarted(bridge, first.dispatch.transportRequest.requestId);
    finishChatRequest(
      bridge,
      first.dispatch.transportRequest.requestId,
      "response-edit-1",
      "first",
    );
    await runtime.registry.whenTerminal(first.dispatch.transportRequest.requestId);

    const descendant = await runtime.service.sendMessage(conversation.id, "Original descendant");
    await waitForStarted(bridge, descendant.dispatch.transportRequest.requestId);
    finishChatRequest(
      bridge,
      descendant.dispatch.transportRequest.requestId,
      "response-edit-2",
      "descendant answer",
    );
    await runtime.registry.whenTerminal(descendant.dispatch.transportRequest.requestId);

    const edited = await runtime.service.editUserMessage(
      first.dispatch.userMessage.id,
      "Edited user text",
    );
    await waitForStarted(bridge, edited.dispatch.transportRequest.requestId);
    expect(edited.dispatch.userMessage).toMatchObject({
      parentId: first.dispatch.userMessage.parentId,
      siblingOrder: 1,
    });
    expect(edited.dispatch.userMessage.id).not.toBe(first.dispatch.userMessage.id);
    const editedContext = JSON.stringify(edited.dispatch.canonicalContext);
    expect(editedContext).toContain("Edited user text");
    expect(editedContext).not.toContain("Original user text");
    expect(editedContext).not.toContain("Original descendant");

    finishChatRequest(
      bridge,
      edited.dispatch.transportRequest.requestId,
      "response-edit-3",
      "edited answer",
    );
    await runtime.registry.whenTerminal(edited.dispatch.transportRequest.requestId);

    expect(
      (await runtime.service.loadConversationMessages(conversation.id)).map((value) => value.id),
    ).toEqual([edited.dispatch.userMessage.id, edited.dispatch.assistantPlaceholder.id]);
    expect(await repository.getMessage(first.dispatch.userMessage.id)).toMatchObject({
      blocks: { blocks: [{ type: "text", text: "Original user text" }] },
    });
    expect(await repository.getMessage(descendant.dispatch.assistantPlaceholder.id)).toMatchObject({
      blocks: { blocks: [{ type: "text", text: "descendant answer" }] },
    });

    expect(await runtime.service.switchMessageSibling(edited.dispatch.userMessage.id, -1)).toBe(
      first.dispatch.userMessage.id,
    );
    expect(
      (await runtime.service.loadConversationMessages(conversation.id)).map((value) => value.id),
    ).toEqual([
      first.dispatch.userMessage.id,
      first.dispatch.assistantPlaceholder.id,
      descendant.dispatch.userMessage.id,
      descendant.dispatch.assistantPlaceholder.id,
    ]);
  });

  it("switches assistant siblings and keeps ContextAssembler on the selected path", async () => {
    const { conversation, runtime } = await createConfiguredRuntime(repository, bridge, "switch");
    const first = await runtime.service.sendMessage(conversation.id, "Choose one answer");
    await waitForStarted(bridge, first.dispatch.transportRequest.requestId);
    finishChatRequest(
      bridge,
      first.dispatch.transportRequest.requestId,
      "response-switch-original",
      "original branch answer",
    );
    await runtime.registry.whenTerminal(first.dispatch.transportRequest.requestId);

    const regenerated = await runtime.service.regenerate(first.dispatch.assistantPlaceholder.id);
    await waitForStarted(bridge, regenerated.dispatch.transportRequest.requestId);
    finishChatRequest(
      bridge,
      regenerated.dispatch.transportRequest.requestId,
      "response-switch-regenerated",
      "regenerated branch answer",
    );
    await runtime.registry.whenTerminal(regenerated.dispatch.transportRequest.requestId);

    expect(
      await runtime.service.switchMessageSibling(regenerated.dispatch.assistantPlaceholder.id, -1),
    ).toBe(first.dispatch.assistantPlaceholder.id);
    expect(
      (await runtime.service.loadConversationMessages(conversation.id)).map((value) => value.id),
    ).toEqual([first.dispatch.userMessage.id, first.dispatch.assistantPlaceholder.id]);
    const assembler = new ContextAssembler(repository);
    const originalContext = JSON.stringify(
      await assembler.assemble({
        anchorMessageId: first.dispatch.assistantPlaceholder.id,
        conversationId: conversation.id,
      }),
    );
    expect(originalContext).toContain("original branch answer");
    expect(originalContext).not.toContain("regenerated branch answer");

    expect(
      await runtime.service.switchMessageSibling(first.dispatch.assistantPlaceholder.id, 1),
    ).toBe(regenerated.dispatch.assistantPlaceholder.id);
    const regeneratedContext = JSON.stringify(
      await assembler.assemble({
        anchorMessageId: regenerated.dispatch.assistantPlaceholder.id,
        conversationId: conversation.id,
      }),
    );
    expect(regeneratedContext).toContain("regenerated branch answer");
    expect(regeneratedContext).not.toContain("original branch answer");
  });

  it("allows only one active request per conversation and accepts the next turn after terminal", async () => {
    const { conversation, runtime } = await createConfiguredRuntime(
      repository,
      bridge,
      "single-active",
    );
    const firstPromise = runtime.service.sendMessage(conversation.id, "First active request");

    await expect(
      runtime.service.sendMessage(conversation.id, "Must not create another turn"),
    ).rejects.toThrow("already has an active request");
    const first = await firstPromise;
    await waitForStarted(bridge, first.dispatch.transportRequest.requestId);
    expect(
      await fixture.database.select<{ count: number }>(
        "SELECT COUNT(*) AS count FROM message WHERE conversation_id = ? AND role <> 'root'",
        [conversation.id],
      ),
    ).toEqual([{ count: 2 }]);

    finishChatRequest(
      bridge,
      first.dispatch.transportRequest.requestId,
      "response-first",
      "first answer",
    );
    await runtime.registry.whenTerminal(first.dispatch.transportRequest.requestId);

    const second = await runtime.service.sendMessage(conversation.id, "Second request");
    await waitForStarted(bridge, second.dispatch.transportRequest.requestId);
    finishChatRequest(
      bridge,
      second.dispatch.transportRequest.requestId,
      "response-second",
      "second answer",
    );
    await runtime.registry.whenTerminal(second.dispatch.transportRequest.requestId);
    expect((await runtime.service.loadConversationMessages(conversation.id)).at(-1)).toMatchObject({
      role: "assistant",
      status: "done",
      providerResponseId: "response-second",
    });
  });
});

async function createConfiguredRuntime(
  repository: Phase3Repository,
  bridge: FakeDesktopBridge,
  suffix: string,
): Promise<{
  conversation: Conversation;
  runtime: ApplicationRuntime;
  selection: Awaited<ReturnType<ApplicationRuntime["service"]["createProviderConfiguration"]>>;
}> {
  const runtime = await createApplicationRuntime(repository, bridge);
  const selection = await runtime.service.createProviderConfiguration({
    authBindings: [],
    baseUrl: "https://fixture.invalid/proxy",
    connectionName: `SQLite ${suffix}`,
    explicitPort: null,
    modelDisplayName: `SQLite ${suffix}`,
    modelId: `sqlite-${suffix}`,
    path: "/v1/chat/completions",
    profileId: OPENAI_CHAT_COMPLETIONS_PROFILE_ID,
    timeoutMs: 5_000,
  });
  const conversation = await runtime.service.createConversation(
    `SQLite ${suffix}`,
    selection.model.id,
  );
  return { conversation, runtime, selection };
}

function finishChatRequest(
  bridge: FakeDesktopBridge,
  requestId: string,
  responseId: string,
  text: string,
): void {
  bridge.emit({
    type: "data",
    requestId,
    data: [
      JSON.stringify({
        id: responseId,
        choices: [{ delta: { content: text }, finish_reason: "stop" }],
      }),
      "[DONE]",
    ],
  });
  bridge.emit({ type: "done", requestId });
}

async function waitForStarted(bridge: FakeDesktopBridge, requestId: string): Promise<void> {
  await vi.waitFor(() =>
    expect(bridge.startedRequests.some((request) => request.requestId === requestId)).toBe(true),
  );
}
