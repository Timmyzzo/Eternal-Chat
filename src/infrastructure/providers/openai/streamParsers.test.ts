import { describe, expect, it } from "vitest";

import {
  ChatCompletionsStreamParser,
  ResponsesStreamParser,
} from "@/infrastructure/providers/openai/streamParsers";

describe("ChatCompletionsStreamParser", () => {
  it("parses text, configured reasoning lifecycle, usage, response id, and DONE", () => {
    const parser = new ChatCompletionsStreamParser(["reasoning_content"]);

    expect(
      parser.push(
        JSON.stringify({
          id: "chat-response-1",
          choices: [
            {
              delta: { content: "answer", reasoning_content: "thought" },
              finish_reason: null,
            },
          ],
        }),
      ),
    ).toEqual([
      { type: "started", responseId: "chat-response-1" },
      { type: "text_delta", blockId: "output_text", delta: "answer" },
      {
        type: "thinking_started",
        blockId: "reasoning:0",
        label: "Provider reasoning",
        visibility: "provider_returned",
      },
      {
        type: "thinking_delta",
        blockId: "reasoning:0",
        delta: "thought",
        label: "Provider reasoning",
        visibility: "provider_returned",
      },
    ]);
    expect(
      parser.push(
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      ),
    ).toEqual([
      {
        type: "usage",
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ]);
    expect(parser.push("[DONE]")).toEqual([
      { type: "thinking_completed", blockId: "reasoning:0" },
      { type: "done", finishReason: "stop", responseId: "chat-response-1" },
    ]);
  });

  it("accumulates tool arguments by stable index and completes them before DONE", () => {
    const parser = new ChatCompletionsStreamParser();
    expect(
      parser.push(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call-1", function: { name: "search", arguments: '{"q":' } },
                ],
              },
            },
          ],
        }),
      ),
    ).toEqual([
      {
        type: "tool_call_started",
        call: {
          id: "call-1",
          name: "search",
          args: {},
          source: "provider",
          providerMeta: { protocol: "chat_completions", toolIndex: 0 },
        },
      },
      { type: "tool_call_delta", id: "call-1", argsDelta: '{"q":' },
    ]);
    parser.push(
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"phase7"}' } }] } }],
      }),
    );
    expect(parser.push("[DONE]")).toEqual([
      { type: "tool_call_completed", id: "call-1", args: { q: "phase7" } },
      { type: "done", finishReason: null, responseId: undefined },
    ]);
  });

  it("reports malformed, embedded, missing, and post-terminal events", () => {
    expect(new ChatCompletionsStreamParser().push("  ")).toEqual([]);
    expect(new ChatCompletionsStreamParser().push("not-json")[0]).toMatchObject({
      type: "error",
      error: { code: "chat_malformed_json" },
    });
    expect(
      new ChatCompletionsStreamParser().push(
        JSON.stringify({ error: { code: "provider_code", message: "Provider rejected it" } }),
      )[0],
    ).toMatchObject({
      type: "error",
      error: { code: "chat_stream_error", details: { providerCode: "provider_code" } },
    });
    expect(new ChatCompletionsStreamParser().finish()[0]).toMatchObject({
      type: "error",
      error: { code: "chat_missing_terminal" },
    });

    const terminal = new ChatCompletionsStreamParser();
    terminal.push("[DONE]");
    expect(terminal.push(JSON.stringify({ choices: [] }))[0]).toMatchObject({
      type: "error",
      error: { code: "chat_event_after_terminal" },
    });
  });
});

