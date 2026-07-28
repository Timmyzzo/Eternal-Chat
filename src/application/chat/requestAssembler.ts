import type { Message, RequestSnapshot } from "@/domain/chat";
import type { CanonicalContext, ContextManifest } from "@/domain/context";
import type { JsonObject, JsonValue } from "@/domain/json";
import type {
  Model,
  ProtocolProfile,
  ProviderConnection,
  ProviderEndpoint,
} from "@/domain/provider";
import { hashStableJson } from "@/domain/stableJson";
import type { PipeField, PipeRequest } from "@/infrastructure/desktop/pipeContract";
import { resolveRetryPolicy, type RetryPolicy } from "@/application/chat/retryPolicy";
import {
  resolveRequestConfiguration,
  type RequestFieldSources,
} from "@/application/providers/requestConfiguration";
import {
  handoffSerializedOpenAIRequest,
  type OpenAIContextProtocol,
  type SerializedOpenAIRequest,
} from "@/infrastructure/providers/openai/serializedRequestBoundary";
import {
  OPENAI_CHAT_COMPLETIONS_CODEC,
  OPENAI_RESPONSES_CODEC,
} from "@/infrastructure/providers/openai/protocolProfiles";
import {
  parserFactoryForProfile,
  type OpenAIStreamParserFactory,
} from "@/infrastructure/providers/openai/streamParsers";

const CREDENTIAL_MARKER = "[credential]";

export interface CredentialResolver {
  resolve(connectionId: string, credentialKey: string): Promise<string | null>;
}

export interface AuthBinding {
  credentialKey: string;
  name: string;
  placement: "body" | "header" | "query";
  prefix?: string;
}

export interface RequestPreview {
  body: JsonValue | null;
  headers: PipeField[];
  method: string;
  query: PipeField[];
  sources: RequestFieldSources;
  timeoutMs: number | null;
  url: string;
}

export interface PreparedDispatch {
  assistantPlaceholder: Message;
  canonicalContext: CanonicalContext;
  contextManifest: ContextManifest;
  modelRevision: number;
  parser: OpenAIStreamParserFactory;
  preview: RequestPreview;
  profileRevision: number;
  redactedRequest: PipeRequest;
  requestSnapshot: RequestSnapshot;
  retryPolicy: RetryPolicy;
  transportRequest: PipeRequest;
  userMessage: Message;
}

export interface PrepareDispatchInput {
  applicationRetryPolicy?: RetryPolicy;
  assistantPlaceholder: Message;
  connection: ProviderConnection;
  context: CanonicalContext;
  conversationExtraBody: JsonValue;
  conversationExtraHeaders: JsonValue;
  conversationExtraQuery: JsonValue;
  conversationExtraPath?: JsonValue;
  conversationParams: JsonValue;
  conversationToolsOverride?: JsonValue;
  credentialResolver: CredentialResolver;
  endpoint: ProviderEndpoint;
  model: Model;
  now: number;
  profile: ProtocolProfile;
  requestId: string;
  snapshotId: string;
  userMessage: Message;
}

