import type { JsonObject, JsonValue } from "@/domain/json";
import type {
  CitationEvent,
  SourceEvent,
  StreamDomainEvent,
  StreamErrorCode,
  ToolCallStart,
} from "@/domain/streaming";
import type { ProtocolProfile } from "@/domain/provider";
import {
  OPENAI_CHAT_COMPLETIONS_CODEC,
  OPENAI_RESPONSES_CODEC,
} from "@/infrastructure/providers/openai/protocolProfiles";

export interface OpenAIStreamParser {
  finish(): StreamDomainEvent[];
  push(data: string): StreamDomainEvent[];
}

export type OpenAIStreamParserFactory = () => OpenAIStreamParser;

interface ToolAccumulator {
  argsText: string;
  id: string;
  name: string;
}

export function parserFactoryForProfile(profile: ProtocolProfile): OpenAIStreamParserFactory {
  if (profile.codecId === OPENAI_CHAT_COMPLETIONS_CODEC) {
    const reasoningPaths = readReasoningDeltaPaths(profile.responseMapping);
    return () => new ChatCompletionsStreamParser(reasoningPaths);
  }
  if (profile.codecId === OPENAI_RESPONSES_CODEC) {
    return () => new ResponsesStreamParser();
  }
  throw new Error(`Unsupported Phase 7 codec: ${profile.codecId}`);
}

export class ChatCompletionsStreamParser implements OpenAIStreamParser {
  private finishReason: string | null = null;
  private responseId: string | undefined;
  private terminal = false;
  private readonly openThinking = new Set<string>();
  private readonly tools = new Map<number, ToolAccumulator>();

  constructor(private readonly reasoningDeltaPaths: readonly string[] = []) {}

  push(data: string): StreamDomainEvent[] {
    if (data.trim() === "") return [];
    if (this.terminal) {
      return [streamError("chat_event_after_terminal", "Chat data arrived after [DONE].")];
    }
    if (data.trim() === "[DONE]") {
      this.terminal = true;
      return [
        ...this.completeOpenStructures(),
        { type: "done", finishReason: this.finishReason, responseId: this.responseId },
      ];
    }

    const parsed = parseObject(data);
    if (!parsed) {
      this.terminal = true;
      return [streamError("chat_malformed_json", "Chat stream data is not valid JSON.")];
    }
    if (isRecord(parsed.error)) {
      this.terminal = true;
      return [
        streamError(
          "chat_stream_error",
          readString(parsed.error.message) ?? "The Chat stream returned an error.",
          { embedded: true, providerCode: readString(parsed.error.code) ?? "unknown" },
        ),
      ];
    }

    const events: StreamDomainEvent[] = [];
    const responseId = readString(parsed.id);
    if (responseId && responseId !== this.responseId) {
      this.responseId = responseId;
      events.push({ type: "started", responseId });
    }

    if (Array.isArray(parsed.choices)) {
      parsed.choices.forEach((choice) => {
        if (!isRecord(choice)) return;
        const finishReason = readString(choice.finish_reason);
        if (finishReason) this.finishReason = finishReason;
        if (!isRecord(choice.delta)) return;

        const content = readString(choice.delta.content);
        if (content) events.push({ type: "text_delta", blockId: "output_text", delta: content });

        this.reasoningDeltaPaths.forEach((path, pathIndex) => {
          const reasoning = readStringAtPath(choice.delta as JsonObject, path);
          if (!reasoning) return;
          const blockId = `reasoning:${pathIndex}`;
          if (!this.openThinking.has(blockId)) {
            this.openThinking.add(blockId);
            events.push({
              type: "thinking_started",
              blockId,
              label: "Provider reasoning",
              visibility: "provider_returned",
            });
          }
          events.push({
            type: "thinking_delta",
            blockId,
            delta: reasoning,
            label: "Provider reasoning",
            visibility: "provider_returned",
          });
        });

        if (Array.isArray(choice.delta.tool_calls)) {
          choice.delta.tool_calls.forEach((tool) => {
            if (!isRecord(tool)) return;
            events.push(...this.consumeChatToolDelta(tool));
          });
        }
        if (isRecord(choice.delta.function_call)) {
          events.push(
            ...this.consumeChatToolDelta({
              function: choice.delta.function_call,
              id: "legacy_function_call",
              index: -1,
            }),
          );
        }
      });
    }

    if (isJsonValue(parsed.usage)) events.push({ type: "usage", usage: parsed.usage });
    return events;
  }

