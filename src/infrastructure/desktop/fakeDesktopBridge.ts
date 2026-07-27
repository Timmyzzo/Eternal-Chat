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

  private readonly eventListeners = new Set<(event: PipeEvent) => void>();

  async cancelStream(requestId: string) {
    this.cancelledRequestIds.push(requestId);
  }

  emit(event: PipeEvent) {
    this.eventListeners.forEach((listener) => listener(event));
  }

  async openExternal(url: string) {
    this.openedUrls.push(url);
  }

  async startStream(request: PipeRequest, onEvent: (event: PipeEvent) => void) {
    this.startedRequests.push(request);
    this.eventListeners.add(onEvent);
  }
}
