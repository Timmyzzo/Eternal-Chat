import type {
  CitationBlock,
  MessageBlock,
  MessageBlocks,
  MessageStatus,
  ProviderStateBlock,
  RequestAttempt,
  SourceBlock,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResult,
} from "@/domain/chat";
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

export interface ToolCallStart {
  id: string;
  name: string;
  args?: JsonValue;
  source?: "client" | "mcp" | "provider";
  providerMeta?: JsonObject;
}

export interface ToolResultEvent extends ToolResult {
  providerMeta?: JsonObject;
}

export interface SourceEvent {
  id: string;
  kind: "web" | "x_post" | "file" | "database" | "other";
  title?: string;
  url?: string;
  preview?: string;
  favicon?: string;
  authorName?: string;
  authorHandle?: string;
  publishedAt?: string;
  toolCallId?: string;
  providerMeta?: JsonObject;
}

export interface CitationEvent {
  id: string;
  sourceId: string;
  marker?: string;
  range?: JsonObject;
  url?: string;
  title?: string;
  toolCallId?: string;
  providerMeta?: JsonObject;
}

export interface AgentStatusEvent {
  id: string;
  status: string;
  label?: string;
  rolloutId?: string;
  activeItem?: string;
  providerMeta?: JsonObject;
}

export type StreamDomainEvent =
  | { type: "started"; responseId?: string }
  | { type: "heartbeat"; idleMs: number }
  | { type: "text_delta"; blockId?: string; delta: string }
  | {
      type: "thinking_started";
      blockId: string;
      label?: string;
      visibility: string;
    }
  | {
      type: "thinking_delta";
      blockId?: string;
      delta: string;
      label?: string;
      visibility: string;
    }
  | { type: "thinking_completed"; blockId: string; durationMs?: number }
  | { type: "tool_call_started"; call: ToolCallStart }
  | { type: "tool_call_delta"; id: string; argsDelta?: string }
  | { type: "tool_call_completed"; id: string; args?: JsonValue }
  | { type: "tool_result"; id: string; result: ToolResultEvent }
  | { type: "source"; source: SourceEvent }
  | { type: "citation"; citation: CitationEvent }
  | { type: "agent_status"; agent: AgentStatusEvent }
  | { type: "usage"; usage: JsonValue }
  | { type: "metadata"; key: string; value: JsonValue }
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
  eventSeq: number;
  finishReason: string | null;
  firstEventAt: number | null;
  firstTextAt: number | null;
  lastEventAt: number | null;
  maxAttempts: number;
  requestId: string;
  responseId: string | null;
  retry: RetryWaitState | null;
  startedAt: number;
  status: ActiveRequestStatus;
  transportRequestId: string;
  usage: JsonValue | null;
}

