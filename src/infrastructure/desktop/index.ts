export type {
  DesktopBridge,
  DesktopNotification,
  NotificationPort,
} from "@/infrastructure/desktop/desktopBridge";
export type {
  PipeError,
  PipeErrorKind,
  PipeEvent,
  PipeField,
  PipeRequest,
} from "@/infrastructure/desktop/pipeContract";
export {
  FakeDesktopBridge,
  FakeNotificationPort,
} from "@/infrastructure/desktop/fakeDesktopBridge";
export {
  TauriDesktopBridge,
  type TauriChannel,
  type TauriDesktopServices,
  type TauriIpc,
} from "@/infrastructure/desktop/tauriDesktopBridge";