  finish(): StreamDomainEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return [streamError("chat_missing_terminal", "Chat stream ended before [DONE].")];
  }

  private consumeChatToolDelta(tool: JsonObject): StreamDomainEvent[] {
    const index = readNumber(tool.index) ?? this.tools.size;
    const current = this.tools.get(index);
    const fn = isRecord(tool.function) ? tool.function : tool;
    const id = readString(tool.id) ?? current?.id ?? `chat-tool-${index}`;
    const name = readString(fn.name) ?? current?.name ?? "function";
    const argsDelta = readString(fn.arguments);
    const events: StreamDomainEvent[] = [];
    if (!current) {
      const call: ToolCallStart = {
        id,
        name,
        args: {},
        source: "provider",
        providerMeta: { protocol: "chat_completions", toolIndex: index },
      };
      events.push({ type: "tool_call_started", call });
    }
    const next = { id, name, argsText: `${current?.argsText ?? ""}${argsDelta ?? ""}` };
    this.tools.set(index, next);
    if (argsDelta) events.push({ type: "tool_call_delta", id, argsDelta });
    return events;
  }

  private completeOpenStructures(): StreamDomainEvent[] {
    const events: StreamDomainEvent[] = [];
    this.openThinking.forEach((blockId) => events.push({ type: "thinking_completed", blockId }));
    this.openThinking.clear();
    this.tools.forEach((tool) =>
      events.push({
        type: "tool_call_completed",
        id: tool.id,
        args: parseJsonValue(tool.argsText, {}),
      }),
    );
    this.tools.clear();
    return events;
  }
}

const RESPONSES_IGNORED_EVENTS = new Set([
  "response.queued",
  "response.in_progress",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.done",
  "response.refusal.done",
]);

const PROVIDER_TOOL_ITEM_TYPES = new Set([
  "code_interpreter_call",
  "computer_call",
  "custom_tool_call",
  "file_search_call",
  "function_call",
  "image_generation_call",
  "mcp_call",
  "web_search_call",
  "x_search_call",
]);

const BUILT_IN_RESULT_TYPES = new Set([
  "code_interpreter_call",
  "computer_call",
  "file_search_call",
  "image_generation_call",
  "mcp_call",
  "web_search_call",
  "x_search_call",
]);

export class ResponsesStreamParser implements OpenAIStreamParser {
  private responseId: string | undefined;
  private terminal = false;
  private readonly openThinking = new Set<string>();
  private readonly startedTools = new Set<string>();
  private readonly toolArgs = new Map<string, string>();