describe("ResponsesStreamParser", () => {
  it("parses reasoning, search, sources, citations, agents, usage, and completion", () => {
    const parser = new ResponsesStreamParser();
    expect(
      parser.push(
        JSON.stringify({
          type: "response.created",
          response: {
            id: "resp-1",
            previous_response_id: "resp-0",
            reasoning: { effort: "high" },
            rollout_ids: ["rollout-1"],
          },
        }),
      ),
    ).toEqual([
      { type: "started", responseId: "resp-1" },
      { type: "metadata", key: "previous_response_id", value: "resp-0" },
      { type: "metadata", key: "reasoning_layout", value: { effort: "high" } },
      { type: "metadata", key: "rollout_ids", value: ["rollout-1"] },
    ]);
    expect(
      parser.push(
        JSON.stringify({
          type: "response.reasoning_summary_text.delta",
          item_id: "reasoning-1",
          delta: "summary",
        }),
      ),
    ).toEqual([
      {
        type: "thinking_started",
        blockId: "reasoning-1",
        label: "Reasoning summary",
        visibility: "summary",
      },
      {
        type: "thinking_delta",
        blockId: "reasoning-1",
        delta: "summary",
        label: "Reasoning summary",
        visibility: "summary",
      },
    ]);
    expect(
      parser.push(
        JSON.stringify({
          type: "response.output_item.added",
          item: {
            id: "search-1",
            type: "web_search_call",
            action: { type: "search", query: "phase 7" },
          },
        }),
      )[0],
    ).toMatchObject({
      type: "tool_call_started",
      call: { id: "search-1", name: "web_search" },
    });
    const searchCompleted = parser.push(
      JSON.stringify({
        type: "response.web_search_call.completed",
        item_id: "search-1",
        query: "phase 7",
        results: [{ id: "source-1", title: "Example", url: "https://example.com/phase7" }],
      }),
    );
    expect(searchCompleted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "source",
          source: expect.objectContaining({ id: "source-1" }),
        }),
        expect.objectContaining({ type: "tool_result", id: "search-1" }),
      ]),
    );
    expect(
      parser.push(
        JSON.stringify({
          type: "response.output_text.annotation.added",
          item_id: "search-1",
          annotation: {
            source_id: "source-1",
            citation_id: "citation-1",
            title: "Example",
            url: "https://example.com/phase7",
            start_index: 0,
            end_index: 7,
          },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "source",
        source: expect.objectContaining({ id: "source-1" }),
      }),
      expect.objectContaining({
        type: "citation",
        citation: expect.objectContaining({ id: "citation-1" }),
      }),
    ]);
    expect(
      parser.push(
        JSON.stringify({
          type: "response.agent_status",
          rollout_id: "rollout-1",
          agent: { id: "agent-1", label: "Search agent", status: "completed" },
        }),
      )[0],
    ).toMatchObject({
      type: "agent_status",
      agent: { id: "agent-1", rolloutId: "rollout-1", status: "completed" },
    });
    expect(
      parser.push(JSON.stringify({ type: "response.output_text.delta", delta: "answer" })),
    ).toEqual([{ type: "text_delta", blockId: "output_text", delta: "answer" }]);
    expect(
      parser.push(
        JSON.stringify({
          type: "response.completed",
          response: { id: "resp-1", usage: { input_tokens: 4, output_tokens: 3 } },
        }),
      ),
    ).toEqual([
      { type: "thinking_completed", blockId: "reasoning-1" },
      { type: "usage", usage: { input_tokens: 4, output_tokens: 3 } },
      { type: "done", finishReason: "completed", responseId: "resp-1" },
    ]);
  });

  it("keeps unknown typed events as compatibility warnings and continues", () => {
    const parser = new ResponsesStreamParser();
    expect(parser.push(JSON.stringify({ type: "response.output_item.added" }))).toEqual([]);
    expect(parser.push(JSON.stringify({ type: "future.event" }))).toEqual([
      {
        type: "metadata",
        key: "compatibility_warning",
        value: { code: "responses_unknown_event", eventType: "future.event" },
      },
    ]);
    expect(
      parser.push(JSON.stringify({ type: "response.output_text.delta", delta: "still works" })),
    ).toEqual([{ type: "text_delta", blockId: "output_text", delta: "still works" }]);
  });

  it("maps failed, incomplete, error, malformed, missing, and post-terminal boundaries", () => {
    expect(
      new ResponsesStreamParser().push(
        JSON.stringify({
          type: "response.failed",
          response: { error: { code: "bad_request", message: "Rejected" } },
        }),
      )[0],
    ).toMatchObject({
      type: "error",
      error: { code: "responses_failed", details: { providerCode: "bad_request" } },
    });
    expect(
      new ResponsesStreamParser().push(
        JSON.stringify({
          type: "response.incomplete",
          response: { incomplete_details: { reason: "max_output_tokens" } },
        }),
      )[0],
    ).toMatchObject({ type: "error", error: { code: "responses_incomplete" } });
    expect(
      new ResponsesStreamParser().push(
        JSON.stringify({ type: "error", code: "server_error", message: "Unavailable" }),
      )[0],
    ).toMatchObject({ type: "error", error: { code: "responses_error" } });
    expect(new ResponsesStreamParser().push("{")[0]).toMatchObject({
      type: "error",
      error: { code: "responses_malformed_event" },
    });
    expect(new ResponsesStreamParser().finish()[0]).toMatchObject({
      type: "error",
      error: { code: "responses_missing_terminal" },
    });

    const terminal = new ResponsesStreamParser();
    terminal.push(JSON.stringify({ type: "response.completed", response: {} }));
    expect(terminal.push(JSON.stringify({ type: "response.in_progress" }))[0]).toMatchObject({
      type: "error",
      error: { code: "responses_event_after_terminal" },
    });
  });
});
