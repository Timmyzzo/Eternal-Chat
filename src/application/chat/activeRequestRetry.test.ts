import { describe, expect, it, vi } from "vitest";

import {
  ActiveRequestRegistry,
  type ActiveRequestPersistence,
} from "@/application/chat/activeRequestRegistry";
import type { PreparedDispatch } from "@/application/chat/requestAssembler";
import {
  DEFAULT_RETRY_POLICY,
  resolveRetryPolicy,
  type RetryPolicy,
} from "@/application/chat/retryPolicy";
import type { MessageStatus, RequestAttempt, RequestSnapshot } from "@/domain/chat";
import type { JsonObject } from "@/domain/json";
import type { StreamDomainEvent } from "@/domain/streaming";
import type {
  FinalizeRequestAttemptInput,
  InterruptWaitingRetryInput,
  ScheduleRetryInput,
} from "@/infrastructure/db/phase3Repository";
import { FakeDesktopBridge } from "@/infrastructure/desktop/fakeDesktopBridge";
import type { OpenAIStreamParser } from "@/infrastructure/providers/openai/streamParsers";
import { ChatCompletionsStreamParser } from "@/infrastructure/providers/openai/streamParsers";

describe("ActiveRequestRegistry automatic retry", () => {
  it("keeps one logical request and assistant while two 429 attempts retry before success", async () => {
    const harness = createHarness({ baseDelayMs: 0, maxDelayMs: 0 });
    const dispatch = createDispatch("logical-429", harness.policy);
    harness.registry.start(dispatch);
    await vi.waitFor(() => expect(harness.bridge.startedRequests).toHaveLength(1));

    emitHttpError(harness.bridge, harness.bridge.startedRequests[0]!.requestId, 429, "0");
    await vi.waitFor(() =>
      expect(harness.registry.get(dispatch.transportRequest.requestId)?.status).toBe(
        "waiting_retry",
      ),
    );
    harness.clock.runDue();
    await vi.waitFor(() => expect(harness.bridge.startedRequests).toHaveLength(2));

    emitHttpError(harness.bridge, harness.bridge.startedRequests[1]!.requestId, 429, "0");
    await vi.waitFor(() =>
      expect(harness.registry.get(dispatch.transportRequest.requestId)?.retry?.nextAttemptNo).toBe(
        3,
      ),
    );
    harness.clock.runDue();
    await vi.waitFor(() => expect(harness.bridge.startedRequests).toHaveLength(3));

    const finalTransportId = harness.bridge.startedRequests[2]!.requestId;
    harness.bridge.emit({
      type: "data",
      requestId: finalTransportId,
      data: [
        JSON.stringify({
          id: "provider-response",
          choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
        }),
        "[DONE]",
      ],
    });
    harness.bridge.emit({ type: "done", requestId: finalTransportId });

    const terminal = await harness.registry.whenTerminal(dispatch.transportRequest.requestId);
    expect(terminal).toMatchObject({
      assistantMessageId: dispatch.assistantPlaceholder.id,
      status: "done",
      attemptNo: 3,
      attempts: [
        { attemptNo: 1, status: "retryable_failed" },
        { attemptNo: 2, status: "retryable_failed" },
        { attemptNo: 3, status: "completed" },
      ],
      blocks: { blocks: [{ type: "text", text: "done" }] },
    });
    expect(harness.persistence.logicalStarts).toHaveLength(1);
    expect(harness.persistence.retryStarts).toHaveLength(2);
    expect(harness.persistence.scheduled).toHaveLength(2);
    expect(harness.persistence.finalized).toHaveLength(1);
    expect(new Set(harness.bridge.startedRequests.map((request) => request.requestId)).size).toBe(
      3,
    );
    const frozenRequests = harness.bridge.startedRequests.map(({ requestId, ...request }) => {
      void requestId;
      return request;
    });
    expect(frozenRequests[1]).toEqual(frozenRequests[0]);
    expect(frozenRequests[2]).toEqual(frozenRequests[0]);
    expect(dispatch.requestSnapshot.contextHash).toBe("sha256:context");
    expect(harness.persistence.logicalStarts[0]?.snapshot.requestBodyHash).toBe("sha256:body");
    expect(
      harness.persistence.retryStarts.every(
        (attempt) => attempt.requestBodyHash === dispatch.requestSnapshot.requestBodyHash,
      ),
    ).toBe(true);
  });

  it("does not start a Retry-After attempt before the server delay", async () => {
    const harness = createHarness();
    const dispatch = createDispatch("logical-delay", harness.policy);
    harness.registry.start(dispatch);
    await vi.waitFor(() => expect(harness.bridge.startedRequests).toHaveLength(1));

    emitHttpError(harness.bridge, harness.bridge.startedRequests[0]!.requestId, 429, "2");
    await vi.waitFor(() =>
      expect(harness.registry.get(dispatch.transportRequest.requestId)?.retry).toMatchObject({
        delayMs: 2_000,
        delaySource: "retry_after",
        retryAfterMs: 2_000,
      }),
    );

    harness.clock.advanceBy(1_999);
    expect(harness.bridge.startedRequests).toHaveLength(1);
    harness.clock.advanceBy(1);
    await vi.waitFor(() => expect(harness.bridge.startedRequests).toHaveLength(2));

    harness.registry.stop(dispatch.transportRequest.requestId);
    await harness.registry.whenTerminal(dispatch.transportRequest.requestId);
  });

  it("retries an HTTP 200 embedded error only when its exact provider code is allowlisted", async () => {
    const harness = createHarness({
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableProviderCodes: ["temporary_overload"],
    });
    const dispatch = createDispatch("logical-embedded", harness.policy);
    harness.registry.start(dispatch);
    await vi.waitFor(() => expect(harness.bridge.startedRequests).toHaveLength(1));

    harness.bridge.emit({
      type: "data",
      requestId: harness.bridge.startedRequests[0]!.requestId,
      data: [
        JSON.stringify({
          error: { code: "temporary_overload", message: "Structured temporary failure" },
        }),
      ],
    });
    await vi.waitFor(() => expect(harness.persistence.scheduled).toHaveLength(1));
    expect(harness.persistence.scheduled[0]).toMatchObject({
      providerErrorCode: "temporary_overload",
      retryReason: "provider_embedded_error",
    });
    harness.clock.runDue();
    await vi.waitFor(() => expect(harness.bridge.startedRequests).toHaveLength(2));

    const retryId = harness.bridge.startedRequests[1]!.requestId;
    harness.bridge.emit({ type: "data", requestId: retryId, data: ["[DONE]"] });
    harness.bridge.emit({ type: "done", requestId: retryId });
    expect((await harness.registry.whenTerminal(dispatch.transportRequest.requestId)).status).toBe(
      "done",
    );

    const rejected = createHarness({ baseDelayMs: 0, maxDelayMs: 0 });
    const rejectedDispatch = createDispatch("logical-embedded-rejected", rejected.policy);
    rejected.registry.start(rejectedDispatch);
    await vi.waitFor(() => expect(rejected.bridge.startedRequests).toHaveLength(1));
    rejected.bridge.emit({
      type: "data",
      requestId: rejected.bridge.startedRequests[0]!.requestId,
      data: [
        JSON.stringify({
          error: { code: "temporary_overload", message: "Not allowlisted here" },
        }),
      ],
    });
    const rejectedTerminal = await rejected.registry.whenTerminal(
      rejectedDispatch.transportRequest.requestId,
    );
    expect(rejectedTerminal.status).toBe("error");
    expect(rejected.bridge.startedRequests).toHaveLength(1);
    expect(rejected.persistence.scheduled).toHaveLength(0);
  });

  it("does not retry after response id, reasoning, text, tool, or source output", async () => {
    const cases: Array<{
      data: string;
      name: string;
      parser?: () => OpenAIStreamParser;
    }> = [
      {
        name: "response id",
        data: JSON.stringify({ id: "accepted", choices: [{ delta: {} }] }),
      },
      {
        name: "reasoning",
        data: JSON.stringify({ choices: [{ delta: { reasoning_content: "thought" } }] }),
        parser: () => new ChatCompletionsStreamParser(["reasoning_content"]),
      },
      {
        name: "text",
        data: JSON.stringify({ choices: [{ delta: { content: "partial" } }] }),
      },
      {
        name: "tool",
        data: JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "call" }] } }] }),
      },
      {
        name: "source",
        data: "source-marker",
        parser: () =>
          new StaticParser([
            {
              type: "source",
              source: { id: "source-1", kind: "web", url: "https://example.com" },
            },
          ]),
      },
    ];

    for (const fixture of cases) {
      const harness = createHarness({ baseDelayMs: 0, maxDelayMs: 0 });
      const dispatch = createDispatch(
        `logical-output-${fixture.name}`,
        harness.policy,
        fixture.parser,
      );
      harness.registry.start(dispatch);
      await vi.waitFor(() => expect(harness.bridge.startedRequests).toHaveLength(1));
      const transportId = harness.bridge.startedRequests[0]!.requestId;
      harness.bridge.emit({ type: "data", requestId: transportId, data: [fixture.data] });
      harness.bridge.emit({
        type: "error",
        requestId: transportId,
        error: { kind: "stream", message: "Disconnected" },
      });

      const terminal = await harness.registry.whenTerminal(dispatch.transportRequest.requestId);
      expect(terminal.status, fixture.name).toBe("interrupted");
      expect(terminal.blocks.blocks.at(-1), fixture.name).toMatchObject({
        type: "error",
        code: "retry_disallowed_after_output",
      });
      expect(harness.bridge.startedRequests, fixture.name).toHaveLength(1);
      expect(harness.persistence.scheduled, fixture.name).toHaveLength(0);
    }
  });

  it("lets stop win a waiting timer race without starting more than one next attempt", async () => {
    const harness = createHarness();
    const dispatch = createDispatch("logical-race", harness.policy);
    harness.registry.start(dispatch);
    await vi.waitFor(() => expect(harness.bridge.startedRequests).toHaveLength(1));
    emitHttpError(harness.bridge, harness.bridge.startedRequests[0]!.requestId, 429, "1");
    await vi.waitFor(() =>
      expect(harness.registry.get(dispatch.transportRequest.requestId)?.status).toBe(
        "waiting_retry",
      ),
    );

    harness.clock.advanceBy(1_000);
    harness.registry.stop(dispatch.transportRequest.requestId);
    const terminal = await harness.registry.whenTerminal(dispatch.transportRequest.requestId);

    expect(terminal.status).toBe("interrupted");
    expect(harness.bridge.startedRequests.length).toBeLessThanOrEqual(2);
    expect(harness.persistence.retryStarts.length).toBeLessThanOrEqual(1);
    expect(harness.clock.pendingCount).toBe(0);
  });

  it.each([
    ["HTTP 408", { kind: "http" as const, message: "temporary", status: 408 }],
    ["HTTP 500", { kind: "http" as const, message: "temporary", status: 500 }],
    ["HTTP 502", { kind: "http" as const, message: "temporary", status: 502 }],
    ["HTTP 503", { kind: "http" as const, message: "temporary", status: 503 }],
    ["HTTP 504", { kind: "http" as const, message: "temporary", status: 504 }],
    ["network", { kind: "network" as const, message: "reset" }],
    ["timeout", { kind: "timeout" as const, message: "slow" }],
  ])("schedules a retry for %s before valuable output", async (_name, error) => {
    const harness = createHarness();
    const dispatch = createDispatch(`logical-${_name}`, harness.policy);
    harness.registry.start(dispatch);
    await vi.waitFor(() => expect(harness.bridge.startedRequests).toHaveLength(1));
    harness.bridge.emit({
      type: "error",
      requestId: harness.bridge.startedRequests[0]!.requestId,
      error,
    });

    await vi.waitFor(() => expect(harness.persistence.scheduled).toHaveLength(1));
    harness.registry.stop(dispatch.transportRequest.requestId);
    await harness.registry.whenTerminal(dispatch.transportRequest.requestId);
  });

  it.each([400, 401, 403, 404, 422])("does not retry non-temporary HTTP %s", async (status) => {
    const harness = createHarness({ baseDelayMs: 0, maxDelayMs: 0 });
    const dispatch = createDispatch(`logical-http-${status}`, harness.policy);
    harness.registry.start(dispatch);
    await vi.waitFor(() => expect(harness.bridge.startedRequests).toHaveLength(1));
    emitHttpError(harness.bridge, harness.bridge.startedRequests[0]!.requestId, status);

    expect((await harness.registry.whenTerminal(dispatch.transportRequest.requestId)).status).toBe(
      "error",
    );
    expect(harness.persistence.scheduled).toHaveLength(0);
    expect(harness.bridge.startedRequests).toHaveLength(1);
  });

  it("does not delete a rejected unknown parameter or resend a downgraded body", async () => {
    const harness = createHarness({ baseDelayMs: 0, maxDelayMs: 0 });
    const dispatch = createDispatch("logical-parameter-rejected", harness.policy);
    dispatch.transportRequest.body = JSON.stringify({
      model: "unknown-model",
      future_parameter: "kept",
    });
    harness.registry.start(dispatch);
    await vi.waitFor(() => expect(harness.bridge.startedRequests).toHaveLength(1));

    emitHttpError(harness.bridge, harness.bridge.startedRequests[0]!.requestId, 422);
    expect((await harness.registry.whenTerminal(dispatch.transportRequest.requestId)).status).toBe(
      "error",
    );
    expect(harness.bridge.startedRequests).toHaveLength(1);
    expect(JSON.parse(harness.bridge.startedRequests[0]!.body ?? "{}")).toEqual({
      model: "unknown-model",
      future_parameter: "kept",
    });
    expect(harness.persistence.scheduled).toHaveLength(0);
  });

  it("falls back from an invalid Retry-After and records the stable reason", async () => {
    const harness = createHarness();
    const dispatch = createDispatch("logical-invalid-retry-after", harness.policy);
    harness.registry.start(dispatch);
    await vi.waitFor(() => expect(harness.bridge.startedRequests).toHaveLength(1));
    emitHttpError(harness.bridge, harness.bridge.startedRequests[0]!.requestId, 429, "not-a-delay");

    await vi.waitFor(() =>
      expect(harness.registry.get(dispatch.transportRequest.requestId)?.retry).toMatchObject({
        delayMs: 500,
        delaySource: "full_jitter",
        retryAfterInvalid: true,
      }),
    );
    expect(harness.persistence.scheduled[0]?.retryReason).toBe("retry_after_invalid");
    harness.registry.stop(dispatch.transportRequest.requestId);
    await harness.registry.whenTerminal(dispatch.transportRequest.requestId);
  });

  it("stops at the attempt limit with retry_exhausted", async () => {
    const harness = createHarness({ baseDelayMs: 0, maxDelayMs: 0, maxRetries: 1 });
    const dispatch = createDispatch("logical-attempt-limit", harness.policy);
    harness.registry.start(dispatch);
    await vi.waitFor(() => expect(harness.bridge.startedRequests).toHaveLength(1));
    emitHttpError(harness.bridge, harness.bridge.startedRequests[0]!.requestId, 503, "0");
    await vi.waitFor(() => expect(harness.persistence.scheduled).toHaveLength(1));
    harness.clock.runDue();
    await vi.waitFor(() => expect(harness.bridge.startedRequests).toHaveLength(2));
    emitHttpError(harness.bridge, harness.bridge.startedRequests[1]!.requestId, 503, "0");

    const terminal = await harness.registry.whenTerminal(dispatch.transportRequest.requestId);
    expect(terminal).toMatchObject({
      status: "error",
      error: { code: "retry_exhausted" },
      attempts: [
        { attemptNo: 1, status: "retryable_failed" },
        { attemptNo: 2, status: "non_retryable_failed" },
      ],
    });
  });

  it("does not start a delayed attempt after the total budget expires", async () => {
    const harness = createHarness({ maxTotalElapsedMs: 1_500 });
    const dispatch = createDispatch("logical-late-budget", harness.policy);
    harness.registry.start(dispatch);
    await vi.waitFor(() => expect(harness.bridge.startedRequests).toHaveLength(1));
    emitHttpError(harness.bridge, harness.bridge.startedRequests[0]!.requestId, 429, "1");
    await vi.waitFor(() =>
      expect(harness.registry.get(dispatch.transportRequest.requestId)?.status).toBe(
        "waiting_retry",
      ),
    );

    harness.clock.advanceBy(2_000);
    const terminal = await harness.registry.whenTerminal(dispatch.transportRequest.requestId);
    expect(terminal).toMatchObject({
      status: "error",
      error: { code: "retry_budget_exhausted" },
    });
    expect(harness.bridge.startedRequests).toHaveLength(1);
    expect(harness.persistence.retryStarts).toHaveLength(0);
    expect(harness.persistence.interrupted[0]).toMatchObject({
      errorCode: "retry_budget_exhausted",
      status: "error",
    });
  });
});

