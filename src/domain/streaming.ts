import type { MessageBlock, MessageBlocks, MessageStatus, RequestAttempt } from "@/domain/chat";
import type { JsonObject, JsonValue } from "@/domain/json";

export type StreamErrorCode =
  | "chat_malformed_json"
  | "chat_stream_error"
  | "chat_event_after_terminal"
  | "chat_missing_terminal"
  | "responses_malformed_event"
  | "responses_unknown_event"
  | "responses_failed"
  | "responses_incomplete"
  | "responses_error"
  | "responses_event_after_terminal"
  | "responses_missing_terminal"
  | "transport_error"
  | "storage_finalize_failed"
  | "retry_exhausted"
  | "retry_budget_exhausted"
  | "retry_after_invalid"
  | "retry_disallowed_after_output"
  | "retry_cancelled"
  | "provider_embedded_error";

export interface StreamErrorInfo {
  code: StreamErrorCode;
  details?: JsonObject;
  message: string;
  retryable: false;
}

export type StreamDomainEvent =
  | { type: "started"; responseId?: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string; visibility: string }
  | { type: "semantic"; kind: "tool" | "source" | "citation" | "provider" }
  | { type: "usage"; usage: JsonValue }
  | { type: "done"; finishReason: string | null; responseId?: string }
  | { type: "error"; error: StreamErrorInfo };

export type StreamLifecycleAction =
  | StreamDomainEvent
  | {
      type: "interrupted";
      code?: StreamErrorCode;
      finishReason: string;
      message: string;
    };

export type ActiveRequestStatus = MessageStatus;
export type TerminalRequestStatus = Extract<ActiveRequestStatus, "done" | "interrupted" | "error">;

export interface RetryWaitState {
  delayMs: number;
  delaySource: "full_jitter" | "retry_after";
  failureCode: string;
  failureMessage: string;
  httpStatus: number | null;
  nextAttemptAt: number;
  nextAttemptNo: number;
  providerCode: string | null;
  retryAfterInvalid: boolean;
  retryAfterMs: number | null;
}

export interface StreamingMessageState {
  assistantMessageId: string;
  attemptNo: number;
  attempts: RequestAttempt[];
  blocks: MessageBlocks;
  completedAt: number | null;
  error: StreamErrorInfo | null;
  finishReason: string | null;
  firstEventAt: number | null;
  maxAttempts: number;
  requestId: string;
  responseId: string | null;
  retry: RetryWaitState | null;
  startedAt: number;
  status: ActiveRequestStatus;
  transportRequestId: string;
  usage: JsonValue | null;
}

export function createStreamingMessageState(input: {
  assistantMessageId: string;
  attemptNo?: number;
  maxAttempts?: number;
  requestId: string;
  startedAt: number;
  transportRequestId?: string;
}): StreamingMessageState {
  return {
    assistantMessageId: input.assistantMessageId,
    attemptNo: input.attemptNo ?? 1,
    attempts: [],
    blocks: { version: 1, blocks: [] },
    completedAt: null,
    error: null,
    finishReason: null,
    firstEventAt: null,
    maxAttempts: input.maxAttempts ?? 1,
    requestId: input.requestId,
    responseId: null,
    retry: null,
    startedAt: input.startedAt,
    status: "pending",
    transportRequestId: input.transportRequestId ?? input.requestId,
    usage: null,
  };
}

export function reduceStreamingMessage(
  state: StreamingMessageState,
  action: StreamLifecycleAction,
  occurredAt: number,
): StreamingMessageState {
  if (isTerminalStatus(state.status)) {
    return state;
  }

  const firstEventAt = state.firstEventAt ?? occurredAt;
  switch (action.type) {
    case "started":
      return {
        ...state,
        firstEventAt,
        responseId: action.responseId ?? state.responseId,
        status: "streaming",
      };
    case "text_delta":
      return {
        ...state,
        blocks: appendDelta(state.blocks, "text", action.delta, "visible"),
        firstEventAt,
        status: "streaming",
      };
    case "thinking_delta":
      return {
        ...state,
        blocks: appendDelta(state.blocks, "thinking", action.delta, action.visibility),
        firstEventAt,
        status: "streaming",
      };
    case "semantic":
      return { ...state, firstEventAt, status: "streaming" };
    case "usage":
      return { ...state, firstEventAt, status: "streaming", usage: action.usage };
    case "done":
      return {
        ...state,
        completedAt: occurredAt,
        finishReason: action.finishReason,
        firstEventAt,
        responseId: action.responseId ?? state.responseId,
        status: "done",
      };
    case "error":
      return {
        ...state,
        blocks: appendErrorBlock(state.blocks, action.error.code, action.error.message),
        completedAt: occurredAt,
        error: action.error,
        firstEventAt,
        finishReason: "error",
        status: "error",
      };
    case "interrupted":
      return {
        ...state,
        blocks: appendErrorBlock(state.blocks, action.code ?? "interrupted", action.message),
        completedAt: occurredAt,
        finishReason: action.finishReason,
        status: "interrupted",
      };
  }
}

export function isTerminalStatus(status: ActiveRequestStatus): status is TerminalRequestStatus {
  return status === "done" || status === "interrupted" || status === "error";
}

export function isValuableStreamEvent(event: StreamDomainEvent): boolean {
  return event.type !== "error";
}

function appendDelta(
  envelope: MessageBlocks,
  type: "text" | "thinking",
  delta: string,
  visibility: string,
): MessageBlocks {
  if (delta === "") {
    return envelope;
  }

  const blocks = [...envelope.blocks];
  const last = blocks.at(-1);
  if (type === "text" && last?.type === "text") {
    blocks[blocks.length - 1] = { ...last, text: `${last.text}${delta}` };
  } else if (type === "thinking" && last?.type === "thinking" && last.visibility === visibility) {
    blocks[blocks.length - 1] = { ...last, text: `${last.text}${delta}` };
  } else {
    const block: MessageBlock =
      type === "text"
        ? { type: "text", text: delta }
        : { type: "thinking", text: delta, visibility };
    blocks.push(block);
  }
  return { version: 1, blocks };
}

function appendErrorBlock(envelope: MessageBlocks, code: string, message: string): MessageBlocks {
  return {
    version: 1,
    blocks: [...envelope.blocks, { type: "error", code, message, retryable: false }],
  };
}
