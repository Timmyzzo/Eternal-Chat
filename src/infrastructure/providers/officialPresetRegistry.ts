import type { JsonObject, JsonValue } from "@/domain/json";
import type {
  BuiltInToolDefinition,
  OfficialFieldRecord,
  ParameterDefinition,
  ProtocolProfile,
  SourceMetadata,
} from "@/domain/provider";

export const OFFICIAL_PRESET_CHECKED_AT = "2026-07-28";
export const OFFICIAL_PRESET_REVISION = 1;

export const OPENAI_CHAT_PROFILE_ID = "preset.openai-chat-completions.v1";
export const OPENAI_RESPONSES_PROFILE_ID = "preset.openai-responses.v1";
export const ANTHROPIC_MESSAGES_PROFILE_ID = "preset.anthropic-messages.v1";
export const GEMINI_GENERATE_CONTENT_PROFILE_ID = "preset.gemini-generate-content.v1";
export const GEMINI_INTERACTIONS_PROFILE_ID = "preset.gemini-interactions.v1";

export interface OfficialEndpointPreset {
  baseUrl: string;
  method: string;
  pathTemplate: string;
  protocolProfileId: string;
  requestFields: OfficialFieldRecord[];
}

export interface OfficialModelPreset {
  id: string;
  label: string;
  vendor: "anthropic" | "google" | "openai" | "xai";
  modelId: string;
  endpoint: OfficialEndpointPreset;
  capabilities: JsonObject;
  parameters: ParameterDefinition[];
  parameterValues: JsonObject;
  tools: BuiltInToolDefinition[];
  toolSettings: JsonObject;
  source: SourceMetadata;
}

interface ProtocolPresetDefinition {
  id: string;
  name: string;
  codecId: string;
  requestMapping: JsonObject;
  responseMapping: JsonObject;
  toolsMapping: JsonObject;
  continuationMapping: JsonValue | null;
  source: SourceMetadata;
}

const openAIResponsesSource = source(
  "https://developers.openai.com/api/reference/resources/responses/methods/create",
  "/v1/responses",
);
const openAIChatSource = source(
  "https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create",
  "/v1/chat/completions",
);
const xaiResponsesSource = source("https://docs.x.ai/docs/guides/reasoning", "/v1/responses", [
  "grok-4.20-multi-agent",
]);
const geminiGenerateSource = source(
  "https://ai.google.dev/api/generate-content",
  "/v1beta/{+model}:streamGenerateContent",
  undefined,
  "v1beta",
);
const geminiInteractionsSource = source(
  "https://ai.google.dev/gemini-api/docs/interactions",
  "/v1beta/interactions",
  undefined,
  "v1beta",
);
const anthropicMessagesSource = source(
  "https://docs.anthropic.com/en/api/messages",
  "/v1/messages",
);

