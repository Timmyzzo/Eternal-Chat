import type { CanonicalContext } from "@/domain/context";
import type { JsonObject } from "@/domain/json";
import { hashStableJson } from "@/domain/stableJson";
import {
  serializeOpenAIChatCompletions,
  serializeOpenAIResponses,
  type OpenAIChatCompletionsBody,
  type OpenAIResponsesBody,
} from "@/infrastructure/providers/openai/contextSerializers";

export type OpenAIContextProtocol = "openai_chat_completions" | "openai_responses";

export interface SerializedOpenAIRequest extends JsonObject {
  body: OpenAIChatCompletionsBody | OpenAIResponsesBody;
  bodyHash: string;
  protocol: OpenAIContextProtocol;
}

export interface SerializedRequestBoundary {
  accept(request: SerializedOpenAIRequest): Promise<void>;
}

export async function handoffSerializedOpenAIRequest(
  protocol: OpenAIContextProtocol,
  context: CanonicalContext,
  model: string,
  boundary: SerializedRequestBoundary,
): Promise<SerializedOpenAIRequest> {
  const body =
    protocol === "openai_chat_completions"
      ? serializeOpenAIChatCompletions(context, model)
      : serializeOpenAIResponses(context, model);
  const request: SerializedOpenAIRequest = {
    body,
    bodyHash: await hashStableJson(body),
    protocol,
  };
  await boundary.accept(request);
  return request;
}
