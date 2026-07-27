import { describe, expect, it, vi } from "vitest";

import {
  FakeNotificationPort,
  TauriDesktopBridge,
  type PipeEvent,
  type PipeRequest,
  type TauriChannel,
  type TauriIpc,
} from "@/infrastructure/desktop";

class TestChannel<T> implements TauriChannel<T> {
  constructor(readonly onmessage: (message: T) => void) {}

  emit(message: T) {
    this.onmessage(message);
  }
}

class TestIpc implements TauriIpc {
  readonly invocations: Array<{
    command: string;
    args?: Record<string, unknown>;
  }> = [];

  private readonly channels: Array<TestChannel<unknown>> = [];

  createChannel<T>(onmessage: (message: T) => void): TauriChannel<T> {
    const channel = new TestChannel(onmessage);
    this.channels.push(channel as TestChannel<unknown>);
    return channel;
  }

  latestChannel<T>() {
    return this.channels.at(-1) as TestChannel<T>;
  }

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.invocations.push({ command, args });
    return undefined as T;
  }
}

describe("TauriDesktopBridge contract", () => {
  it("uses the registered Tauri commands and forwards Channel events", async () => {
    const ipc = new TestIpc();
    const notifications = new FakeNotificationPort();
    const openedUrls: string[] = [];
    const bridge = new TauriDesktopBridge(
      {
        notifications,
        async openExternal(url) {
          openedUrls.push(url);
        },
      },
      ipc,
    );
    const onEvent = vi.fn();
    const request: PipeRequest = {
      requestId: "request-bridge",
      url: "http://127.0.0.1:43123/stream",
      method: "POST",
      headers: [],
      query: [],
    };
    const event: PipeEvent = {
      type: "data",
      requestId: request.requestId,
      data: ["raw-event"],
    };

    await bridge.startStream(request, onEvent);
    const channel = ipc.latestChannel<PipeEvent>();
    channel.emit(event);
    await bridge.cancelStream(request.requestId);
    await bridge.openExternal("https://example.com");
    await bridge.notifications.show({ title: "Done" });

    expect(ipc.invocations).toEqual([
      {
        command: "start_stream",
        args: { request, onEvent: channel },
      },
      {
        command: "cancel_stream",
        args: { requestId: request.requestId },
      },
    ]);
    expect(onEvent).toHaveBeenCalledWith(event);
    expect(openedUrls).toEqual(["https://example.com"]);
    expect(notifications.shown).toEqual([{ title: "Done" }]);
  });
});
