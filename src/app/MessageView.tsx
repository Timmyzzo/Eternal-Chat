import { memo, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  ListTree,
  Pencil,
  RefreshCw,
  Search,
  Square,
  Wrench,
  X,
} from "lucide-react";

import { SafeMarkdown } from "@/app/SafeMarkdown";
import { FluidSheet } from "@/components/shared/FluidSheet";
import { Button } from "@/components/ui/button";
import type {
  CitationBlock,
  Message,
  MessageBlocks,
  MessageSiblingInfo,
  ProviderStateBlock,
  SourceBlock,
  ThinkingBlock,
  ToolCallBlock,
} from "@/domain/chat";
import type { StreamingMessageState } from "@/domain/streaming";

interface MessageContentProps {
  active?: boolean;
  blocks: MessageBlocks;
  completed?: boolean;
  messageId: string;
  onContentRendered?: () => void;
  onOpenExternal?: (url: string) => void;
  version?: string | number;
}

function MessageContent({
  active = false,
  blocks,
  completed = false,
  messageId,
  onContentRendered,
  onOpenExternal,
  version = 0,
}: MessageContentProps) {
  return (
    <div className="message-blocks">
      <StructuredProcess
        active={active}
        blocks={blocks}
        completed={completed}
        messageId={messageId}
        onOpenExternal={onOpenExternal}
        version={version}
      />
      {blocks.blocks.map((block, index) => {
        if (block.type === "text" && typeof block.text === "string") {
          return (
            <SafeMarkdown
              completed={completed}
              key={typeof block.blockId === "string" ? block.blockId : `text-${index}`}
              messageId={`${messageId}:${typeof block.blockId === "string" ? block.blockId : index}`}
              onOpenExternal={onOpenExternal}
              onRendered={onContentRendered}
              text={block.text}
              version={version}
            />
          );
        }
        if (
          block.type === "error" &&
          typeof block.code === "string" &&
          typeof block.message === "string"
        ) {
          return (
            <div className="message-error" key={`error-${index}`} role="alert">
              <strong>{block.code}</strong>
              <span>{block.message}</span>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function StructuredProcess({
  active,
  blocks,
  messageId,
  onOpenExternal,
  version,
}: MessageContentProps) {
  const [expanded, setExpanded] = useState(Boolean(active));
  const thinking = blocks.blocks.filter(isThinkingBlock);
  const tools = blocks.blocks.filter(isToolCallBlock);
  const sources = blocks.blocks.filter(isSourceBlock);
  const citations = blocks.blocks.filter(isCitationBlock);
  const providerStates = blocks.blocks.filter(isProviderStateBlock);
  const compatibilityWarnings = providerStates.filter(
    (block) => block.purpose === "compatibility_warning",
  );
  const timeline = blocks.timeline ?? [];
  const hasProcess =
    thinking.length > 0 ||
    tools.length > 0 ||
    sources.length > 0 ||
    citations.length > 0 ||
    providerStates.some((block) => block.purpose === "agent_status") ||
    compatibilityWarnings.length > 0;
  const now = useElapsedClock(
    Boolean(active) &&
      (thinking.some((block) => block.finishedAt === undefined) ||
        tools.some((tool) => tool.status === "running")),
  );

  if (!hasProcess) return null;

  const durationMs = processDuration(thinking, tools, now);
  const label = processLabel(thinking, tools, durationMs);
  const agents = providerStates.filter((block) => block.purpose === "agent_status");

  return (
    <section className="structured-process" aria-label="Provider process">
      <details
        className="thinking-block"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
        open={expanded}
      >
        <summary>
          <span>{label}</span>
          <span>{processCounts(tools.length, sources.length)}</span>
        </summary>
        <p className="process-truth-note">
          This area shows provider-returned reasoning summaries, tool events, and local timing. It
          does not claim to expose hidden internal thoughts.
        </p>
        {compatibilityWarnings.map((warning) => (
          <div className="process-warning" key={warning.id ?? JSON.stringify(warning.data)}>
            {formatCompatibilityWarning(warning)}
          </div>
        ))}
        {thinking.map((block, index) =>
          block.text ? (
            <div className="reasoning-entry" key={block.blockId ?? `thinking-${index}`}>
              <strong>{block.label ?? reasoningLabel(block.visibility)}</strong>
              <SafeMarkdown
                completed={!active}
                messageId={`${messageId}:thinking:${block.blockId ?? index}`}
                onOpenExternal={onOpenExternal}
                text={block.text}
                version={version}
              />
            </div>
          ) : null,
        )}
        {agents.length > 0 ? (
          <div className="agent-status-list" aria-label="Provider agents">
            {agents.map((agent) => (
              <span key={agent.id ?? JSON.stringify(agent.data)}>{formatAgent(agent)}</span>
            ))}
          </div>
        ) : null}
        {tools.length > 0 ? <ToolList now={now} tools={tools} /> : null}
      </details>
      {sources.length > 0 ? <SourceList onOpenExternal={onOpenExternal} sources={sources} /> : null}
      {citations.length > 0 ? (
        <div className="citation-summary">
          {citations.length} {citations.length === 1 ? "citation" : "citations"} linked to this
          answer
        </div>
      ) : null}
      <FluidSheet
        closeLabel="Close process details"
        description="Provider-returned reasoning, tool, source, citation, and timing events"
        title="Process details"
        trigger={
          <Button
            aria-label="Open process details"
            className="process-detail-trigger"
            variant="ghost"
          >
            <ListTree aria-hidden="true" className="size-4" />
            Details
          </Button>
        }
        triggerTooltip="Process details"
      >
        <div className="process-detail-sheet">
          <p className="process-truth-note">
            Times below are local receive times. Provider timing metadata remains separate when it
            is available.
          </p>
          <ol className="process-timeline">
            {timeline.map((entry) => (
              <li key={`${entry.seq}-${entry.type}`}>
                <span>{entry.seq}</span>
                <strong>{formatEventType(entry.type)}</strong>
                <time>{formatClock(entry.ts)}</time>
              </li>
            ))}
          </ol>
          {sources.length > 0 ? (
            <SourceList onOpenExternal={onOpenExternal} sources={sources} />
          ) : null}
        </div>
      </FluidSheet>
    </section>
  );
}

function ToolList({ now, tools }: { now: number; tools: ToolCallBlock[] }) {
  return (
    <div className="tool-event-list" aria-label="Tool activity">
      {tools.map((tool) => (
        <article className="tool-event" data-tool-status={tool.status} key={tool.id}>
          <Wrench aria-hidden="true" className="size-4" />
          <div>
            <strong>{tool.name}</strong>
            <span>{toolQuery(tool)}</span>
          </div>
          <output>
            {tool.status}
            {toolDuration(tool, now) === null
              ? ""
              : ` · ${formatDuration(toolDuration(tool, now)!)}`}
          </output>
        </article>
      ))}
    </div>
  );
}

function SourceList({
  onOpenExternal,
  sources,
}: {
  onOpenExternal?: (url: string) => void;
  sources: SourceBlock[];
}) {
  return (
    <div className="source-list" aria-label="Sources">
      <header>
        <Search aria-hidden="true" className="size-4" />
        <strong>Sources</strong>
        <span>{sources.length}</span>
      </header>
      <div className="source-pills">
        {sources.map((source, index) => {
          const safeUrl = safeExternalUrl(source.url);
          const title = source.title ?? source.id;
          const domain = sourceDomain(safeUrl);
          return (
            <button
              aria-label={safeUrl ? `Open source ${title}` : `Source ${title}`}
              className="source-pill"
              disabled={!safeUrl || !onOpenExternal}
              key={source.id}
              onClick={() => safeUrl && onOpenExternal?.(safeUrl)}
              type="button"
            >
              <span>{index + 1}</span>
              <span>
                <strong>{title}</strong>
                <small>{domain ?? source.kind ?? "Provider source"}</small>
              </span>
              {safeUrl ? <ExternalLink aria-hidden="true" className="size-3" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const HistoricalMessage = memo(function HistoricalMessage({
  message,
  onEdit,
  onContentRendered,
  onOpenExternal,
  onRegenerate,
  onSwitchSibling,
  sibling,
}: {
  message: Message;
  onEdit?: (messageId: string, text: string) => void;
  onContentRendered?: () => void;
  onOpenExternal?: (url: string) => void;
  onRegenerate?: (messageId: string) => void;
  onSwitchSibling?: (messageId: string, direction: -1 | 1) => void;
  sibling?: MessageSiblingInfo;
}) {
  const renderCount = useRef(0);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => messageText(message));
  renderCount.current += 1;
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copyMessage = async () => {
    const text = messageText(message);
    if (!navigator.clipboard || text === "") return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const saveEdit = () => {
    if (!onEdit || draft.trim() === "") return;
    onEdit(message.id, draft);
    setEditing(false);
  };
  return (
    <article
      className="message-row"
      data-message-id={message.id}
      data-render-count={renderCount.current}
      data-message-status={message.status}
      data-role={message.role}
      tabIndex={-1}
    >
      <header className="message-meta">
        <span>{message.role === "user" ? "You" : "Assistant"}</span>
        <span>{message.status}</span>
      </header>
      {editing ? (
        <div className="message-editor">
          <textarea
            aria-label="Edit message"
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            rows={4}
            value={draft}
          />
          <div className="message-editor-actions">
            <Button
              aria-label="Cancel editing"
              onClick={() => {
                setDraft(messageText(message));
                setEditing(false);
              }}
              size="icon"
              title="Cancel"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" className="size-4" />
            </Button>
            <Button
              aria-label="Save edited message as a new branch"
              disabled={draft.trim() === ""}
              onClick={saveEdit}
              size="icon"
              title="Save as new branch"
              type="button"
            >
              <Check aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
      ) : (
        <MessageContent
          blocks={message.blocks}
          completed
          messageId={message.id}
          onContentRendered={onContentRendered}
          onOpenExternal={onOpenExternal}
          version={message.updatedAt}
        />
      )}
      {message.usage ? (
        <output className="message-usage">{formatUsage(message.usage)}</output>
      ) : null}
      <div className="message-actions">
        {sibling && sibling.siblingIds.length > 1 && onSwitchSibling ? (
          <div className="message-branch-control" aria-label="Message branches">
            <Button
              aria-label="Previous sibling"
              disabled={sibling.index <= 0}
              onClick={() => onSwitchSibling(message.id, -1)}
              size="icon"
              title="Previous branch"
              type="button"
              variant="ghost"
            >
              <ChevronLeft aria-hidden="true" className="size-4" />
            </Button>
            <output aria-live="polite">
              {sibling.index + 1} / {sibling.siblingIds.length}
            </output>
            <Button
              aria-label="Next sibling"
              disabled={sibling.index >= sibling.siblingIds.length - 1}
              onClick={() => onSwitchSibling(message.id, 1)}
              size="icon"
              title="Next branch"
              type="button"
              variant="ghost"
            >
              <ChevronRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
        ) : null}
        <Button
          aria-label={copied ? "Message copied" : "Copy message"}
          onClick={() => void copyMessage()}
          size="icon"
          title="Copy"
          type="button"
          variant="ghost"
        >
          {copied ? (
            <Check aria-hidden="true" className="size-4" />
          ) : (
            <Copy aria-hidden="true" className="size-4" />
          )}
        </Button>
        {message.role === "user" && onEdit ? (
          <Button
            aria-label="Edit message"
            onClick={() => setEditing(true)}
            size="icon"
            title="Edit"
            type="button"
            variant="ghost"
          >
            <Pencil aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
        {message.role === "assistant" && onRegenerate && message.status !== "pending" ? (
          <Button
            aria-label="Regenerate response"
            onClick={() => onRegenerate(message.id)}
            size="icon"
            title="Regenerate"
            type="button"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
      </div>
    </article>
  );
});

export function StreamingMessage({
  onOpenExternal,
  onStop,
  state,
}: {
  onOpenExternal?: (url: string) => void;
  onStop?: () => void;
  state: StreamingMessageState;
}) {
  return (
    <article
      aria-live="polite"
      className="message-row streaming-message"
      data-message-id={state.assistantMessageId}
      data-message-status={state.status}
      data-role="assistant"
    >
      <header className="message-meta">
        <span>Assistant</span>
        <span>{state.status}</span>
      </header>
      <MessageContent
        active={!isTerminalUiStatus(state.status)}
        blocks={state.blocks}
        completed={isTerminalUiStatus(state.status)}
        messageId={state.assistantMessageId}
        onOpenExternal={onOpenExternal}
        version={state.eventSeq}
      />
      {state.status === "waiting_retry" && state.retry ? (
        <RetryWaitStatus onStop={onStop} state={state} />
      ) : state.blocks.blocks.length === 0 ? (
        <span className="streaming-caret">Waiting for the provider</span>
      ) : null}
      {state.usage ? <output className="message-usage">{formatUsage(state.usage)}</output> : null}
    </article>
  );
}

function RetryWaitStatus({ onStop, state }: { onStop?: () => void; state: StreamingMessageState }) {
  const retry = state.retry;
  const [remainingMs, setRemainingMs] = useState(() =>
    retry ? Math.max(0, retry.nextAttemptAt - Date.now()) : 0,
  );

  useEffect(() => {
    if (!retry) return;
    const update = () => setRemainingMs(Math.max(0, retry.nextAttemptAt - Date.now()));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [retry]);

  if (!retry) return null;
  const failure = retry.httpStatus ? `HTTP ${retry.httpStatus}` : retry.failureCode;
  return (
    <div className="retry-wait" role="status">
      <div className="retry-wait-copy">
        <strong>
          Attempt {retry.nextAttemptNo} / {state.maxAttempts}
        </strong>
        <span>{failure}</span>
        <span>Retrying in {formatCountdown(remainingMs)}</span>
      </div>
      {onStop ? (
        <Button aria-label="Stop automatic retry" onClick={onStop} type="button" variant="outline">
          <Square aria-hidden="true" className="size-3 fill-current" />
          Stop
        </Button>
      ) : null}
    </div>
  );
}

function useElapsedClock(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function processDuration(
  thinking: ThinkingBlock[],
  tools: ToolCallBlock[],
  now: number,
): number | null {
  const starts = [
    ...thinking.flatMap((block) => (typeof block.startedAt === "number" ? [block.startedAt] : [])),
    ...tools.flatMap((tool) => (typeof tool.startedAt === "number" ? [tool.startedAt] : [])),
  ];
  if (starts.length === 0) return null;
  const ends = [
    ...thinking.flatMap((block) =>
      typeof block.finishedAt === "number" ? [block.finishedAt] : [],
    ),
    ...tools.flatMap((tool) => (typeof tool.finishedAt === "number" ? [tool.finishedAt] : [])),
  ];
  const hasOpenInterval =
    thinking.some((block) => block.finishedAt === undefined) ||
    tools.some((tool) => tool.startedAt !== undefined && tool.finishedAt === undefined);
  const end = hasOpenInterval || ends.length === 0 ? now : Math.max(...ends);
  return Math.max(0, end - Math.min(...starts));
}

function toolDuration(tool: ToolCallBlock, now: number): number | null {
  if (typeof tool.startedAt !== "number") return null;
  return Math.max(
    0,
    (typeof tool.finishedAt === "number" ? tool.finishedAt : now) - tool.startedAt,
  );
}

function processLabel(
  thinking: ThinkingBlock[],
  tools: ToolCallBlock[],
  durationMs: number | null,
): string {
  const suffix = durationMs === null ? "" : ` for ${formatDuration(durationMs)}`;
  if (thinking.some((block) => block.visibility === "summary")) return `Reasoning summary${suffix}`;
  if (thinking.some((block) => block.text)) return `Provider reasoning${suffix}`;
  if (tools.length > 0) return `Search and tools${suffix}`;
  return `Provider process${suffix}`;
}

function processCounts(toolCount: number, sourceCount: number): string {
  return [
    toolCount > 0 ? `${toolCount} ${toolCount === 1 ? "tool" : "tools"}` : "",
    sourceCount > 0 ? `${sourceCount} ${sourceCount === 1 ? "source" : "sources"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function toolQuery(tool: ToolCallBlock): string {
  if (typeof tool.args === "object" && tool.args !== null && !Array.isArray(tool.args)) {
    const query = tool.args.query;
    if (typeof query === "string") return query;
  }
  const serialized = typeof tool.args === "string" ? tool.args : JSON.stringify(tool.args);
  return serialized.length > 120 ? `${serialized.slice(0, 117)}...` : serialized;
}

function formatAgent(block: ProviderStateBlock): string {
  if (typeof block.data !== "object" || block.data === null || Array.isArray(block.data)) {
    return "Provider agent update";
  }
  const label = typeof block.data.label === "string" ? block.data.label : block.data.id;
  const status = typeof block.data.status === "string" ? block.data.status : "updated";
  return `${typeof label === "string" ? label : "Provider agent"}: ${status}`;
}

function formatCompatibilityWarning(block: ProviderStateBlock): string {
  if (typeof block.data !== "object" || block.data === null || Array.isArray(block.data)) {
    return "The provider returned an event this protocol profile does not recognize.";
  }
  const eventType = typeof block.data.eventType === "string" ? block.data.eventType : "unknown";
  return `Compatibility warning: unsupported provider event ${eventType}.`;
}

function safeExternalUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function sourceDomain(url: string | null): string | null {
  if (!url) return null;
  return new URL(url).hostname;
}

function formatUsage(usage: unknown): string {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return "Usage recorded";
  const value = usage as Record<string, unknown>;
  const total = value.total_tokens ?? value.totalTokens;
  return typeof total === "number" ? `${total} tokens` : "Usage recorded";
}

function messageText(message: Message): string {
  return message.blocks.blocks
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n");
}

function formatCountdown(remainingMs: number): string {
  return `${Math.ceil(remainingMs / 1_000)}s`;
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${durationMs}ms` : `${Math.round(durationMs / 100) / 10}s`;
}

function formatEventType(type: string): string {
  return type.replaceAll("_", " ");
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function reasoningLabel(visibility: string): string {
  return visibility === "summary" ? "Reasoning summary" : "Provider reasoning";
}

function isTerminalUiStatus(status: StreamingMessageState["status"]): boolean {
  return status === "done" || status === "interrupted" || status === "error";
}

function isThinkingBlock(block: MessageBlocks["blocks"][number]): block is ThinkingBlock {
  return block.type === "thinking" && typeof block.text === "string";
}

function isToolCallBlock(block: MessageBlocks["blocks"][number]): block is ToolCallBlock {
  return block.type === "tool_call" && typeof block.id === "string";
}

function isSourceBlock(block: MessageBlocks["blocks"][number]): block is SourceBlock {
  return block.type === "source" && typeof block.id === "string";
}

function isCitationBlock(block: MessageBlocks["blocks"][number]): block is CitationBlock {
  return block.type === "citation" && typeof block.sourceId === "string";
}

function isProviderStateBlock(block: MessageBlocks["blocks"][number]): block is ProviderStateBlock {
  return block.type === "provider_state" && typeof block.purpose === "string";
}
