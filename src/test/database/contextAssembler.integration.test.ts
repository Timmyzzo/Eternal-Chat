// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApplicationRuntime } from "@/application/chat/runtime";
import { ContextAssembler, preflightLosslessBudget } from "@/application/context/contextAssembler";
import type { Conversation, MessageBlocks } from "@/domain/chat";
import {
  Phase3Repository,
  rootMessageId,
  type PendingTurn,
} from "@/infrastructure/db/phase3Repository";
import { FakeDesktopBridge } from "@/infrastructure/desktop/fakeDesktopBridge";
import { FIXTURE_TIME, seedProviderGraph } from "@/test/database/phase3Seed";
import { createTempDatabase, type TempDatabaseFixture } from "@/test/database/tempDatabase";

describe("ContextAssembler SQLite integration", () => {
  let fixture: TempDatabaseFixture;
  let repository: Phase3Repository;
  let assembler: ContextAssembler;

  beforeEach(async () => {
    fixture = await createTempDatabase();
    repository = new Phase3Repository(fixture.database);
    assembler = new ContextAssembler(repository);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("reads the selected branch root-to-leaf while excluding first-turn and deep siblings", async () => {
    const conversation = await createConversation(repository, "conversation-branch");
    const rootId = rootMessageId(conversation.id);
    const firstBranch = await createTurn(
      repository,
      conversation.id,
      rootId,
      "first-a-user",
      "first-a-assistant",
      FIXTURE_TIME + 1,
    );
    await finishAssistant(repository, firstBranch.assistantMessage.id, "first-a-only", 2);
    const selectedFirst = await createTurn(
      repository,
      conversation.id,
      rootId,
      "first-b-user",
      "first-b-assistant",
      FIXTURE_TIME + 3,
    );
    await finishAssistant(repository, selectedFirst.assistantMessage.id, "selected-first", 4);
    const deep = await createTurn(
      repository,
      conversation.id,
      selectedFirst.assistantMessage.id,
      "deep-user",
      "deep-assistant-a",
      FIXTURE_TIME + 5,
    );
    await finishAssistant(repository, deep.assistantMessage.id, "deep-a-only", 6);
    const selectedDeep = await repository.createAssistantSibling({
      conversationId: conversation.id,
      parentUserMessageId: deep.userMessage.id,
      assistantMessageId: "deep-assistant-b",
      assistantBlocks: { version: 1, blocks: [] },
      assistantModelRef: null,
      createdAt: FIXTURE_TIME + 7,
    });
    await finishAssistant(repository, selectedDeep.id, "selected-deep", 8);

    const rawChain = await repository.readMessageParentChain(selectedDeep.id);
    expect(rawChain.messages.map((message) => message.id)).toEqual([
      selectedDeep.id,
      deep.userMessage.id,
      selectedFirst.assistantMessage.id,
      selectedFirst.userMessage.id,
      rootId,
    ]);
    const context = await assembler.assemble({
      anchorMessageId: selectedDeep.id,
      conversationId: conversation.id,
    });
    const selectedIds = context.turns.map((turn) => turn.messageId);

    expect(selectedIds).toEqual([
      selectedFirst.userMessage.id,
      selectedFirst.assistantMessage.id,
      deep.userMessage.id,
      selectedDeep.id,
    ]);
    expect(selectedIds).not.toContain(rootId);
    expect(selectedIds).not.toContain(firstBranch.userMessage.id);
    expect(selectedIds).not.toContain(firstBranch.assistantMessage.id);
    expect(selectedIds).not.toContain(deep.assistantMessage.id);
  });

  it("reads all 500 database messages while the application UI window contains only 50", async () => {
    const graph = await seedProviderGraph(repository, "history-budget");
    await fixture.database.execute(
      "UPDATE model SET context_window = 5000, max_output_tokens = 100 WHERE id = ?",
      [graph.model.id],
    );
    const conversation = await createConversation(
      repository,
      "conversation-500",
      FIXTURE_TIME,
      graph.model.id,
    );
    const expectedIds: string[] = [];
    let parentId = rootMessageId(conversation.id);

    fixture.database.execScript("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 250; index += 1) {
        const suffix = index.toString().padStart(3, "0");
        const turn = await createTurn(
          repository,
          conversation.id,
          parentId,
          `history-user-${suffix}`,
          `history-assistant-${suffix}`,
          FIXTURE_TIME + index + 1,
        );
        await finishAssistant(repository, turn.assistantMessage.id, `answer-${suffix}`, index + 1);
        expectedIds.push(turn.userMessage.id, turn.assistantMessage.id);
        parentId = turn.assistantMessage.id;
      }
      fixture.database.execScript("COMMIT");
    } catch (error) {
      fixture.database.execScript("ROLLBACK");
      throw error;
    }

    const runtime = await createApplicationRuntime(repository, new FakeDesktopBridge());
    const uiWindow = await runtime.service.loadConversationMessages(conversation.id);
    expect(uiWindow).toHaveLength(50);
    expect(uiWindow.map((message) => message.id)).toEqual(expectedIds.slice(-50));
    expect(uiWindow.map((message) => message.id)).not.toContain(expectedIds[0]);
    expect((await runtime.service.preflightMessage(conversation.id, "next message")).status).toBe(
      "over_limit",
    );
    const databaseBefore = await messageStorageFingerprint(fixture, conversation.id);
    const context = await assembler.assemble({
      anchorMessageId: parentId,
      conversationId: conversation.id,
    });
    const contextBeforeBudget = structuredClone(context);

    expect(
      preflightLosslessBudget({
        contextWindow: 4_096,
        estimatedInputTokens: 3_700,
        reservedOutputTokens: 200,
      }).status,
    ).toBe("risk");
    expect(context).toEqual(contextBeforeBudget);
    expect(await messageStorageFingerprint(fixture, conversation.id)).toEqual(databaseBefore);

    const actualIds = context.turns.map((turn) => turn.messageId);
    expect(actualIds).toEqual(expectedIds);
    expect(actualIds).toHaveLength(500);
    expect(new Set(actualIds)).toHaveLength(500);
    expect(context.manifest.items).toHaveLength(500);
    expect(actualIds).not.toContain(rootMessageId(conversation.id));
  }, 15_000);

  it("returns stable errors for a missing conversation or anchor from another conversation", async () => {
    const first = await createConversation(repository, "conversation-anchor-a");
    const second = await createConversation(repository, "conversation-anchor-b");
    const foreign = await createTurn(
      repository,
      second.id,
      rootMessageId(second.id),
      "foreign-user",
      "foreign-assistant",
      FIXTURE_TIME + 1,
    );

    await expect(
      assembler.assemble({ anchorMessageId: "missing", conversationId: "missing-conversation" }),
    ).rejects.toMatchObject({ code: "context_conversation_not_found" });
    await expect(
      assembler.assemble({ anchorMessageId: "missing", conversationId: first.id }),
    ).rejects.toMatchObject({ code: "context_anchor_not_found" });
    await expect(
      assembler.assemble({ anchorMessageId: foreign.userMessage.id, conversationId: first.id }),
    ).rejects.toMatchObject({ code: "context_anchor_cross_conversation" });
    await expect(
      assembler.assemble({ anchorMessageId: rootMessageId(first.id), conversationId: first.id }),
    ).rejects.toMatchObject({ code: "context_anchor_is_virtual_root" });
  });

  it("rejects a missing parent in a damaged SQLite chain", async () => {
    const { conversation, turn } = await seedOneTurn(repository, "conversation-missing-parent");
    fixture.database.execScript(
      "DROP TRIGGER trg_message_parent_update; PRAGMA foreign_keys = OFF;",
    );
    await fixture.database.execute("UPDATE message SET parent_id = ? WHERE id = ?", [
      "missing-parent-id",
      turn.userMessage.id,
    ]);

    await expect(
      assembler.assemble({
        anchorMessageId: turn.assistantMessage.id,
        conversationId: conversation.id,
      }),
    ).rejects.toMatchObject({ code: "context_parent_missing" });
  });

  it("rejects a cycle in a damaged SQLite chain", async () => {
    const { conversation, turn } = await seedOneTurn(repository, "conversation-cycle");
    fixture.database.execScript("DROP TRIGGER trg_message_parent_update;");
    await fixture.database.execute("UPDATE message SET parent_id = ? WHERE id = ?", [
      turn.assistantMessage.id,
      turn.userMessage.id,
    ]);

    await expect(
      assembler.assemble({
        anchorMessageId: turn.assistantMessage.id,
        conversationId: conversation.id,
      }),
    ).rejects.toMatchObject({ code: "context_parent_cycle" });
  });

  it("rejects a parent chain that crosses into another conversation", async () => {
    const first = await seedOneTurn(repository, "conversation-cross-a");
    const second = await seedOneTurn(repository, "conversation-cross-b", FIXTURE_TIME + 10);
    fixture.database.execScript("DROP TRIGGER trg_message_parent_update;");
    await fixture.database.execute("UPDATE message SET parent_id = ? WHERE id = ?", [
      second.turn.assistantMessage.id,
      first.turn.userMessage.id,
    ]);

    await expect(
      assembler.assemble({
        anchorMessageId: first.turn.assistantMessage.id,
        conversationId: first.conversation.id,
      }),
    ).rejects.toMatchObject({ code: "context_parent_cross_conversation" });
  });

  it("rejects a chain that terminates before the conversation virtual root", async () => {
    const { conversation, turn } = await seedOneTurn(repository, "conversation-unreachable-root");
    fixture.database.execScript(
      `DROP TRIGGER trg_message_parent_update;
      DROP INDEX idx_message_one_root_per_conversation;
      PRAGMA ignore_check_constraints = ON;`,
    );
    await fixture.database.execute("UPDATE message SET parent_id = NULL WHERE id = ?", [
      turn.userMessage.id,
    ]);

    await expect(
      assembler.assemble({
        anchorMessageId: turn.assistantMessage.id,
        conversationId: conversation.id,
      }),
    ).rejects.toMatchObject({ code: "context_root_unreachable" });
  });

  it("rejects a damaged virtual root instead of treating it as context", async () => {
    const { conversation, turn } = await seedOneTurn(repository, "conversation-damaged-root");
    fixture.database.execScript(
      "DROP TRIGGER trg_message_root_immutable; PRAGMA ignore_check_constraints = ON;",
    );
    await fixture.database.execute("UPDATE message SET blocks_json = ? WHERE id = ?", [
      JSON.stringify({ version: 1, blocks: [{ type: "text", text: "damaged" }] }),
      rootMessageId(conversation.id),
    ]);

    await expect(
      assembler.assemble({
        anchorMessageId: turn.assistantMessage.id,
        conversationId: conversation.id,
      }),
    ).rejects.toMatchObject({ code: "context_invalid_virtual_root" });
  });
});

async function seedOneTurn(
  repository: Phase3Repository,
  conversationId: string,
  createdAt = FIXTURE_TIME,
): Promise<{ conversation: Conversation; turn: PendingTurn }> {
  const conversation = await createConversation(repository, conversationId, createdAt);
  const turn = await createTurn(
    repository,
    conversation.id,
    rootMessageId(conversation.id),
    `${conversationId}-user`,
    `${conversationId}-assistant`,
    createdAt + 1,
  );
  await finishAssistant(repository, turn.assistantMessage.id, "complete", 2);
  return { conversation, turn };
}

async function createConversation(
  repository: Phase3Repository,
  id: string,
  createdAt = FIXTURE_TIME,
  modelRef: string | null = null,
): Promise<Conversation> {
  return repository.createConversation({
    id,
    title: "Context integration fixture",
    modelRef,
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
    createdAt,
    updatedAt: createdAt,
  });
}

function createTurn(
  repository: Phase3Repository,
  conversationId: string,
  parentId: string,
  userMessageId: string,
  assistantMessageId: string,
  createdAt: number,
): Promise<PendingTurn> {
  return repository.createPendingTurn({
    conversationId,
    parentId,
    userMessageId,
    userBlocks: { version: 1, blocks: [{ type: "text", text: userMessageId }] },
    assistantMessageId,
    assistantBlocks: { version: 1, blocks: [] },
    assistantModelRef: null,
    createdAt,
  });
}

function finishAssistant(
  repository: Phase3Repository,
  assistantMessageId: string,
  text: string,
  timeOffset: number,
): Promise<void> {
  const blocks: MessageBlocks = { version: 1, blocks: [{ type: "text", text }] };
  return repository.updateMessage(assistantMessageId, "done", blocks, FIXTURE_TIME + timeOffset);
}

async function messageStorageFingerprint(
  fixture: TempDatabaseFixture,
  conversationId: string,
): Promise<{ count: number; totalBytes: number }> {
  const row = (
    await fixture.database.select<{ count: number; total_bytes: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(length(blocks_json)), 0) AS total_bytes
      FROM message WHERE conversation_id = ?`,
      [conversationId],
    )
  )[0];
  return { count: row?.count ?? 0, totalBytes: row?.total_bytes ?? 0 };
}
