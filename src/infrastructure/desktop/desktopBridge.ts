import type { PipeEvent, PipeRequest } from "@/infrastructure/desktop/pipeContract";

export interface DesktopNotification {
  body?: string;
  title: string;
}

export interface NotificationPort {
  show(notification: DesktopNotification): Promise<void>;
}

export interface DesktopBridge {
  cancelStream(requestId: string): Promise<void>;
  notifications: NotificationPort;
  openExternal(url: string): Promise<void>;
  /** Resolves after a terminal event is delivered; rejects only when the bridge itself fails. */
  startStream(request: PipeRequest, onEvent: (event: PipeEvent) => void): Promise<void>;
}
