import type { JsonObject, JsonValue } from "@/domain/json";
import type { StreamErrorInfo } from "@/domain/streaming";
import type { PipeError } from "@/infrastructure/desktop/pipeContract";

export interface RetryPolicy extends JsonObject {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxTotalElapsedMs: number;
  retryableHttpStatuses: number[];
  retryableProviderCodes: string[];
  retryOnConnectionFailure: boolean;
  retryOnConnectTimeout: boolean;
  retryOnFirstByteTimeout: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxTotalElapsedMs: 90_000,
  retryableHttpStatuses: [408, 429, 500, 502, 503, 504],
  retryableProviderCodes: [],
  retryOnConnectionFailure: true,
  retryOnConnectTimeout: true,
  retryOnFirstByteTimeout: true,
});

export type RetryFailureCategory =
  "network" | "timeout" | "http" | "provider" | "cancelled" | "protocol" | "transport";

export interface RetryFailure {
  category: RetryFailureCategory;
  code: string;
  httpStatus: number | null;
  message: string;
  providerCode: string | null;
  retryAfterHeader: string | null;
  retryable: boolean;
}

export type RetryAfterResult =
  { kind: "missing" } | { kind: "invalid" } | { kind: "valid"; delayMs: number };

export type RetryStopCode =
  | "retry_disabled"
  | "retry_not_allowed"
  | "retry_exhausted"
  | "retry_budget_exhausted"
  | "retry_disallowed_after_output";

export type RetryPlan =
  | {
      kind: "retry";
      delayMs: number;
      delaySource: "full_jitter" | "retry_after";
      retryAfterInvalid: boolean;
      retryAfterMs: number | null;
    }
  | { kind: "stop"; code: RetryStopCode };

export function resolveRetryPolicy(
  endpointOverride: JsonValue | null | undefined,
  applicationPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
): RetryPolicy {
  const base = validateRetryPolicy(applicationPolicy, "application retry policy");
  if (endpointOverride === null || endpointOverride === undefined) {
    return structuredClone(base);
  }
  if (!isObject(endpointOverride)) {
    throw new Error("Endpoint retry policy must be a JSON object");
  }

  return validateRetryPolicy(
    {
      ...base,
      ...pickDefined(endpointOverride, [
        "enabled",
        "maxRetries",
        "baseDelayMs",
        "maxDelayMs",
        "maxTotalElapsedMs",
        "retryableHttpStatuses",
        "retryableProviderCodes",
        "retryOnConnectionFailure",
        "retryOnConnectTimeout",
        "retryOnFirstByteTimeout",
      ]),
    },
    "endpoint retry policy",
  );
}

export function parseRetryAfter(value: string | undefined, now: number): RetryAfterResult {
  if (value === undefined) {
    return { kind: "missing" };
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isSafeInteger(seconds)) {
      return { kind: "valid", delayMs: seconds * 1_000 };
    }
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isFinite(timestamp)) {
    return { kind: "valid", delayMs: Math.max(0, timestamp - now) };
  }
  return { kind: "invalid" };
}

export function classifyPipeFailure(error: PipeError, policy: RetryPolicy): RetryFailure {
  if (error.kind === "http") {
    const status = error.status ?? null;
    return {
      category: "http",
      code: status === null ? "http_status_unknown" : `http_${status}`,
      httpStatus: status,
      message: error.message,
      providerCode: null,
      retryAfterHeader: error.retryAfter ?? null,
      retryable: status !== null && policy.retryableHttpStatuses.includes(status),
    };
  }
  if (error.kind === "network" || error.kind === "stream") {
    return {
      category: "network",
      code: error.kind === "network" ? "network_error" : "stream_interrupted",
      httpStatus: null,
      message: error.message,
      providerCode: null,
      retryAfterHeader: null,
      retryable: policy.retryOnConnectionFailure,
    };
  }
  if (error.kind === "timeout") {
    return {
      category: "timeout",
      code: "transport_timeout",
      httpStatus: null,
      message: error.message,
      providerCode: null,
      retryAfterHeader: null,
      retryable: policy.retryOnConnectTimeout || policy.retryOnFirstByteTimeout,
    };
  }
  if (error.kind === "cancelled") {
    return {
      category: "cancelled",
      code: "retry_cancelled",
      httpStatus: null,
      message: error.message,
      providerCode: null,
      retryAfterHeader: null,
      retryable: false,
    };
  }
  return {
    category: error.kind === "invalid_request" ? "protocol" : "transport",
    code: error.kind,
    httpStatus: error.status ?? null,
    message: error.message,
    providerCode: null,
    retryAfterHeader: null,
    retryable: false,
  };
}

