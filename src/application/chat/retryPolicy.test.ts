import { describe, expect, it } from "vitest";

import {
  DEFAULT_RETRY_POLICY,
  classifyPipeFailure,
  classifyProviderFailure,
  parseRetryAfter,
  planAutomaticRetry,
  resolveRetryPolicy,
} from "@/application/chat/retryPolicy";

describe("retry policy", () => {
  it("resolves the documented application defaults and endpoint overrides", () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({
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

    expect(
      resolveRetryPolicy(
        {
          enabled: false,
          maxRetries: 1,
          retryableProviderCodes: ["temporary_overload"],
        },
        DEFAULT_RETRY_POLICY,
      ),
    ).toMatchObject({
      enabled: false,
      maxRetries: 1,
      baseDelayMs: 1_000,
      retryableProviderCodes: ["temporary_overload"],
    });
  });

  it("parses Retry-After seconds and HTTP-date without accepting invalid values", () => {
    const now = Date.parse("2026-07-28T00:00:00Z");
    expect(parseRetryAfter("2", now)).toEqual({ kind: "valid", delayMs: 2_000 });
    expect(parseRetryAfter("Tue, 28 Jul 2026 00:00:03 GMT", now)).toEqual({
      kind: "valid",
      delayMs: 3_000,
    });
    expect(parseRetryAfter("not-a-delay", now)).toEqual({ kind: "invalid" });
    expect(parseRetryAfter(undefined, now)).toEqual({ kind: "missing" });
  });

  it("uses full jitter, respects attempt limits, and includes waiting in the total budget", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, maxRetries: 2, maxTotalElapsedMs: 5_000 };
    const failure = classifyPipeFailure({ kind: "network", message: "offline" }, policy);

    expect(
      planAutomaticRetry({
        attemptNo: 1,
        elapsedMs: 100,
        failure,
        hasValuableOutput: false,
        policy,
        random: () => 0.5,
        retryAfter: { kind: "missing" },
      }),
    ).toMatchObject({ kind: "retry", delayMs: 500, delaySource: "full_jitter" });
    expect(
      planAutomaticRetry({
        attemptNo: 3,
        elapsedMs: 100,
        failure,
        hasValuableOutput: false,
        policy,
        random: () => 0,
        retryAfter: { kind: "missing" },
      }),
    ).toEqual({ kind: "stop", code: "retry_exhausted" });
    expect(
      planAutomaticRetry({
        attemptNo: 1,
        elapsedMs: 4_000,
        failure,
        hasValuableOutput: false,
        policy,
        random: () => 0,
        retryAfter: { kind: "valid", delayMs: 2_000 },
      }),
    ).toEqual({ kind: "stop", code: "retry_budget_exhausted" });
  });

  it("classifies only configured temporary failures as retryable", () => {
    const policy = {
      ...DEFAULT_RETRY_POLICY,
      retryableProviderCodes: ["temporary_overload"],
    };

    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(
        classifyPipeFailure({ kind: "http", message: "temporary", status }, policy).retryable,
      ).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 422]) {
      expect(
        classifyPipeFailure({ kind: "http", message: "permanent", status }, policy).retryable,
      ).toBe(false);
    }
    expect(classifyPipeFailure({ kind: "network", message: "reset" }, policy).retryable).toBe(true);
    expect(classifyPipeFailure({ kind: "stream", message: "closed" }, policy).retryable).toBe(true);
    expect(classifyPipeFailure({ kind: "timeout", message: "slow" }, policy).retryable).toBe(true);
    expect(classifyPipeFailure({ kind: "cancelled", message: "stop" }, policy).retryable).toBe(
      false,
    );
    expect(
      classifyProviderFailure(
        {
          code: "responses_failed",
          message: "busy",
          retryable: false,
          details: { providerCode: "temporary_overload", embedded: true },
        },
        policy,
      ).retryable,
    ).toBe(true);
    expect(
      classifyProviderFailure(
        {
          code: "responses_failed",
          message: "bad model",
          retryable: false,
          details: { providerCode: "model_not_found", embedded: true },
        },
        policy,
      ).retryable,
    ).toBe(false);
  });

  it("never retries after a response id or other valuable semantic output", () => {
    const failure = classifyPipeFailure(
      { kind: "network", message: "disconnected" },
      DEFAULT_RETRY_POLICY,
    );
    expect(
      planAutomaticRetry({
        attemptNo: 1,
        elapsedMs: 100,
        failure,
        hasValuableOutput: true,
        policy: DEFAULT_RETRY_POLICY,
        random: () => 0,
        retryAfter: { kind: "missing" },
      }),
    ).toEqual({ kind: "stop", code: "retry_disallowed_after_output" });
  });
});