export async function prepareOpenAIDispatch(
  input: PrepareDispatchInput,
): Promise<PreparedDispatch> {
  const retryPolicy = resolveRetryPolicy(input.endpoint.retryPolicy, input.applicationRetryPolicy);
  const protocol = protocolForCodec(input.profile.codecId);
  const serialized: SerializedOpenAIRequest = await handoffSerializedOpenAIRequest(
    protocol,
    input.context,
    input.model.modelId,
    { async accept() {} },
  );

  const resolved = resolveRequestConfiguration({
    profile: input.profile,
    endpoint: input.endpoint,
    model: input.model,
    protocolBody: serialized.body,
    conversation: {
      params: input.conversationParams,
      extraBody: input.conversationExtraBody,
      extraHeaders: input.conversationExtraHeaders,
      extraQuery: input.conversationExtraQuery,
      extraPath: input.conversationExtraPath ?? {},
      toolsOverride: input.conversationToolsOverride ?? {},
    },
  });
  const body = resolved.body;
  const headers = mergeHeaders(resolved.headers);
  const query = mergeFields(resolved.query);

  const transportBody = structuredClone(body);
  const redactedBody = structuredClone(body);
  const transportHeaders = [...headers];
  const redactedHeaders = [...headers];
  const transportQuery = [...query];
  const redactedQuery = [...query];
  for (const binding of readAuthBindings(input.endpoint.authBindings)) {
    const credential = await input.credentialResolver.resolve(
      input.connection.id,
      binding.credentialKey,
    );
    if (credential === null) {
      throw new Error(`Credential ${binding.credentialKey} is unavailable`);
    }
    const value = `${binding.prefix ?? ""}${credential}`;
    const redactedValue = `${binding.prefix ?? ""}${CREDENTIAL_MARKER}`;
    if (binding.placement === "header") {
      setHeader(transportHeaders, binding.name, value);
      setHeader(redactedHeaders, binding.name, redactedValue);
    } else if (binding.placement === "query") {
      setField(transportQuery, binding.name, value);
      setField(redactedQuery, binding.name, redactedValue);
    } else {
      setJsonPath(transportBody, binding.name, value);
      setJsonPath(redactedBody, binding.name, redactedValue);
    }
  }

  const url = buildEndpointUrl(input.endpoint, resolved.pathValues);
  const method = input.endpoint.method.trim().toUpperCase();
  const transportRequest: PipeRequest = {
    body: JSON.stringify(transportBody),
    headers: transportHeaders,
    method,
    query: transportQuery,
    requestId: input.requestId,
    ...(input.endpoint.timeoutMs === null ? {} : { timeoutMs: input.endpoint.timeoutMs }),
    url,
  };
  const redactedRequest: PipeRequest = {
    body: JSON.stringify(redactedBody),
    headers: redactedHeaders,
    method,
    query: redactedQuery,
    requestId: input.requestId,
    ...(input.endpoint.timeoutMs === null ? {} : { timeoutMs: input.endpoint.timeoutMs }),
    url,
  };
  const requestSnapshot: RequestSnapshot = {
    id: input.snapshotId,
    conversationId: input.userMessage.conversationId,
    userMessageId: input.userMessage.id,
    assistantMessageId: input.assistantPlaceholder.id,
    connectionId: input.connection.id,
    endpointId: input.endpoint.id,
    modelRef: input.model.id,
    protocolProfileId: input.profile.id,
    protocolProfileRevision: input.profile.revision,
    codecVersion: `${input.profile.codecId}/1`,
    requestMethod: method,
    requestUrl: url,
    requestHeaders: fieldsToJson(redactedHeaders),
    requestQuery: fieldsToJson(redactedQuery),
    requestBody: redactedBody,
    params: {
      modelSchemaRevision: input.model.schemaRevision,
      values: structuredClone(input.conversationParams),
      toolSettings: structuredClone(input.conversationToolsOverride ?? {}),
      fieldSources: structuredClone(resolved.sources),
      presetBindings: {
        profile: structuredClone(input.profile.presetBinding),
        endpoint: structuredClone(input.endpoint.presetBinding),
        model: structuredClone(input.model.presetBinding),
      },
    } as unknown as JsonValue,
    contextManifest: structuredClone(input.context.manifest),
    contextHash: input.context.contextHash,
    requestBodyHash: await hashStableJson(redactedBody),
    retryPolicy: structuredClone(retryPolicy),
    attemptCount: 0,
    providerAnchor: null,
    status: "pending",
    finishReason: null,
    errorCode: null,
    startedAt: input.now,
    firstEventAt: null,
    completedAt: null,
  };
  const preview: RequestPreview = {
    body: structuredClone(redactedBody),
    headers: structuredClone(redactedHeaders),
    method,
    query: structuredClone(redactedQuery),
    sources: structuredClone(resolved.sources),
    timeoutMs: input.endpoint.timeoutMs,
    url,
  };

  return deepFreeze({
    assistantPlaceholder: structuredClone(input.assistantPlaceholder),
    canonicalContext: structuredClone(input.context),
    contextManifest: structuredClone(input.context.manifest),
    modelRevision: input.model.schemaRevision,
    parser: parserFactoryForProfile(input.profile),
    preview,
    profileRevision: input.profile.revision,
    redactedRequest,
    requestSnapshot,
    retryPolicy,
    transportRequest,
    userMessage: structuredClone(input.userMessage),
  });
}

