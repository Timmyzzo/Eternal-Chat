import { describe, expect, it } from "vitest";

import { createApplicationRuntime } from "@/application/chat/runtime";
import { InMemoryChatRepository } from "@/infrastructure/db/inMemoryChatRepository";
import { FakeDesktopBridge } from "@/infrastructure/desktop/fakeDesktopBridge";
import {
  ANTHROPIC_MESSAGES_PROFILE_ID,
  OPENAI_RESPONSES_PROFILE_ID,
  findOfficialModelPreset,
} from "@/infrastructure/providers/officialPresetRegistry";

describe("ChatService Phase 6 official presets", () => {
  it("installs all protocol profiles, upgrades tracked values, and preserves detached forks", async () => {
    const repository = new InMemoryChatRepository();
    const runtime = await createApplicationRuntime(repository, new FakeDesktopBridge());
    expect(
      (await runtime.service.listProtocolProfiles()).map((profile) => profile.codecId),
    ).toEqual([
      "anthropic_messages",
      "gemini_generate_content",
      "gemini_interactions",
      "openai_chat_completions",
      "openai_responses",
    ]);

    const responses = await repository.getProtocolProfile(OPENAI_RESPONSES_PROFILE_ID);
    if (!responses) throw new Error("Responses preset is missing");
    await repository.updateProtocolProfile({
      ...responses,
      name: "Stale tracked name",
      revision: 1,
      presetBinding: {
        mode: "tracked",
        presetId: responses.id,
        baseRevision: 0,
        overridePatch: { name: "User tracked name" },
      },
    });

    const anthropic = await repository.getProtocolProfile(ANTHROPIC_MESSAGES_PROFILE_ID);
    if (!anthropic) throw new Error("Anthropic preset is missing");
    await repository.updateProtocolProfile({
      ...anthropic,
      name: "Detached Anthropic fork",
      presetBinding: {
        mode: "detached",
        forkedFromPresetId: anthropic.id,
        forkedFromRevision: anthropic.revision,
      },
    });

    await runtime.service.ensureProtocolPresets();
    expect(await repository.getProtocolProfile(OPENAI_RESPONSES_PROFILE_ID)).toMatchObject({
      name: "User tracked name",
      revision: 1,
      presetBinding: {
        mode: "tracked",
        baseRevision: 1,
        overridePatch: { name: "User tracked name" },
      },
    });
    expect(await repository.getProtocolProfile(ANTHROPIC_MESSAGES_PROFILE_ID)).toMatchObject({
      name: "Detached Anthropic fork",
      presetBinding: { mode: "detached" },
    });
  });

  it("projects tracked endpoint and model presets to the current revision without changing detached copies", async () => {
    const repository = new InMemoryChatRepository();
    const runtime = await createApplicationRuntime(repository, new FakeDesktopBridge());
    const preset = findOfficialModelPreset("openai-responses");
    const trackedBinding = {
      mode: "tracked" as const,
      presetId: preset.id,
      baseRevision: 0,
      overridePatch: {
        endpoint: { pathTemplate: "/proxy/v1/responses" },
        label: "User model label",
        modelId: "user-model-id",
        parameterValues: { reasoning_effort: "xhigh" },
      },
    };
    const tracked = await runtime.service.createProviderConfiguration({
      authBindings: [],
      baseUrl: "https://stale.fixture.invalid",
      connectionName: "Tracked preset fixture",
      explicitPort: 9443,
      modelDisplayName: "Stale model label",
      modelId: "stale-model-id",
      path: "/stale",
      profileId: preset.endpoint.protocolProfileId,
      presetBinding: trackedBinding,
    });
    const detached = await runtime.service.createProviderConfiguration({
      authBindings: [],
      baseUrl: "https://detached.fixture.invalid",
      connectionName: "Detached preset fixture",
      explicitPort: null,
      modelDisplayName: "Detached model",
      modelId: "detached-model",
      path: "/detached",
      profileId: preset.endpoint.protocolProfileId,
      presetBinding: {
        mode: "detached",
        forkedFromPresetId: preset.id,
        forkedFromRevision: 0,
      },
    });

    await runtime.service.ensureProviderPresets();

    expect(await repository.getProviderEndpoint(tracked.endpoint.id)).toMatchObject({
      baseUrl: preset.endpoint.baseUrl,
      explicitPort: 9443,
      pathTemplate: "/proxy/v1/responses",
      presetBinding: { mode: "tracked", baseRevision: preset.source.revision },
    });
    expect(await repository.getModel(tracked.model.id)).toMatchObject({
      displayName: "User model label",
      modelId: "user-model-id",
      parameterValues: { reasoning_effort: "xhigh" },
      presetBinding: { mode: "tracked", baseRevision: preset.source.revision },
      schemaRevision: preset.source.revision,
    });
    expect(await repository.getProviderEndpoint(detached.endpoint.id)).toMatchObject({
      baseUrl: "https://detached.fixture.invalid",
      pathTemplate: "/detached",
      presetBinding: { mode: "detached" },
    });
    expect(await repository.getModel(detached.model.id)).toMatchObject({
      displayName: "Detached model",
      modelId: "detached-model",
      presetBinding: { mode: "detached" },
    });
  });
});
