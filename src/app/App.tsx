import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Laptop,
  MessageCircleMore,
  MessagesSquare,
  Moon,
  PanelRight,
  Plus,
  Search,
  Send,
  Settings2,
  Square,
  Sun,
} from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useStore } from "zustand";

import { ChatHistoryProvider, createChatHistoryStore } from "@/app/chatHistoryStore";
import { ConnectionSettings } from "@/app/ConnectionSettings";
import { ConversationMessageList } from "@/app/ConversationMessageList";
import { RequestInspector } from "@/app/RequestInspector";
import {
  inspectionFromDispatch,
  inspectionFromSnapshot,
  type InspectionState,
} from "@/app/requestInspection";
import { useTheme, type ThemeMode } from "@/app/ThemeProvider";
import { SidebarResizeHandle } from "@/app/SidebarResizeHandle";
import {
  BudgetConfirmationRequiredError,
  type ConversationMessageWindow,
  type ProviderSelection,
} from "@/application/chat/chatService";
import type { ApplicationRuntime } from "@/application/chat/runtime";
import { FluidSheet } from "@/components/shared/FluidSheet";
import { Button } from "@/components/ui/button";
import type { Conversation, ConversationSearchResult, RequestAttempt } from "@/domain/chat";
import type { LosslessBudgetPreflightResult } from "@/domain/context";
import { isTerminalStatus, type StreamingMessageState } from "@/domain/streaming";
import type { ProtocolProfile } from "@/domain/provider";
import { cn } from "@/lib/utils";

