import { Phase3Repository } from "@/infrastructure/db/phase3Repository";
import { openApplicationDatabase } from "@/infrastructure/db/tauriDatabase";
import type { SqlDatabase } from "@/infrastructure/db/sqlDatabase";

type DatabaseOpener = () => Promise<SqlDatabase>;

export async function initializePersistence(
  now = Date.now(),
  openDatabase: DatabaseOpener = openApplicationDatabase,
): Promise<Phase3Repository> {
  const repository = new Phase3Repository(await openDatabase());
  await repository.recoverInterrupted(now);
  return repository;
}
