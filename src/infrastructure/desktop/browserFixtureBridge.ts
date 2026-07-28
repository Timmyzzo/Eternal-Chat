import type { DesktopBridge, NotificationPort } from "@/infrastructure/desktop/desktopBridge";
import type { PipeEvent, PipeRequest } from "@/infrastructure/desktop/pipeContract";

interface RunningFixture {
  onEvent: (event: PipeEvent) => void;
  resolve: () => void;
  timers: number[];
}

const notifications: NotificationPort = { async show() {} };

export class BrowserFixtureBridge implements DesktopBridge {
  readonly notifications = notifications;
  private readonly retryAttempts = new Map<string, number>();
  private readonly running = new Map<string, RunningFixture>();

  async cancelStream(requestId: string): Promise<void> {
    const fixture = this.running.get(requestId);
    if (!fixture) {
      return;
    }
    fixture.timers.forEach((timer) => window.clearTimeout(timer));
    this.running.delete(requestId);
    fixture.onEvent({
      type: "error",
      requestId,
      error: { kind: "cancelled", message: "The browser fixture was cancelled." },
    });
    fixture.resolve();
  }

  async openExternal(url: string): Promise<void> {
    window.open(url, "_blank", "noopener,noreferrer");
  }

  startStream(request: PipeRequest, onEvent: (event: PipeEvent) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      const body = request.body ? (JSON.parse(request.body) as Record<string, unknown>) : {};
      const responses = Array.isArray(body.input);
      const retryKey = request.body ?? "";
      const retryFixture = retryKey.includes("Retry UI");
      const retryAttempt = retryFixture ? (this.retryAttempts.get(retryKey) ?? 0) + 1 : 0;
      if (retryFixture) {
        this.retryAttempts.set(retryKey, retryAttempt);
      }
      const payloads =
        retryFixture && retryAttempt === 1
          ? retryPayloads(request.requestId)
          : responses
            ? responsesPayloads(request.requestId)
            : chatPayloads(request.requestId);
      const fixture: RunningFixture = { onEvent, resolve, timers: [] };
      this.running.set(request.requestId, fixture);
      payloads.forEach((event, index) => {
        fixture.timers.push(
          window.setTimeout(
            () => {
              if (!this.running.has(request.requestId)) {
                return;
              }
              onEvent(event);
              if (event.type === "done" || event.type === "error") {
                this.running.delete(request.requestId);
                if (retryFixture && retryAttempt > 1) {
                  this.retryAttempts.delete(retryKey);
                }
                resolve();
              }
            },
            90 + index * 90,
          ),
        );
      });
    });
  }
}

function retryPayloads(requestId: string): PipeEvent[] {
  return [
    {
      type: "error",
      requestId,
      error: {
        kind: "http",
        message: "The browser fixture is temporarily rate limited.",
        retryAfter: "5",
        status: 429,
      },
    },
  ];
}

function chatPayloads(requestId: string): PipeEvent[] {
  return [
    {
      type: "data",
      requestId,
      data: [
        JSON.stringify({
          id: `browser-chat-${requestId}`,
          choices: [{ delta: { reasoning: "Checking the local fixture. " } }],
        }),
      ],
    },
    {
      type: "data",
      requestId,
      data: [JSON.stringify({ choices: [{ delta: { content: "This response is streaming " } }] })],
    },
    {
      type: "data",
      requestId,
      data: [
        JSON.stringify({
          choices: [{ delta: { content: "through the Phase 5 pipeline." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
        }),
        "[DONE]",
      ],
    },
    { type: "done", requestId },
  ];
}

function responsesPayloads(requestId: string): PipeEvent[] {
  const responseId = `browser-response-${requestId}`;
  return [
    {
      type: "data",
      requestId,
      data: [
        JSON.stringify({
          type: "response.created",
          response: {
            id: responseId,
            reasoning: { effort: "high", summary: "auto" },
            rollout_ids: ["rollout-browser-1"],
          },
        }),
      ],
    },
    {
      type: "data",
      requestId,
      data: [
        JSON.stringify({
          type: "response.reasoning_summary_part.added",
          item_id: "reasoning-browser-1",
        }),
      ],
    },
    {
      type: "data",
      requestId,
      data: [
        JSON.stringify({
          type: "response.reasoning_summary_text.delta",
          item_id: "reasoning-browser-1",
          delta: "Checking the Responses fixture. ",
        }),
      ],
    },
    {
      type: "data",
      requestId,
      data: [
        JSON.stringify({
          type: "response.output_item.added",
          item: {
            id: "search-browser-1",
            type: "web_search_call",
            status: "in_progress",
            action: { type: "search", query: "Phase 7 structured search" },
          },
        }),
      ],
    },
    {
      type: "data",
      requestId,
      data: [
        JSON.stringify({
          type: "response.web_search_call.completed",
          item_id: "search-browser-1",
          query: "Phase 7 structured search",
          results: [
            {
              id: "source-phase7",
              title: "Phase 7 source",
              url: "https://example.com/phase7",
              snippet: "A deterministic local source fixture.",
            },
          ],
        }),
      ],
    },
    {
      type: "data",
      requestId,
      data: [
        JSON.stringify({
          type: "response.agent_status",
          rollout_id: "rollout-browser-1",
          agent: { id: "agent-browser-1", label: "Search agent", status: "completed" },
        }),
      ],
    },
    {
      type: "data",
      requestId,
      data: [
        JSON.stringify({
          type: "response.output_text.delta",
          delta: "The Responses endpoint uses the same registry and persistence path.",
        }),
      ],
    },
    {
      type: "data",
      requestId,
      data: [
        JSON.stringify({
          type: "response.output_text.annotation.added",
          item_id: "search-browser-1",
          annotation: {
            type: "url_citation",
            source_id: "source-phase7",
            citation_id: "citation-phase7",
            title: "Phase 7 source",
            url: "https://example.com/phase7",
            start_index: 0,
            end_index: 18,
          },
        }),
      ],
    },
    {
      type: "data",
      requestId,
      data: [
        JSON.stringify({
          type: "response.reasoning_summary_part.done",
          item_id: "reasoning-browser-1",
        }),
      ],
    },
    {
      type: "data",
      requestId,
      data: [
        JSON.stringify({
          type: "response.completed",
          response: {
            id: responseId,
            usage: { input_tokens: 11, output_tokens: 10, total_tokens: 21 },
          },
        }),
      ],
    },
    { type: "done", requestId },
  ];
}