export function buildEndpointUrl(endpoint: ProviderEndpoint, pathValues: JsonObject = {}): string {
  const url = new URL(endpoint.baseUrl);
  if (endpoint.explicitPort !== null) {
    url.port = String(endpoint.explicitPort);
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  const endpointPath = interpolatePath(endpoint.pathTemplate, pathValues).replace(/^\/+/, "");
  url.pathname = `${basePath}/${endpointPath}`.replace(/\/{2,}/g, "/");
  return url.toString();
}

function interpolatePath(template: string, values: JsonObject): string {
  return template.replace(/\{(\+?)([^{}]+)\}/g, (_match, preserveSlash: string, key: string) => {
    const value = values[key];
    if (value === undefined || value === null) {
      throw new Error(`Path variable ${key} is unavailable`);
    }
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return preserveSlash === "+"
      ? text
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/")
      : encodeURIComponent(text);
  });
}

export function redactPipeRequest(
  request: PipeRequest,
  bindings: readonly AuthBinding[],
): PipeRequest {
  const redacted = structuredClone(request);
  const body = redacted.body ? (JSON.parse(redacted.body) as JsonValue) : null;
  bindings.forEach((binding) => {
    const marker = `${binding.prefix ?? ""}${CREDENTIAL_MARKER}`;
    if (binding.placement === "header") {
      setHeader(redacted.headers, binding.name, marker);
    } else if (binding.placement === "query") {
      setField(redacted.query, binding.name, marker);
    } else if (body && isObject(body)) {
      setJsonPath(body, binding.name, marker);
    }
  });
  if (body !== null) {
    redacted.body = JSON.stringify(body);
  }
  return redacted;
}

export function readAuthBindings(value: JsonValue): AuthBinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    if (!isObject(candidate)) {
      return [];
    }
    const credentialKey = stringValue(candidate.credentialKey);
    const name = stringValue(candidate.name);
    const placement = stringValue(candidate.placement);
    if (
      !credentialKey ||
      !name ||
      (placement !== "header" && placement !== "query" && placement !== "body")
    ) {
      return [];
    }
    const prefix = stringValue(candidate.prefix);
    return [{ credentialKey, name, placement, ...(prefix ? { prefix } : {}) }];
  });
}

export function deepMergeObjects(...sources: JsonObject[]): JsonObject {
  const target: JsonObject = {};
  sources.forEach((source) => {
    Object.entries(source).forEach(([key, value]) => {
      const current = target[key];
      target[key] =
        isObject(current) && isObject(value)
          ? deepMergeObjects(current, value)
          : structuredClone(value);
    });
  });
  return target;
}

function protocolForCodec(codecId: string): OpenAIContextProtocol {
  if (codecId === OPENAI_CHAT_COMPLETIONS_CODEC) {
    return OPENAI_CHAT_COMPLETIONS_CODEC;
  }
  if (codecId === OPENAI_RESPONSES_CODEC) {
    return OPENAI_RESPONSES_CODEC;
  }
  throw new Error(`Unsupported Phase 5 codec: ${codecId}`);
}

function mergeHeaders(...sources: JsonObject[]): PipeField[] {
  const fields: PipeField[] = [];
  sources.forEach((source) => {
    Object.entries(source).forEach(([name, value]) => setHeader(fields, name, fieldValue(value)));
  });
  return fields;
}

function mergeFields(...sources: JsonObject[]): PipeField[] {
  const fields: PipeField[] = [];
  sources.forEach((source) => {
    Object.entries(source).forEach(([name, value]) => setField(fields, name, fieldValue(value)));
  });
  return fields;
}

function setHeader(fields: PipeField[], name: string, value: string): void {
  const index = fields.findIndex((field) => field.name.toLowerCase() === name.toLowerCase());
  if (index >= 0) {
    fields[index] = { name, value };
  } else {
    fields.push({ name, value });
  }
}

function setField(fields: PipeField[], name: string, value: string): void {
  const index = fields.findIndex((field) => field.name === name);
  if (index >= 0) {
    fields[index] = { name, value };
  } else {
    fields.push({ name, value });
  }
}

function fieldValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function fieldsToJson(fields: readonly PipeField[]): JsonValue {
  return fields.map((field) => ({ name: field.name, value: field.value }));
}

function setJsonPath(target: JsonObject, path: string, value: string): void {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) {
    throw new Error("Credential body path is empty");
  }
  let current = target;
  segments.slice(0, -1).forEach((segment) => {
    const existing = current[segment];
    if (!isObject(existing)) {
      current[segment] = {};
    }
    current = current[segment] as JsonObject;
  });
  const leaf = segments.at(-1);
  if (leaf) {
    current[leaf] = value;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
