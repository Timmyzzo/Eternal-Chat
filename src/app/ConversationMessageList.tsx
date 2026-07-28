import { ArrowDown, ChevronUp, LoaderCircle } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VList, type VListHandle } from "virtua";

import { useChatHistory } from "@/app/chatHistoryStore";
import { HistoricalMessage, StreamingMessage } from "@/app/MessageView";
import { Button } from "@/components/ui/button";
import type { StreamingMessageState } from "@/domain/streaming";

const STREAM_ITEM_ID = "__eternal_chat_streaming_message__";
const BOTTOM_THRESHOLD_PX = 72;

interface ConversationMessageListProps {
  activeState: StreamingMessageState | null;
  conversationId: string;
  focusMessageId: string | null;
  loadingOlder: boolean;
  onEdit: (messageId: string, text: string) => void;
  onFocusHandled: () => void;
  onLoadOlder: () => Promise<void>;
  onOpenExternal: (url: string) => void;
  onRegenerate: (messageId: string) => void;
  onReturnLatest: () => Promise<void>;
  onStop?: () => void;
  onSwitchSibling: (messageId: string, direction: -1 | 1) => void;
}

export function ConversationMessageList({
  activeState,
  conversationId,
  focusMessageId,
  loadingOlder,
  onEdit,
  onFocusHandled,
  onLoadOlder,
  onOpenExternal,
  onRegenerate,
  onReturnLatest,
  onStop,
  onSwitchSibling,
}: ConversationMessageListProps) {
  const order = useChatHistory((state) => state.order);
  const nextCursor = useChatHistory((state) => state.nextCursor);
  const atLatestWindow = useChatHistory((state) => state.atLatest);
  const historyConversationId = useChatHistory((state) => {
    const firstMessageId = state.order[0];
    return firstMessageId ? (state.byId[firstMessageId]?.conversationId ?? null) : null;
  });
  const prefersReducedMotion = useReducedMotion();
  const listRef = useRef<VListHandle>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const animationFrames = useRef(new Set<number>());
  const mounted = useRef(true);
  const initializedConversation = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const previousEventSeq = useRef<number | null>(null);
  const stickToBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [unreadUpdates, setUnreadUpdates] = useState(0);
  const hasActiveState = activeState !== null;
  const items = useMemo(
    () => (hasActiveState ? [...order, STREAM_ITEM_ID] : order),
    [hasActiveState, order],
  );
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const scheduleAnimationFrame = useCallback((callback: () => void) => {
    if (!mounted.current) return -1;
    let frame = 0;
    frame = window.requestAnimationFrame(() => {
      animationFrames.current.delete(frame);
      callback();
    });
    animationFrames.current.add(frame);
    return frame;
  }, []);

  const cancelScheduledAnimationFrame = useCallback((frame: number) => {
    if (frame < 0) return;
    animationFrames.current.delete(frame);
    window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const frames = animationFrames.current;
    return () => {
      mounted.current = false;
      frames.forEach((frame) => window.cancelAnimationFrame(frame));
      frames.clear();
    };
  }, []);

  const scrollToBottom = useCallback(
    (smooth = false) => {
      const index = items.length - 1;
      if (index < 0) return;
      stickToBottomRef.current = true;
      listRef.current?.scrollToIndex(index, {
        align: "end",
        smooth: smooth && !prefersReducedMotion,
      });
      setAtBottom(true);
      setUnreadUpdates(0);
    },
    [items.length, prefersReducedMotion],
  );

  const loadOlder = useCallback(async () => {
    if (!nextCursor || loadingRef.current || loadingOlder) return;
    const preserveBottom = stickToBottomRef.current;
    const handle = listRef.current;
    const visibleAnchor = findVisibleAnchor(sectionRef.current);
    const fallbackIndex = handle?.findItemIndex(handle.scrollOffset) ?? -1;
    const anchorId = visibleAnchor?.messageId ?? items[fallbackIndex] ?? null;
    const anchorOffset =
      visibleAnchor?.offset ??
      (handle && fallbackIndex >= 0
        ? handle.getItemOffset(fallbackIndex) - handle.scrollOffset
        : 0);
    loadingRef.current = true;
    try {
      await onLoadOlder();
    } finally {
      scheduleAnimationFrame(() => {
        scheduleAnimationFrame(() => {
          const nextHandle = listRef.current;
          const nextIndex = anchorId ? itemsRef.current.indexOf(anchorId) : -1;
          if (preserveBottom) {
            scrollToBottom(false);
          } else if (nextHandle && nextIndex >= 0 && Number.isFinite(anchorOffset)) {
            nextHandle.scrollTo(nextHandle.getItemOffset(nextIndex) - anchorOffset);
          }
          loadingRef.current = false;
        });
      });
    }
  }, [items, loadingOlder, nextCursor, onLoadOlder, scheduleAnimationFrame, scrollToBottom]);

  const handleScroll = useCallback(
    (offset: number) => {
      const handle = listRef.current;
      if (!handle) return;
      const distanceFromBottom = handle.scrollSize - handle.viewportSize - offset;
      const nextAtBottom = distanceFromBottom <= BOTTOM_THRESHOLD_PX;
      setAtBottom(nextAtBottom);
      if (nextAtBottom) {
        stickToBottomRef.current = true;
        setUnreadUpdates(0);
      }
      if (
        initializedConversation.current === conversationId &&
        offset < BOTTOM_THRESHOLD_PX &&
        nextCursor
      ) {
        void loadOlder();
      }
    },
    [conversationId, loadOlder, nextCursor],
  );

  useEffect(() => {
    if (
      initializedConversation.current === conversationId ||
      historyConversationId !== conversationId ||
      items.length === 0
    ) {
      return;
    }
    initializedConversation.current = conversationId;
    stickToBottomRef.current = true;
    previousEventSeq.current = activeState?.eventSeq ?? null;
    const frame = scheduleAnimationFrame(() => scrollToBottom(false));
    return () => cancelScheduledAnimationFrame(frame);
  }, [
    activeState?.eventSeq,
    cancelScheduledAnimationFrame,
    conversationId,
    historyConversationId,
    items.length,
    scheduleAnimationFrame,
    scrollToBottom,
  ]);

  useEffect(() => {
    if (!activeState) {
      previousEventSeq.current = null;
      return;
    }
    const previous = previousEventSeq.current;
    previousEventSeq.current = activeState.eventSeq;
    if (previous === null || previous === activeState.eventSeq) return;
    if (atBottom) {
      const frame = scheduleAnimationFrame(() => scrollToBottom(false));
      return () => cancelScheduledAnimationFrame(frame);
    }
    setUnreadUpdates((current) => current + 1);
  }, [
    activeState,
    atBottom,
    cancelScheduledAnimationFrame,
    scheduleAnimationFrame,
    scrollToBottom,
  ]);

  const handleLatestContentRendered = useCallback(() => {
    if (!stickToBottomRef.current) return;
    scheduleAnimationFrame(() => scrollToBottom(false));
  }, [scheduleAnimationFrame, scrollToBottom]);

  useEffect(() => {
    if (!focusMessageId) return;
    const index = order.indexOf(focusMessageId);
    if (index < 0) return;
    listRef.current?.scrollToIndex(index, {
      align: "center",
      smooth: !prefersReducedMotion,
    });
    const timer = window.setTimeout(
      () => {
        const target = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].find(
          (element) => element.dataset.messageId === focusMessageId,
        );
        target?.focus({ preventScroll: true });
        onFocusHandled();
      },
      prefersReducedMotion ? 0 : 80,
    );
    return () => window.clearTimeout(timer);
  }, [focusMessageId, onFocusHandled, order, prefersReducedMotion]);

  const returnLatest = async () => {
    if (!atLatestWindow) {
      await onReturnLatest();
    }
    scheduleAnimationFrame(() => scrollToBottom(true));
  };

  return (
    <section
      className="message-list"
      data-ui="chat.message-list"
      onKeyDownCapture={(event) => {
        if (["ArrowUp", "Home", "PageUp"].includes(event.key)) stickToBottomRef.current = false;
      }}
      onPointerDownCapture={(event) => {
        const target = event.target;
        if (target instanceof Element && target.classList.contains("message-virtual-list")) {
          stickToBottomRef.current = false;
        }
      }}
      onTouchMoveCapture={() => {
        stickToBottomRef.current = false;
      }}
      onWheelCapture={(event) => {
        if (event.deltaY < 0) stickToBottomRef.current = false;
      }}
      ref={sectionRef}
    >
      {nextCursor ? (
        <Button
          aria-label="Load earlier messages"
          className="history-load-button"
          disabled={loadingOlder}
          onClick={() => void loadOlder()}
          type="button"
          variant="outline"
        >
          {loadingOlder ? (
            <LoaderCircle aria-hidden="true" className="size-3 history-load-spinner" />
          ) : (
            <ChevronUp aria-hidden="true" className="size-3" />
          )}
          Earlier
        </Button>
      ) : null}
      <VList
        aria-label="Conversation messages"
        bufferSize={560}
        className="message-virtual-list"
        data={items}
        itemSize={132}
        onScroll={handleScroll}
        ref={listRef}
        ssrCount={Math.min(items.length, 51)}
      >
        {(itemId) =>
          itemId === STREAM_ITEM_ID && activeState ? (
            <div className="message-stack" key={STREAM_ITEM_ID}>
              <StreamingMessage
                onOpenExternal={onOpenExternal}
                onStop={onStop}
                state={activeState}
              />
            </div>
          ) : (
            <HistoryItem
              key={itemId}
              messageId={itemId}
              onContentRendered={itemId === order.at(-1) ? handleLatestContentRendered : undefined}
              onEdit={onEdit}
              onOpenExternal={onOpenExternal}
              onRegenerate={onRegenerate}
              onSwitchSibling={onSwitchSibling}
            />
          )
        }
      </VList>
      {!atBottom || !atLatestWindow ? (
        <Button
          aria-label={atLatestWindow ? "Return to bottom" : "Return to latest messages"}
          className="return-to-bottom"
          onClick={() => void returnLatest()}
          type="button"
          variant="outline"
        >
          <ArrowDown aria-hidden="true" className="size-4" />
          {unreadUpdates > 0 ? `${unreadUpdates} new` : atLatestWindow ? "Latest" : "Return"}
        </Button>
      ) : null}
    </section>
  );
}

