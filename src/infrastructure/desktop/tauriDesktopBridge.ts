import { Channel, invoke } from "@tauri-apps/api/core";

import type { DesktopBridge, NotificationPort } from "@/infrastructure/desktop/desktopBridge";
import type { PipeEvent, PipeRequest } from "@/infrastructure/desktop/pipeContract";

export interface TauriChannel<T> {
  onmessage: (message: T) => void;
}

export interface TauriIpc {
  createChannel<T>(onmessage: (message: T) => void): TauriChannel<T>;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export interface TauriDesktopServices {
  notifications: NotificationPort;
  openExternal(url: string): Promise<void>;
}

const defaultIpc: TauriIpc = {
  createChannel: <T>(onmessage: (message: T) => void) => new Channel<T>(onmessage),
  invoke,
};

export class TauriDesktopBridge implements DesktopBridge {
  readonly notifications: NotificationPort;

  constructor(
    private readonly services: TauriDesktopServices,
    private readonly ipc: TauriIpc = defaultIpc,
  ) {
    this.notifications = services.notifications;
  }

  async cancelStream(requestId: string) {
    await this.ipc.invoke<void>("cancel_stream", { requestId });
  }

  async openExternal(url: string) {
    await this.services.openExternal(url);
  }

  async startStream(request: PipeRequest, onEvent: (event: PipeEvent) => void) {
    const channel = this.ipc.createChannel(onEvent);
    await this.ipc.invoke<void>("start_stream", { request, onEvent: channel });
  }
}
