// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  applyMigrations,
  calculateMigrationChecksum,
  createTempDatabase,
  pathExists,
  PHASE_3_MIGRATION,
} from "@/test/database/tempDatabase";

describe("Phase 3 migrations", () => {
  it("initializes a new database with the authoritative schema", async () => {
    const fixture = await createTempDatabase([PHASE_3_MIGRATION]);
    try {
      const tables = await fixture.database.select<{ name: string }>(
        `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
      );
      expect(tables.map((row) => row.name)).toEqual([
        "artifact",
        "conversation",
        "message",
        "model",
        "parameter_compatibility_probe",
        "protocol_profile",
        "provider_connection",
        "provider_endpoint",
        "request_snapshot",
        "schema_migration",
      ]);

      const versions = await fixture.database.select<{
        version: number;
        name: string;
        checksum: string;
      }>("SELECT version, name, checksum FROM schema_migration");
      expect(versions).toEqual([
        {
          version: PHASE_3_MIGRATION.version,
          name: PHASE_3_MIGRATION.name,
          checksum: PHASE_3_MIGRATION.checksum,
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("uses a reproducible checksum for the migration source", () => {
    expect(calculateMigrationChecksum(PHASE_3_MIGRATION.sql)).toBe(PHASE_3_MIGRATION.checksum);
  });

  it("does not reapply an already recorded migration", async () => {
    const fixture = await createTempDatabase([PHASE_3_MIGRATION]);
    try {
      const appliedAt = await fixture.database.select<{ applied_at: number }>(
        "SELECT applied_at FROM schema_migration WHERE version = 1",
      );
      applyMigrations(fixture.database, [PHASE_3_MIGRATION]);
      expect(
        await fixture.database.select<{ applied_at: number }>(
          "SELECT applied_at FROM schema_migration WHERE version = 1",
        ),
      ).toEqual(appliedAt);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a changed checksum for an applied migration", async () => {
    const fixture = await createTempDatabase();
    try {
      expect(() =>
        applyMigrations(fixture.database, [
          { ...PHASE_3_MIGRATION, checksum: "sha256:changed-test-checksum" },
        ]),
      ).toThrow(/metadata does not match/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rolls back every statement when a migration fails", async () => {
    const fixture = await createTempDatabase([PHASE_3_MIGRATION]);
    try {
      expect(() =>
        applyMigrations(fixture.database, [
          PHASE_3_MIGRATION,
          {
            version: 2,
            name: "test_failure",
            checksum: "sha256:test-only",
            sql: `
              CREATE TABLE rollback_probe (id INTEGER PRIMARY KEY);
              INSERT INTO schema_migration (version, name, applied_at, checksum)
              VALUES (2, 'test_failure', 1, 'sha256:test-only');
              INSERT INTO table_that_does_not_exist (id) VALUES (1);
            `,
          },
        ]),
      ).toThrow();

      expect(
        await fixture.database.select<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'rollback_probe'",
        ),
      ).toEqual([{ count: 0 }]);
      expect(
        await fixture.database.select<{ count: number }>(
          "SELECT COUNT(*) AS count FROM schema_migration WHERE version = 2",
        ),
      ).toEqual([{ count: 0 }]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("closes and removes the temporary database, WAL, SHM, and directory", async () => {
    const fixture = await createTempDatabase();
    const { databasePath, directory } = fixture;
    const walPath = `${databasePath}-wal`;
    const shmPath = `${databasePath}-shm`;
    try {
      fixture.database.execScript(
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE sidecar_probe (id INTEGER); INSERT INTO sidecar_probe VALUES (1);",
      );
      expect(await pathExists(databasePath)).toBe(true);
      expect(await pathExists(walPath)).toBe(true);
      expect(await pathExists(shmPath)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
    expect(await pathExists(databasePath)).toBe(false);
    expect(await pathExists(walPath)).toBe(false);
    expect(await pathExists(shmPath)).toBe(false);
    expect(await pathExists(directory)).toBe(false);
  });
});
