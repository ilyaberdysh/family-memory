import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Unsent text survives reloads, crashes and closed tabs: it is autosaved to localStorage (debounced, and
 * flushed when the page is hidden) and removed only after the server confirmed the save, or when the person
 * deletes the draft. Keys are scoped by user so relatives sharing a device do not see each other's drafts.
 */
const PREFIX = 'family-memory:draft:v1';
interface StoredDraft<T> { value: T; savedAt: string }

export function draftKey(userId: string, ...parts: string[]) { return [PREFIX, userId, ...parts].join(':'); }

export function readDraft<T>(key: string | null | undefined): T | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredDraft<T> | null;
    return stored && typeof stored === 'object' && 'value' in stored ? stored.value : null;
  } catch { return null; }
}
export function writeDraft<T>(key: string, value: T): boolean {
  try { localStorage.setItem(key, JSON.stringify({ value, savedAt: new Date().toISOString() } satisfies StoredDraft<T>)); return true; }
  catch { return false; }
}
export function clearDraft(key: string | null | undefined) {
  if (!key) return;
  try { localStorage.removeItem(key); } catch { /* storage unavailable: nothing was saved either */ }
}

export interface DraftControl {
  /** The last save attempt failed (private mode, full storage): the text lives only on this page. */
  failed: boolean;
  /** Remove the stored draft and ignore the current value until it changes. */
  clear: () => void;
  /** Write a pending change immediately. */
  flush: () => void;
}

/**
 * Autosaves `value` under `key` (null disables). The value present when a key becomes active is not written
 * until it changes, so restoring or opening an editor never overwrites a stored draft by itself.
 * `isClean` decides when there is nothing worth keeping; then the stored draft is removed.
 */
export function useDraft<T>(key: string | null, value: T, isClean: (value: T) => boolean, delay = 800): DraftControl {
  const [failed, setFailed] = useState(false);
  const serialized = JSON.stringify(value) ?? '';
  const latest = useRef({ key, serialized });
  latest.current = { key, serialized };
  const cleanRef = useRef(isClean);
  cleanRef.current = isClean;
  const active = useRef<{ key: string; initial: string; touched: boolean } | null>(null);
  const skip = useRef<string | null>(null);
  const pending = useRef<{ key: string; value: T } | null>(null);
  const timer = useRef(0);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    if (cleanRef.current(next.value)) { clearDraft(next.key); setFailed(false); return; }
    setFailed(!writeDraft(next.key, next.value));
  }, []);

  useEffect(() => {
    if (active.current?.key !== (key ?? undefined)) {
      flush();
      active.current = key ? { key, initial: serialized, touched: false } : null;
      skip.current = null;
      return;
    }
    if (!key || !active.current) return;
    if (!active.current.touched) {
      if (serialized === active.current.initial) return;
      active.current.touched = true;
    }
    if (skip.current !== null) {
      if (serialized === skip.current) return;
      skip.current = null;
    }
    pending.current = { key, value };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, delay);
    // `serialized` stands in for `value`.
  }, [key, serialized, delay, flush]);

  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hidden); flush(); };
  }, [flush]);

  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    pending.current = null;
    clearDraft(latest.current.key);
    skip.current = latest.current.serialized;
    setFailed(false);
  }, []);

  return { failed, clear, flush };
}