const TIMELINE_LIMIT = 512;
const DEFAULT_TEXT_BLOCK_ID = "output_text";
const DEFAULT_THINKING_BLOCK_ID = "reasoning";

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
    blocks: { version: 1, blocks: [], timeline: [] },
    completedAt: null,
    error: null,
    eventSeq: 0,
    finishReason: null,
    firstEventAt: null,
    firstTextAt: null,
    lastEventAt: null,
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

  const eventSeq = state.eventSeq + 1;
  const firstEventAt =
    action.type === "heartbeat" ? state.firstEventAt : (state.firstEventAt ?? occurredAt);
  const common = {
    eventSeq,
    firstEventAt,
    lastEventAt: occurredAt,
  };

  switch (action.type) {
    case "started":
      return {
        ...state,
        ...common,
        blocks: recordTimeline(state.blocks, action, occurredAt, eventSeq),
        responseId: action.responseId ?? state.responseId,
        status: "streaming",
      };
    case "heartbeat":
      return {
        ...state,
        ...common,
        blocks: recordTimeline(state.blocks, action, occurredAt, eventSeq),
      };
    case "text_delta": {
      const blocks = appendTextDelta(
        state.blocks,
        action.blockId ?? DEFAULT_TEXT_BLOCK_ID,
        action.delta,
      );
      return {
        ...state,
        ...common,
        blocks: recordTimeline(blocks, action, occurredAt, eventSeq),
        firstTextAt: state.firstTextAt ?? occurredAt,
        status: "streaming",
      };
    }
    case "thinking_started": {
      const blocks = startThinkingBlock(state.blocks, action, occurredAt);
      return {
        ...state,
        ...common,
        blocks: recordTimeline(blocks, action, occurredAt, eventSeq),
        status: "streaming",
      };
    }
    case "thinking_delta": {
      const blocks = appendThinkingDelta(
        state.blocks,
        action.blockId ?? DEFAULT_THINKING_BLOCK_ID,
        action.delta,
        action.visibility,
        action.label,
        occurredAt,
      );
      return {
        ...state,
        ...common,
        blocks: recordTimeline(blocks, action, occurredAt, eventSeq),
        status: "streaming",
      };
    }
    case "thinking_completed": {
      const blocks = completeThinkingBlock(state.blocks, action, occurredAt);
      return {
        ...state,
        ...common,
        blocks: recordTimeline(blocks, action, occurredAt, eventSeq),
        status: "streaming",
      };
    }
    case "tool_call_started": {
      const blocks = startToolCall(state.blocks, action.call, occurredAt);
      return {
        ...state,
        ...common,
        blocks: recordTimeline(blocks, action, occurredAt, eventSeq),
        status: "streaming",
      };
    }
    case "tool_call_delta": {
      const blocks = appendToolCallDelta(state.blocks, action.id, action.argsDelta);
      return {
        ...state,
        ...common,
        blocks: recordTimeline(blocks, action, occurredAt, eventSeq),
        status: "streaming",
      };
    }
    case "tool_call_completed": {
      const blocks = completeToolCall(state.blocks, action.id, action.args, occurredAt);
      return {
        ...state,
        ...common,
        blocks: recordTimeline(blocks, action, occurredAt, eventSeq),
        status: "streaming",
      };
    }
    case "tool_result": {
      const blocks = applyToolResult(state.blocks, action.id, action.result, occurredAt);
      return {
        ...state,
        ...common,
        blocks: recordTimeline(blocks, action, occurredAt, eventSeq),
        status: "streaming",
      };
    }
    case "source": {
      const blocks = upsertSource(state.blocks, action.source, occurredAt);
      return {
        ...state,
        ...common,
        blocks: recordTimeline(blocks, action, occurredAt, eventSeq),
        status: "streaming",
      };
    }
    case "citation": {
      const blocks = upsertCitation(state.blocks, action.citation, occurredAt);
      return {
        ...state,
        ...common,
        blocks: recordTimeline(blocks, action, occurredAt, eventSeq),
        status: "streaming",
      };
    }
    case "agent_status": {
      const blocks = upsertProviderState(
        state.blocks,
        `agent:${action.agent.id}`,
        "agent_status",
        {
          id: action.agent.id,
          status: action.agent.status,
          ...(action.agent.label ? { label: action.agent.label } : {}),
          ...(action.agent.rolloutId ? { rolloutId: action.agent.rolloutId } : {}),
          ...(action.agent.activeItem ? { activeItem: action.agent.activeItem } : {}),
          ...(action.agent.providerMeta ? { providerMeta: action.agent.providerMeta } : {}),
        },
        occurredAt,
      );
      return {
        ...state,
        ...common,
        blocks: recordTimeline(blocks, action, occurredAt, eventSeq),
        status: "streaming",
      };
    }
    case "metadata": {
      const blocks = upsertProviderState(
        state.blocks,
        `metadata:${action.key}`,
        action.key,
        action.value,
        occurredAt,
      );
      return {
        ...state,
        ...common,
        blocks: recordTimeline(blocks, action, occurredAt, eventSeq),
        status: "streaming",
      };
    }
    case "usage":
      return {
        ...state,
        ...common,
        blocks: recordTimeline(state.blocks, action, occurredAt, eventSeq),
        status: "streaming",
        usage: action.usage,
      };
    case "done": {
      const completedBlocks = completeOpenBlocks(state.blocks, occurredAt);
      return {
        ...state,
        ...common,
        blocks: recordTimeline(completedBlocks, action, occurredAt, eventSeq),
        completedAt: occurredAt,
        finishReason: action.finishReason,
        responseId: action.responseId ?? state.responseId,
        status: "done",
      };
    }
    case "error": {
      const blocks = appendErrorBlock(
        cancelOpenTools(completeOpenThinkingBlocks(state.blocks, occurredAt), occurredAt),
        action.error.code,
        action.error.message,
      );
      return {
        ...state,
        ...common,
        blocks: recordTimeline(blocks, action, occurredAt, eventSeq),
        completedAt: occurredAt,
        error: action.error,
        finishReason: "error",
        status: "error",
      };
    }
    case "interrupted": {
      const blocks = appendErrorBlock(
        cancelOpenTools(completeOpenThinkingBlocks(state.blocks, occurredAt), occurredAt),
        action.code ?? "interrupted",
        action.message,
      );
      return {
        ...state,
        ...common,
        blocks: recordTimeline(blocks, action, occurredAt, eventSeq),
        completedAt: occurredAt,
        finishReason: action.finishReason,
        status: "interrupted",
      };
    }
  }
}