class StaticParser implements OpenAIStreamParser {
  constructor(private readonly events: StreamDomainEvent[]) {}

  finish(): StreamDomainEvent[] {
    return [];
  }

  push(): StreamDomainEvent[] {
    return structuredClone(this.events);
  }
}

class ManualClock {
  private nextTaskId = 0;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();

  constructor(private value = 1_000) {}

  readonly now = () => this.value;

  readonly schedule = (delayMs: number, callback: () => void) => {
    const id = ++this.nextTaskId;
    this.tasks.set(id, { at: this.value + delayMs, callback });
    return () => this.tasks.delete(id);
  };

  get pendingCount(): number {
    return this.tasks.size;
  }

  advanceBy(delayMs: number): void {
    this.value += delayMs;
    this.runDue();
  }

  runDue(): void {
    const due = [...this.tasks.entries()]
      .filter(([, task]) => task.at <= this.value)
      .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
    due.forEach(([id, task]) => {
      if (this.tasks.delete(id)) {
        task.callback();
      }
    });
  }
}

class CaptureRetryPersistence implements ActiveRequestPersistence {
  readonly finalized: FinalizeRequestAttemptInput[] = [];
  readonly interrupted: InterruptWaitingRetryInput[] = [];
  readonly logicalStarts: Array<{ attempt: RequestAttempt; snapshot: RequestSnapshot }> = [];
  readonly retryStarts: RequestAttempt[] = [];
  readonly scheduled: ScheduleRetryInput[] = [];
  readonly updatedMessages: Array<{ id: string; status: string }> = [];

