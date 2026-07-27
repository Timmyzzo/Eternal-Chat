export interface PipeField {
  name: string;
  value: string;
}

export interface PipeRequest {
  body?: string;
  headers: PipeField[];
  method: string;
  query: PipeField[];
  requestId: string;
  timeoutMs?: number;
  url: string;
}

export type PipeErrorKind =
  "invalid_request" | "network" | "http" | "timeout" | "cancelled" | "stream" | "channel_closed";

export interface PipeError {
  body?: string;
  kind: PipeErrorKind;
  message: string;
  status?: number;
}

export type PipeEvent =
  | { type: "data"; requestId: string; data: string[] }
  | { type: "done"; requestId: string }
  | { type: "error"; requestId: string; error: PipeError };
