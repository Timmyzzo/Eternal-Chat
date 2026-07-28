// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  applyMigrations,
  createTempDatabase,
  PHASE_3_MIGRATION,
  PHASE_5A_MIGRATION,
} from "@/test/database/tempDatabase";

describe("Phase 5A migration", () => {
  it("adds request_attempt without changing the published v1 migration", async () => {
    const fixture = await createTempDatabase([PHASE_3_MIGRATION]);
    try {
      const v1Before = await fixture.database.select<{
        checksum: string;
        name: string;
        version: number;
      }>("SELECT version, name, checksum FROM schema_migration WHERE version = 1");

      applyMigrations(fixture.database, [PHASE_3_MIGRATION, PHASE_5A_MIGRATION]);

      expect(
        await fixture.database.select<{ checksum: string; name: string; version: number }>(
          "SELECT version, name, checksum FROM schema_migration ORDER BY version",
        ),
      ).toEqual([
        v1Before[0],
        {
          version: 2,
          name: "phase_5a_request_attempts",
          checksum: PHASE_5A_MIGRATION.checksum,
        },
      ]);
      expect(
        await fixture.database.select<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'request_attempt'",
        ),
      ).toEqual([{ count: 1 }]);
      expect(
        await fixture.database.select<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_request_attempt_snapshot_no'",
        ),
      ).toEqual([{ name: "idx_request_attempt_snapshot_no" }]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("creates the latest schema by default and enforces attempt identity and status", async () => {
    const fixture = await createTempDatabase();
    try {
      const versions = await fixture.database.select<{ version: number }>(
        "SELECT version FROM schema_migration ORDER BY version",
      );
      expect(versions).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);

      const sql = (
        await fixture.database.select<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'request_attempt'",
        )
      )[0]?.sql;
      expect(sql).toContain("UNIQUE(request_snapshot_id, attempt_no)");
      expect(sql).toContain("retryable_failed");
      expect(sql).toContain("non_retryable_failed");
    } finally {
      await fixture.cleanup();
    }
  });
});