function findVisibleAnchor(
  section: HTMLElement | null,
): { messageId: string; offset: number } | undefined {
  const viewport = section?.querySelector<HTMLElement>(".message-virtual-list");
  if (!viewport) return undefined;
  const viewportRect = viewport.getBoundingClientRect();
  const visibleRows = [...viewport.querySelectorAll<HTMLElement>("[data-message-id]")]
    .map((row) => ({ row, rect: row.getBoundingClientRect() }))
    .filter(({ rect }) => rect.bottom > viewportRect.top && rect.top < viewportRect.bottom)
    .sort((left, right) => left.rect.top - right.rect.top);
  const anchor = visibleRows[0];
  const messageId = anchor?.row.dataset.messageId;
  return anchor && messageId
    ? { messageId, offset: anchor.rect.top - viewportRect.top }
    : undefined;
}

const HistoryItem = memo(function HistoryItem({
  messageId,
  onContentRendered,
  onEdit,
  onOpenExternal,
  onRegenerate,
  onSwitchSibling,
}: {
  messageId: string;
  onContentRendered?: () => void;
  onEdit: (messageId: string, text: string) => void;
  onOpenExternal: (url: string) => void;
  onRegenerate: (messageId: string) => void;
  onSwitchSibling: (messageId: string, direction: -1 | 1) => void;
}) {
  const message = useChatHistory((state) => state.byId[messageId]);
  const sibling = useChatHistory((state) => state.siblingById[messageId]);
  if (!message) return null;
  return (
    <div className="message-stack">
      <HistoricalMessage
        message={message}
        onContentRendered={onContentRendered}
        onEdit={message.role === "user" ? onEdit : undefined}
        onOpenExternal={onOpenExternal}
        onRegenerate={message.role === "assistant" ? onRegenerate : undefined}
        onSwitchSibling={sibling && sibling.siblingIds.length > 1 ? onSwitchSibling : undefined}
        sibling={sibling}
      />
    </div>
  );
});
