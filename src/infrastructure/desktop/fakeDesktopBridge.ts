import type {
  DesktopBridge,
  DesktopNotification,
  NotificationPort,
} from "@/infrastructure/desktop/desktopBridge";

export class FakeNotificationPort implements NotificationPort {
  readonly shown: DesktopNotification[] = [];

  async show(notification: DesktopNotification) {
    this.shown.push(notification);
  }
}

export class FakeDesktopBridge<TRequest = never, TEvent = never> implements DesktopBridge<
  TRequest,
  TEvent
> {
  readonly cancelledRequestIds: string[] = [];
  readonly notifications = new FakeNotificationPort();
  readonly openedUrls: string[] = [];
  readonly startedRequests: TRequest[] = [];

  private readonly eventListeners = new Set<(event: TEvent) => void>();

  async cancelStream(requestId: string) {
    this.cancelledRequestIds.push(requestId);
  }

  emit(event: TEvent) {
    this.eventListeners.forEach((listener) => listener(event));
  }

  async openExternal(url: string) {
    this.openedUrls.push(url);
  }

  async startStream(request: TRequest, onEvent: (event: TEvent) => void) {
    this.startedRequests.push(request);
    this.eventListeners.add(onEvent);
  }
}
