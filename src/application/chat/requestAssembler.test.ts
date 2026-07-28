import { describe, expect, it } from "vitest";

import type { Message } from "@/domain/chat";
import type { CanonicalContext } from "@/domain/context";
import type { Model, ProviderConnection, ProviderEndpoint } from "@/domain/provider";
import { DEFAULT_RETRY_POLICY } from "@/application/chat/retryPolicy";
import {
  buildEndpointUrl,
  prepareOpenAIDispatch,
  redactPipeRequest,
  readAuthBindings,
} from "@/application/chat/requestAssembler";
import {
  createOpenAIProtocolPresets,
  OPENAI_CHAT_COMPLETIONS_CODEC,
} from "@/infrastructure/providers/openai/protocolProfiles";

describe("prepareOpenAIDispatch", () => {
  it("preserves proxy paths and ports, applies merge order, redacts auth, and freezes dispatch", async () => {
    const profile = {
      ...createOpenAIProtocolPresets(1)[0]!,
      name: "Renamed profile without a provider brand",
      requestMapping: {
        baseBody: { nested: { profile: true }, array: ["profile"] },
        defaultHeaders: { "X-Case": "profile", Accept: "text/event-stream" },
        defaultQuery: { source: "profile" },
        forceStream: true,
      },
      responseMapping: { reasoningDeltaPaths: ["reasoning"] },
    };
    expect(profile.codecId).toBe(OPENAI_CHAT_COMPLETIONS_CODEC);
    const fixture = fixtureGraph(profile.id);
    const dispatch = await prepareOpenAIDispatch({
      ...fixture,
      profile,
      conversationParams: { temperature: 0.4, nested: { params: true } },
      conversationExtraBody: {
        model: "must-not-win",
        stream: false,
        nested: { conversation: true },
        array: ["conversation"],
        unknown_field: { preserved: true },
      },
      conversationExtraHeaders: { "x-case": "conversation" },
      conversationExtraQuery: { source: "conversation" },
      credentialResolver: {
        async resolve() {
          return "test-token-not-a-secret";
        },
      },
    });

    expect(dispatch.transportRequest.url).toBe(
      "https://compat.example:8443/proxy/v1/chat/completions",
    );
    expect(JSON.parse(dispatch.transportRequest.body ?? "{}")).toMatchObject({
      model: "remote-model",
      stream: true,
      temperature: 0.4,
      nested: { profile: true, endpoint: true, model: true, params: true, conversation: true },
      array: ["conversation"],
      unknown_field: { preserved: true },
    });
    expect(dispatch.transportRequest.headers).toContainEqual({
      name: "Authorization",
      value: "Bearer test-token-not-a-secret",
    });
    expect(dispatch.redactedRequest.headers).toContainEqual({
      name: "Authorization",
      value: "Bearer [credential]",
    });
    expect(dispatch.preview.headers).toEqual(dispatch.redactedRequest.headers);
    expect(dispatch.requestSnapshot.requestBody).toEqual(dispatch.preview.body);
    expect(JSON.stringify(dispatch.requestSnapshot)).not.toContain("test-token-not-a-secret");
    expect(
      dispatch.transportRequest.headers.filter((field) => field.name.toLowerCase() === "x-case"),
    ).toEqual([{ name: "x-case", value: "conversation" }]);
    expect(Object.isFrozen(dispatch)).toBe(true);
    expect(Object.isFrozen(dispatch.transportRequest.headers)).toBe(true);

    fixture.model.extraBody = { mutated: true };
    expect(JSON.parse(dispatch.transportRequest.body ?? "{}")).not.toHaveProperty("mutated");
  });

  it("redacts header, query, and body credentials using the stored bindings", () => {
    const bindings = readAuthBindings([
      { placement: "header", name: "Authorization", credentialKey: "header", prefix: "Bearer " },
      { placement: "query", name: "key", credentialKey: "query" },
      { placement: "body", name: "auth.token", credentialKey: "body" },
    ]);
    expect(
      redactPipeRequest(
        {
          requestId: "request",
          url: "https://fixture.invalid",
          method: "POST",
          headers: [{ name: "Authorization", value: "Bearer value" }],
          query: [{ name: "key", value: "value" }],
          body: JSON.stringify({ auth: { token: "value" } }),
        },
        bindings,
      ),
    ).toEqual({
      requestId: "request",
      url: "https://fixture.invalid",
      method: "POST",
      headers: [{ name: "Authorization", value: "Bearer [credential]" }],
      query: [{ name: "key", value: "[credential]" }],
      body: JSON.stringify({ auth: { token: "[credential]" } }),
    });
  });

  it("does not infer the codec from names or vendor hints", async () => {
    const responses = createOpenAIProtocolPresets(1)[1]!;
    const fixture = fixtureGraph(responses.id);
    fixture.connection.name = "Chat Completions brand bait";
    fixture.connection.vendorHint = "chat";
    const dispatch = await prepareOpenAIDispatch({
      ...fixture,
      profile: { ...responses, name: "Unrelated display name" },
      credentialResolver: {
        async resolve() {
          return "test-token-not-a-secret";
        },
      },
      conversationParams: {},
      conversationExtraBody: {},
      conversationExtraHeaders: {},
      conversationExtraQuery: {},
    });
    expect(JSON.parse(dispatch.transportRequest.body ?? "{}")).toHaveProperty("input");
    expect(JSON.parse(dispatch.transportRequest.body ?? "{}")).not.toHaveProperty("messages");
  });

  it("freezes the effective application and endpoint retry policy in the logical request", async () => {
    const profile = createOpenAIProtocolPresets(1)[0]!;
    const fixture = fixtureGraph(profile.id);
    fixture.endpoint.retryPolicy = {
      maxRetries: 1,
      retryableProviderCodes: ["temporary_overload"],
    };
    const dispatch = await prepareOpenAIDispatch({
      ...fixture,
      profile,
      credentialResolver: {
        async resolve() {
          return "test-token-not-a-secret";
        },
      },
      conversationParams: {},
      conversationExtraBody: {},
      conversationExtraHeaders: {},
      conversationExtraQuery: {},
    });

    expect(dispatch.retryPolicy).toEqual({
      ...DEFAULT_RETRY_POLICY,
      maxRetries: 1,
      retryableProviderCodes: ["temporary_overload"],
    });
    expect(dispatch.requestSnapshot.retryPolicy).toEqual(dispatch.retryPolicy);

    fixture.endpoint.retryPolicy = { enabled: false };
    expect(dispatch.retryPolicy.enabled).toBe(true);
    expect(Object.isFrozen(dispatch.retryPolicy)).toBe(true);
  });

  it("uses Phase 6 schema, tools, path overrides, and one frozen final request", async () => {
    const profile = createOpenAIProtocolPresets(1)[1]!;
    const fixture = fixtureGraph(profile.id);
    fixture.endpoint.pathTemplate = "/{apiVersion}/deployments/{deployment}/responses";
    fixture.endpoint.pathDefaults = { apiVersion: "v1", deployment: "endpoint" };
    fixture.model.paramsSchema = [
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
    ];
    fixture.model.parameterValues = { effort: "high" };
    fixture.model.builtInTools = [
      {
        id: "web_search",
        label: "Web search",
        modeOptions: ["off", "auto", "required"],
        descriptor: { type: "web_search" },
        choiceMapping: { auto: "auto", required: "required" },
        paramsSchema: [],
        userEdited: false,
      },
    ];
    fixture.model.toolSettings = { web_search: { mode: "auto" } };

    const dispatch = await prepareOpenAIDispatch({
      ...fixture,
      profile,
      conversationParams: { effort: "xhigh" },
      conversationExtraBody: { custom_unknown: { retained: true } },
      conversationExtraHeaders: { "X-Conversation": "fixture" },
      conversationExtraQuery: { region: "test" },
      conversationExtraPath: { deployment: "conversation" },
      conversationToolsOverride: { web_search: { mode: "required" } },
      credentialResolver: {
        async resolve() {
          return "test-token-not-a-secret";
        },
      },
    });

    const transportBody = JSON.parse(dispatch.transportRequest.body ?? "{}");
    expect(dispatch.transportRequest.url).toBe(
      "https://compat.example:8443/proxy/v1/v1/deployments/conversation/responses",
    );
    expect(transportBody).toMatchObject({
      model: "remote-model",
      reasoning: { effort: "xhigh" },
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      custom_unknown: { retained: true },
    });
    expect(transportBody).toEqual(dispatch.preview.body);
    expect(dispatch.requestSnapshot.requestBody).toEqual(dispatch.preview.body);
    expect(dispatch.requestSnapshot.params).toMatchObject({
      fieldSources: {
        body: {
          "reasoning.effort": { winner: { layer: "conversation_schema", value: "xhigh" } },
          tools: { winner: { layer: "conversation_schema" } },
        },
        path: {
          deployment: { winner: { layer: "conversation_raw", value: "conversation" } },
        },
      },
    });
    expect(Object.isFrozen(dispatch.preview.sources)).toBe(true);
  });
});

