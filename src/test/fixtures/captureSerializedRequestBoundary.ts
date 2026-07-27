import type {
  SerializedOpenAIRequest,
  SerializedRequestBoundary,
} from "@/infrastructure/providers/openai/serializedRequestBoundary";

export class CaptureSerializedRequestBoundary implements SerializedRequestBoundary {
  readonly requests: SerializedOpenAIRequest[] = [];

  async accept(request: SerializedOpenAIRequest): Promise<void> {
    this.requests.push(structuredClone(request));
  }
}
