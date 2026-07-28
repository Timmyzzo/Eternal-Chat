import { describe, expect, it } from "vitest";

import { createChatHistoryStore } from "@/app/chatHistoryStore";
import type { ConversationMessageWindow } from "@/application/chat/chatService";
import type { Message } from "@/domain/chat";

describe("chatHistoryStore", () => {
  it("caps replacement windows at the latest 300 messages", () => {
    const store = createChatHistoryStore();
    store.getState().setWindow(windowFor(range(0, 350)));

    const state = store.getState();
    expect(state.order).toHaveLength(300);
    expect(state.order[0]).toBe("message-50");
    expect(state.order.at(-1)).toBe("message-349");
    expect(Object.keys(state.byId)).toHaveLength(300);
    expect(Object.keys(state.siblingById)).toHaveLength(300);
  });

  it("moves into an older bounded window when prepending past the cap", () => {
    const store = createChatHistoryStore();
    store.getState().setWindow(windowFor(range(100, 398)));
    store.getState().prependWindow(windowFor(range(50, 100), { createdAt: 50, id: "message-50" }));

    const state = store.getState();
    expect(state.order).toHaveLength(300);
    expect(state.order[0]).toBe("message-50");
    expect(state.order.at(-1)).toBe("message-349");
    expect(state.atLatest).toBe(false);
    expect(state.nextCursor).toEqual({ createdAt: 50, id: "message-50" });
    expect(state.byId["message-397"]).toBeUndefined();
  });

  it("keeps only the latest 300 entries and sibling metadata when appending", () => {
    const store = createChatHistoryStore();
    store.getState().setWindow(windowFor(range(0, 300)));
    store.getState().appendMessage(message(300));

    const state = store.getState();
    expect(state.order[0]).toBe("message-1");
    expect(state.order.at(-1)).toBe("message-300");
    expect(state.byId["message-0"]).toBeUndefined();
    expect(state.siblingById["message-0"]).toBeUndefined();
    expect(state.atLatest).toBe(true);
  });
});

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, index) => start + index);
}

function windowFor(
  indexes: number[],
  nextCursor: ConversationMessageWindow["nextCursor"] = null,
): ConversationMessageWindow {
  return {
    messages: indexes.map(message),
    nextCursor,
    siblings: indexes.map((index) => ({
      index: 0,
      messageId: `message-${index}`,
      siblingIds: [`message-${index}`],
    })),
  };
}

function message(index: number): Message {
  return {
    id: `message-${index}`,
    conversationId: "conversation-history",
    role: index % 2 === 0 ? "user" : "assistant",
    blocks: { version: 1, blocks: [{ type: "text", text: `Message ${index}` }] },
    status: "done",
    usage: null,
    modelRef: "model-history",
    parentId: index === 0 ? "conversation-history:root" : `message-${index - 1}`,
    siblingOrder: 0,
    providerResponseId: null,
    providerPreviousResponseId: null,
    requestSnapshotId: null,
    createdAt: index,
    updatedAt: index,
  };
}
