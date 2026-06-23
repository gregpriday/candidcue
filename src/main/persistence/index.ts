import type { CandidCueRepository } from '@shared/contracts/repository';
import { SqliteRepository } from './sqlite-repository';

export { SqliteRepository, minimalAnswer } from './sqlite-repository';
export type { SqliteHandle, SqliteStatement } from './sqlite-repository';
export { MemoryRepository } from './memory-repository';
export { MIGRATIONS } from './migrations/index';
export type { Migration, MigrationDb } from './migrations/index';

/**
 * Open (or create) the on-disk CandidCue database and return a ready-to-use
 * repository. The schema is NOT migrated here — callers run `migrate()` once at
 * startup so migration timing/logging stays in app bootstrap rather than buried
 * in a constructor.
 *
 * @param dbPath Absolute path to the SQLite file (or `:memory:` for tests).
 */
export function createRepository(dbPath: string): CandidCueRepository {
  return new SqliteRepository(dbPath);
}