  push(data: string): StreamDomainEvent[] {
    if (data.trim() === "") return [];
    if (this.terminal) {
      return [
        streamError(
          "responses_event_after_terminal",
          "Responses data arrived after a terminal event.",
        ),
      ];
    }

    const parsed = parseObject(data);
    if (!parsed) {
      this.terminal = true;
      return [
        streamError("responses_malformed_event", "Responses stream data is not a JSON object."),
      ];
    }
    const eventType = readString(parsed.type);
    if (!eventType) {
      this.terminal = true;
      return [streamError("responses_malformed_event", "Responses stream event type is missing.")];
    }

    if (eventType === "response.created") return this.responseCreated(parsed);
    if (eventType === "response.output_text.delta" || eventType === "response.refusal.delta") {
      const delta = readString(parsed.delta);
      return delta ? [{ type: "text_delta", blockId: "output_text", delta }] : [];
    }
    if (eventType === "response.reasoning_summary_part.added") {
      return this.startThinking(parsed, "reasoning_summary", "Reasoning summary", "summary");
    }
    if (eventType === "response.reasoning_summary_text.delta") {
      return this.thinkingDelta(parsed, "reasoning_summary", "Reasoning summary", "summary");
    }
    if (
      eventType === "response.reasoning_summary_text.done" ||
      eventType === "response.reasoning_summary_part.done"
    ) {
      return this.completeThinking(blockIdFromEvent(parsed, "reasoning_summary"));
    }
    if (eventType === "response.reasoning_text.delta") {
      return this.thinkingDelta(parsed, "reasoning", "Provider reasoning", "provider_returned");
    }
    if (eventType === "response.reasoning_text.done") {
      return this.completeThinking(blockIdFromEvent(parsed, "reasoning"));
    }
    if (eventType === "response.output_item.added") {
      return isRecord(parsed.item) ? this.outputItemEvents(parsed.item, parsed, false) : [];
    }
    if (eventType === "response.output_item.done") {
      return isRecord(parsed.item) ? this.outputItemEvents(parsed.item, parsed, true) : [];
    }
    if (eventType === "response.function_call_arguments.delta") {
      return this.functionArgumentsDelta(parsed);
    }
    if (eventType === "response.function_call_arguments.done") {
      return this.functionArgumentsDone(parsed);
    }
    if (/^response\.(web_search|x_search|file_search)_call\./.test(eventType)) {
      return this.searchLifecycleEvents(parsed, eventType);
    }
    if (eventType === "response.output_text.annotation.added" && isRecord(parsed.annotation)) {
      return annotationEvents(parsed.annotation, readString(parsed.item_id));
    }
    if (
      eventType === "response.agent_status" ||
      eventType === "response.agent.status" ||
      eventType === "response.rollout_status" ||
      eventType === "response.rollout.status"
    ) {
      return agentStatusEvents(parsed);
    }
    if (eventType === "response.completed") return this.completeResponse(parsed);
    if (eventType === "response.failed") {
      this.terminal = true;
      const response = isRecord(parsed.response) ? parsed.response : {};
      const error = isRecord(response.error) ? response.error : {};
      return [
        streamError(
          "responses_failed",
          readString(error.message) ?? "The Responses request failed.",
          { embedded: true, providerCode: readString(error.code) ?? "unknown" },
        ),
      ];
    }
    if (eventType === "response.incomplete") {
      this.terminal = true;
      const response = isRecord(parsed.response) ? parsed.response : {};
      const details = isRecord(response.incomplete_details) ? response.incomplete_details : {};
      return [
        streamError("responses_incomplete", "The Responses request ended incomplete.", {
          reason: readString(details.reason) ?? "unknown",
        }),
      ];
    }
    if (eventType === "error") {
      this.terminal = true;
      return [
        streamError(
          "responses_error",
          readString(parsed.message) ?? "The Responses stream returned an error.",
          { embedded: true, providerCode: readString(parsed.code) ?? "unknown" },
        ),
      ];
    }
    if (RESPONSES_IGNORED_EVENTS.has(eventType)) return [];

    return [
      {
        type: "metadata",
        key: "compatibility_warning",
        value: { code: "responses_unknown_event", eventType },
      },
    ];
  }

