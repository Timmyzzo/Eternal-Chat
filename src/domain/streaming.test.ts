import { describe, expect, it } from "vitest";

import {
  createStreamingMessageState,
  isValuableStreamEvent,
  reduceStreamingMessage,
} from "@/domain/streaming";

describe("streaming message reducer", () => {
  it("coalesces adjacent blocks and applies a terminal state exactly once", () => {
    let state = createStreamingMessageState({
      assistantMessageId: "assistant-1",
      requestId: "request-1",
      startedAt: 10,
    });
    state = reduceStreamingMessage(state, { type: "started", responseId: "response-1" }, 11);
    state = reduceStreamingMessage(
      state,
      { type: "thinking_delta", delta: "think", visibility: "provider_returned" },
      12,
    );
    state = reduceStreamingMessage(
      state,
      { type: "thinking_delta", delta: "ing", visibility: "provider_returned" },
      13,
    );
    state = reduceStreamingMessage(state, { type: "text_delta", delta: "answer" }, 14);
    state = reduceStreamingMessage(
      state,
      { type: "done", finishReason: "stop", responseId: "response-1" },
      15,
    );

    expect(state).toMatchObject({
      status: "done",
      firstEventAt: 11,
      completedAt: 15,
      responseId: "response-1",
      finishReason: "stop",
      blocks: {
        blocks: [
          { type: "thinking", text: "thinking" },
          { type: "text", text: "answer" },
        ],
      },
    });
    expect(
      reduceStreamingMessage(
        state,
        {
          type: "error",
          error: { code: "transport_error", message: "late", retryable: false },
        },
        16,
      ),
    ).toBe(state);
  });

  it("retains partial content and adds an error or interruption block", () => {
    const partial = reduceStreamingMessage(
      createStreamingMessageState({
        assistantMessageId: "assistant-2",
        requestId: "request-2",
        startedAt: 20,
      }),
      { type: "text_delta", delta: "partial" },
      21,
    );
    expect(
      reduceStreamingMessage(
        partial,
        {
          type: "error",
          error: { code: "transport_error", message: "failed", retryable: false },
        },
        22,
      ).blocks.blocks,
    ).toEqual([
      { type: "text", text: "partial" },
      { type: "error", code: "transport_error", message: "failed", retryable: false },
    ]);
    expect(
      reduceStreamingMessage(
        partial,
        {
          type: "interrupted",
          code: "retry_disallowed_after_output",
          finishReason: "cancelled",
          message: "stopped",
        },
        23,
      ),
    ).toMatchObject({
      status: "interrupted",
      blocks: {
        blocks: [
          { type: "text", text: "partial" },
          { type: "error", code: "retry_disallowed_after_output" },
        ],
      },
    });
  });

  it("tracks attempt metadata and treats tool and source markers as valuable output", () => {
    const state = createStreamingMessageState({
      assistantMessageId: "assistant-3",
      attemptNo: 2,
      maxAttempts: 4,
      requestId: "logical-request",
      startedAt: 30,
      transportRequestId: "transport-2",
    });

    expect(state).toMatchObject({
      attemptNo: 2,
      maxAttempts: 4,
      requestId: "logical-request",
      transportRequestId: "transport-2",
      attempts: [],
      retry: null,
    });
    expect(isValuableStreamEvent({ type: "semantic", kind: "tool" })).toBe(true);
    expect(isValuableStreamEvent({ type: "semantic", kind: "source" })).toBe(true);
    expect(
      isValuableStreamEvent({
        type: "error",
        error: { code: "transport_error", message: "failed", retryable: false },
      }),
    ).toBe(false);
  });
});