export function isTerminalStatus(status: ActiveRequestStatus): status is TerminalRequestStatus {
  return status === "done" || status === "interrupted" || status === "error";
}

export function isValuableStreamEvent(event: StreamDomainEvent): boolean {
  return event.type !== "error" && event.type !== "heartbeat";
}

function appendTextDelta(envelope: MessageBlocks, blockId: string, delta: string): MessageBlocks {
  if (delta === "") return envelope;
  const blocks = [...envelope.blocks];
  const index = blocks.findIndex(
    (block) => isTextBlock(block) && (block.blockId ?? DEFAULT_TEXT_BLOCK_ID) === blockId,
  );
  if (index >= 0) {
    const block = blocks[index];
    if (block && isTextBlock(block)) {
      blocks[index] = { ...block, blockId, text: `${block.text}${delta}` };
    }
  } else {
    blocks.push({ type: "text", blockId, text: delta });
  }
  return withBlocks(envelope, blocks);
}

function startThinkingBlock(
  envelope: MessageBlocks,
  event: Extract<StreamDomainEvent, { type: "thinking_started" }>,
  occurredAt: number,
): MessageBlocks {
  const blocks = [...envelope.blocks];
  const index = findThinkingBlock(blocks, event.blockId);
  if (index >= 0) {
    const block = blocks[index];
    if (block && isThinkingBlock(block)) {
      blocks[index] = {
        ...block,
        label: event.label ?? block.label,
        startedAt: block.startedAt ?? occurredAt,
        visibility: event.visibility,
      };
    }
  } else {
    blocks.push({
      type: "thinking",
      blockId: event.blockId,
      label: event.label,
      startedAt: occurredAt,
      text: "",
      visibility: event.visibility,
    });
  }
  return withBlocks(envelope, blocks);
}

function appendThinkingDelta(
  envelope: MessageBlocks,
  blockId: string,
  delta: string,
  visibility: string,
  label: string | undefined,
  occurredAt: number,
): MessageBlocks {
  if (delta === "") return envelope;
  const started = startThinkingBlock(
    envelope,
    { type: "thinking_started", blockId, label, visibility },
    occurredAt,
  );
  const blocks = [...started.blocks];
  const index = findThinkingBlock(blocks, blockId);
  const block = blocks[index];
  if (index >= 0 && block && isThinkingBlock(block)) {
    blocks[index] = { ...block, text: `${block.text}${delta}` };
  }
  return withBlocks(started, blocks);
}

function completeThinkingBlock(
  envelope: MessageBlocks,
  event: Extract<StreamDomainEvent, { type: "thinking_completed" }>,
  occurredAt: number,
): MessageBlocks {
  const blocks = [...envelope.blocks];
  const index = findThinkingBlock(blocks, event.blockId);
  const block = blocks[index];
  if (index >= 0 && block && isThinkingBlock(block)) {
    const durationMs =
      event.durationMs ??
      (block.startedAt === undefined ? undefined : occurredAt - block.startedAt);
    blocks[index] = {
      ...block,
      ...(durationMs === undefined ? {} : { durationMs: Math.max(0, durationMs) }),
      finishedAt: occurredAt,
    };
  }
  return withBlocks(envelope, blocks);
}

