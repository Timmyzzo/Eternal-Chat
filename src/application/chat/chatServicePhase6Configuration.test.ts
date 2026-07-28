import { describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "@/application/chat/runtime";
import { InMemoryChatRepository } from "@/infrastructure/db/inMemoryChatRepository";
import { FakeDesktopBridge } from "@/infrastructure/desktop/fakeDesktopBridge";
import { findOfficialModelPreset } from "@/infrastructure/providers/officialPresetRegistry";

describe("ChatService Phase 6 configuration", () => {
  it("persists a catalog-backed unknown model and applies conversation overrides to dispatch", async () => {
    const repository = new InMemoryChatRepository();
    const bridge = new FakeDesktopBridge();
    const runtime = await createApplicationRuntime(repository, bridge);
    const preset = findOfficialModelPreset("xai-responses");
    const selection = await runtime.service.createProviderConfiguration({
      authBindings: [],
      baseUrl: "https://fixture.invalid/proxy",
      connectionName: "Unknown model fixture",
      explicitPort: 8443,
      modelDisplayName: "Directory external model",
      modelId: "directory-external-model",
      path: "/v1/{deployment}/responses",
      pathDefaults: { deployment: "endpoint" },
      profileId: preset.endpoint.protocolProfileId,
      capabilitySchema: preset.capabilities,
      paramsSchema: preset.parameters as never,
      parameterValues: { reasoning_effort: "xhigh", future_parameter: "kept" },
      builtInTools: preset.tools as never,
      toolSettings: { x_search: { mode: "auto" } },
      source: preset.source as never,
      presetBinding: {
        mode: "tracked",
        presetId: preset.id,
        baseRevision: preset.source.revision,
        overridePatch: { modelId: "directory-external-model" },
      },
    });
    const conversation = await runtime.service.createConversation(
      "Phase 6 configuration",
      selection.model.id,
    );
    await runtime.service.updateConversationConfiguration(conversation.id, {
      params: { reasoning_effort: "future-ultra" },
      extraBody: { custom: { kept: true } },
      extraHeaders: { "X-Conversation": "fixture" },
      extraQuery: { mode: "fixture" },
      extraPath: { deployment: "conversation" },
      toolsOverride: { x_search: { mode: "required" } },
    });

    const result = await runtime.service.sendMessage(conversation.id, "Fixture");
    expect(result.dispatch.transportRequest.url).toBe(
      "https://fixture.invalid:8443/proxy/v1/conversation/responses",
    );
    expect(JSON.parse(result.dispatch.transportRequest.body ?? "{}")).toMatchObject({
      model: "directory-external-model",
      reasoning: { effort: "future-ultra" },
      future_parameter: "kept",
      custom: { kept: true },
      tools: [{ type: "x_search" }],
      tool_choice: "required",
    });
    expect(result.dispatch.requestSnapshot.params).toMatchObject({
      fieldSources: {
        body: {
          future_parameter: { winner: { layer: "model_schema" } },
          "reasoning.effort": { winner: { layer: "conversation_schema" } },
        },
      },
    });
    runtime.registry.stop(result.dispatch.transportRequest.requestId);
    await runtime.registry.whenTerminal(result.dispatch.transportRequest.requestId);
  });

  it("allows one connection to own different ports and explicit protocol profiles", async () => {
    const repository = new InMemoryChatRepository();
    const runtime = await createApplicationRuntime(repository, new FakeDesktopBridge());
    const first = await runtime.service.createProviderConfiguration({
      authBindings: [],
      baseUrl: "https://mixed.fixture.invalid",
      connectionName: "Mixed relay",
      explicitPort: 443,
      modelDisplayName: "Gemini display through Chat",
      modelId: "gemini-display-only",
      path: "/v1/chat/completions",
      profileId: "preset.openai-chat-completions.v1",
    });
    const second = await runtime.service.createProviderConfiguration({
      authBindings: [],
      baseUrl: "https://mixed.fixture.invalid",
      connectionId: first.connection.id,
      connectionName: "Ignored duplicate name",
      explicitPort: 8443,
      modelDisplayName: "Claude display through Messages",
      modelId: "claude-display-only",
      path: "/v1/messages",
      profileId: "preset.anthropic-messages.v1",
    });

    expect(second.connection.id).toBe(first.connection.id);
    expect(
      (await runtime.service.listProviderSelections()).map((selection) => ({
        connectionId: selection.connection.id,
        port: selection.endpoint.explicitPort,
        codec: selection.profile.codecId,
      })),
    ).toEqual([
      {
        connectionId: first.connection.id,
        port: 443,
        codec: "openai_chat_completions",
      },
      {
        connectionId: first.connection.id,
        port: 8443,
        codec: "anthropic_messages",
      },
    ]);
  });

  it("marks compatibility evidence stale when the current profile revision changes", async () => {
    const repository = new InMemoryChatRepository();
    const runtime = await createApplicationRuntime(repository, new FakeDesktopBridge());
    const selection = await runtime.service.createProviderConfiguration({
      authBindings: [],
      baseUrl: "https://evidence.fixture.invalid",
      connectionName: "Evidence fixture",
      explicitPort: null,
      modelDisplayName: "Evidence model",
      modelId: "evidence-model",
      path: "/v1/responses",
      profileId: "preset.openai-responses.v1",
    });
    const common = {
      endpointId: selection.endpoint.id,
      modelRef: selection.model.id,
      protocolProfileId: selection.profile.id,
      apiVersion: selection.endpoint.apiVersion,
      parameterId: "reasoning_effort",
      placement: "body",
      wirePath: "reasoning.effort",
      testedValue: "xhigh",
      status: "unknown" as const,
      evidenceType: "fixture",
      requestFingerprint: null,
      httpStatus: 200,
      providerErrorCode: null,
      note: null,
    };
    await repository.insertCompatibilityProbe({
      ...common,
      id: "probe-current",
      protocolProfileRevision: selection.profile.revision,
      checkedAt: 2,
    });
    await repository.insertCompatibilityProbe({
      ...common,
      id: "probe-stale",
      protocolProfileRevision: selection.profile.revision - 1,
      checkedAt: 1,
    });

    expect(await runtime.service.listCompatibilityEvidence(selection.model.id)).toMatchObject([
      { current: true, probe: { id: "probe-current", status: "unknown" } },
      { current: false, probe: { id: "probe-stale", status: "unknown" } },
    ]);
  });

  it("runs one isolated parameter probe and records HTTP success as unknown evidence", async () => {
    const repository = new InMemoryChatRepository();
    const bridge = new FakeDesktopBridge();
    const runtime = await createApplicationRuntime(repository, bridge);
    const preset = findOfficialModelPreset("openai-responses");
    const selection = await runtime.service.createProviderConfiguration({
      authBindings: [],
      baseUrl: "https://probe.fixture.invalid",
      connectionName: "Probe fixture",
      explicitPort: null,
      modelDisplayName: "Probe model",
      modelId: "probe-model",
      path: preset.endpoint.pathTemplate,
      profileId: preset.endpoint.protocolProfileId,
      paramsSchema: preset.parameters as never,
      parameterValues: { verbosity: "high" },
    });

    const pending = runtime.service.runCompatibilityProbe(selection.model.id, {
      parameterId: "reasoning_effort",
      testedValue: "xhigh",
    });
    await vi.waitFor(() => expect(bridge.startedRequests).toHaveLength(1));
    const request = bridge.startedRequests[0];
    if (!request) throw new Error("The compatibility probe request was not started");
    expect(JSON.parse(request.body ?? "{}")).toMatchObject({
      model: "probe-model",
      reasoning: { effort: "xhigh" },
    });
    expect(JSON.parse(request.body ?? "{}")).not.toHaveProperty("text.verbosity");
    bridge.emit({ type: "done", requestId: request.requestId });

    await expect(pending).resolves.toMatchObject({
      current: true,
      probe: {
        parameterId: "reasoning_effort",
        status: "unknown",
        httpStatus: 200,
        evidenceType: "minimal_probe",
      },
    });
    await expect(
      runtime.service.listCompatibilityEvidence(selection.model.id),
    ).resolves.toHaveLength(1);
  });
});
