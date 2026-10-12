import { useCallback, useEffect, useState } from 'react';
import type { TreeState } from '../shared/types';

const EMPTY: TreeState = { people: [], relations: [], canUndo: false };

async function call(path: string, method = 'GET'): Promise<TreeState> {
  const response = await fetch(path, { method });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Не удалось обновить древо.');
  return body as TreeState;
}

export type TreeApi = {
  tree: TreeState;
  error: string | null;
  refresh: () => void;
  undo: () => void;
  reset: () => void;
  remove: (id: string) => void;
};

export function useTree(): TreeApi {
  const [tree, setTree] = useState<TreeState>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback((path: string, method?: string) => {
    call(path, method).then(next => { setTree(next); setError(null); }).catch(e => setError((e as Error).message));
  }, []);

  useEffect(() => { run('/api/tree'); }, [run]);

  return {
    tree,
    error,
    refresh: () => run('/api/tree'),
    undo: () => run('/api/tree/undo', 'POST'),
    reset: () => run('/api/tree/reset', 'POST'),
    remove: id => run(`/api/tree/people/${encodeURIComponent(id)}`, 'DELETE'),
  };
}
