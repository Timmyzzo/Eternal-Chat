import { describe, expect, it, vi } from "vitest";

import { FakeDesktopBridge, type PipeEvent, type PipeRequest } from "@/infrastructure/desktop";

describe("FakeDesktopBridge contract", () => {
  it("records platform calls and forwards injected stream events", async () => {
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

    await bridge.startStream(request, onEvent);
    bridge.emit(event);
    await bridge.cancelStream(request.requestId);
    await bridge.openExternal("https://example.com");
    await bridge.notifications.show({ title: "Done" });

    expect(bridge.startedRequests).toEqual([request]);
    expect(onEvent).toHaveBeenCalledWith(event);
    expect(bridge.cancelledRequestIds).toEqual([request.requestId]);
    expect(bridge.openedUrls).toEqual(["https://example.com"]);
    expect(bridge.notifications.shown).toEqual([{ title: "Done" }]);
  });
});
