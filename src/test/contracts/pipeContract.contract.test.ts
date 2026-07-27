import { describe, expect, it } from "vitest";

import type { PipeEvent, PipeRequest } from "@/infrastructure/desktop";
import contractFixture from "@/test/fixtures/pipe-contract.json";

describe("Pipe IPC contract", () => {
  it("matches the shared TypeScript and Rust golden fixture", () => {
    const request: PipeRequest = {
      requestId: "request-2a",
      url: "http://127.0.0.1:43123/v1/stream?existing=keep",
      method: "POST",
      headers: [
        { name: "Content-Type", value: "application/json" },
        { name: "X-Eternal-Test", value: "exact-value" },
      ],
      query: [
        { name: "Mode", value: "raw" },
        { name: "Mode", value: "duplicate" },
      ],
      body: '{"opaque":{"custom_key":"custom-value"}}',
      timeoutMs: 15_000,
    };
    const events: PipeEvent[] = [
      {
        type: "data",
        requestId: "request-2a",
        data: ['{"delta":"first"}', "second"],
      },
      { type: "done", requestId: "request-2a" },
      {
        type: "error",
        requestId: "request-2a",
        error: {
          kind: "http",
          message: "The server returned HTTP 502.",
          status: 502,
          body: "fixture error",
        },
      },
    ];

    expect(contractFixture.request).toEqual(request);
    expect(contractFixture.events).toEqual(events);
  });
});