  finish(): StreamDomainEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return [
      streamError("responses_missing_terminal", "Responses stream ended before a terminal event."),
    ];
  }

  private responseCreated(event: JsonObject): StreamDomainEvent[] {
    const response = isRecord(event.response) ? event.response : {};
    const responseId = readString(response.id);
    if (responseId) this.responseId = responseId;
    const events: StreamDomainEvent[] = [
      { type: "started", ...(responseId ? { responseId } : {}) },
    ];
    const previousResponseId = readString(response.previous_response_id);
    if (previousResponseId) {
      events.push({ type: "metadata", key: "previous_response_id", value: previousResponseId });
    }
    if (isJsonValue(response.reasoning)) {
      events.push({ type: "metadata", key: "reasoning_layout", value: response.reasoning });
    }
    const rolloutIds = jsonValueAt(response, "rollout_ids") ?? jsonValueAt(response, "rolloutIds");
    if (rolloutIds !== undefined) {
      events.push({ type: "metadata", key: "rollout_ids", value: rolloutIds });
    }
    return events;
  }

  private startThinking(
    event: JsonObject,
    fallbackId: string,
    label: string,
    visibility: string,
  ): StreamDomainEvent[] {
    const blockId = blockIdFromEvent(event, fallbackId);
    if (this.openThinking.has(blockId)) return [];
    this.openThinking.add(blockId);
    return [{ type: "thinking_started", blockId, label, visibility }];
  }

  private thinkingDelta(
    event: JsonObject,
    fallbackId: string,
    label: string,
    visibility: string,
  ): StreamDomainEvent[] {
    const delta = readString(event.delta);
    if (!delta) return [];
    const blockId = blockIdFromEvent(event, fallbackId);
    return [
      ...this.startThinking(event, fallbackId, label, visibility),
      { type: "thinking_delta", blockId, delta, label, visibility },
    ];
  }

  private completeThinking(blockId: string): StreamDomainEvent[] {
    if (!this.openThinking.delete(blockId)) return [];
    return [{ type: "thinking_completed", blockId }];
  }

  private outputItemEvents(
    item: JsonObject,
    envelope: JsonObject,
    done: boolean,
  ): StreamDomainEvent[] {
    const events: StreamDomainEvent[] = [];
    if (isProviderToolItem(item)) {
      const call = toolCallFromItem(item, envelope);
      if (call && !this.startedTools.has(call.id)) {
        this.startedTools.add(call.id);
        events.push({ type: "tool_call_started", call });
      }
      if (call && done) {
        events.push({ type: "tool_call_completed", id: call.id, args: call.args });
        if (BUILT_IN_RESULT_TYPES.has(readString(item.type) ?? "")) {
          const failed = readString(item.status) === "failed";
          const error = failed
            ? (providerError(item) ?? { message: "The provider tool failed." })
            : undefined;
          events.push({
            type: "tool_result",
            id: call.id,
            result: {
              modelContent: item,
              ...(error ? { error } : {}),
              providerMeta: { itemType: readString(item.type) ?? "provider_tool" },
            },
          });
        }
      }
    }
    events.push(
      ...sourceEventsFromContainer(item, readString(item.id) ?? readString(envelope.item_id)),
    );
    return events;
  }

  private functionArgumentsDelta(event: JsonObject): StreamDomainEvent[] {
    const id = readString(event.item_id) ?? readString(event.call_id);
    const delta = readString(event.delta);
    if (!id || !delta) return [];
    this.toolArgs.set(id, `${this.toolArgs.get(id) ?? ""}${delta}`);
    return [{ type: "tool_call_delta", id, argsDelta: delta }];
  }

  private functionArgumentsDone(event: JsonObject): StreamDomainEvent[] {
    const id = readString(event.item_id) ?? readString(event.call_id);
    if (!id) return [];
    const argsText = readString(event.arguments) ?? this.toolArgs.get(id) ?? "";
    this.toolArgs.delete(id);
    return [{ type: "tool_call_completed", id, args: parseJsonValue(argsText, {}) }];
  }

  private searchLifecycleEvents(event: JsonObject, eventType: string): StreamDomainEvent[] {
    const id =
      readString(event.item_id) ?? readString(event.call_id) ?? eventType.split(".")[1] ?? "search";
    const name = eventType.includes("x_search")
      ? "x_search"
      : eventType.includes("file_search")
        ? "file_search"
        : "web_search";
    const events: StreamDomainEvent[] = [];
    if (!this.startedTools.has(id)) {
      this.startedTools.add(id);
      events.push({
        type: "tool_call_started",
        call: {
          id,
          name,
          args: searchArgs(event),
          source: "provider",
          providerMeta: { eventType },
        },
      });
    }
    events.push(...sourceEventsFromContainer(event, id));
    if (eventType.endsWith(".completed")) {
      events.push({ type: "tool_call_completed", id, args: searchArgs(event) });
      events.push({
        type: "tool_result",
        id,
        result: { modelContent: event, providerMeta: { eventType } },
      });
    }
    return events;
  }

  private completeResponse(event: JsonObject): StreamDomainEvent[] {
    this.terminal = true;
    const response = isRecord(event.response) ? event.response : {};
    const responseId = readString(response.id) ?? this.responseId;
    const events: StreamDomainEvent[] = [];
    this.openThinking.forEach((blockId) => events.push({ type: "thinking_completed", blockId }));
    this.openThinking.clear();
    if (isJsonValue(response.usage)) events.push({ type: "usage", usage: response.usage });
    events.push({
      type: "done",
      finishReason: readString(response.status) ?? "completed",
      ...(responseId ? { responseId } : {}),
    });
    return events;
  }
}

