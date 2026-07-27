import { describe, expect, it, vi } from "vitest";

import { FakeDesktopBridge } from "@/infrastructure/desktop";

interface TestRequest {
  requestId: string;
}

interface TestEvent {
  requestId: string;
  type: "chunk";
}

describe("FakeDesktopBridge contract", () => {
  it("records platform calls and forwards injected stream events", async () => {
    const bridge = new FakeDesktopBridge<TestRequest, TestEvent>();
    const onEvent = vi.fn();
    const request = { requestId: "request-1" };
    const event = { requestId: "request-1", type: "chunk" } as const;

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