  async startLogicalRequest(snapshot: RequestSnapshot, attempt: RequestAttempt): Promise<void> {
    this.logicalStarts.push({
      snapshot: structuredClone(snapshot),
      attempt: structuredClone(attempt),
    });
  }

  async scheduleRetry(input: ScheduleRetryInput): Promise<void> {
    this.scheduled.push(structuredClone(input));
  }

  async startRetryAttempt(_assistantMessageId: string, attempt: RequestAttempt): Promise<void> {
    this.retryStarts.push(structuredClone(attempt));
  }

  async finalizeRequestAttempt(input: FinalizeRequestAttemptInput): Promise<boolean> {
    this.finalized.push(structuredClone(input));
    return true;
  }

  async interruptWaitingRetry(input: InterruptWaitingRetryInput): Promise<void> {
    this.interrupted.push(structuredClone(input));
  }

  async updateMessage(id: string, status: MessageStatus) {
    this.updatedMessages.push({ id, status });
  }

  async finalizeChatRequest(): Promise<boolean> {
    throw new Error("legacy finalization must not be used");
  }

  async markRequestRunning(): Promise<void> {
    throw new Error("legacy start must not be used");
  }
}

function createHarness(overrides: Partial<RetryPolicy> = {}) {
  const bridge = new FakeDesktopBridge();
  const persistence = new CaptureRetryPersistence();
  const clock = new ManualClock();
  const policy = resolveRetryPolicy(overrides as JsonObject, DEFAULT_RETRY_POLICY);
  let nextId = 0;
  const registry = new ActiveRequestRegistry(bridge, persistence, clock.now, {
    createId: () => `generated-${++nextId}`,
    random: () => 0.5,
    schedule: clock.schedule,
  });
  return { bridge, clock, persistence, policy, registry };
}

