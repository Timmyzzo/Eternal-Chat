import { describe, expect, it, vi } from "vitest";

import { FakeDesktopBridge, type PipeEvent, type PipeRequest } from "@/infrastructure/desktop";

describe("FakeDesktopBridge contract", () => {
  it("records platform calls and resolves startStream only after a terminal event", async () => {
    const bridge = new FakeDesktopBridge();
    const onEvent = vi.fn();
    const request: PipeRequest = {
      requestId: "request-1",
      url: "http://127.0.0.1:43123/stream",
      method: "POST",
      headers: [],
      query: [],
    };
    const event: PipeEvent = {
      requestId: "request-1",
      type: "data",
      data: ["chunk"],
    };
    const terminal: PipeEvent = {
      requestId: "request-1",
      type: "error",
      error: {
        kind: "cancelled",
        message: "The stream was cancelled.",
      },
    };

    let settled = false;
    const start = bridge.startStream(request, onEvent).then(() => {
      settled = true;
    });
    bridge.emit(event);
    await Promise.resolve();
    expect(settled).toBe(false);

    await bridge.cancelStream(request.requestId);
    bridge.emit(terminal);
    await start;
    await bridge.openExternal("https://example.com");
    await bridge.notifications.show({ title: "Done" });

    expect(bridge.startedRequests).toEqual([request]);
    expect(onEvent.mock.calls).toEqual([[event], [terminal]]);
    expect(settled).toBe(true);
    expect(bridge.cancelledRequestIds).toEqual([request.requestId]);
    expect(bridge.openedUrls).toEqual(["https://example.com"]);
    expect(bridge.notifications.shown).toEqual([{ title: "Done" }]);
  });
});
