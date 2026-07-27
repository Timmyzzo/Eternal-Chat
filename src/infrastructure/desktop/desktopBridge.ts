export interface DesktopNotification {
  body?: string;
  title: string;
}

export interface NotificationPort {
  show(notification: DesktopNotification): Promise<void>;
}

export interface DesktopBridge<TRequest = never, TEvent = never> {
  cancelStream(requestId: string): Promise<void>;
  notifications: NotificationPort;
  openExternal(url: string): Promise<void>;
  startStream(request: TRequest, onEvent: (event: TEvent) => void): Promise<void>;
}
