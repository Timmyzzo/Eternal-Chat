import { describe, expect, it } from "vitest";

import type { JsonObject } from "@/domain/json";
import type { Model, ProtocolProfile, ProviderEndpoint } from "@/domain/provider";
import { resolveRequestConfiguration } from "@/application/providers/requestConfiguration";

describe("Phase 6 layered request configuration", () => {
  it("deep merges ordered layers, replaces arrays, preserves unknown values, and tracks sources", () => {
    const profile = createProfile();
    const endpoint = createEndpoint();
    const model = createModel();
    const scope = {
      profile,
      endpoint,
      model,
      protocolBody: {
        input: [{ role: "user", content: "Fixture" }],
        nested: { protocol: true, values: ["protocol"] },
      },
      conversation: {
        params: { effort: "future-ultra", temperature: 0.4 },
        extraBody: { nested: { conversation: true, values: ["conversation"] } },
        extraHeaders: { "X-Trace": "conversation" },
        extraQuery: { region: "conversation" },
        extraPath: { deployment: "conversation-deployment" },
        toolsOverride: {},
      },
    };

    const resolved = resolveRequestConfiguration(scope);

    expect(resolved.body).toEqual({
      input: [{ role: "user", content: "Fixture" }],
      model: "unknown-model-id",
      nested: {
        endpoint: true,
        model: true,
        protocol: true,
        conversation: true,
        values: ["conversation"],
      },
      reasoning: { effort: "future-ultra" },
      stream: true,
      temperature: 0.4,
      unknown_model_field: { kept: true },
    });
    expect(resolved.headers).toEqual({
      Accept: "text/event-stream",
      "x-model": "model",
      "X-Trace": "conversation",
    });
    expect(resolved.query).toEqual({ api_version: "v1", region: "conversation" });
    expect(resolved.pathValues).toEqual({
      apiVersion: "v1",
      deployment: "conversation-deployment",
      model: "unknown-model-id",
    });
    expect(resolved.sources.body["reasoning.effort"]?.winner.layer).toBe("conversation_schema");
    expect(resolved.sources.body["nested.values"]?.winner.layer).toBe("conversation_raw");
    expect(resolved.sources.headers["x-trace"]?.winner.layer).toBe("conversation_raw");
    expect(resolved.sources.path.deployment?.winner.layer).toBe("conversation_raw");
    expect(scope.model.parameterValues).toEqual({ effort: "xhigh", temperature: 0.7 });
  });

  it("maps enabled tools to the profile descriptor and rejects unsupported required mode", () => {
    const auto = resolveRequestConfiguration({
      profile: createProfile(),
      endpoint: createEndpoint(),
      model: createModel({
        toolSettings: { web_search: { mode: "auto" } },
      }),
      protocolBody: {},
      conversation: emptyConversationOverrides(),
    });

    expect(auto.body.tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
    expect(auto.body.tool_choice).toBe("auto");
    expect(auto.sources.body.tools?.winner.layer).toBe("model_schema");

    const off = resolveRequestConfiguration({
      profile: createProfile(),
      endpoint: createEndpoint(),
      model: createModel({ toolSettings: { web_search: { mode: "off" } } }),
      protocolBody: {},
      conversation: emptyConversationOverrides(),
    });
    expect(off.body).not.toHaveProperty("tools");
    expect(off.body).not.toHaveProperty("tool_choice");

    expect(() =>
      resolveRequestConfiguration({
        profile: createProfile(),
        endpoint: createEndpoint(),
        model: createModel({
          builtInTools: [
            {
              id: "optional_only",
              label: "Optional only",
              modeOptions: ["off", "auto"],
              descriptor: { type: "optional_only" },
              choiceMapping: { auto: "auto" },
              paramsSchema: [],
              userEdited: false,
            },
          ],
          toolSettings: { optional_only: { mode: "required" } },
        }),
        protocolBody: {},
        conversation: emptyConversationOverrides(),
      }),
    ).toThrow(/does not support required mode/);
  });
});

function createProfile(): ProtocolProfile {
  return {
    id: "profile-phase6",
    name: "Phase 6 fixture",
    codecId: "openai_responses",
    requestMapping: {
      baseBody: { nested: { protocol: true, values: ["base"] } },
      defaultHeaders: { Accept: "text/event-stream", "X-Trace": "protocol" },
      defaultQuery: { api_version: "v1", region: "protocol" },
      defaultPath: { apiVersion: "v1", deployment: "protocol-deployment" },
      forceStream: true,
      model: { placement: "body", path: "model" },
    },
    responseMapping: {},
    toolsMapping: { bodyPath: "tools", choicePath: "tool_choice" },
    continuationMapping: null,
    source: null,
    presetBinding: null,
    userEdited: false,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createEndpoint(): ProviderEndpoint {
  return {
    id: "endpoint-phase6",
    connectionId: "connection-phase6",
    name: "Phase 6 endpoint",
    baseUrl: "https://fixture.invalid/proxy",
    explicitPort: 8443,
    pathTemplate: "/{apiVersion}/deployments/{deployment}/responses",
    method: "POST",
    apiVersion: "v1",
    protocolProfileId: "profile-phase6",
    authBindings: [],
    headers: { "x-trace": "endpoint" },
    query: { region: "endpoint" },
    bodyDefaults: { nested: { endpoint: true, values: ["endpoint"] } },
    pathDefaults: { deployment: "endpoint-deployment" },
    source: null,
    presetBinding: null,
    timeoutMs: 30_000,
    retryPolicy: null,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "model-phase6",
    endpointId: "endpoint-phase6",
    modelId: "unknown-model-id",
    displayName: "Unknown model",
    capabilitySchema: { custom: { future_capability: { state: "unknown" } } },
    paramsSchema: [
      {
        id: "effort",
        label: "Reasoning effort",
        semanticHint: "reasoning_effort",
        placement: "body",
        path: "reasoning.effort",
        type: "select",
        options: [{ label: "High", value: "high" }],
        allowCustomValue: true,
      },
      {
        id: "temperature",
        label: "Temperature",
        placement: "body",
        path: "temperature",
        type: "number",
        allowCustomValue: true,
      },
    ],
    parameterValues: { effort: "xhigh", temperature: 0.7 },
    builtInTools: [
      {
        id: "web_search",
        label: "Web search",
        modeOptions: ["off", "auto", "required"],
        descriptor: { type: "web_search", search_context_size: "medium" },
        choiceMapping: { auto: "auto", required: "required" },
        paramsSchema: [],
        userEdited: false,
      },
    ],
    toolSettings: {},
    extraBody: {
      nested: { model: true, values: ["model"] },
      unknown_model_field: { kept: true },
    },
    extraHeaders: { "x-model": "model" },
    extraQuery: { region: "model" },
    extraPath: { deployment: "model-deployment" },
    contextWindow: null,
    maxOutputTokens: null,
    protocolProfileOverrideId: null,
    schemaOrigin: "user",
    schemaRevision: 1,
    source: null,
    presetBinding: null,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function emptyConversationOverrides() {
  return {
    params: {} as JsonObject,
    extraBody: {} as JsonObject,
    extraHeaders: {} as JsonObject,
    extraQuery: {} as JsonObject,
    extraPath: {} as JsonObject,
    toolsOverride: {} as JsonObject,
  };
}
