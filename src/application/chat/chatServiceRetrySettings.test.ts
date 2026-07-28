import { describe, expect, it, vi } from "vitest";

import { DEFAULT_RETRY_POLICY } from "@/application/chat/retryPolicy";
import { createApplicationRuntime } from "@/application/chat/runtime";
import { InMemoryChatRepository } from "@/infrastructure/db/inMemoryChatRepository";
import { FakeDesktopBridge } from "@/infrastructure/desktop/fakeDesktopBridge";
import { OPENAI_CHAT_COMPLETIONS_PROFILE_ID } from "@/infrastructure/providers/openai/protocolProfiles";

describe("ChatService retry settings", () => {
  it("persists the application default, applies endpoint overrides, and freezes each dispatch", async () => {
    const repository = new InMemoryChatRepository();
    const bridge = new FakeDesktopBridge();
    const runtime = await createApplicationRuntime(repository, bridge);

    expect(runtime.service.getApplicationRetryPolicy()).toEqual(DEFAULT_RETRY_POLICY);
    await runtime.service.setApplicationRetryPolicy({
      ...DEFAULT_RETRY_POLICY,
      maxRetries: 1,
    });
    const selection = await runtime.service.createProviderConfiguration({
      authBindings: [],
      baseUrl: "https://fixture.invalid",
      connectionName: "Retry settings",
      explicitPort: null,
      modelDisplayName: "Retry settings",
      modelId: "retry-settings-model",
      path: "/v1/chat/completions",
      profileId: OPENAI_CHAT_COMPLETIONS_PROFILE_ID,
    });
    const inheritedConversation = await runtime.service.createConversation(
      "Inherited retry policy",
      selection.model.id,
    );
    const inherited = await runtime.service.sendMessage(inheritedConversation.id, "Inherited");
    expect(inherited.dispatch.retryPolicy.maxRetries).toBe(1);
    await vi.waitFor(() => expect(bridge.startedRequests).toHaveLength(1));
    runtime.registry.stop(inherited.dispatch.transportRequest.requestId);
    await runtime.registry.whenTerminal(inherited.dispatch.transportRequest.requestId);

    expect(
      await runtime.service.updateEndpointRetryPolicy(selection.endpoint.id, { maxRetries: 2 }),
    ).toMatchObject({ maxRetries: 2 });
    const overriddenConversation = await runtime.service.createConversation(
      "Endpoint retry policy",
      selection.model.id,
    );
    const overridden = await runtime.service.sendMessage(overriddenConversation.id, "Override");
    expect(overridden.dispatch.retryPolicy.maxRetries).toBe(2);
    await vi.waitFor(() => expect(bridge.startedRequests).toHaveLength(2));
    runtime.registry.stop(overridden.dispatch.transportRequest.requestId);
    await runtime.registry.whenTerminal(overridden.dispatch.transportRequest.requestId);

    expect(
      await runtime.service.updateEndpointRetryPolicy(selection.endpoint.id, null),
    ).toMatchObject({ maxRetries: 1 });
    const restarted = await createApplicationRuntime(repository, new FakeDesktopBridge());
    expect(restarted.service.getApplicationRetryPolicy()).toMatchObject({ maxRetries: 1 });
  });
});