function readReasoningDeltaPaths(value: JsonValue): string[] {
  if (!isRecord(value) || !Array.isArray(value.reasoningDeltaPaths)) return [];
  return value.reasoningDeltaPaths.filter(
    (path): path is string => typeof path === "string" && path.trim() !== "",
  );
}

function toolCallFromItem(item: JsonObject, envelope: JsonObject): ToolCallStart | null {
  const id =
    readString(item.id) ??
    readString(item.call_id) ??
    readString(envelope.item_id) ??
    readString(envelope.call_id);
  if (!id) return null;
  const type = readString(item.type) ?? "provider_tool";
  const action = isRecord(item.action) ? item.action : {};
  const name =
    readString(item.name) ??
    (type === "provider_tool"
      ? readString(action.type)
      : type.replace(/_call$/, "").replace(/^computer$/, "computer_use")) ??
    "provider_tool";
  const rawArgs = item.arguments ?? item.action ?? item.input ?? {};
  return {
    id,
    name,
    args: isJsonValue(rawArgs) ? rawArgs : {},
    source: "provider",
    providerMeta: { itemType: type },
  };
}

function annotationEvents(annotation: JsonObject, toolCallId?: string): StreamDomainEvent[] {
  const url = readString(annotation.url);
  const title = readString(annotation.title);
  const sourceId =
    readString(annotation.source_id) ?? readString(annotation.id) ?? stableSourceId(url, title);
  const source: SourceEvent = {
    id: sourceId,
    kind: sourceKind(url),
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    providerMeta: annotation,
  };
  const range = rangeFromAnnotation(annotation);
  const citation: CitationEvent = {
    id: readString(annotation.citation_id) ?? `citation:${sourceId}:${rangeKey(range)}`,
    sourceId,
    ...(readString(annotation.text) ? { marker: readString(annotation.text) } : {}),
    ...(range ? { range } : {}),
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    providerMeta: annotation,
  };
  return [
    { type: "source", source },
    { type: "citation", citation },
  ];
}

