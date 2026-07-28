import type { JsonObject, JsonValue } from "@/domain/json";
import type { StreamDomainEvent, StreamErrorCode } from "@/domain/streaming";
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

export function parserFactoryForProfile(profile: ProtocolProfile): OpenAIStreamParserFactory {
  if (profile.codecId === OPENAI_CHAT_COMPLETIONS_CODEC) {
    const reasoningPaths = readReasoningDeltaPaths(profile.responseMapping);
    return () => new ChatCompletionsStreamParser(reasoningPaths);
  }
  if (profile.codecId === OPENAI_RESPONSES_CODEC) {
    return () => new ResponsesStreamParser();
  }
  throw new Error(`Unsupported Phase 5 codec: ${profile.codecId}`);
}

export class ChatCompletionsStreamParser implements OpenAIStreamParser {
  private finishReason: string | null = null;
  private responseId: string | undefined;
  private terminal = false;

  constructor(private readonly reasoningDeltaPaths: readonly string[] = []) {}

  push(data: string): StreamDomainEvent[] {
    if (data.trim() === "") {
      return [];
    }
    if (this.terminal) {
      return [streamError("chat_event_after_terminal", "Chat data arrived after [DONE].")];
    }
    if (data.trim() === "[DONE]") {
      this.terminal = true;
      return [{ type: "done", finishReason: this.finishReason, responseId: this.responseId }];
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
        if (!isRecord(choice)) {
          return;
        }
        const finishReason = readString(choice.finish_reason);
        if (finishReason) {
          this.finishReason = finishReason;
        }
        if (!isRecord(choice.delta)) {
          return;
        }
        const content = readString(choice.delta.content);
        if (content) {
          events.push({ type: "text_delta", delta: content });
        }
        if (
          (Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length > 0) ||
          isRecord(choice.delta.function_call)
        ) {
          events.push({ type: "semantic", kind: "tool" });
        }
        this.reasoningDeltaPaths.forEach((path) => {
          const reasoning = readStringAtPath(choice.delta as JsonObject, path);
          if (reasoning) {
            events.push({
              type: "thinking_delta",
              delta: reasoning,
              visibility: "provider_returned",
            });
          }
        });
      });
    }

    if (isJsonValue(parsed.usage)) {
      events.push({ type: "usage", usage: parsed.usage });
    }
    return events;
  }

  finish(): StreamDomainEvent[] {
    if (this.terminal) {
      return [];
    }
    this.terminal = true;
    return [streamError("chat_missing_terminal", "Chat stream ended before [DONE].")];
  }
}

const RESPONSES_IGNORED_EVENTS = new Set([
  "response.queued",
  "response.in_progress",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.done",
  "response.output_text.annotation.added",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.done",
  "response.refusal.done",
]);

export class ResponsesStreamParser implements OpenAIStreamParser {
  private responseId: string | undefined;
  private terminal = false;

  push(data: string): StreamDomainEvent[] {
    if (data.trim() === "") {
      return [];
    }
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

    if (eventType === "response.created") {
      const responseId = responseIdFromEvent(parsed);
      if (responseId) {
        this.responseId = responseId;
      }
      return [{ type: "started", ...(responseId ? { responseId } : {}) }];
    }
    if (eventType === "response.output_text.delta") {
      return deltaEvent(parsed, "text_delta");
    }
    if (
      eventType === "response.reasoning_summary_text.delta" ||
      eventType === "response.reasoning_text.delta"
    ) {
      const delta = readString(parsed.delta);
      return delta ? [{ type: "thinking_delta", delta, visibility: "provider_returned" }] : [];
    }
    if (eventType === "response.refusal.delta") {
      return deltaEvent(parsed, "text_delta");
    }
    if (
      (eventType === "response.output_item.added" || eventType === "response.output_item.done") &&
      isProviderToolItem(parsed.item)
    ) {
      return [{ type: "semantic", kind: "tool" }];
    }
    if (eventType === "response.output_text.annotation.added" && isRecord(parsed.annotation)) {
      return [{ type: "semantic", kind: "source" }];
    }
    if (eventType === "response.completed") {
      this.terminal = true;
      const response = isRecord(parsed.response) ? parsed.response : {};
      const responseId = readString(response.id) ?? this.responseId;
      const events: StreamDomainEvent[] = [];
      if (isJsonValue(response.usage)) {
        events.push({ type: "usage", usage: response.usage });
      }
      events.push({
        type: "done",
        finishReason: "completed",
        ...(responseId ? { responseId } : {}),
      });
      return events;
    }
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
    if (RESPONSES_IGNORED_EVENTS.has(eventType)) {
      return [];
    }

    this.terminal = true;
    return [
      streamError("responses_unknown_event", `Unsupported Responses event: ${eventType}`, {
        eventType,
      }),
    ];
  }

  finish(): StreamDomainEvent[] {
    if (this.terminal) {
      return [];
    }
    this.terminal = true;
    return [
      streamError("responses_missing_terminal", "Responses stream ended before a terminal event."),
    ];
  }
}

function readReasoningDeltaPaths(value: JsonValue): string[] {
  if (!isRecord(value) || !Array.isArray(value.reasoningDeltaPaths)) {
    return [];
  }
  return value.reasoningDeltaPaths.filter(
    (path): path is string => typeof path === "string" && path.trim() !== "",
  );
}

function deltaEvent(event: JsonObject, type: "text_delta"): StreamDomainEvent[] {
  const delta = readString(event.delta);
  return delta ? [{ type, delta }] : [];
}

function responseIdFromEvent(event: JsonObject): string | undefined {
  return isRecord(event.response) ? readString(event.response.id) : undefined;
}

const PROVIDER_TOOL_ITEM_TYPES = new Set([
  "code_interpreter_call",
  "computer_call",
  "custom_tool_call",
  "file_search_call",
  "function_call",
  "image_generation_call",
  "mcp_call",
  "web_search_call",
]);

function isProviderToolItem(value: unknown): boolean {
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readStringAtPath(value: JsonObject, path: string): string | undefined {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return readString(current);
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
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
