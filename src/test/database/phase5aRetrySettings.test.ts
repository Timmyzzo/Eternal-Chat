// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_RETRY_POLICY } from "@/application/chat/retryPolicy";
import { Phase3Repository } from "@/infrastructure/db/phase3Repository";
import { FIXTURE_TIME, seedProviderGraph } from "@/test/database/phase3Seed";
import { createTempDatabase, type TempDatabaseFixture } from "@/test/database/tempDatabase";

describe("Phase 5A retry settings persistence", () => {
  let fixture: TempDatabaseFixture;
  let repository: Phase3Repository;

  beforeEach(async () => {
    fixture = await createTempDatabase();
    repository = new Phase3Repository(fixture.database);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("round-trips the application default and endpoint override independently", async () => {
    expect(await repository.getApplicationRetryPolicy()).toBeNull();

    const applicationPolicy = { ...DEFAULT_RETRY_POLICY, maxRetries: 2 };
    await repository.setApplicationRetryPolicy(applicationPolicy, FIXTURE_TIME);
    expect(await repository.getApplicationRetryPolicy()).toEqual(applicationPolicy);

    const graph = await seedProviderGraph(repository, "retry-settings");
    expect(graph.endpoint.retryPolicy).toBeNull();
    await repository.updateProviderEndpointRetryPolicy(
      graph.endpoint.id,
      { enabled: false, maxRetries: 0 },
      FIXTURE_TIME + 1,
    );
    expect(await repository.getProviderEndpoint(graph.endpoint.id)).toMatchObject({
      retryPolicy: { enabled: false, maxRetries: 0 },
      updatedAt: FIXTURE_TIME + 1,
    });

    await repository.updateProviderEndpointRetryPolicy(graph.endpoint.id, null, FIXTURE_TIME + 2);
    expect(await repository.getProviderEndpoint(graph.endpoint.id)).toMatchObject({
      retryPolicy: null,
      updatedAt: FIXTURE_TIME + 2,
    });
  });
});