function emitHttpError(
  bridge: FakeDesktopBridge,
  requestId: string,
  status: number,
  retryAfter?: string,
) {
  bridge.emit({
    type: "error",
    requestId,
    error: {
      kind: "http",
      message: `HTTP ${status}`,
      status,
      ...(retryAfter === undefined ? {} : { retryAfter }),
    },
  });
}

function createDispatch(
  requestId: string,
  retryPolicy: RetryPolicy,
  parser: (() => OpenAIStreamParser) | undefined = undefined,
): PreparedDispatch {
  const userMessage = {
    id: `${requestId}-user`,
    conversationId: `${requestId}-conversation`,
    role: "user" as const,
    blocks: { version: 1 as const, blocks: [{ type: "text" as const, text: "hello" }] },
    status: "done" as const,
    usage: null,
    modelRef: "model-1",
    parentId: `${requestId}-conversation:root`,
    siblingOrder: 0,
    providerResponseId: null,
    providerPreviousResponseId: null,
    requestSnapshotId: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
  const assistantPlaceholder = {
    ...userMessage,
    id: `${requestId}-assistant`,
    role: "assistant" as const,
    blocks: { version: 1 as const, blocks: [] },
    status: "pending" as const,
    parentId: userMessage.id,
  };
  const manifest = {
    version: 1 as const,
    conversationId: userMessage.conversationId,
    anchorMessageId: userMessage.id,
    hash: "sha256:manifest",
    items: [],
    policy: "lossless" as const,
  };
  const context = {
    version: 1 as const,
    conversationId: userMessage.conversationId,
    anchorMessageId: userMessage.id,
    contextHash: "sha256:context",
    system: [],
    turns: [],
    manifest,
  };
  const request = {
    requestId,
    url: "https://fixture.invalid/v1/chat/completions",
    method: "POST",
    headers: [{ name: "Authorization", value: "Bearer frozen" }],
    query: [{ name: "api-version", value: "fixed" }],
    body: JSON.stringify({ model: "fixed-model", stream: true, temperature: 0.2 }),
  };
  return {
    assistantPlaceholder,
    canonicalContext: context,
    contextManifest: manifest,
    modelRevision: 1,
    parser: parser ?? (() => new ChatCompletionsStreamParser()),
    preview: {
      body: { model: "fixed-model", stream: true, temperature: 0.2 },
      headers: [{ name: "Authorization", value: "Bearer [credential]" }],
      method: "POST",
      query: request.query,
      sources: { body: {}, headers: {}, path: {}, query: {} },
      timeoutMs: null,
      url: request.url,
    },
    profileRevision: 1,
    redactedRequest: {
      ...request,
      headers: [{ name: "Authorization", value: "Bearer [credential]" }],
    },
    requestSnapshot: {
      id: `${requestId}-snapshot`,
      conversationId: userMessage.conversationId,
      userMessageId: userMessage.id,
      assistantMessageId: assistantPlaceholder.id,
      connectionId: "connection-1",
      endpointId: "endpoint-1",
      modelRef: "model-1",
      protocolProfileId: "profile-1",
      protocolProfileRevision: 1,
      codecVersion: "openai_chat_completions/1",
      requestMethod: "POST",
      requestUrl: request.url,
      requestHeaders: [],
      requestQuery: request.query,
      requestBody: { model: "fixed-model", stream: true, temperature: 0.2 },
      params: { temperature: 0.2 },
      contextManifest: manifest,
      contextHash: "sha256:context",
      requestBodyHash: "sha256:body",
      retryPolicy,
      attemptCount: 0,
      providerAnchor: null,
      status: "pending",
      finishReason: null,
      errorCode: null,
      startedAt: 1_000,
      firstEventAt: null,
      completedAt: null,
    },
    retryPolicy,
    transportRequest: request,
    userMessage,
  };
}
