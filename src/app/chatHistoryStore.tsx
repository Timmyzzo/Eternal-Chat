/* eslint-disable react-refresh/only-export-components -- The provider and its vanilla store share one context. */
import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { ConversationMessageWindow } from "@/application/chat/chatService";
import type { Message, MessageCursor, MessageSiblingInfo } from "@/domain/chat";

const MAX_HISTORY_WINDOW = 300;

interface ChatHistoryState {
  atLatest: boolean;
  byId: Record<string, Message>;
  nextCursor: MessageCursor | null;
  order: string[];
  siblingById: Record<string, MessageSiblingInfo>;
  appendMessage(message: Message): void;
  clear(): void;
  prependWindow(window: ConversationMessageWindow): void;
  setWindow(window: ConversationMessageWindow): void;
}

export type ChatHistoryStore = StoreApi<ChatHistoryState>;

const ChatHistoryContext = createContext<ChatHistoryStore | null>(null);

export function createChatHistoryStore(): ChatHistoryStore {
  return createStore<ChatHistoryState>((set) => ({
    atLatest: true,
    byId: {},
    nextCursor: null,
    order: [],
    siblingById: {},
    appendMessage(message) {
      set((state) => {
        const exists = Object.prototype.hasOwnProperty.call(state.byId, message.id);
        const order = exists
          ? state.order
          : [...state.order, message.id].slice(-MAX_HISTORY_WINDOW);
        const retained = new Set(order);
        const mergedById: Record<string, Message> = { ...state.byId, [message.id]: message };
        return {
          atLatest: true,
          byId: Object.fromEntries(Object.entries(mergedById).filter(([id]) => retained.has(id))),
          order,
          siblingById: Object.fromEntries(
            Object.entries(state.siblingById).filter(([id]) => retained.has(id)),
          ),
        };
      });
    },
    clear() {
      set({ atLatest: true, byId: {}, nextCursor: null, order: [], siblingById: {} });
    },
    prependWindow(window) {
      set((state) => {
        const incomingIds = window.messages
          .map((message) => message.id)
          .filter((id) => !Object.prototype.hasOwnProperty.call(state.byId, id));
        const combined = [...incomingIds, ...state.order];
        const order = combined.slice(0, MAX_HISTORY_WINDOW);
        const retained = new Set(order);
        const incoming: Record<string, Message> = Object.fromEntries(
          window.messages.map((message) => [message.id, message]),
        );
        const mergedSiblingById: Record<string, MessageSiblingInfo> = {
          ...state.siblingById,
          ...Object.fromEntries(window.siblings.map((info) => [info.messageId, info])),
        };
        const siblingById = Object.fromEntries(
          Object.entries(mergedSiblingById).filter(([id]) => retained.has(id)),
        );
        return {
          atLatest: combined.length <= MAX_HISTORY_WINDOW && state.atLatest,
          byId: Object.fromEntries(
            [...Object.entries(incoming), ...Object.entries(state.byId)].filter(([id]) =>
              retained.has(id),
            ),
          ),
          nextCursor: window.nextCursor,
          order,
          siblingById,
        };
      });
    },
    setWindow(window) {
      const messages = window.messages.slice(-MAX_HISTORY_WINDOW);
      const retained = new Set(messages.map((message) => message.id));
      set({
        atLatest: true,
        byId: Object.fromEntries(messages.map((message) => [message.id, message])),
        nextCursor: window.nextCursor,
        order: messages.map((message) => message.id),
        siblingById: Object.fromEntries(
          window.siblings
            .filter((info) => retained.has(info.messageId))
            .map((info) => [info.messageId, info]),
        ),
      });
    },
  }));
}

export function ChatHistoryProvider({
  children,
  store,
}: {
  children: ReactNode;
  store: ChatHistoryStore;
}) {
  return <ChatHistoryContext.Provider value={store}>{children}</ChatHistoryContext.Provider>;
}

export function useChatHistory<T>(selector: (state: ChatHistoryState) => T): T {
  const store = useContext(ChatHistoryContext);
  if (!store) {
    throw new Error("useChatHistory must be used inside ChatHistoryProvider");
  }
  return useStore(store, selector);
}
