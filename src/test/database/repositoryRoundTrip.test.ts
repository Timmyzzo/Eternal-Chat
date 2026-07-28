// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Conversation, MessageBlocks, RequestSnapshot } from "@/domain/chat";
import { EMPTY_MESSAGE_BLOCKS } from "@/domain/chat";
import type { Artifact, CompatibilityProbeStatus } from "@/domain/provider";
import { Phase3Repository, rootMessageId } from "@/infrastructure/db/phase3Repository";
import { FIXTURE_TIME, seedProviderGraph } from "@/test/database/phase3Seed";
import { createTempDatabase, type TempDatabaseFixture } from "@/test/database/tempDatabase";

describe("Phase3Repository round trips", () => {
  let fixture: TempDatabaseFixture;
  let repository: Phase3Repository;

  beforeEach(async () => {
    fixture = await createTempDatabase();
    repository = new Phase3Repository(fixture.database);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("round trips one connection with multiple explicit ports, profiles, and models", async () => {
    const primary = await seedProviderGraph(repository);
    const secondary = await seedProviderGraph(repository, "secondary", primary.connection);

    expect(await repository.getProviderConnection(primary.connection.id)).toEqual(
      primary.connection,
    );
    expect(await repository.getProtocolProfile(primary.profile.id)).toEqual(primary.profile);
    expect(await repository.getProviderEndpoint(primary.endpoint.id)).toEqual(primary.endpoint);
    expect(await repository.getModel(primary.model.id)).toEqual(primary.model);

    expect(await repository.getProtocolProfile(secondary.profile.id)).toEqual(secondary.profile);
    expect(await repository.getProviderEndpoint(secondary.endpoint.id)).toEqual(secondary.endpoint);
    expect(await repository.getModel(secondary.model.id)).toEqual(secondary.model);
    expect(primary.endpoint.explicitPort).toBe(8443);
    expect(secondary.endpoint.explicitPort).toBe(443);
    expect(primary.endpoint.protocolProfileId).not.toBe(secondary.endpoint.protocolProfileId);

    const updatedEndpoint = {
      ...primary.endpoint,
      baseUrl: "https://updated.fixture.invalid",
      pathTemplate: "/updated/{deployment}",
      pathDefaults: { deployment: "responses" },
      presetBinding: {
        mode: "tracked" as const,
        presetId: "fixture-endpoint-preset",
        baseRevision: 2,
        overridePatch: { endpoint: { pathTemplate: "/updated/{deployment}" } },
      },
      updatedAt: FIXTURE_TIME + 20,
    };
    await repository.updateProviderEndpoint(updatedEndpoint);
    expect(await repository.getProviderEndpoint(updatedEndpoint.id)).toEqual(updatedEndpoint);

    const updatedModel = {
      ...primary.model,
      displayName: "Updated fixture model",
      parameterValues: { reasoning_effort: "xhigh" },
      presetBinding: {
        mode: "tracked" as const,
        presetId: "fixture-model-preset",
        baseRevision: 2,
        overridePatch: { parameterValues: { reasoning_effort: "xhigh" } },
      },
      schemaRevision: 2,
      updatedAt: FIXTURE_TIME + 21,
    };
    await repository.updateModel(updatedModel);
    expect(await repository.getModel(updatedModel.id)).toEqual(updatedModel);
  });

  it("round trips every compatibility probe status without sharing endpoint evidence", async () => {
    const graph = await seedProviderGraph(repository);
    const statuses: CompatibilityProbeStatus[] = [
      "unknown",
      "accepted_effective",
      "accepted_ignored",
      "rejected",
      "translated",
    ];

    for (const [index, status] of statuses.entries()) {
      const probe = {
        id: `probe-${status}`,
        endpointId: graph.endpoint.id,
        modelRef: graph.model.id,
        protocolProfileId: graph.profile.id,
        protocolProfileRevision: graph.profile.revision,
        apiVersion: graph.endpoint.apiVersion,
        parameterId: `parameter-${index}`,
        placement: "body",
        wirePath: `reasoning.parameter_${index}`,
        testedValue: { value: index },
        status,
        evidenceType: "fixture",
        requestFingerprint: `fingerprint-${index}`,
        httpStatus: status === "rejected" ? 422 : 200,
        providerErrorCode: status === "rejected" ? "fixture_rejected" : null,
        note: `Fixture evidence ${status}`,
        checkedAt: FIXTURE_TIME + index,
      } as const;
      await repository.insertCompatibilityProbe(probe);
      expect(await repository.getCompatibilityProbe(probe.id)).toEqual(probe);
    }

    expect(
      (await repository.listCompatibilityProbes(graph.model.id)).map((probe) => probe.id),
    ).toEqual([...statuses].reverse().map((status) => `probe-${status}`));
    expect(await repository.listCompatibilityProbes("missing-model")).toEqual([]);
  });

  it("round trips versioned message blocks and artifact references without losing unknown blocks", async () => {
    const graph = await seedProviderGraph(repository);
    const artifact: Artifact = {
      id: "artifact-fixture",
      contentHash: "sha256:fixture-content",
      relativePath: "artifacts/fixture-content.bin",
      mimeType: "application/json",
      byteSize: 42,
      kind: "tool_result",
      originalName: "fixture-result.json",
      createdAt: FIXTURE_TIME,
      lastAccessedAt: null,
    };
    await repository.insertArtifact(artifact);

    const conversation = await createConversation(
      repository,
      graph.model.id,
      "conversation-blocks",
    );
    expect(await repository.getConversation(conversation.id)).toEqual(conversation);
    const blocks: MessageBlocks = {
      version: 1,
      blocks: [
        { type: "thinking", text: "Fixture thought summary", visibility: "provider_returned" },
        { type: "text", text: "Fixture answer" },
        {
          type: "tool_call",
          id: "tool-call-fixture",
          name: "fixture_search",
          args: { query: "fixture" },
          status: "succeeded",
          source: "client",
          result: {
            modelContent: { type: "json", value: { fact: "CANARY_FIXTURE" } },
            rawRef: artifact.id,
            rawHash: artifact.contentHash,
          },
        },
        {
          type: "source",
          id: "source-fixture",
          url: "https://fixture.invalid/source",
          title: "Fixture source",
          toolCallId: "tool-call-fixture",
        },
        { type: "future_block", preserved: { nested: [1, true, "value"] } },
      ],
    };

    const turn = await repository.createPendingTurn({
      conversationId: conversation.id,
      parentId: rootMessageId(conversation.id),
      userMessageId: "message-user-blocks",
      userBlocks: { version: 1, blocks: [{ type: "text", text: "Fixture question" }] },
      assistantMessageId: "message-assistant-blocks",
      assistantBlocks: EMPTY_MESSAGE_BLOCKS,
      assistantModelRef: graph.model.id,
      createdAt: FIXTURE_TIME + 1,
    });
    await repository.updateMessage(turn.assistantMessage.id, "done", blocks, FIXTURE_TIME + 2);

    expect(await repository.getArtifact(artifact.id)).toEqual(artifact);
    expect((await repository.getMessage(turn.assistantMessage.id))?.blocks).toEqual(blocks);
  });

  it("keeps RequestSnapshot endpoint and profile revision association immutable", async () => {
    const graph = await seedProviderGraph(repository);
    const conversation = await createConversation(
      repository,
      graph.model.id,
      "conversation-snapshot",
    );
    const turn = await repository.createPendingTurn({
      conversationId: conversation.id,
      parentId: rootMessageId(conversation.id),
      userMessageId: "message-user-snapshot",
      userBlocks: { version: 1, blocks: [{ type: "text", text: "Snapshot fixture" }] },
      assistantMessageId: "message-assistant-snapshot",
      assistantBlocks: EMPTY_MESSAGE_BLOCKS,
      assistantModelRef: graph.model.id,
      createdAt: FIXTURE_TIME + 1,
    });
    const snapshot = createSnapshot(
      conversation.id,
      turn.userMessage.id,
      turn.assistantMessage.id,
      graph,
    );

    await repository.createRequestSnapshot(snapshot);
    expect(await repository.getRequestSnapshot(snapshot.id)).toEqual(snapshot);
    expect((await repository.getMessage(turn.assistantMessage.id))?.requestSnapshotId).toBe(
      snapshot.id,
    );

    await repository.updateProtocolProfile({
      ...graph.profile,
      revision: graph.profile.revision + 1,
      updatedAt: FIXTURE_TIME + 10,
    });
    expect((await repository.getRequestSnapshot(snapshot.id))?.protocolProfileRevision).toBe(3);
  });

  it("rejects snapshot and probe associations that mix endpoint, model, profile, or revision", async () => {
    const primary = await seedProviderGraph(repository);
    const secondary = await seedProviderGraph(repository, "secondary", primary.connection);
    const conversation = await createConversation(
      repository,
      primary.model.id,
      "conversation-association-rejection",
    );
    const turn = await repository.createPendingTurn({
      conversationId: conversation.id,
      parentId: rootMessageId(conversation.id),
      userMessageId: "message-user-association",
      userBlocks: { version: 1, blocks: [{ type: "text", text: "Association fixture" }] },
      assistantMessageId: "message-assistant-association",
      assistantBlocks: EMPTY_MESSAGE_BLOCKS,
      assistantModelRef: primary.model.id,
      createdAt: FIXTURE_TIME + 1,
    });
    const snapshot = createSnapshot(
      conversation.id,
      turn.userMessage.id,
      turn.assistantMessage.id,
      primary,
    );

    await expect(
      repository.createRequestSnapshot({
        ...snapshot,
        id: "snapshot-wrong-endpoint",
        endpointId: secondary.endpoint.id,
      }),
    ).rejects.toThrow(/request_snapshot_model_endpoint_mismatch/);
    await expect(
      repository.createRequestSnapshot({
        ...snapshot,
        id: "snapshot-wrong-profile",
        protocolProfileId: secondary.profile.id,
      }),
    ).rejects.toThrow(/request_snapshot_profile_mismatch/);
    await expect(
      repository.createRequestSnapshot({
        ...snapshot,
        id: "snapshot-wrong-revision",
        protocolProfileRevision: primary.profile.revision + 1,
      }),
    ).rejects.toThrow(/request_snapshot_profile_revision_mismatch/);
    expect((await repository.getMessage(turn.assistantMessage.id))?.requestSnapshotId).toBeNull();

    await expect(
      repository.insertCompatibilityProbe({
        id: "probe-wrong-endpoint",
        endpointId: secondary.endpoint.id,
        modelRef: primary.model.id,
        protocolProfileId: secondary.profile.id,
        protocolProfileRevision: secondary.profile.revision,
        apiVersion: secondary.endpoint.apiVersion,
        parameterId: "fixture_parameter",
        placement: "body",
        wirePath: "fixture_parameter",
        testedValue: "fixture",
        status: "unknown",
        evidenceType: "fixture",
        requestFingerprint: null,
        httpStatus: null,
        providerErrorCode: null,
        note: null,
        checkedAt: FIXTURE_TIME,
      }),
    ).rejects.toThrow(/parameter_probe_model_endpoint_mismatch/);
  });
});

async function createConversation(
  repository: Phase3Repository,
  modelRef: string,
  id: string,
): Promise<Conversation> {
  return repository.createConversation({
    id,
    title: "Fixture conversation",
    modelRef,
    systemPrompt: "",
    params: { effort: "fixture" },
    extraBody: {},
    extraHeaders: {},
    extraQuery: {},
    extraPath: { deployment: "fixture" },
    toolsOverride: {},
    contextPolicy: { mode: "lossless" },
    activeLeafMessageId: null,
    archived: false,
    starred: false,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  });
}

function createSnapshot(
  conversationId: string,
  userMessageId: string,
  assistantMessageId: string,
  graph: Awaited<ReturnType<typeof seedProviderGraph>>,
): RequestSnapshot {
  return {
    id: "snapshot-fixture",
    conversationId,
    userMessageId,
    assistantMessageId,
    connectionId: graph.connection.id,
    endpointId: graph.endpoint.id,
    modelRef: graph.model.id,
    protocolProfileId: graph.profile.id,
    protocolProfileRevision: graph.profile.revision,
    codecVersion: "fixture-codec/0",
    requestMethod: "POST",
    requestUrl: "https://fixture.invalid:8443/v1/primary/messages",
    requestHeaders: { "x-fixture": "primary" },
    requestQuery: { api_version: "fixture" },
    requestBody: { messages: [{ role: "user", content: "Fixture" }] },
    params: { effort: "fixture" },
    contextManifest: { version: 1, items: [] },
    contextHash: "sha256:fixture-context",
    requestBodyHash: "sha256:fixture-body",
    retryPolicy: { mode: "none" },
    attemptCount: 0,
    providerAnchor: null,
    status: "pending",
    finishReason: null,
    errorCode: null,
    startedAt: FIXTURE_TIME + 2,
    firstEventAt: null,
    completedAt: null,
  };
}