const protocolDefinitions: ProtocolPresetDefinition[] = [
  {
    id: OPENAI_CHAT_PROFILE_ID,
    name: "OpenAI-compatible Chat Completions",
    codecId: "openai_chat_completions",
    requestMapping: {
      baseBody: {},
      defaultHeaders: { Accept: "text/event-stream", "Content-Type": "application/json" },
      defaultQuery: {},
      defaultPath: {},
      forceStream: true,
      model: { placement: "body", path: "model" },
      stream: { placement: "body", path: "stream", value: true },
      networkStatus: "implemented",
    },
    responseMapping: { reasoningDeltaPaths: [] },
    toolsMapping: { bodyPath: "tools", choicePath: "tool_choice" },
    continuationMapping: { mode: "explicit_items" },
    source: openAIChatSource,
  },
  {
    id: OPENAI_RESPONSES_PROFILE_ID,
    name: "OpenAI-compatible Responses",
    codecId: "openai_responses",
    requestMapping: {
      baseBody: {},
      defaultHeaders: { Accept: "text/event-stream", "Content-Type": "application/json" },
      defaultQuery: {},
      defaultPath: {},
      forceStream: true,
      model: { placement: "body", path: "model" },
      stream: { placement: "body", path: "stream", value: true },
      networkStatus: "implemented",
    },
    responseMapping: { reasoningEvents: "official" },
    toolsMapping: { bodyPath: "tools", choicePath: "tool_choice" },
    continuationMapping: { mode: "explicit_items" },
    source: openAIResponsesSource,
  },
  {
    id: ANTHROPIC_MESSAGES_PROFILE_ID,
    name: "Anthropic Messages",
    codecId: "anthropic_messages",
    requestMapping: {
      baseBody: {},
      defaultHeaders: { Accept: "text/event-stream", "Content-Type": "application/json" },
      defaultQuery: {},
      defaultPath: {},
      forceStream: true,
      model: { placement: "body", path: "model" },
      stream: { placement: "body", path: "stream", value: true },
      networkStatus: "specified_phase_9",
    },
    responseMapping: { fixture: "anthropic_messages" },
    toolsMapping: { bodyPath: "tools", choicePath: "tool_choice" },
    continuationMapping: { mode: "content_blocks" },
    source: anthropicMessagesSource,
  },
  {
    id: GEMINI_GENERATE_CONTENT_PROFILE_ID,
    name: "Gemini generateContent",
    codecId: "gemini_generate_content",
    requestMapping: {
      baseBody: {},
      defaultHeaders: { Accept: "text/event-stream", "Content-Type": "application/json" },
      defaultQuery: { alt: "sse" },
      defaultPath: {},
      forceStream: false,
      model: { placement: "path", path: "model" },
      networkStatus: "specified_phase_9",
    },
    responseMapping: { fixture: "gemini_generate_content" },
    toolsMapping: {
      bodyPath: "tools",
      choicePath: "toolConfig.functionCallingConfig.mode",
    },
    continuationMapping: { mode: "contents" },
    source: geminiGenerateSource,
  },
  {
    id: GEMINI_INTERACTIONS_PROFILE_ID,
    name: "Gemini Interactions",
    codecId: "gemini_interactions",
    requestMapping: {
      baseBody: {},
      defaultHeaders: { Accept: "text/event-stream", "Content-Type": "application/json" },
      defaultQuery: {},
      defaultPath: {},
      forceStream: false,
      model: { placement: "body", path: "model" },
      networkStatus: "specified_phase_9",
    },
    responseMapping: { fixture: "gemini_interactions" },
    toolsMapping: { bodyPath: "tools", choicePath: "tool_choice" },
    continuationMapping: { mode: "interactions" },
    source: geminiInteractionsSource,
  },
];