function fixtureGraph(profileId: string) {
  const connection: ProviderConnection = {
    id: "connection-1",
    name: "Compatibility gateway",
    vendorHint: null,
    description: null,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const endpoint: ProviderEndpoint = {
    id: "endpoint-1",
    connectionId: connection.id,
    name: "Endpoint",
    baseUrl: "https://compat.example/proxy/v1/",
    explicitPort: 8443,
    pathTemplate: "/chat/completions",
    method: "post",
    apiVersion: null,
    protocolProfileId: profileId,
    authBindings: [
      {
        placement: "header",
        name: "Authorization",
        credentialKey: "apiKey",
        prefix: "Bearer ",
      },
    ],
    headers: { "X-Case": "endpoint" },
    query: { source: "endpoint" },
    bodyDefaults: { nested: { endpoint: true }, array: ["endpoint"] },
    pathDefaults: {},
    source: null,
    presetBinding: null,
    timeoutMs: 12_345,
    retryPolicy: null,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const model: Model = {
    id: "model-1",
    endpointId: endpoint.id,
    modelId: "remote-model",
    displayName: "Remote model",
    capabilitySchema: {},
    paramsSchema: [],
    parameterValues: {},
    builtInTools: [],
    toolSettings: {},
    extraBody: { nested: { model: true }, array: ["model"] },
    extraHeaders: { "x-case": "model" },
    extraQuery: { source: "model" },
    extraPath: {},
    contextWindow: 1000,
    maxOutputTokens: 100,
    protocolProfileOverrideId: null,
    schemaOrigin: "fixture",
    schemaRevision: 7,
    source: null,
    presetBinding: null,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const userMessage = message("user-1", "user", [{ type: "text", text: "Hello" }]);
  const assistantPlaceholder = message("assistant-1", "assistant", []);
  const context: CanonicalContext = {
    version: 1,
    conversationId: "conversation-1",
    anchorMessageId: userMessage.id,
    contextHash: "sha256:context",
    system: [],
    turns: [
      {
        messageId: userMessage.id,
        role: "user",
        blocks: [
          {
            type: "text",
            text: "Hello",
            provenance: { messageId: userMessage.id, blockIndex: 0 },
          },
        ],
      },
    ],
    manifest: {
      version: 1,
      conversationId: "conversation-1",
      anchorMessageId: userMessage.id,
      hash: "sha256:manifest",
      items: [],
      policy: "lossless",
    },
  };
  return {
    assistantPlaceholder,
    connection,
    context,
    endpoint,
    model,
    now: 10,
    requestId: "request-1",
    snapshotId: "snapshot-1",
    userMessage,
  };
}

function message(
  id: string,
  role: "user" | "assistant",
  blocks: Message["blocks"]["blocks"],
): Message {
  return {
    id,
    conversationId: "conversation-1",
    role,
    blocks: { version: 1, blocks },
    status: role === "user" ? "done" : "pending",
    usage: null,
    modelRef: "model-1",
    parentId: role === "user" ? "conversation-1:root" : "user-1",
    siblingOrder: 0,
    providerResponseId: null,
    providerPreviousResponseId: null,
    requestSnapshotId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("buildEndpointUrl", () => {
  it("preserves an existing explicit port when no override is supplied", () => {
    const endpoint = fixtureGraph("profile").endpoint;
    endpoint.baseUrl = "http://127.0.0.1:43123/reverse/proxy";
    endpoint.explicitPort = null;
    endpoint.pathTemplate = "v1/responses";
    expect(buildEndpointUrl(endpoint)).toBe("http://127.0.0.1:43123/reverse/proxy/v1/responses");
  });
});
