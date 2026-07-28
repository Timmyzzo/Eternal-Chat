import { describe, expect, it } from "vitest";

import {
  ChatCompletionsStreamParser,
  ResponsesStreamParser,
} from "@/infrastructure/providers/openai/streamParsers";

describe("ChatCompletionsStreamParser", () => {
  it("parses text, configured reasoning, usage, finish reason, response id, and DONE", () => {
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
      { type: "text_delta", delta: "answer" },
      { type: "thinking_delta", delta: "thought", visibility: "provider_returned" },
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
      { type: "done", finishReason: "stop", responseId: "chat-response-1" },
    ]);
  });

  it("ignores heartbeat data and reports malformed, missing, and post-terminal events", () => {
    expect(new ChatCompletionsStreamParser().push("  ")).toEqual([]);
    expect(new ChatCompletionsStreamParser().push("not-json")[0]).toMatchObject({
      type: "error",
      error: { code: "chat_malformed_json" },
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

  it("maps structured stream errors to a stable code", () => {
    expect(
      new ChatCompletionsStreamParser().push(
        JSON.stringify({ error: { code: "provider_code", message: "Provider rejected it" } }),
      )[0],
    ).toMatchObject({
      type: "error",
      error: {
        code: "chat_stream_error",
        details: { embedded: true, providerCode: "provider_code" },
        message: "Provider rejected it",
      },
    });
  });

  it("marks tool calls as valuable semantic output", () => {
    expect(
      new ChatCompletionsStreamParser().push(
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ id: "call-1", type: "function" }] } }],
        }),
      ),
    ).toEqual([{ type: "semantic", kind: "tool" }]);
  });
});

describe("ResponsesStreamParser", () => {
  it("parses created, text, reasoning, usage, response id, and completed", () => {
    const parser = new ResponsesStreamParser();
    expect(
      parser.push(JSON.stringify({ type: "response.created", response: { id: "resp-1" } })),
    ).toEqual([{ type: "started", responseId: "resp-1" }]);
    expect(
      parser.push(JSON.stringify({ type: "response.output_text.delta", delta: "answer" })),
    ).toEqual([{ type: "text_delta", delta: "answer" }]);
    expect(
      parser.push(
        JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "summary" }),
      ),
    ).toEqual([{ type: "thinking_delta", delta: "summary", visibility: "provider_returned" }]);
    expect(
      parser.push(
        JSON.stringify({
          type: "response.completed",
          response: { id: "resp-1", usage: { input_tokens: 4, output_tokens: 3 } },
        }),
      ),
    ).toEqual([
      { type: "usage", usage: { input_tokens: 4, output_tokens: 3 } },
      { type: "done", finishReason: "completed", responseId: "resp-1" },
    ]);
  });

  it("recognizes lifecycle envelopes but rejects unknown typed events", () => {
    const parser = new ResponsesStreamParser();
    expect(parser.push(JSON.stringify({ type: "response.output_item.added" }))).toEqual([]);
    expect(parser.push(JSON.stringify({ type: "future.event" }))[0]).toMatchObject({
      type: "error",
      error: { code: "responses_unknown_event", details: { eventType: "future.event" } },
    });
  });

  it("marks Responses tool and source events as valuable semantic output", () => {
    const parser = new ResponsesStreamParser();
    expect(
      parser.push(
        JSON.stringify({
          type: "response.output_item.added",
          item: { id: "call-1", type: "function_call" },
        }),
      ),
    ).toEqual([{ type: "semantic", kind: "tool" }]);
    expect(
      parser.push(
        JSON.stringify({
          type: "response.output_text.annotation.added",
          annotation: { type: "url_citation", url: "https://example.com" },
        }),
      ),
    ).toEqual([{ type: "semantic", kind: "source" }]);
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
      error: {
        code: "responses_failed",
        details: { embedded: true, providerCode: "bad_request" },
      },
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
    ).toMatchObject({
      type: "error",
      error: {
        code: "responses_error",
        details: { embedded: true, providerCode: "server_error" },
      },
    });
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