const modelPresets: OfficialModelPreset[] = [
  {
    id: "openai-chat",
    label: "OpenAI GPT via Chat Completions",
    vendor: "openai",
    modelId: "gpt-5.6-sol",
    endpoint: endpoint(
      "https://api.openai.com",
      "/v1/chat/completions",
      OPENAI_CHAT_PROFILE_ID,
      openAIChatFields(),
      openAIChatSource,
    ),
    capabilities: capabilityProfile(["text"], ["text"], ["function_tools", "reasoning"]),
    parameters: [
      parameter("reasoning_effort", "Reasoning effort", "reasoning_effort", openAIChatSource, {
        semanticHint: "reasoning_effort",
        options: effortOptions(["none", "low", "medium", "high", "xhigh", "max"]),
      }),
      parameter("temperature", "Temperature", "temperature", openAIChatSource, {
        semanticHint: "temperature",
        type: "number",
      }),
      parameter("top_p", "Top P", "top_p", openAIChatSource, {
        semanticHint: "top_p",
        type: "number",
      }),
    ],
    parameterValues: {},
    tools: [functionTool(openAIChatSource)],
    toolSettings: {},
    source: openAIChatSource,
  },
  {
    id: "openai-responses",
    label: "OpenAI GPT via Responses",
    vendor: "openai",
    modelId: "gpt-5.6-sol",
    endpoint: endpoint(
      "https://api.openai.com",
      "/v1/responses",
      OPENAI_RESPONSES_PROFILE_ID,
      openAIResponsesFields(),
      openAIResponsesSource,
    ),
    capabilities: capabilityProfile(
      ["text", "image", "file"],
      ["text"],
      ["function_tools", "reasoning", "web_search"],
    ),
    parameters: [
      parameter("reasoning_effort", "Reasoning effort", "reasoning.effort", openAIResponsesSource, {
        semanticHint: "reasoning_effort",
        options: effortOptions(["none", "low", "medium", "high", "xhigh", "max"]),
      }),
      parameter(
        "reasoning_summary",
        "Reasoning summary",
        "reasoning.summary",
        openAIResponsesSource,
      ),
      parameter("verbosity", "Verbosity", "text.verbosity", openAIResponsesSource, {
        semanticHint: "verbosity",
        options: effortOptions(["low", "medium", "high"]),
      }),
      parameter(
        "max_output_tokens",
        "Max output tokens",
        "max_output_tokens",
        openAIResponsesSource,
        {
          semanticHint: "max_output",
          type: "integer",
        },
      ),
    ],
    parameterValues: {},
    tools: [builtInTool("web_search", "Web search", { type: "web_search" }, openAIResponsesSource)],
    toolSettings: {},
    source: openAIResponsesSource,
  },
  {
    id: "xai-responses",
    label: "xAI Grok 4.20 multi-agent via Responses",
    vendor: "xai",
    modelId: "grok-4.20-multi-agent",
    endpoint: endpoint(
      "https://api.x.ai",
      "/v1/responses",
      OPENAI_RESPONSES_PROFILE_ID,
      [...openAIResponsesFields(), "max_turns"],
      xaiResponsesSource,
    ),
    capabilities: capabilityProfile(
      ["text", "image"],
      ["text"],
      ["reasoning", "web_search", "x_search", "multi_agent"],
    ),
    parameters: [
      parameter("reasoning_effort", "Reasoning effort", "reasoning.effort", xaiResponsesSource, {
        semanticHint: "reasoning_effort",
        options: [
          { label: "Low", value: "low", note: "4 agents" },
          { label: "Medium", value: "medium", note: "4 agents" },
          { label: "High", value: "high", note: "16 agents" },
          { label: "XHigh", value: "xhigh", note: "16 agents" },
        ],
      }),
      parameter("max_turns", "Maximum agent turns", "max_turns", xaiResponsesSource, {
        type: "integer",
      }),
    ],
    parameterValues: { reasoning_effort: "high" },
    tools: [
      builtInTool("web_search", "Web search", { type: "web_search" }, xaiResponsesSource),
      builtInTool("x_search", "X search", { type: "x_search" }, xaiResponsesSource),
    ],
    toolSettings: {},
    source: xaiResponsesSource,
  },
  {
    id: "gemini-generate-content",
    label: "Google Gemini generateContent",
    vendor: "google",
    modelId: "models/gemini-2.5-pro",
    endpoint: endpoint(
      "https://generativelanguage.googleapis.com",
      "/v1beta/{+model}:streamGenerateContent",
      GEMINI_GENERATE_CONTENT_PROFILE_ID,
      geminiGenerateFields(),
      geminiGenerateSource,
    ),
    capabilities: capabilityProfile(
      ["text", "image", "audio", "video", "file"],
      ["text"],
      ["reasoning", "function_tools", "google_search"],
    ),
    parameters: [
      parameter(
        "thinking_level",
        "Thinking level",
        "generationConfig.thinkingConfig.thinkingLevel",
        geminiGenerateSource,
        {
          semanticHint: "reasoning_effort",
          options: effortOptions(["minimal", "low", "medium", "high"]),
        },
      ),
      parameter(
        "thinking_budget",
        "Thinking budget",
        "generationConfig.thinkingConfig.thinkingBudget",
        geminiGenerateSource,
        { semanticHint: "thinking_budget", type: "integer" },
      ),
      parameter(
        "include_thoughts",
        "Include thoughts",
        "generationConfig.thinkingConfig.includeThoughts",
        geminiGenerateSource,
        { type: "boolean" },
      ),
    ],
    parameterValues: {},
    tools: [
      builtInTool("google_search", "Google Search", { googleSearch: {} }, geminiGenerateSource, {
        auto: "AUTO",
        off: "NONE",
        required: "ANY",
      }),
    ],
    toolSettings: {},
    source: geminiGenerateSource,
  },
  {
    id: "gemini-interactions",
    label: "Google Gemini Interactions",
    vendor: "google",
    modelId: "gemini-2.5-pro",
    endpoint: endpoint(
      "https://generativelanguage.googleapis.com",
      "/v1beta/interactions",
      GEMINI_INTERACTIONS_PROFILE_ID,
      geminiInteractionFields(),
      geminiInteractionsSource,
    ),
    capabilities: capabilityProfile(["text", "image"], ["text"], ["reasoning", "tools"]),
    parameters: [
      parameter(
        "thinking_level",
        "Thinking level",
        "generation_config.thinking_level",
        geminiInteractionsSource,
        {
          semanticHint: "reasoning_effort",
          options: effortOptions(["minimal", "low", "medium", "high"]),
        },
      ),
    ],
    parameterValues: {},
    tools: [],
    toolSettings: {},
    source: geminiInteractionsSource,
  },
  {
    id: "anthropic-messages",
    label: "Anthropic Claude Messages",
    vendor: "anthropic",
    modelId: "claude-opus-4-1",
    endpoint: endpoint(
      "https://api.anthropic.com",
      "/v1/messages",
      ANTHROPIC_MESSAGES_PROFILE_ID,
      anthropicMessageFields(),
      anthropicMessagesSource,
    ),
    capabilities: capabilityProfile(
      ["text", "image", "file"],
      ["text"],
      ["reasoning", "function_tools", "web_search"],
    ),
    parameters: [
      parameter("effort", "Effort", "output_config.effort", anthropicMessagesSource, {
        semanticHint: "reasoning_effort",
        options: effortOptions(["low", "medium", "high", "xhigh", "max"]),
      }),
      parameter("max_tokens", "Max output tokens", "max_tokens", anthropicMessagesSource, {
        semanticHint: "max_output",
        type: "integer",
      }),
    ],
    parameterValues: { effort: "high" },
    tools: [
      builtInTool(
        "web_search",
        "Web search",
        { type: "web_search_20250305", name: "web_search" },
        anthropicMessagesSource,
        {
          auto: { type: "auto" },
          required: { type: "any" },
        },
      ),
    ],
    toolSettings: {},
    source: anthropicMessagesSource,
  },
];

