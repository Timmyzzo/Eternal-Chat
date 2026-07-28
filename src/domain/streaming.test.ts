import { describe, expect, it } from "vitest";

import {
  createStreamingMessageState,
  isValuableStreamEvent,
  reduceStreamingMessage,
} from "@/domain/streaming";

describe("streaming message reducer", () => {
  it("coalesces stable text and thinking blocks with local timing", () => {
    let state = createStreamingMessageState({
      assistantMessageId: "assistant-1",
      requestId: "request-1",
      startedAt: 10,
    });
    state = reduceStreamingMessage(state, { type: "started", responseId: "response-1" }, 11);
    state = reduceStreamingMessage(
      state,
      {
        type: "thinking_started",
        blockId: "reasoning-1",
        label: "Reasoning summary",
        visibility: "summary",
      },
      12,
    );
    state = reduceStreamingMessage(
      state,
      {
        type: "thinking_delta",
        blockId: "reasoning-1",
        delta: "think",
        visibility: "summary",
      },
      13,
    );
    state = reduceStreamingMessage(
      state,
      {
        type: "thinking_delta",
        blockId: "reasoning-1",
        delta: "ing",
        visibility: "summary",
      },
      14,
    );
    state = reduceStreamingMessage(
      state,
      { type: "thinking_completed", blockId: "reasoning-1" },
      15,
    );
    state = reduceStreamingMessage(
      state,
      { type: "text_delta", blockId: "answer-1", delta: "answer" },
      16,
    );
    state = reduceStreamingMessage(
      state,
      { type: "done", finishReason: "stop", responseId: "response-1" },
      17,
    );

    expect(state).toMatchObject({
      status: "done",
      firstEventAt: 11,
      firstTextAt: 16,
      completedAt: 17,
      responseId: "response-1",
      finishReason: "stop",
      blocks: {
        blocks: [
          {
            type: "thinking",
            blockId: "reasoning-1",
            text: "thinking",
            visibility: "summary",
            startedAt: 12,
            finishedAt: 15,
            durationMs: 3,
          },
          { type: "text", blockId: "answer-1", text: "answer" },
        ],
      },
    });
    expect(state.blocks.timeline?.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(
      reduceStreamingMessage(
        state,
        {
          type: "error",
          error: { code: "transport_error", message: "late", retryable: false },
        },
        18,
      ),
    ).toBe(state);
  });

  it("updates parallel tools by id and deduplicates sources without losing associations", () => {
    let state = createStreamingMessageState({
      assistantMessageId: "assistant-tools",
      requestId: "request-tools",
      startedAt: 20,
    });
    state = reduceStreamingMessage(
      state,
      {
        type: "tool_call_started",
        call: { id: "search-1", name: "web_search", args: { query: "phase 7" } },
      },
      21,
    );
    state = reduceStreamingMessage(
      state,
      {
        type: "tool_call_started",
        call: { id: "search-2", name: "x_search", args: { query: "phase 7" } },
      },
      22,
    );
    state = reduceStreamingMessage(
      state,
      {
        type: "source",
        source: {
          id: "source-1",
          kind: "web",
          title: "Example",
          url: "https://example.com/phase7",
          toolCallId: "search-1",
        },
      },
      23,
    );
    state = reduceStreamingMessage(
      state,
      {
        type: "source",
        source: {
          id: "source-1",
          kind: "web",
          title: "Example",
          url: "https://example.com/phase7",
          toolCallId: "search-2",
        },
      },
      24,
    );
    state = reduceStreamingMessage(
      state,
      {
        type: "tool_result",
        id: "search-2",
        result: { modelContent: { results: ["source-1"] } },
      },
      25,
    );
    state = reduceStreamingMessage(
      state,
      {
        type: "tool_result",
        id: "search-1",
        result: { modelContent: { results: ["source-1"] } },
      },
      26,
    );

    expect(state.blocks.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "search-1", status: "succeeded", type: "tool_call" }),
        expect.objectContaining({ id: "search-2", status: "succeeded", type: "tool_call" }),
        expect.objectContaining({
          id: "source-1",
          toolCallIds: ["search-1", "search-2"],
          type: "source",
        }),
      ]),
    );
  });

  it("retains partial content and closes running thinking and tools on interruption", () => {
    let partial = reduceStreamingMessage(
      createStreamingMessageState({
        assistantMessageId: "assistant-2",
        requestId: "request-2",
        startedAt: 30,
      }),
      { type: "text_delta", delta: "partial" },
      31,
    );
    partial = reduceStreamingMessage(
      partial,
      {
        type: "thinking_started",
        blockId: "reasoning-interrupted",
        visibility: "summary",
      },
      32,
    );
    partial = reduceStreamingMessage(
      partial,
      {
        type: "thinking_delta",
        blockId: "reasoning-interrupted",
        delta: "partial reasoning",
        visibility: "summary",
      },
      33,
    );
    partial = reduceStreamingMessage(
      partial,
      { type: "tool_call_started", call: { id: "call-1", name: "web_search" } },
      34,
    );
    const interrupted = reduceStreamingMessage(
      partial,
      {
        type: "interrupted",
        code: "retry_disallowed_after_output",
        finishReason: "cancelled",
        message: "stopped",
      },
      35,
    );

    expect(interrupted).toMatchObject({ status: "interrupted" });
    expect(interrupted.blocks.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "partial" }),
        expect.objectContaining({
          blockId: "reasoning-interrupted",
          durationMs: 3,
          finishedAt: 35,
          type: "thinking",
        }),
        expect.objectContaining({ id: "call-1", status: "cancelled", type: "tool_call" }),
        expect.objectContaining({ type: "error", code: "retry_disallowed_after_output" }),
      ]),
    );
  });

  it("tracks attempt metadata and classifies provider events as valuable output", () => {
    const state = createStreamingMessageState({
      assistantMessageId: "assistant-3",
      attemptNo: 2,
      maxAttempts: 4,
      requestId: "logical-request",
      startedAt: 40,
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
    expect(
      isValuableStreamEvent({
        type: "tool_call_started",
        call: { id: "call-1", name: "web_search" },
      }),
    ).toBe(true);
    expect(
      isValuableStreamEvent({
        type: "source",
        source: { id: "source-1", kind: "web", url: "https://example.com" },
      }),
    ).toBe(true);
    expect(isValuableStreamEvent({ type: "heartbeat", idleMs: 1_000 })).toBe(false);
    expect(
      isValuableStreamEvent({
        type: "error",
        error: { code: "transport_error", message: "failed", retryable: false },
      }),
    ).toBe(false);
  });
});
