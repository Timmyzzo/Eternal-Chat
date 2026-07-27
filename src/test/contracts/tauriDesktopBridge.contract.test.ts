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
  private completeStartInvocation?: () => void;

  createChannel<T>(onmessage: (message: T) => void): TauriChannel<T> {
    const channel = new TestChannel(onmessage);
    this.channels.push(channel as TestChannel<unknown>);
    return channel;
  }

  latestChannel<T>() {
    return this.channels.at(-1) as TestChannel<T>;
  }

  completeStart() {
    this.completeStartInvocation?.();
    this.completeStartInvocation = undefined;
  }

  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.invocations.push({ command, args });
    if (command !== "start_stream") {
      return Promise.resolve(undefined as T);
    }

    return new Promise<T>((resolve) => {
      this.completeStartInvocation = () => resolve(undefined as T);
    });
  }
}

describe("TauriDesktopBridge contract", () => {
  it("uses the registered commands and waits for both command and terminal event", async () => {
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
    const terminal: PipeEvent = {
      type: "done",
      requestId: request.requestId,
    };

    let settled = false;
    const start = bridge.startStream(request, onEvent).then(() => {
      settled = true;
    });
    const channel = ipc.latestChannel<PipeEvent>();
    channel.emit(event);
    ipc.completeStart();
    await Promise.resolve();
    expect(settled).toBe(false);

    channel.emit(terminal);
    await start;
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
    expect(onEvent.mock.calls).toEqual([[event], [terminal]]);
    expect(settled).toBe(true);
    expect(openedUrls).toEqual(["https://example.com"]);
    expect(notifications.shown).toEqual([{ title: "Done" }]);
  });

  it("keeps startStream pending until the command completes after a terminal event", async () => {
    const ipc = new TestIpc();
    const bridge = new TauriDesktopBridge(
      {
        notifications: new FakeNotificationPort(),
        async openExternal() {},
      },
      ipc,
    );
    const request: PipeRequest = {
      requestId: "request-command-lifecycle",
      url: "http://127.0.0.1:43123/stream",
      method: "GET",
      headers: [],
      query: [],
    };
    let settled = false;
    const start = bridge.startStream(request, vi.fn()).then(() => {
      settled = true;
    });

    ipc.latestChannel<PipeEvent>().emit({ type: "done", requestId: request.requestId });
    await Promise.resolve();
    expect(settled).toBe(false);

    ipc.completeStart();
    await start;
    expect(settled).toBe(true);
  });
});