export const OFFICIAL_PRESET_REGISTRY = {
  checkedAt: OFFICIAL_PRESET_CHECKED_AT,
  revision: OFFICIAL_PRESET_REVISION,
  protocolIds: protocolDefinitions.map((definition) => definition.id),
  modelPresets,
} as const;

export function createOfficialProtocolPresets(now: number): ProtocolProfile[] {
  return protocolDefinitions.map((definition) => ({
    id: definition.id,
    name: definition.name,
    codecId: definition.codecId,
    requestMapping: structuredClone(definition.requestMapping),
    responseMapping: structuredClone(definition.responseMapping),
    toolsMapping: structuredClone(definition.toolsMapping),
    continuationMapping: structuredClone(definition.continuationMapping),
    source: structuredClone(definition.source) as unknown as JsonValue,
    presetBinding: {
      mode: "tracked",
      presetId: definition.id,
      baseRevision: OFFICIAL_PRESET_REVISION,
      overridePatch: {},
    },
    userEdited: false,
    revision: OFFICIAL_PRESET_REVISION,
    createdAt: now,
    updatedAt: now,
  }));
}

export function findOfficialModelPreset(id: string): OfficialModelPreset {
  const preset = modelPresets.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`Unknown official model preset: ${id}`);
  return structuredClone(preset);
}

export function listOfficialModelPresets(): OfficialModelPreset[] {
  return structuredClone(modelPresets);
}

function source(
  sourceUrl: string,
  endpointPath: string,
  models?: string[],
  apiVersion?: string,
): SourceMetadata {
  return {
    sourceUrl,
    checkedAt: OFFICIAL_PRESET_CHECKED_AT,
    revision: OFFICIAL_PRESET_REVISION,
    appliesTo: {
      endpoint: endpointPath,
      ...(models ? { models } : {}),
      ...(apiVersion ? { apiVersion } : {}),
    },
  };
}

function endpoint(
  baseUrl: string,
  pathTemplate: string,
  protocolProfileId: string,
  requestFieldPaths: string[],
  metadata: SourceMetadata,
): OfficialEndpointPreset {
  const requestFields = requestFieldPaths.map((path) =>
    officialField(pathTemplate, "body", path, metadata),
  );
  for (const match of pathTemplate.matchAll(/\{\+?([^{}]+)\}/g)) {
    const path = match[1];
    if (path) requestFields.push(officialField(pathTemplate, "path", path, metadata));
  }
  return { baseUrl, method: "POST", pathTemplate, protocolProfileId, requestFields };
}

function officialField(
  endpointPath: string,
  location: OfficialFieldRecord["location"],
  path: string,
  metadata: SourceMetadata,
): OfficialFieldRecord {
  return {
    endpoint: endpointPath,
    ...(metadata.appliesTo?.apiVersion ? { apiVersion: metadata.appliesTo.apiVersion } : {}),
    location,
    path,
    semanticLabel: path.replaceAll(/[_.]/g, " "),
    type: officialFieldType(path),
    required: isRequiredOfficialField(path),
    unsupportedBehavior: "unknown",
    sourceUrl: metadata.sourceUrl,
    checkedAt: metadata.checkedAt,
    revision: metadata.revision,
  };
}

function isRequiredOfficialField(path: string): boolean {
  return ["model", "messages", "input", "contents", "max_tokens"].includes(path);
}

