import { describe, expect, it } from "vitest";

import { createChatHistoryStore } from "@/app/chatHistoryStore";
import { seedPhase8PerformanceFixture } from "@/application/chat/browserPerformanceFixture";
import { createApplicationRuntime } from "@/application/chat/runtime";
import { BrowserFixtureBridge } from "@/infrastructure/desktop/browserFixtureBridge";
import { InMemoryChatRepository } from "@/infrastructure/db/inMemoryChatRepository";
import { OPENAI_CHAT_COMPLETIONS_PROFILE_ID } from "@/infrastructure/providers/openai/protocolProfiles";
import type { TextBlock } from "@/domain/chat";

describe("Phase 8 deterministic performance fixture", () => {
  it("opens and pages a 1000-message active path within bounded windows", async () => {
    const repository = new InMemoryChatRepository();
    const runtime = await createApplicationRuntime(repository, new BrowserFixtureBridge());
    const selection = await runtime.service.createProviderConfiguration({
      authBindings: [],
      baseUrl: "http://127.0.0.1/phase8-performance",
      connectionName: "Phase 8 performance",
      explicitPort: null,
      modelDisplayName: "Phase 8 performance",
      modelId: "phase8-performance",
      path: "/v1/chat/completions",
      profileId: OPENAI_CHAT_COMPLETIONS_PROFILE_ID,
      timeoutMs: 10_000,
    });

    const seedStartedAt = performance.now();
    const summary = await seedPhase8PerformanceFixture(
      repository,
      runtime.service,
      selection.model.id,
    );
    const seedMs = performance.now() - seedStartedAt;

    const openStartedAt = performance.now();
    const latest = await runtime.service.loadConversationWindow(summary.conversationId);
    const openLatestMs = performance.now() - openStartedAt;
    expect(latest.messages).toHaveLength(50);
    expect(latest.nextCursor).not.toBeNull();
    expect(openLatestMs).toBeLessThan(350);

    const pageStartedAt = performance.now();
    const ids: string[] = [];
    let page = latest;
    while (true) {
      ids.push(...page.messages.map((message) => message.id));
      const cursor = page.nextCursor;
      if (!cursor) break;
      page = await runtime.service.loadConversationWindow(summary.conversationId, cursor);
    }
    const paginateMs = performance.now() - pageStartedAt;

    expect(ids).toHaveLength(1_000);
    expect(new Set(ids)).toHaveLength(1_000);
    expect(summary).toMatchObject({
      activePathMessages: 1_000,
      attachmentBlocks: 4,
      branchMessages: 20,
      codeBlocks: 20,
      longTextCharacters: 50_000,
      thinkingBlocks: 50,
      toolCalls: 100,
      totalMessages: 1_020,
    });

    const longMessage = await repository.getMessage("phase8-assistant-0499");
    const longText = longMessage?.blocks.blocks.find(
      (block): block is TextBlock => block.type === "text" && typeof block.text === "string",
    );
    expect(longText?.text.length ?? 0).toBeGreaterThan(50_000);
    expect(longMessage?.blocks.blocks.filter((block) => block.type === "thinking")).toHaveLength(
      50,
    );
    expect(longMessage?.blocks.blocks.filter((block) => block.type === "tool_call")).toHaveLength(
      100,
    );
    expect(
      longMessage?.blocks.blocks.filter((block) => block.type === "file" || block.type === "image"),
    ).toHaveLength(4);

    const historyStore = createChatHistoryStore();
    historyStore.getState().setWindow(latest);
    let olderCursor = latest.nextCursor;
    while (olderCursor) {
      const older = await runtime.service.loadConversationWindow(
        summary.conversationId,
        olderCursor,
      );
      historyStore.getState().prependWindow(older);
      olderCursor = older.nextCursor;
    }
    expect(historyStore.getState().order).toHaveLength(300);
    expect(historyStore.getState().atLatest).toBe(false);

    console.info(
      "Phase 8 performance metrics",
      JSON.stringify({
        activePathMessages: ids.length,
        loadedMessages: historyStore.getState().order.length,
        openLatestMs: Number(openLatestMs.toFixed(2)),
        paginateMs: Number(paginateMs.toFixed(2)),
        seedMs: Number(seedMs.toFixed(2)),
        terminalRegistry: runtime.registry.diagnostics(),
      }),
    );
  }, 20_000);
});