function startToolCall(
  envelope: MessageBlocks,
  call: ToolCallStart,
  occurredAt: number,
): MessageBlocks {
  const blocks = [...envelope.blocks];
  const index = findToolCall(blocks, call.id);
  if (index >= 0) {
    const block = blocks[index];
    if (block && isToolCallBlock(block)) {
      blocks[index] = {
        ...block,
        args: call.args ?? block.args,
        name: call.name || block.name,
        providerMeta: { ...block.providerMeta, ...call.providerMeta },
        startedAt: block.startedAt ?? occurredAt,
        status: block.status === "requested" ? "running" : block.status,
      };
    }
  } else {
    blocks.push({
      type: "tool_call",
      id: call.id,
      name: call.name,
      args: call.args ?? {},
      status: "running",
      source: call.source ?? "provider",
      startedAt: occurredAt,
      ...(call.providerMeta ? { providerMeta: call.providerMeta } : {}),
    });
  }
  return withBlocks(envelope, blocks);
}

function appendToolCallDelta(
  envelope: MessageBlocks,
  id: string,
  argsDelta: string | undefined,
): MessageBlocks {
  if (!argsDelta) return envelope;
  const blocks = [...envelope.blocks];
  const index = findToolCall(blocks, id);
  const block = blocks[index];
  if (index < 0 || !block || !isToolCallBlock(block)) return envelope;
  const previous =
    typeof block.providerMeta?.argsText === "string" ? block.providerMeta.argsText : "";
  const argsText = `${previous}${argsDelta}`;
  blocks[index] = {
    ...block,
    args: parseJsonOrText(argsText),
    providerMeta: { ...block.providerMeta, argsText },
  };
  return withBlocks(envelope, blocks);
}

function completeToolCall(
  envelope: MessageBlocks,
  id: string,
  args: JsonValue | undefined,
  occurredAt: number,
): MessageBlocks {
  const blocks = [...envelope.blocks];
  const index = findToolCall(blocks, id);
  const block = blocks[index];
  if (index < 0 || !block || !isToolCallBlock(block)) return envelope;
  blocks[index] = {
    ...block,
    args: args ?? block.args,
    finishedAt: block.finishedAt ?? occurredAt,
  };
  return withBlocks(envelope, blocks);
}

function applyToolResult(
  envelope: MessageBlocks,
  id: string,
  result: ToolResultEvent,
  occurredAt: number,
): MessageBlocks {
  const blocks = [...envelope.blocks];
  const index = findToolCall(blocks, id);
  if (index < 0) {
    blocks.push({
      type: "tool_call",
      id,
      name: "provider_tool",
      args: {},
      status: result.error ? "failed" : "succeeded",
      source: "provider",
      finishedAt: occurredAt,
      result: toolResult(result),
      ...(result.providerMeta ? { providerMeta: result.providerMeta } : {}),
    });
  } else {
    const block = blocks[index];
    if (block && isToolCallBlock(block)) {
      blocks[index] = {
        ...block,
        finishedAt: occurredAt,
        providerMeta: { ...block.providerMeta, ...result.providerMeta },
        result: toolResult(result),
        status: result.error ? "failed" : "succeeded",
      };
    }
  }
  return withBlocks(envelope, blocks);
}

function upsertSource(
  envelope: MessageBlocks,
  source: SourceEvent,
  occurredAt: number,
): MessageBlocks {
  const blocks = [...envelope.blocks];
  const index = blocks.findIndex((block) => isSourceBlock(block) && block.id === source.id);
  const toolCallIds = source.toolCallId ? [source.toolCallId] : [];
  const next: SourceBlock = {
    type: "source",
    id: source.id,
    kind: source.kind,
    ...(source.title ? { title: source.title } : {}),
    ...(source.url ? { url: source.url } : {}),
    ...(source.preview ? { preview: source.preview } : {}),
    ...(source.favicon ? { favicon: source.favicon } : {}),
    ...(source.authorName ? { authorName: source.authorName } : {}),
    ...(source.authorHandle ? { authorHandle: source.authorHandle } : {}),
    ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
    ...(source.toolCallId ? { toolCallId: source.toolCallId, toolCallIds } : {}),
    ...(source.providerMeta ? { providerMeta: source.providerMeta } : {}),
    receivedAt: occurredAt,
  };
  if (index >= 0) {
    const existing = blocks[index];
    if (existing && isSourceBlock(existing)) {
      const related = new Set([...(existing.toolCallIds ?? []), ...toolCallIds]);
      blocks[index] = {
        ...existing,
        ...next,
        toolCallId: existing.toolCallId ?? next.toolCallId,
        ...(related.size > 0 ? { toolCallIds: [...related] } : {}),
      };
    }
  } else {
    blocks.push(next);
  }
  return withBlocks(envelope, blocks);
}