function officialFieldType(path: string): string {
  if (
    [
      "messages",
      "input",
      "contents",
      "tools",
      "stop",
      "stop_sequences",
      "modalities",
      "include",
      "safetySettings",
    ].includes(path)
  ) {
    return "array";
  }
  if (
    [
      "reasoning",
      "text",
      "metadata",
      "response_format",
      "stream_options",
      "tool_choice",
      "toolConfig",
      "generationConfig",
      "generation_config",
      "output_config",
      "thinking",
    ].includes(path)
  ) {
    return "object";
  }
  if (["stream", "store", "background", "parallel_tool_calls", "logprobs"].includes(path)) {
    return "boolean";
  }
  if (
    [
      "temperature",
      "top_p",
      "top_k",
      "frequency_penalty",
      "presence_penalty",
      "max_tokens",
      "max_completion_tokens",
      "max_output_tokens",
      "max_tool_calls",
      "max_turns",
      "n",
      "seed",
      "top_logprobs",
    ].includes(path)
  ) {
    return "number";
  }
  return "string";
}

function parameter(
  id: string,
  label: string,
  path: string,
  metadata: SourceMetadata,
  overrides: Partial<ParameterDefinition> = {},
): ParameterDefinition {
  return {
    id,
    label,
    placement: "body",
    path,
    type: "select",
    control: "select",
    allowCustomValue: true,
    source: metadata,
    ...overrides,
  };
}

function builtInTool(
  id: string,
  label: string,
  descriptor: JsonObject,
  metadata: SourceMetadata,
  choiceMapping: JsonObject = { auto: "auto", required: "required" },
): BuiltInToolDefinition {
  return {
    id,
    label,
    modeOptions: ["off", "auto", "required"],
    descriptor,
    choiceMapping,
    paramsSchema: [],
    source: metadata,
    userEdited: false,
  };
}

function functionTool(metadata: SourceMetadata): BuiltInToolDefinition {
  return builtInTool(
    "function",
    "Function tool",
    {
      type: "function",
      function: {
        name: "custom_function",
        description: "User-defined function",
        parameters: { type: "object", properties: {} },
      },
    },
    metadata,
  );
}

function capabilityProfile(
  inputModalities: string[],
  outputModalities: string[],
  reported: string[],
): JsonObject {
  return {
    inputModalities: { state: "reported", value: inputModalities, userEdited: false },
    outputModalities: { state: "reported", value: outputModalities, userEdited: false },
    custom: Object.fromEntries(
      reported.map((id) => [id, { state: "reported", value: true, userEdited: false }]),
    ),
  };
}

function effortOptions(values: string[]) {
  return values.map((value) => ({ label: value, value }));
}

function openAIChatFields(): string[] {
  return [
    "messages",
    "model",
    "audio",
    "frequency_penalty",
    "function_call",
    "functions",
    "logit_bias",
    "logprobs",
    "max_completion_tokens",
    "max_tokens",
    "metadata",
    "modalities",
    "n",
    "parallel_tool_calls",
    "prediction",
    "presence_penalty",
    "reasoning_effort",
    "response_format",
    "seed",
    "service_tier",
    "stop",
    "store",
    "stream",
    "stream_options",
    "temperature",
    "tool_choice",
    "tools",
    "top_logprobs",
    "top_p",
    "user",
    "verbosity",
    "web_search_options",
  ];
}

function openAIResponsesFields(): string[] {
  return [
    "model",
    "input",
    "instructions",
    "background",
    "conversation",
    "include",
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "parallel_tool_calls",
    "previous_response_id",
    "prompt",
    "prompt_cache_key",
    "prompt_cache_retention",
    "reasoning",
    "safety_identifier",
    "service_tier",
    "store",
    "stream",
    "stream_options",
    "temperature",
    "text",
    "tool_choice",
    "tools",
    "top_logprobs",
    "top_p",
    "truncation",
    "user",
  ];
}

function geminiGenerateFields(): string[] {
  return [
    "contents",
    "systemInstruction",
    "tools",
    "toolConfig",
    "safetySettings",
    "generationConfig",
    "cachedContent",
  ];
}

function geminiInteractionFields(): string[] {
  return [
    "model",
    "input",
    "system_instruction",
    "generation_config",
    "tools",
    "tool_choice",
    "stream",
    "metadata",
  ];
}

function anthropicMessageFields(): string[] {
  return [
    "model",
    "messages",
    "max_tokens",
    "metadata",
    "service_tier",
    "stop_sequences",
    "stream",
    "system",
    "temperature",
    "thinking",
    "tool_choice",
    "tools",
    "top_k",
    "top_p",
    "output_config",
  ];
}