const themeOptions: ReadonlyArray<{
  value: ThemeMode;
  label: string;
  icon: typeof Laptop;
}> = [
  { value: "system", label: "System", icon: Laptop },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

function AppearanceSettings() {
  const { mode, setMode } = useTheme();
  const prefersReducedMotion = useReducedMotion();

  return (
    <div className="appearance-settings">
      <section aria-labelledby="theme-label" className="settings-section">
        <h2 id="theme-label">Theme</h2>
        <div aria-labelledby="theme-label" className="theme-options" role="radiogroup">
          {themeOptions.map(({ value, label, icon: Icon }) => {
            const selected = mode === value;
            return (
              <button
                aria-checked={selected}
                className={cn("theme-option", selected && "theme-option-selected")}
                key={value}
                onClick={() => setMode(value)}
                role="radio"
                type="button"
              >
                <Icon aria-hidden="true" className="size-4" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </section>
      <section className="settings-section settings-inline" aria-labelledby="motion-label">
        <h2 id="motion-label">Motion</h2>
        <output>{prefersReducedMotion ? "Reduced" : "Standard"}</output>
      </section>
    </div>
  );
}

export function App({ runtime }: { runtime: ApplicationRuntime }) {
  const { credentials, registry, service } = runtime;
  const [historyStore] = useState(createChatHistoryStore);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selections, setSelections] = useState<ProviderSelection[]>([]);
  const [profiles, setProfiles] = useState<ProtocolProfile[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [newConversationModelRef, setNewConversationModelRef] = useState("");
  const [activeState, setActiveState] = useState<StreamingMessageState | null>(null);
  const [currentRequestId, setCurrentRequestId] = useState<string | null>(null);
  const [requestConversationId, setRequestConversationId] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [budget, setBudget] = useState<LosslessBudgetPreflightResult | null>(null);
  const [inspection, setInspection] = useState<InspectionState | null>(null);
  const [requestAttempts, setRequestAttempts] = useState<RequestAttempt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [overLimitDraft, setOverLimitDraft] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ConversationSearchResult[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const terminalHandled = useRef(new Set<string>());
  const messageCount = useStore(historyStore, (state) => state.order.length);

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );
  const selectedModel = useMemo(
    () =>
      selections.find((selection) => selection.model.id === selectedConversation?.modelRef) ?? null,
    [selectedConversation, selections],
  );
  const requestActive =
    activeState !== null &&
    (activeState.status === "pending" ||
      activeState.status === "streaming" ||
      activeState.status === "waiting_retry");

  const refreshCatalog = useCallback(
    async (
      preferredModelRef?: string,
      preferredConversationId?: string | null,
      archived = showArchived,
    ) => {
      const [nextConversations, nextSelections, nextProfiles] = await Promise.all([
        service.listConversations(archived),
        service.listProviderSelections(),
        service.listProtocolProfiles(),
      ]);
      setConversations(nextConversations);
      setSelections(nextSelections);
      setProfiles(nextProfiles);
      setNewConversationModelRef((current) => {
        const preferred = preferredModelRef ?? current;
        return nextSelections.some((selection) => selection.model.id === preferred)
          ? preferred
          : (nextSelections[0]?.model.id ?? "");
      });
      setSelectedConversationId((current) =>
        nextConversations.some(
          (conversation) => conversation.id === (preferredConversationId ?? current),
        )
          ? (preferredConversationId ?? current)
          : (nextConversations[0]?.id ?? null),
      );
    },
    [service, showArchived],
  );

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setOverLimitDraft(null);
    if (!selectedConversationId) {
      historyStore.getState().clear();
      setActiveState(null);
      setCurrentRequestId(null);
      setRequestConversationId(null);
      setInspection(null);
      setRequestAttempts([]);
      return () => {
        cancelled = true;
      };
    }

    const latest = registry.latestForConversation(selectedConversationId);
    const live = latest && !isTerminalStatus(latest.status) ? latest : null;
    setActiveState(live);
    setCurrentRequestId(live?.requestId ?? null);
    setRequestConversationId(live ? selectedConversationId : null);
    void service.loadConversationWindow(selectedConversationId).then(async (window) => {
      if (cancelled) {
        return;
      }
      const visibleWindow = live ? excludeWindowMessage(window, live.assistantMessageId) : window;
      historyStore.getState().setWindow(visibleWindow);
      const assistant = visibleWindow.messages
        .filter((message) => message.role === "assistant")
        .at(-1);
      if (assistant) {
        const snapshot = await service.getSnapshotForAssistant(assistant.id);
        if (!cancelled && snapshot) {
          setInspection(inspectionFromSnapshot(snapshot));
          setRequestAttempts(await service.listRequestAttemptsForAssistant(assistant.id));
        }
      } else {
        setInspection(null);
        setRequestAttempts([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [historyStore, registry, selectedConversationId, service]);

  useEffect(() => {
    if (!currentRequestId || !requestConversationId) {
      return;
    }
    return registry.subscribe(currentRequestId, (state) => {
      setActiveState(state);
      setRequestAttempts(state.attempts);
      if (!isTerminalStatus(state.status) || terminalHandled.current.has(state.requestId)) {
        return;
      }
      terminalHandled.current.add(state.requestId);
      void registry.whenTerminal(state.requestId).then(async (terminal) => {
        try {
          const [window, snapshot, attempts] = await Promise.all([
            service.loadConversationWindow(requestConversationId),
            service.getSnapshotForAssistant(terminal.assistantMessageId),
            service.listRequestAttemptsForAssistant(terminal.assistantMessageId),
          ]);
          historyStore.getState().setWindow(window);
          setActiveState(null);
          setCurrentRequestId(null);
          setRequestConversationId(null);
          setRequestAttempts(attempts);
          if (snapshot) {
            setInspection(inspectionFromSnapshot(snapshot));
          }
          void refreshCatalog();
        } finally {
          terminalHandled.current.delete(state.requestId);
          registry.removeTerminal(state.requestId);
        }
      });
    });
  }, [currentRequestId, historyStore, refreshCatalog, registry, requestConversationId, service]);

  useEffect(() => {
    if (!selectedConversationId) {
      setBudget(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void service.preflightMessage(selectedConversationId, composer).then((result) => {
        if (!cancelled) {
          setBudget(result);
        }
      });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [composer, selectedConversationId, service]);

  useEffect(() => {
    const normalized = searchQuery.trim();
    if (normalized === "") {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void service.searchConversations(normalized, showArchived).then((results) => {
        if (!cancelled) setSearchResults(results);
      });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchQuery, service, showArchived]);

  const attachDispatch = useCallback(
    async (result: Awaited<ReturnType<typeof service.sendMessage>>, conversationId: string) => {
      const { dispatch } = result;
      const window = excludeWindowMessage(
        await service.loadConversationWindow(conversationId),
        dispatch.assistantPlaceholder.id,
      );
      terminalHandled.current.delete(dispatch.transportRequest.requestId);
      setInspection(inspectionFromDispatch(dispatch));
      setRequestAttempts(registry.get(dispatch.transportRequest.requestId)?.attempts ?? []);
      setBudget(result.budget);
      historyStore.getState().setWindow(window);
      setActiveState(registry.get(dispatch.transportRequest.requestId));
      setCurrentRequestId(dispatch.transportRequest.requestId);
      setRequestConversationId(conversationId);
      setComposer("");
      setOverLimitDraft(null);
      setError(null);
    },
    [historyStore, registry, service],
  );

  const send = useCallback(
    async (draft: string, allowOverLimit = false) => {
      if (!selectedConversationId || requestActive) {
        return;
      }
      try {
        await attachDispatch(
          await service.sendMessage(selectedConversationId, draft, allowOverLimit),
          selectedConversationId,
        );
      } catch (cause) {
        if (cause instanceof BudgetConfirmationRequiredError) {
          setBudget(cause.budget);
          setOverLimitDraft(draft);
        } else {
          setError(cause instanceof Error ? cause.message : "The message could not be sent.");
          void service
            .loadConversationWindow(selectedConversationId)
            .then((window) => historyStore.getState().setWindow(window));
        }
      }
    },
    [attachDispatch, historyStore, requestActive, selectedConversationId, service],
  );

  const regenerate = useCallback(
    async (assistantMessageId: string, allowOverLimit = false) => {
      if (!selectedConversationId || requestActive) {
        return;
      }
      try {
        const result = await service.regenerate(assistantMessageId, allowOverLimit);
        await attachDispatch(result, selectedConversationId);
      } catch (cause) {
        if (cause instanceof BudgetConfirmationRequiredError) {
          setBudget(cause.budget);
          setError("Regeneration exceeds the configured context limit.");
        } else {
          setError(
            cause instanceof Error ? cause.message : "The response could not be regenerated.",
          );
        }
      }
    },
    [attachDispatch, requestActive, selectedConversationId, service],
  );

  const editMessage = useCallback(
    async (messageId: string, text: string) => {
      if (!selectedConversationId || requestActive) return;
      try {
        await attachDispatch(
          await service.editUserMessage(messageId, text),
          selectedConversationId,
        );
      } catch (cause) {
        if (cause instanceof BudgetConfirmationRequiredError) {
          setBudget(cause.budget);
          setError("The edited branch exceeds the configured context limit.");
        } else {
          setError(cause instanceof Error ? cause.message : "The message could not be edited.");
        }
      }
    },
    [attachDispatch, requestActive, selectedConversationId, service],
  );

  const switchSibling = useCallback(
    async (messageId: string, direction: -1 | 1) => {
      if (!selectedConversationId || requestActive) return;
      try {
        const targetId = await service.switchMessageSibling(messageId, direction);
        historyStore
          .getState()
          .setWindow(await service.loadConversationWindow(selectedConversationId));
        setFocusMessageId(targetId);
        await refreshCatalog(undefined, selectedConversationId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The branch could not be changed.");
      }
    },
    [historyStore, refreshCatalog, requestActive, selectedConversationId, service],
  );

  const loadOlder = useCallback(async () => {
    if (!selectedConversationId || loadingOlder) return;
    const cursor = historyStore.getState().nextCursor;
    if (!cursor) return;
    setLoadingOlder(true);
    try {
      historyStore
        .getState()
        .prependWindow(await service.loadConversationWindow(selectedConversationId, cursor));
    } finally {
      setLoadingOlder(false);
    }
  }, [historyStore, loadingOlder, selectedConversationId, service]);

  const returnLatest = useCallback(async () => {
    if (!selectedConversationId) return;
    const window = await service.loadConversationWindow(selectedConversationId);
    historyStore
      .getState()
      .setWindow(
        activeState ? excludeWindowMessage(window, activeState.assistantMessageId) : window,
      );
  }, [activeState, historyStore, selectedConversationId, service]);

  const openSearchResult = useCallback(
    async (result: ConversationSearchResult) => {
      try {
        await service.activateSearchResult(result);
        setFocusMessageId(result.messageId);
        await refreshCatalog(undefined, result.conversationId, result.archived);
        setSelectedConversationId(result.conversationId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The search result could not be opened.");
      }
    },
    [refreshCatalog, service],
  );

  const setArchived = useCallback(async () => {
    if (!selectedConversationId) return;
    try {
      await service.setConversationArchived(selectedConversationId, !showArchived);
      setSearchQuery("");
      await refreshCatalog(undefined, null, showArchived);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The conversation could not be archived.");
    }
  }, [refreshCatalog, selectedConversationId, service, showArchived]);

  const openExternal = useCallback(
    (url: string) => {
      void service
        .openExternal(url)
        .catch(() => setError("The source link could not be opened safely."));
    },
    [service],
  );

  const createConversation = useCallback(async () => {
    if (!newConversationModelRef) {
      setError("Configure a connection before creating a conversation.");
      return;
    }
    try {
      const conversation = await service.createConversation(
        "New conversation",
        newConversationModelRef,
      );
      setShowArchived(false);
      await refreshCatalog(newConversationModelRef, conversation.id, false);
      setSelectedConversationId(conversation.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The conversation could not be created.");
    }
  }, [newConversationModelRef, refreshCatalog, service]);

  const clearFocusMessage = useCallback(() => setFocusMessageId(null), []);
  const stopCurrentRequest = useCallback(() => {
    if (currentRequestId) registry.stop(currentRequestId);
  }, [currentRequestId, registry]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (event.key.toLocaleLowerCase() === "n") {
        event.preventDefault();
        void createConversation();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [createConversation]);

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (composer.trim() !== "") {
        void send(composer);
      }
    }
  };

  const inspector = (
    <RequestInspector attempts={requestAttempts} budget={budget} inspection={inspection} />
  );

  return (
    <ChatHistoryProvider store={historyStore}>
      <div className="app-layout" data-ui="app.window">
        <aside className="conversation-sidebar" data-ui="app.sidebar">
          <header className="brand-header">
            <span className="brand-mark">
              <MessageCircleMore aria-hidden="true" className="size-4" />
            </span>
            <span>Eternal Chat</span>
          </header>

          <div className="sidebar-toolbar">
            <Button aria-label="New conversation" onClick={createConversation} size="icon">
              <Plus aria-hidden="true" className="size-4" />
            </Button>
            <label className="model-select-label">
              <span className="sr-only">Model for new conversation</span>
              <select
                aria-label="Model for new conversation"
                disabled={selections.length === 0}
                onChange={(event) => setNewConversationModelRef(event.target.value)}
                value={newConversationModelRef}
              >
                {selections.length === 0 ? <option value="">No models</option> : null}
                {selections.map((selection) => (
                  <option key={selection.model.id} value={selection.model.id}>
                    {selection.model.displayName}
                  </option>
                ))}
              </select>
            </label>
            <FluidSheet
              closeLabel="Close connection settings"
              contentClassName="connection-settings-sheet"
              description="Connection and protocol settings"
              title="Connections"
              trigger={
                <Button aria-label="Open connection settings" size="icon" variant="ghost">
                  <Settings2 aria-hidden="true" className="size-4" />
                </Button>
              }
              triggerTooltip="Connections"
            >
              <ConnectionSettings
                conversation={selectedConversation}
                credentials={credentials}
                onChanged={(selection) => void refreshCatalog(selection?.model.id)}
                profiles={profiles}
                selections={selections}
                service={service}
              />
            </FluidSheet>
            <FluidSheet
              closeLabel="Close appearance settings"
              description="Appearance settings"
              title="Appearance"
              trigger={
                <Button aria-label="Open appearance settings" size="icon" variant="ghost">
                  <Sun aria-hidden="true" className="size-4" />
                </Button>
              }
              triggerTooltip="Appearance"
            >
              <AppearanceSettings />
            </FluidSheet>
          </div>

          <div className="sidebar-library-controls">
            <label className="conversation-search">
              <Search aria-hidden="true" className="size-4" />
              <input
                aria-keyshortcuts="Control+K Meta+K"
                aria-label="Search conversations"
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search"
                ref={searchInputRef}
                type="search"
                value={searchQuery}
              />
            </label>
            <div aria-label="Conversation library" className="library-segments" role="group">
              <button
                aria-pressed={!showArchived}
                onClick={() => {
                  setSearchQuery("");
                  setShowArchived(false);
                }}
                type="button"
              >
                Recent
              </button>
              <button
                aria-pressed={showArchived}
                onClick={() => {
                  setSearchQuery("");
                  setShowArchived(true);
                }}
                type="button"
              >
                Archived
              </button>
            </div>
          </div>

          <nav aria-label="Conversations" className="conversation-list">
            {searchQuery.trim() !== "" ? (
              searchResults.length === 0 ? (
                <div className="sidebar-empty">
                  <Search aria-hidden="true" className="size-5" />
                  <span>No matches</span>
                </div>
              ) : (
                searchResults.map((result) => (
                  <button
                    className="conversation-item conversation-search-result"
                    key={`${result.conversationId}:${result.messageId ?? "title"}`}
                    onClick={() => void openSearchResult(result)}
                    type="button"
                  >
                    <Search aria-hidden="true" className="size-4" />
                    <span>
                      <strong>{result.title}</strong>
                      <small>{result.snippet}</small>
                    </span>
                  </button>
                ))
              )
            ) : conversations.length === 0 ? (
              <div className="sidebar-empty">
                {showArchived ? (
                  <Archive aria-hidden="true" className="size-5" />
                ) : (
                  <MessagesSquare aria-hidden="true" className="size-5" />
                )}
                <span>{showArchived ? "No archived conversations" : "No conversations"}</span>
              </div>
            ) : (
              conversations.map((conversation) => (
                <button
                  aria-current={conversation.id === selectedConversationId ? "page" : undefined}
                  className={cn(
                    "conversation-item",
                    conversation.id === selectedConversationId && "conversation-item-selected",
                  )}
                  key={conversation.id}
                  onClick={() => setSelectedConversationId(conversation.id)}
                  type="button"
                >
                  <MessagesSquare aria-hidden="true" className="size-4" />
                  <span>{conversation.title}</span>
                </button>
              ))
            )}
          </nav>
          <SidebarResizeHandle />
        </aside>

        <main className="chat-workspace" data-ui="app.content chat.view">
          <header className="chat-header">
            <div className="chat-heading">
              <h1>{selectedConversation?.title ?? "Conversations"}</h1>
              <span>{selectedModel?.model.displayName ?? "No model selected"}</span>
            </div>
            <div className="chat-header-actions">
              {selectedConversation ? (
                <Button
                  aria-label={showArchived ? "Restore conversation" : "Archive conversation"}
                  onClick={() => void setArchived()}
                  size="icon"
                  title={showArchived ? "Restore" : "Archive"}
                  type="button"
                  variant="ghost"
                >
                  {showArchived ? (
                    <ArchiveRestore aria-hidden="true" className="size-4" />
                  ) : (
                    <Archive aria-hidden="true" className="size-4" />
                  )}
                </Button>
              ) : null}
              <div className="mobile-inspector-trigger">
                <FluidSheet
                  closeLabel="Close request inspector"
                  description="Frozen request and context inspection"
                  title="Request inspector"
                  trigger={
                    <Button aria-label="Open request inspector" size="icon" variant="ghost">
                      <PanelRight aria-hidden="true" className="size-4" />
                    </Button>
                  }
                  triggerTooltip="Request inspector"
                >
                  {inspector}
                </FluidSheet>
              </div>
            </div>
          </header>

          {!selectedConversation ? (
            <section className="message-list" data-ui="chat.message-list">
              <div className="empty-workspace">
                <MessageCircleMore aria-hidden="true" className="size-6" />
                <h2>No conversation selected</h2>
              </div>
            </section>
          ) : messageCount === 0 && !activeState ? (
            <section className="message-list" data-ui="chat.message-list">
              <div className="empty-workspace">
                <MessageCircleMore aria-hidden="true" className="size-6" />
                <h2>New conversation</h2>
              </div>
            </section>
          ) : (
            <ConversationMessageList
              activeState={activeState}
              conversationId={selectedConversation.id}
              focusMessageId={focusMessageId}
              loadingOlder={loadingOlder}
              onEdit={editMessage}
              onFocusHandled={clearFocusMessage}
              onLoadOlder={loadOlder}
              onOpenExternal={openExternal}
              onRegenerate={regenerate}
              onReturnLatest={returnLatest}
              onStop={currentRequestId ? stopCurrentRequest : undefined}
              onSwitchSibling={switchSibling}
            />
          )}

          <footer className="composer-footer">
            {error ? (
              <div className="composer-alert" role="alert">
                <AlertTriangle aria-hidden="true" className="size-4" />
                <span>{error}</span>
                <button aria-label="Dismiss error" onClick={() => setError(null)} type="button">
                  Dismiss
                </button>
              </div>
            ) : null}
            {overLimitDraft ? (
              <div className="composer-alert budget-confirmation" role="alert">
                <AlertTriangle aria-hidden="true" className="size-4" />
                <span>Lossless context is over the configured limit.</span>
                <button onClick={() => void send(overLimitDraft, true)} type="button">
                  Send losslessly
                </button>
                <button onClick={() => setOverLimitDraft(null)} type="button">
                  Review
                </button>
              </div>
            ) : null}
            <div className="composer-row" data-ui="chat.composer">
              <textarea
                aria-label="Message"
                className="composer-input"
                disabled={!selectedConversation}
                onChange={(event) => setComposer(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={selectedConversation ? "Message" : "Select a conversation"}
                rows={2}
                value={composer}
              />
              {requestActive && currentRequestId ? (
                <Button
                  aria-label="Stop generation"
                  onClick={() => registry.stop(currentRequestId)}
                  size="icon"
                  type="button"
                  variant="outline"
                >
                  <Square aria-hidden="true" className="size-4 fill-current" />
                </Button>
              ) : (
                <Button
                  aria-label="Send message"
                  disabled={!selectedConversation || composer.trim() === ""}
                  onClick={() => void send(composer)}
                  size="icon"
                  type="button"
                >
                  <Send aria-hidden="true" className="size-4" />
                </Button>
              )}
            </div>
            <div className="composer-status">
              <span className={`budget-badge budget-${budget?.status ?? "uncertain"}`}>
                {(budget?.status ?? "uncertain").replace("_", " ")}
              </span>
              <span aria-live="polite">{requestActive ? activeState?.status : "ready"}</span>
            </div>
          </footer>
        </main>

        <aside className="request-inspector" aria-label="Request inspector">
          <header>
            <h2>Request inspector</h2>
          </header>
          {inspector}
        </aside>
      </div>
    </ChatHistoryProvider>
  );
}

function excludeWindowMessage(
  window: ConversationMessageWindow,
  messageId: string,
): ConversationMessageWindow {
  return {
    messages: window.messages.filter((message) => message.id !== messageId),
    nextCursor: window.nextCursor,
    siblings: window.siblings.filter((info) => info.messageId !== messageId),
  };
}
