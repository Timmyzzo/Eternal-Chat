import { ActiveRequestRegistry } from "@/application/chat/activeRequestRegistry";
import {
  ChatService,
  SessionCredentialResolver,
  type ChatRepository,
} from "@/application/chat/chatService";
import type { DesktopBridge } from "@/infrastructure/desktop/desktopBridge";
import { BrowserFixtureBridge } from "@/infrastructure/desktop/browserFixtureBridge";
import { InMemoryChatRepository } from "@/infrastructure/db/inMemoryChatRepository";
import {
  OPENAI_CHAT_COMPLETIONS_PROFILE_ID,
  OPENAI_RESPONSES_PROFILE_ID,
} from "@/infrastructure/providers/openai/protocolProfiles";

export interface ApplicationRuntime {
  credentials: SessionCredentialResolver;
  registry: ActiveRequestRegistry;
  service: ChatService;
}

export async function createApplicationRuntime(
  repository: ChatRepository,
  bridge: DesktopBridge,
): Promise<ApplicationRuntime> {
  const credentials = new SessionCredentialResolver();
  const registry = new ActiveRequestRegistry(bridge, repository);
  const service = new ChatService(repository, registry, credentials, bridge);
  await service.loadApplicationSettings();
  await service.ensureProtocolPresets();
  await service.ensureProviderPresets();
  return { credentials, registry, service };
}

export async function createBrowserFixtureRuntime(): Promise<ApplicationRuntime> {
  const repository = new InMemoryChatRepository();
  const runtime = await createApplicationRuntime(repository, new BrowserFixtureBridge());
  const chat = await runtime.service.createProviderConfiguration({
    authBindings: [],
    baseUrl: "http://127.0.0.1/browser-fixture",
    connectionName: "Local Chat fixture",
    explicitPort: null,
    method: "POST",
    modelDisplayName: "Browser Chat fixture",
    modelId: "browser-fixture-chat",
    path: "/v1/chat/completions",
    profileId: OPENAI_CHAT_COMPLETIONS_PROFILE_ID,
    reasoningDeltaPaths: ["reasoning"],
    timeoutMs: 10_000,
  });
  await runtime.service.createProviderConfiguration({
    authBindings: [],
    baseUrl: "http://127.0.0.1/browser-fixture",
    connectionName: "Local Responses fixture",
    explicitPort: null,
    method: "POST",
    modelDisplayName: "Browser Responses fixture",
    modelId: "browser-fixture-responses",
    path: "/v1/responses",
    profileId: OPENAI_RESPONSES_PROFILE_ID,
    timeoutMs: 10_000,
  });
  const compatibilityBase = {
    endpointId: chat.endpoint.id,
    modelRef: chat.model.id,
    protocolProfileId: chat.profile.id,
    apiVersion: chat.endpoint.apiVersion,
    parameterId: "reasoning_effort",
    placement: "body",
    wirePath: "reasoning_effort",
    testedValue: "xhigh",
    evidenceType: "browser_fixture",
    requestFingerprint: null,
    httpStatus: 200,
    providerErrorCode: null,
    note: null,
  };
  await repository.insertCompatibilityProbe({
    ...compatibilityBase,
    id: "browser-probe-current",
    protocolProfileRevision: chat.profile.revision,
    status: "unknown",
    checkedAt: 2,
  });
  await repository.insertCompatibilityProbe({
    ...compatibilityBase,
    id: "browser-probe-stale",
    protocolProfileRevision: chat.profile.revision - 1,
    status: "accepted_ignored",
    checkedAt: 1,
  });
  await runtime.service.createConversation("Phase 5 local fixture", chat.model.id);
  return runtime;
}