function upsertCitation(
  envelope: MessageBlocks,
  citation: CitationEvent,
  occurredAt: number,
): MessageBlocks {
  const blocks = [...envelope.blocks];
  const index = blocks.findIndex(
    (block) => isCitationBlock(block) && (block.id ?? citationKey(block)) === citation.id,
  );
  const next: CitationBlock = {
    type: "citation",
    id: citation.id,
    sourceId: citation.sourceId,
    ...(citation.marker ? { marker: citation.marker } : {}),
    ...(citation.range ? { range: citation.range } : {}),
    ...(citation.url ? { url: citation.url } : {}),
    ...(citation.title ? { title: citation.title } : {}),
    ...(citation.toolCallId ? { toolCallId: citation.toolCallId } : {}),
    ...(citation.providerMeta ? { providerMeta: citation.providerMeta } : {}),
    receivedAt: occurredAt,
  };
  if (index >= 0) blocks[index] = { ...blocks[index], ...next } as CitationBlock;
  else blocks.push(next);
  return withBlocks(envelope, blocks);
}

function upsertProviderState(
  envelope: MessageBlocks,
  id: string,
  purpose: string,
  data: JsonValue,
  occurredAt: number,
): MessageBlocks {
  const blocks = [...envelope.blocks];
  const index = blocks.findIndex((block) => isProviderStateBlock(block) && block.id === id);
  const next: MessageBlock = {
    type: "provider_state",
    id,
    provider: "openai_compatible",
    purpose,
    data,
    receivedAt: occurredAt,
  };
  if (index >= 0) blocks[index] = next;
  else blocks.push(next);
  return withBlocks(envelope, blocks);
}

function completeOpenBlocks(envelope: MessageBlocks, occurredAt: number): MessageBlocks {
  const completedThinking = completeOpenThinkingBlocks(envelope, occurredAt);
  const blocks = completedThinking.blocks.map((block) => {
    if (isToolCallBlock(block) && block.status === "running") {
      return { ...block, finishedAt: block.finishedAt ?? occurredAt, status: "requested" as const };
    }
    return block;
  });
  return withBlocks(completedThinking, blocks);
}

function completeOpenThinkingBlocks(envelope: MessageBlocks, occurredAt: number): MessageBlocks {
  return withBlocks(
    envelope,
    envelope.blocks.map((block) =>
      isThinkingBlock(block) && block.finishedAt === undefined
        ? {
            ...block,
            durationMs:
              block.startedAt === undefined ? undefined : Math.max(0, occurredAt - block.startedAt),
            finishedAt: occurredAt,
          }
        : block,
    ),
  );
}

function cancelOpenTools(envelope: MessageBlocks, occurredAt: number): MessageBlocks {
  return withBlocks(
    envelope,
    envelope.blocks.map((block) =>
      isToolCallBlock(block) && block.status === "running"
        ? { ...block, finishedAt: occurredAt, status: "cancelled" as const }
        : block,
    ),
  );
}

function appendErrorBlock(envelope: MessageBlocks, code: string, message: string): MessageBlocks {
  return withBlocks(envelope, [
    ...envelope.blocks,
    { type: "error", code, message, retryable: false },
  ]);
}

function recordTimeline(
  envelope: MessageBlocks,
  action: StreamLifecycleAction,
  occurredAt: number,
  seq: number,
): MessageBlocks {
  const timeline = [
    ...(envelope.timeline ?? []),
    { seq, ts: occurredAt, type: action.type, details: timelineDetails(action) },
  ];
  return { ...envelope, timeline: timeline.slice(-TIMELINE_LIMIT) };
}

