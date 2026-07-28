import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import migrationSql from "@/infrastructure/db/migrations/0001_phase_3_authoritative_schema.sql?raw";
import phase5aMigrationSql from "@/infrastructure/db/migrations/0002_phase_5a_request_attempts.sql?raw";
import phase6MigrationSql from "@/infrastructure/db/migrations/0003_phase_6_provider_configuration.sql?raw";
import type { SqlDatabase, SqlQueryResult } from "@/infrastructure/db/sqlDatabase";

export interface MigrationDefinition {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

export const PHASE_3_MIGRATION: MigrationDefinition = {
  version: 1,
  name: "phase_3_authoritative_schema",
  checksum: readMigrationChecksum(migrationSql),
  sql: migrationSql,
};

export const PHASE_5A_MIGRATION: MigrationDefinition = {
  version: 2,
  name: "phase_5a_request_attempts",
  checksum: readMigrationChecksum(phase5aMigrationSql),
  sql: phase5aMigrationSql,
};

export const PHASE_6_MIGRATION: MigrationDefinition = {
  version: 3,
  name: "phase_6_provider_configuration",
  checksum: readMigrationChecksum(phase6MigrationSql),
  sql: phase6MigrationSql,
};

export const APPLICATION_MIGRATIONS = [
  PHASE_3_MIGRATION,
  PHASE_5A_MIGRATION,
  PHASE_6_MIGRATION,
] as const;

export class NodeSqliteDatabase implements SqlDatabase {
  private readonly database: DatabaseSync;

  constructor(readonly path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON");
  }

  async execute(query: string, bindValues: unknown[] = []): Promise<SqlQueryResult> {
    const result = this.database.prepare(query).run(...toSqliteBindings(bindValues));
    return {
      rowsAffected: Number(result.changes),
      lastInsertId: Number(result.lastInsertRowid),
    };
  }

  async select<T extends object>(query: string, bindValues: unknown[] = []): Promise<T[]> {
    return this.selectSync<T>(query, bindValues);
  }

  selectSync<T extends object>(query: string, bindValues: unknown[] = []): T[] {
    return this.database.prepare(query).all(...toSqliteBindings(bindValues)) as T[];
  }

  execScript(sql: string): void {
    this.database.exec(sql);
  }

  async close(): Promise<void> {
    this.database.close();
  }
}

export interface TempDatabaseFixture {
  database: NodeSqliteDatabase;
  databasePath: string;
  directory: string;
  cleanup(): Promise<void>;
}

export async function createTempDatabase(
  migrations: readonly MigrationDefinition[] = APPLICATION_MIGRATIONS,
): Promise<TempDatabaseFixture> {
  const directory = await mkdtemp(join(tmpdir(), "eternal-chat-phase3-"));
  const databasePath = join(directory, "fixture.sqlite");
  const database = new NodeSqliteDatabase(databasePath);

  try {
    applyMigrations(database, migrations);
  } catch (error) {
    await database.close();
    await rm(directory, { force: true, recursive: true });
    throw error;
  }

  let cleaned = false;
  return {
    database,
    databasePath,
    directory,
    async cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      await database.close();
      await rm(directory, { force: true, recursive: true });
    },
  };
}

export function applyMigrations(
  database: NodeSqliteDatabase,
  migrations: readonly MigrationDefinition[],
): void {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  const migrationTableExists =
    database.selectSync<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'",
    )[0]?.count === 1;

  const applied = new Map<number, { name: string; checksum: string }>();
  if (migrationTableExists) {
    database
      .selectSync<{ version: number; name: string; checksum: string }>(
        "SELECT version, name, checksum FROM schema_migration ORDER BY version",
      )
      .forEach((row) => applied.set(row.version, row));
  }

  ordered.forEach((migration) => {
    const existing = applied.get(migration.version);
    if (existing) {
      if (existing.name !== migration.name || existing.checksum !== migration.checksum) {
        throw new Error(`Migration ${migration.version} metadata does not match`);
      }
      return;
    }

    database.execScript("BEGIN IMMEDIATE");
    try {
      database.execScript(migration.sql);
      database.execScript("COMMIT");
      applied.set(migration.version, {
        name: migration.name,
        checksum: migration.checksum,
      });
    } catch (error) {
      database.execScript("ROLLBACK");
      throw error;
    }
  });
}

export function calculateMigrationChecksum(sql: string): string {
  const canonical = sql.replace(/sha256:(?:PLACEHOLDER|[0-9a-f]{64})/, "sha256:<canonical>");
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function readMigrationChecksum(sql: string): string {
  const match = sql.match(/'(?<checksum>sha256:[0-9a-f]{64})'/);
  if (!match?.groups?.checksum) {
    throw new Error("Migration checksum is missing");
  }
  return match.groups.checksum;
}

function toSqliteBindings(values: unknown[]): SQLInputValue[] {
  return values.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new Error("Unsupported SQLite fixture binding");
  });
}