function sourceEventsFromContainer(
  container: JsonObject,
  toolCallId?: string,
): StreamDomainEvent[] {
  const candidates = [container.sources, container.results, container.search_results]
    .filter(Array.isArray)
    .flat() as unknown[];
  return candidates.flatMap((candidate) => {
    if (!isRecord(candidate) || !isJsonValue(candidate)) return [];
    const sourceRecord = candidate as JsonObject;
    const url = readString(sourceRecord.url) ?? readString(sourceRecord.link);
    const title = readString(sourceRecord.title) ?? readString(sourceRecord.name);
    if (!url && !title && !readString(sourceRecord.id)) return [];
    const source: SourceEvent = {
      id: readString(sourceRecord.id) ?? stableSourceId(url, title),
      kind: sourceKind(url),
      ...(url ? { url } : {}),
      ...(title ? { title } : {}),
      ...(readString(sourceRecord.snippet) ? { preview: readString(sourceRecord.snippet) } : {}),
      ...(readString(sourceRecord.preview) ? { preview: readString(sourceRecord.preview) } : {}),
      ...(readString(sourceRecord.author) ? { authorName: readString(sourceRecord.author) } : {}),
      ...(readString(sourceRecord.published_at)
        ? { publishedAt: readString(sourceRecord.published_at) }
        : {}),
      ...(toolCallId ? { toolCallId } : {}),
      providerMeta: sourceRecord,
    };
    return [{ type: "source", source } satisfies StreamDomainEvent];
  });
}

function agentStatusEvents(event: JsonObject): StreamDomainEvent[] {
  const agent = isRecord(event.agent) ? event.agent : event;
  const id =
    readString(agent.id) ?? readString(agent.agent_id) ?? readString(event.rollout_id) ?? "agent";
  const status = readString(agent.status) ?? readString(event.status) ?? "unknown";
  return [
    {
      type: "agent_status",
      agent: {
        id,
        status,
        ...(readString(agent.label) ? { label: readString(agent.label) } : {}),
        ...(readString(event.rollout_id) ? { rolloutId: readString(event.rollout_id) } : {}),
        ...(readString(event.active_item) ? { activeItem: readString(event.active_item) } : {}),
        providerMeta: event,
      },
    },
  ];
}

function searchArgs(event: JsonObject): JsonValue {
  if (isJsonValue(event.arguments)) return event.arguments;
  const query = readString(event.query);
  return query ? { query } : {};
}

function providerError(value: JsonObject): JsonObject | undefined {
  if (isRecord(value.error) && isJsonValue(value.error)) return value.error;
  return undefined;
}

function rangeFromAnnotation(annotation: JsonObject): JsonObject | undefined {
  const start = readNumber(annotation.start_index);
  const end = readNumber(annotation.end_index);
  if (start === undefined && end === undefined) return undefined;
  return {
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  };
}

function rangeKey(range: JsonObject | undefined): string {
  if (!range) return "unplaced";
  return `${String(range.start ?? "")}-${String(range.end ?? "")}`;
}

function blockIdFromEvent(event: JsonObject, fallback: string): string {
  return readString(event.item_id) ?? readString(event.part_id) ?? fallback;
}

function stableSourceId(url?: string, title?: string): string {
  const normalized = `${url?.trim().toLowerCase() ?? ""}|${title?.trim().toLowerCase() ?? ""}`;
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `source:${(hash >>> 0).toString(16)}`;
}

function sourceKind(url?: string): SourceEvent["kind"] {
  if (!url) return "other";
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" ? "x_post" : "web";
  } catch {
    return "other";
  }
}

function isProviderToolItem(value: unknown): value is JsonObject {
  return isRecord(value) && PROVIDER_TOOL_ITEM_TYPES.has(readString(value.type) ?? "");
}

function streamError(
  code: StreamErrorCode,
  message: string,
  details?: JsonObject,
): StreamDomainEvent {
  return {
    type: "error",
    error: { code, ...(details ? { details } : {}), message, retryable: false },
  };
}

function parseObject(value: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && isJsonValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonValue(value: string, fallback: JsonValue): JsonValue {
  if (value === "") return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonValue(parsed) ? parsed : fallback;
  } catch {
    return value;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringAtPath(value: JsonObject, path: string): string | undefined {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return readString(current);
}

function jsonValueAt(value: JsonObject, key: string): JsonValue | undefined {
  const candidate = value[key];
  return isJsonValue(candidate) ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
