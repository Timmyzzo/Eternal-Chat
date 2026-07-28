import { memo, useEffect, useRef, useState } from "react";
import { RefreshCw, Square } from "lucide-react";

import { SafeMarkdown } from "@/app/SafeMarkdown";
import { Button } from "@/components/ui/button";
import type { Message, MessageBlocks } from "@/domain/chat";
import type { StreamingMessageState } from "@/domain/streaming";

interface MessageContentProps {
  blocks: MessageBlocks;
}

function MessageContent({ blocks }: MessageContentProps) {
  return (
    <div className="message-blocks">
      {blocks.blocks.map((block, index) => {
        if (block.type === "text" && typeof block.text === "string") {
          return <SafeMarkdown key={`text-${index}`} text={block.text} />;
        }
        if (
          block.type === "thinking" &&
          typeof block.text === "string" &&
          typeof block.visibility === "string"
        ) {
          return (
            <details className="thinking-block" key={`thinking-${index}`} open={false}>
              <summary>Reasoning</summary>
              <SafeMarkdown text={block.text} />
            </details>
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

export const HistoricalMessage = memo(function HistoricalMessage({
  message,
  onRegenerate,
}: {
  message: Message;
  onRegenerate?: (messageId: string) => void;
}) {
  const renderCount = useRef(0);
  renderCount.current += 1;
  return (
    <article
      className="message-row"
      data-message-id={message.id}
      data-render-count={renderCount.current}
      data-message-status={message.status}
      data-role={message.role}
    >
      <header className="message-meta">
        <span>{message.role === "user" ? "You" : "Assistant"}</span>
        <span>{message.status}</span>
      </header>
      <MessageContent blocks={message.blocks} />
      {message.usage ? (
        <output className="message-usage">{formatUsage(message.usage)}</output>
      ) : null}
      {message.role === "assistant" && onRegenerate && message.status !== "pending" ? (
        <Button
          aria-label="Regenerate response"
          className="message-action"
          onClick={() => onRegenerate(message.id)}
          size="icon"
          type="button"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
        </Button>
      ) : null}
    </article>
  );
});

export function StreamingMessage({
  onStop,
  state,
}: {
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
      <MessageContent blocks={state.blocks} />
      {state.status === "waiting_retry" && state.retry ? (
        <RetryWaitStatus onStop={onStop} state={state} />
      ) : state.blocks.blocks.length === 0 ? (
        <span className="streaming-caret">Waiting</span>
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
    if (!retry) {
      return;
    }
    const update = () => setRemainingMs(Math.max(0, retry.nextAttemptAt - Date.now()));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [retry]);

  if (!retry) {
    return null;
  }
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

function formatUsage(usage: unknown): string {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return "Usage recorded";
  }
  const value = usage as Record<string, unknown>;
  const total = value.total_tokens ?? value.totalTokens;
  return typeof total === "number" ? `${total} tokens` : "Usage recorded";
}

function formatCountdown(remainingMs: number): string {
  return `${Math.ceil(remainingMs / 1_000)}s`;
}
