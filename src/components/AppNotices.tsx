import { useEffect, useRef } from 'react';
import type { AppState } from '../../shared/types';
import { UnsavedRecordings } from './LocalRecordings';
import { AdminStatusBanner } from './ServerStatus';

/** App-level notices above the current section: unsaved recordings on this device and admin warnings. */
export default function AppNotices({ state, onOpenMembers }: { state: AppState; onOpenMembers: () => void }) {
  const container = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // The assistant sizes itself from its position; tell it when notices appear or disappear.
    const node = container.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let height = node.offsetHeight;
    const observer = new ResizeObserver(() => { if (node.offsetHeight !== height) { height = node.offsetHeight; window.dispatchEvent(new Event('resize')); } });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <div ref={container} className="app-notices">
    <UnsavedRecordings userId={state.user.id} />
    {state.user.role === 'admin' && <AdminStatusBanner settings={state.settings} onOpen={onOpenMembers} />}
  </div>;
}
