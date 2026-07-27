export interface SqlQueryResult {
  rowsAffected: number;
  lastInsertId?: number;
}

export interface SqlDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<SqlQueryResult>;
  select<T extends object>(query: string, bindValues?: unknown[]): Promise<T[]>;
  close?(): Promise<void>;
}