export function classifyProviderFailure(error: StreamErrorInfo, policy: RetryPolicy): RetryFailure {
  const details = error.details;
  const providerCode = stringValue(details?.providerCode) ?? null;
  const embedded = details?.embedded === true;
  return {
    category: embedded ? "provider" : "protocol",
    code: embedded ? "provider_embedded_error" : error.code,
    httpStatus: null,
    message: error.message,
    providerCode,
    retryAfterHeader: null,
    retryable:
      embedded && providerCode !== null && policy.retryableProviderCodes.includes(providerCode),
  };
}

export function planAutomaticRetry(input: {
  attemptNo: number;
  elapsedMs: number;
  failure: RetryFailure;
  hasValuableOutput: boolean;
  policy: RetryPolicy;
  random: () => number;
  retryAfter: RetryAfterResult;
}): RetryPlan {
  if (!input.policy.enabled) {
    return { kind: "stop", code: "retry_disabled" };
  }
  if (input.hasValuableOutput) {
    return { kind: "stop", code: "retry_disallowed_after_output" };
  }
  if (!input.failure.retryable) {
    return { kind: "stop", code: "retry_not_allowed" };
  }
  if (input.attemptNo > input.policy.maxRetries) {
    return { kind: "stop", code: "retry_exhausted" };
  }

  const retryAfterMs = input.retryAfter.kind === "valid" ? input.retryAfter.delayMs : null;
  const delayMs =
    retryAfterMs ??
    fullJitterDelay(input.policy, input.attemptNo - 1, normalizeRandom(input.random()));
  if (input.elapsedMs + delayMs > input.policy.maxTotalElapsedMs) {
    return { kind: "stop", code: "retry_budget_exhausted" };
  }

  return {
    kind: "retry",
    delayMs,
    delaySource: retryAfterMs === null ? "full_jitter" : "retry_after",
    retryAfterInvalid: input.retryAfter.kind === "invalid",
    retryAfterMs,
  };
}

function fullJitterDelay(policy: RetryPolicy, retryIndex: number, random: number): number {
  const exponent = Math.min(retryIndex, 30);
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  return Math.floor(random * (cap + 1));
}

function validateRetryPolicy(value: JsonObject, label: string): RetryPolicy {
  const enabled = booleanField(value, "enabled", label);
  const maxRetries = integerField(value, "maxRetries", 0, label);
  const baseDelayMs = integerField(value, "baseDelayMs", 0, label);
  const maxDelayMs = integerField(value, "maxDelayMs", 0, label);
  const maxTotalElapsedMs = integerField(value, "maxTotalElapsedMs", 1, label);
  const retryableHttpStatuses = numberArrayField(value, "retryableHttpStatuses", label).map(
    (status) => {
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new Error(`${label}.retryableHttpStatuses contains an invalid HTTP status`);
      }
      return status;
    },
  );
  const retryableProviderCodes = stringArrayField(value, "retryableProviderCodes", label);
  return {
    enabled,
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    maxTotalElapsedMs,
    retryableHttpStatuses,
    retryableProviderCodes,
    retryOnConnectionFailure: booleanField(value, "retryOnConnectionFailure", label),
    retryOnConnectTimeout: booleanField(value, "retryOnConnectTimeout", label),
    retryOnFirstByteTimeout: booleanField(value, "retryOnFirstByteTimeout", label),
  };
}

function pickDefined(value: JsonObject, keys: readonly string[]): JsonObject {
  const result: JsonObject = {};
  keys.forEach((key) => {
    if (value[key] !== undefined) {
      result[key] = structuredClone(value[key] as JsonValue);
    }
  });
  return result;
}

function booleanField(value: JsonObject, key: string, label: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw new Error(`${label}.${key} must be a boolean`);
  }
  return field;
}

function integerField(value: JsonObject, key: string, minimum: number, label: string): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < minimum) {
    throw new Error(`${label}.${key} must be an integer greater than or equal to ${minimum}`);
  }
  return field as number;
}

function numberArrayField(value: JsonObject, key: string, label: string): number[] {
  const field = value[key];
  if (!Array.isArray(field) || !field.every((item) => typeof item === "number")) {
    throw new Error(`${label}.${key} must be a number array`);
  }
  return field.map((item) => item as number);
}

function stringArrayField(value: JsonObject, key: string, label: string): string[] {
  const field = value[key];
  if (
    !Array.isArray(field) ||
    !field.every((item) => typeof item === "string" && item.trim() !== "")
  ) {
    throw new Error(`${label}.${key} must be a non-empty string array`);
  }
  return field.map((item) => item as string);
}

function normalizeRandom(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1 - Number.EPSILON);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