function timelineDetails(action: StreamLifecycleAction): JsonObject {
  switch (action.type) {
    case "started":
      return action.responseId ? { responseId: action.responseId } : {};
    case "heartbeat":
      return { idleMs: action.idleMs };
    case "text_delta":
      return { blockId: action.blockId ?? DEFAULT_TEXT_BLOCK_ID, length: action.delta.length };
    case "thinking_started":
      return {
        blockId: action.blockId,
        visibility: action.visibility,
        ...(action.label ? { label: action.label } : {}),
      };
    case "thinking_delta":
      return {
        blockId: action.blockId ?? DEFAULT_THINKING_BLOCK_ID,
        length: action.delta.length,
        visibility: action.visibility,
      };
    case "thinking_completed":
      return {
        blockId: action.blockId,
        ...(action.durationMs === undefined ? {} : { durationMs: action.durationMs }),
      };
    case "tool_call_started":
      return { id: action.call.id, name: action.call.name };
    case "tool_call_delta":
      return { id: action.id, length: action.argsDelta?.length ?? 0 };
    case "tool_call_completed":
      return { id: action.id };
    case "tool_result":
      return { id: action.id, status: action.result.error ? "failed" : "succeeded" };
    case "source":
      return { id: action.source.id, kind: action.source.kind };
    case "citation":
      return { id: action.citation.id, sourceId: action.citation.sourceId };
    case "agent_status":
      return { id: action.agent.id, status: action.agent.status };
    case "usage":
      return {};
    case "metadata":
      return { key: action.key };
    case "done":
      return {
        finishReason: action.finishReason ?? "unknown",
        ...(action.responseId ? { responseId: action.responseId } : {}),
      };
    case "error":
      return { code: action.error.code };
    case "interrupted":
      return { code: action.code ?? "interrupted", finishReason: action.finishReason };
  }
}

function findThinkingBlock(blocks: readonly MessageBlock[], blockId: string): number {
  return blocks.findIndex(
    (block) => isThinkingBlock(block) && (block.blockId ?? DEFAULT_THINKING_BLOCK_ID) === blockId,
  );
}

function findToolCall(blocks: readonly MessageBlock[], id: string): number {
  return blocks.findIndex((block) => isToolCallBlock(block) && block.id === id);
}

function withBlocks(envelope: MessageBlocks, blocks: MessageBlock[]): MessageBlocks {
  return { ...envelope, blocks };
}

function parseJsonOrText(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

function toolResult(result: ToolResultEvent): ToolResult {
  return {
    modelContent: result.modelContent,
    ...(result.rawRef ? { rawRef: result.rawRef } : {}),
    ...(result.rawHash ? { rawHash: result.rawHash } : {}),
    ...(result.mimeType ? { mimeType: result.mimeType } : {}),
    ...(result.truncatedAtSource === undefined
      ? {}
      : { truncatedAtSource: result.truncatedAtSource }),
    ...(result.error ? { error: result.error } : {}),
  };
}

function citationKey(citation: CitationBlock): string {
  return `${citation.sourceId}:${citation.marker ?? ""}:${JSON.stringify(citation.range ?? {})}`;
}

function isTextBlock(block: MessageBlock): block is TextBlock {
  return block.type === "text" && typeof block.text === "string";
}

function isThinkingBlock(block: MessageBlock): block is ThinkingBlock {
  return block.type === "thinking" && typeof block.text === "string";
}

function isToolCallBlock(block: MessageBlock): block is ToolCallBlock {
  return block.type === "tool_call" && typeof block.id === "string";
}

function isSourceBlock(block: MessageBlock): block is SourceBlock {
  return block.type === "source" && typeof block.id === "string";
}

function isCitationBlock(block: MessageBlock): block is CitationBlock {
  return block.type === "citation" && typeof block.sourceId === "string";
}

function isProviderStateBlock(block: MessageBlock): block is ProviderStateBlock {
  return block.type === "provider_state" && typeof block.purpose === "string";
}
