import Database from "@tauri-apps/plugin-sql";

import type { SqlDatabase, SqlQueryResult } from "@/infrastructure/db/sqlDatabase";

export const APPLICATION_DATABASE_URL = "sqlite:eternal-chat.db";

class TauriSqlDatabase implements SqlDatabase {
  constructor(private readonly database: Database) {}

  async execute(query: string, bindValues?: unknown[]): Promise<SqlQueryResult> {
    return this.database.execute(query, bindValues);
  }

  async select<T extends object>(query: string, bindValues?: unknown[]): Promise<T[]> {
    return this.database.select<T[]>(query, bindValues);
  }

  async close(): Promise<void> {
    await this.database.close(this.database.path);
  }
}

export async function openApplicationDatabase(): Promise<SqlDatabase> {
  const database = new TauriSqlDatabase(await Database.load(APPLICATION_DATABASE_URL));
  await database.execute("PRAGMA foreign_keys = ON");
  return database;
}
