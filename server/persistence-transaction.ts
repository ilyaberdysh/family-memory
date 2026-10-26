import { restoreResearchStore, snapshotResearchStore } from './research-store.js';
import { restoreTreeStore, snapshotTreeStore } from './tree-store.js';

/**
 * Keeps the two local JSON projections consistent when an in-process write fails.
 * Atomic rename protects each file; this rollback protects the pair as one operation.
 */
export function withPersistenceTransaction<T>(operation: () => T): T {
  const treeBefore = snapshotTreeStore();
  const researchBefore = snapshotResearchStore();
  try {
    return operation();
  } catch (error) {
    const rollbackErrors: Error[] = [];
    try {
      restoreTreeStore(treeBefore);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError as Error);
    }
    try {
      restoreResearchStore(researchBefore);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError as Error);
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error as Error, ...rollbackErrors], 'Операция не выполнена, а откат локальных хранилищ завершился с ошибкой.');
    }
    throw error;
  }
}
