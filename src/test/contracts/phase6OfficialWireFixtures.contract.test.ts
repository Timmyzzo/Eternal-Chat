import { describe, expect, it } from "vitest";

import { buildEndpointUrl } from "@/application/chat/requestAssembler";
import { resolveRequestConfiguration } from "@/application/providers/requestConfiguration";
import type { Model, ProviderEndpoint } from "@/domain/provider";
import {
  createOfficialProtocolPresets,
  findOfficialModelPreset,
  type OfficialModelPreset,
} from "@/infrastructure/providers/officialPresetRegistry";

describe("Phase 6 official wire fixtures", () => {
  it("keeps OpenAI Chat and Responses reasoning and tool shapes separate", () => {
    const chat = resolvePreset("openai-chat", {
      params: { reasoning_effort: "xhigh" },
      tools: { function: { mode: "required" } },
      protocolBody: { messages: [{ role: "user", content: "Fixture" }] },
    });
    expect(chat.body).toMatchObject({
      reasoning_effort: "xhigh",
      tools: [
        {
          type: "function",
          function: { name: "custom_function", parameters: { type: "object" } },
        },
      ],
      tool_choice: "required",
    });
    expect(chat.body).not.toHaveProperty("reasoning");

    const responses = resolvePreset("openai-responses", {
      params: { reasoning_effort: "xhigh" },
      tools: { web_search: { mode: "auto" } },
      protocolBody: { input: [{ role: "user", content: "Fixture" }] },
    });
    expect(responses.body).toMatchObject({
      reasoning: { effort: "xhigh" },
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
    });
    expect(responses.body).not.toHaveProperty("reasoning_effort");
  });

  it("preserves Grok multi-agent xhigh and Responses-only tools", () => {
    const grok = resolvePreset("xai-responses", {
      params: { reasoning_effort: "xhigh" },
      tools: { web_search: { mode: "auto" }, x_search: { mode: "required" } },
      protocolBody: { input: "Fixture" },
    });
    expect(grok.body.reasoning).toEqual({ effort: "xhigh" });
    expect(grok.body.tools).toEqual([{ type: "web_search" }, { type: "x_search" }]);
    expect(grok.body.tool_choice).toBe("required");
    expect(grok.body).not.toHaveProperty("generationConfig");
  });

  it("builds Gemini generateContent and Interactions without OpenAI field names", () => {
    const generate = resolvePreset("gemini-generate-content", {
      params: { thinking_level: "high" },
      tools: { google_search: { mode: "required" } },
      protocolBody: { contents: [{ role: "user", parts: [{ text: "Fixture" }] }] },
    });
    expect(generate.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent",
    );
    expect(generate.body).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: "high" } },
      tools: [{ googleSearch: {} }],
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
    });
    expect(generate.body).not.toHaveProperty("reasoning");
    expect(generate.body).not.toHaveProperty("model");

    const interactions = resolvePreset("gemini-interactions", {
      params: { thinking_level: "future_level" },
      tools: {},
      protocolBody: { input: "Fixture" },
    });
    expect(interactions.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(interactions.body).toMatchObject({
      model: "gemini-2.5-pro",
      generation_config: { thinking_level: "future_level" },
    });
    expect(interactions.body).not.toHaveProperty("generationConfig");
  });

  it("builds Anthropic effort and versioned web search descriptor only at Messages paths", () => {
    const anthropic = resolvePreset("anthropic-messages", {
      params: { effort: "max" },
      tools: { web_search: { mode: "required" } },
      protocolBody: { messages: [{ role: "user", content: "Fixture" }] },
    });
    expect(anthropic.url).toBe("https://api.anthropic.com/v1/messages");
    expect(anthropic.body).toMatchObject({
      output_config: { effort: "max" },
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      tool_choice: { type: "any" },
    });
    expect(anthropic.body).not.toHaveProperty("reasoning");
    expect(anthropic.body).not.toHaveProperty("generationConfig");
  });
});

function resolvePreset(
  id: string,
  input: {
    params: Record<string, unknown>;
    tools: Record<string, unknown>;
    protocolBody: Record<string, unknown>;
  },
) {
  const preset = findOfficialModelPreset(id);
  const profile = createOfficialProtocolPresets(1).find(
    (candidate) => candidate.id === preset.endpoint.protocolProfileId,
  );
  if (!profile) throw new Error(`Missing profile for ${id}`);
  const endpoint = materializeEndpoint(preset);
  const model = materializeModel(preset);
  const resolved = resolveRequestConfiguration({
    profile,
    endpoint,
    model,
    protocolBody: input.protocolBody as never,
    conversation: {
      params: input.params as never,
      extraBody: {},
      extraHeaders: {},
      extraQuery: {},
      extraPath: {},
      toolsOverride: input.tools as never,
    },
  });
  return { ...resolved, url: buildEndpointUrl(endpoint, resolved.pathValues) };
}

function materializeEndpoint(preset: OfficialModelPreset): ProviderEndpoint {
  return {
    id: `endpoint-${preset.id}`,
    connectionId: `connection-${preset.id}`,
    name: preset.label,
    baseUrl: preset.endpoint.baseUrl,
    explicitPort: null,
    pathTemplate: preset.endpoint.pathTemplate,
    method: preset.endpoint.method,
    apiVersion: preset.source.appliesTo?.apiVersion ?? null,
    protocolProfileId: preset.endpoint.protocolProfileId,
    authBindings: [],
    headers: {},
    query: {},
    bodyDefaults: {},
    pathDefaults: {},
    source: preset.source as never,
    presetBinding: {
      mode: "tracked",
      presetId: preset.id,
      baseRevision: preset.source.revision,
      overridePatch: {},
    },
    timeoutMs: null,
    retryPolicy: null,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function materializeModel(preset: OfficialModelPreset): Model {
  return {
    id: `model-${preset.id}`,
    endpointId: `endpoint-${preset.id}`,
    modelId: preset.modelId,
    displayName: preset.label,
    capabilitySchema: preset.capabilities,
    paramsSchema: preset.parameters as never,
    parameterValues: preset.parameterValues,
    builtInTools: preset.tools as never,
    toolSettings: preset.toolSettings,
    extraBody: {},
    extraHeaders: {},
    extraQuery: {},
    extraPath: {},
    contextWindow: null,
    maxOutputTokens: null,
    protocolProfileOverrideId: null,
    schemaOrigin: "official",
    schemaRevision: preset.source.revision,
    source: preset.source as never,
    presetBinding: {
      mode: "tracked",
      presetId: preset.id,
      baseRevision: preset.source.revision,
      overridePatch: {},
    },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
