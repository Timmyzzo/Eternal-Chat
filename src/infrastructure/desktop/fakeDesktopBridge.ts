import type {
  DesktopBridge,
  DesktopNotification,
  NotificationPort,
} from "@/infrastructure/desktop/desktopBridge";
import type { PipeEvent, PipeRequest } from "@/infrastructure/desktop/pipeContract";

export class FakeNotificationPort implements NotificationPort {
  readonly shown: DesktopNotification[] = [];

  async show(notification: DesktopNotification) {
    this.shown.push(notification);
  }
}

export class FakeDesktopBridge implements DesktopBridge {
  readonly cancelledRequestIds: string[] = [];
  readonly notifications = new FakeNotificationPort();
  readonly openedUrls: string[] = [];
  readonly startedRequests: PipeRequest[] = [];

  private readonly streams = new Map<
    string,
    Set<{
      onEvent: (event: PipeEvent) => void;
      resolve: () => void;
    }>
  >();

  async cancelStream(requestId: string) {
    this.cancelledRequestIds.push(requestId);
  }

  emit(event: PipeEvent) {
    const streams = this.streams.get(event.requestId);
    if (!streams) {
      return;
    }

    const terminal = event.type === "done" || event.type === "error";
    if (terminal) {
      this.streams.delete(event.requestId);
    }

    let callbackError: unknown;
    streams.forEach((stream) => {
      try {
        stream.onEvent(event);
      } catch (error) {
        callbackError ??= error;
      } finally {
        if (terminal) {
          stream.resolve();
        }
      }
    });

    if (callbackError) {
      throw callbackError;
    }
  }

  async openExternal(url: string) {
    this.openedUrls.push(url);
  }

  startStream(request: PipeRequest, onEvent: (event: PipeEvent) => void) {
    this.startedRequests.push(request);
    return new Promise<void>((resolve) => {
      const streams = this.streams.get(request.requestId) ?? new Set();
      streams.add({ onEvent, resolve });
      this.streams.set(request.requestId, streams);
    });
  }
}
