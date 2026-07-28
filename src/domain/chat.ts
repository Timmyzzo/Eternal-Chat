import type { JsonObject, JsonValue } from "@/domain/json";

export type MessageRole = "root" | "system" | "user" | "assistant";

export type MessageStatus =
  "pending" | "waiting_retry" | "streaming" | "done" | "interrupted" | "error";

export interface TextBlock {
  type: "text";
  text: string;
  blockId?: string;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
  visibility: string;
  blockId?: string;
  label?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  signature?: string;
  meta?: JsonObject;
}

export interface ToolResult {
  modelContent: JsonValue;
  rawRef?: string;
  rawHash?: string;
  mimeType?: string;
  truncatedAtSource?: boolean;
  error?: JsonObject;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  args: JsonValue;
  status: "requested" | "running" | "succeeded" | "failed" | "denied" | "cancelled";
  source: "client" | "mcp" | "provider";
  startedAt?: number;
  finishedAt?: number;
  result?: ToolResult;
  providerMeta?: JsonObject;
}

export interface SourceBlock {
  type: "source";
  id: string;
  kind?: "web" | "x_post" | "file" | "database" | "other";
  url?: string;
  title?: string;
  toolCallId?: string;
  toolCallIds?: string[];
  preview?: string;
  favicon?: string;
  authorName?: string;
  authorHandle?: string;
  publishedAt?: string;
  receivedAt?: number;
  providerMeta?: JsonObject;
}

export interface CitationBlock {
  type: "citation";
  id?: string;
  sourceId: string;
  marker?: string;
  range?: JsonObject;
  url?: string;
  title?: string;
  toolCallId?: string;
  receivedAt?: number;
  providerMeta?: JsonObject;
}

export interface ImageBlock {
  type: "image";
  artifactRef: string;
  mime: string;
  alt?: string;
}

export interface FileBlock {
  type: "file";
  artifactRef: string;
  name: string;
  mime?: string;
}

export interface ErrorBlock {
  type: "error";
  code: string;
  message: string;
  retryable: boolean;
}

export interface ProviderStateBlock {
  type: "provider_state";
  id?: string;
  provider: string;
  purpose: string;
  data: JsonValue;
  receivedAt?: number;
}

export interface UnknownMessageBlock {
  type: string;
  [key: string]: JsonValue;
}

export type MessageBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | SourceBlock
  | CitationBlock
  | ImageBlock
  | FileBlock
  | ErrorBlock
  | ProviderStateBlock
  | UnknownMessageBlock;

export interface MessageTimelineEntry {
  seq: number;
  ts: number;
  type: string;
  details: JsonObject;
}

export interface MessageBlocks {
  version: 1;
  blocks: MessageBlock[];
  timeline?: MessageTimelineEntry[];
}

export const EMPTY_MESSAGE_BLOCKS: MessageBlocks = { version: 1, blocks: [] };

export function parseMessageBlocks(value: string): MessageBlocks {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.blocks)) {
    throw new Error("Unsupported message block envelope");
  }

  parsed.blocks.forEach((block) => {
    if (!isRecord(block) || typeof block.type !== "string") {
      throw new Error("Invalid message block");
    }
  });

  return parsed as unknown as MessageBlocks;
}

export function serializeMessageBlocks(value: MessageBlocks): string {
  return JSON.stringify(value);
}

export interface Conversation {
  id: string;
  title: string;
  modelRef: string | null;
  systemPrompt: string;
  params: JsonValue;
  extraBody: JsonValue;
  extraHeaders: JsonValue;
  extraQuery: JsonValue;
  extraPath: JsonValue;
  toolsOverride: JsonValue;
  contextPolicy: JsonValue;
  activeLeafMessageId: string | null;
  archived: boolean;
  starred: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  blocks: MessageBlocks;
  status: MessageStatus;
  usage: JsonValue | null;
  modelRef: string | null;
  parentId: string | null;
  siblingOrder: number;
  providerResponseId: string | null;
  providerPreviousResponseId: string | null;
  requestSnapshotId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type RequestSnapshotStatus = "pending" | "running" | "done" | "interrupted" | "error";

export interface RequestSnapshot {
  id: string;
  conversationId: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  connectionId: string;
  endpointId: string;
  modelRef: string | null;
  protocolProfileId: string;
  protocolProfileRevision: number;
  codecVersion: string;
  requestMethod: string;
  requestUrl: string;
  requestHeaders: JsonValue | null;
  requestQuery: JsonValue | null;
  requestBody: JsonValue | null;
  params: JsonValue;
  contextManifest: JsonValue;
  contextHash: string;
  requestBodyHash: string;
  retryPolicy: JsonValue;
  attemptCount: number;
  providerAnchor: JsonValue | null;
  status: RequestSnapshotStatus;
  finishReason: string | null;
  errorCode: string | null;
  startedAt: number;
  firstEventAt: number | null;
  completedAt: number | null;
}

export type RequestAttemptTrigger = "initial" | "automatic_retry";

export type RequestAttemptStatus =
  "running" | "retryable_failed" | "non_retryable_failed" | "completed" | "cancelled";

export interface RequestAttempt {
  id: string;
  requestSnapshotId: string;
  attemptNo: number;
  trigger: RequestAttemptTrigger;
  transportRequestId: string;
  requestBodyHash: string;
  status: RequestAttemptStatus;
  retryable: boolean;
  retryReason: string | null;
  httpStatus: number | null;
  providerErrorCode: string | null;
  retryAfterMs: number | null;
  scheduledDelayMs: number | null;
  startedAt: number;
  firstByteAt: number | null;
  firstSemanticEventAt: number | null;
  completedAt: number | null;
  bytesReceived: number;
  semanticEventCount: number;
}

export interface MessageCursor {
  createdAt: number;
  id: string;
}

export interface MessagePage {
  messages: Message[];
  nextCursor: MessageCursor | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
