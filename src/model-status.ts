import { useEffect, useState } from 'react';

export type ModelStatus = { ready: true; provider: string; model: string } | { ready: false; reason: string };

export function useModelStatus(): ModelStatus | null {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  useEffect(() => {
    fetch('/api/health')
      .then(response => response.json())
      .then(body => setStatus(body.model))
      .catch(() => setStatus({ ready: false, reason: 'Сервер недоступен.' }));
  }, []);
  return status;
}
