import type {
  ProtocolProfile,
  ProviderConnection,
  ProviderEndpoint,
  Model,
} from "@/domain/provider";
import type { Phase3Repository } from "@/infrastructure/db/phase3Repository";

export const FIXTURE_TIME = 1_800_000_000_000;

export interface ProviderGraph {
  connection: ProviderConnection;
  profile: ProtocolProfile;
  endpoint: ProviderEndpoint;
  model: Model;
}

export async function seedProviderGraph(
  repository: Phase3Repository,
  suffix = "primary",
  connection?: ProviderConnection,
): Promise<ProviderGraph> {
  const graphConnection =
    connection ??
    ({
      id: `connection-${suffix}`,
      name: `Fixture connection ${suffix}`,
      vendorHint: "fixture",
      description: "Non-secret deterministic test data",
      enabled: true,
      createdAt: FIXTURE_TIME,
      updatedAt: FIXTURE_TIME,
    } satisfies ProviderConnection);

  const profile: ProtocolProfile = {
    id: `profile-${suffix}`,
    name: `Fixture profile ${suffix}`,
    codecId: `fixture_codec_${suffix}`,
    requestMapping: { messagesPath: "messages" },
    responseMapping: { textPath: "delta.text" },
    toolsMapping: { callsPath: "tool_calls" },
    continuationMapping: { mode: "explicit_items" },
    source: { kind: "fixture", revision: 1 },
    userEdited: false,
    revision: 3,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  };

  const endpoint: ProviderEndpoint = {
    id: `endpoint-${suffix}`,
    connectionId: graphConnection.id,
    name: `Fixture endpoint ${suffix}`,
    baseUrl: "https://fixture.invalid",
    explicitPort: suffix === "secondary" ? 443 : 8443,
    pathTemplate: `/v1/${suffix}/messages`,
    method: "POST",
    apiVersion: "fixture-2026-07",
    protocolProfileId: profile.id,
    authBindings: [{ bindingRef: "fixture-auth-reference" }],
    headers: { "x-fixture": suffix },
    query: { api_version: "fixture" },
    bodyDefaults: { stream: true },
    timeoutMs: 30_000,
    retryPolicy: null,
    enabled: true,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  };

  const model: Model = {
    id: `model-${suffix}`,
    endpointId: endpoint.id,
    modelId: `remote-model-${suffix}`,
    displayName: `Fixture model ${suffix}`,
    capabilitySchema: { reasoning: true },
    paramsSchema: [{ id: "effort", type: "string" }],
    builtInTools: [{ id: "fixture_search" }],
    extraBody: { fixture: true },
    extraHeaders: { "x-model": suffix },
    extraQuery: { model_revision: "fixture" },
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    protocolProfileOverrideId: null,
    schemaOrigin: "fixture",
    schemaRevision: 7,
    enabled: true,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  };

  if (!connection) {
    await repository.insertProviderConnection(graphConnection);
  }
  await repository.insertProtocolProfile(profile);
  await repository.insertProviderEndpoint(endpoint);
  await repository.insertModel(model);

  return { connection: graphConnection, profile, endpoint, model };
}
