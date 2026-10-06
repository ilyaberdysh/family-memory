import { useEffect, useRef, useState } from 'react';
import { Download, Mic, Play, Share2, Trash2, X } from 'lucide-react';
import { deleteRecording, isRecordingElsewhere, listRecordings, loadRecording, subscribeRecordings, ACTIVE_ELSEWHERE_MS, type RecordingSession } from '../recording-store';
import { Modal } from './ui';

export function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const rest = (seconds % 60).toString().padStart(2, '0');
  return hours ? `${hours}:${minutes}:${rest}` : `${minutes}:${rest}`;
}
export function formatBytes(bytes: number) {
  const number = (value: number) => new Intl.NumberFormat('ru', { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value);
  if (bytes >= 1024 ** 3) return `${number(bytes / 1024 ** 3)} ГБ`;
  if (bytes >= 1024 * 1024) return `${number(bytes / 1024 / 1024)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}
export function recordingTitle(session: RecordingSession) {
  const date = new Date(session.startedAt);
  return Number.isNaN(date.getTime()) ? 'Запись' : `Запись от ${new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(date)}`;
}
export function recordingDetails(session: RecordingSession) {
  return [formatDuration(session.durationSeconds), formatBytes(session.size), session.context].filter(Boolean).join(' · ');
}

const canShareFile = (file: File) => { try { return typeof navigator.share === 'function' && !!navigator.canShare?.({ files: [file] }); } catch { return false; } };

/** "Save a copy" for a recording that so far exists only on this device. */
export function SaveCopyActions({ file, url, className = 'archive-recorder-copy', label = 'Сохранить копию на устройство' }: { file: File; url: string; className?: string; label?: string }) {
  const [shareError, setShareError] = useState('');
  async function share() {
    setShareError('');
    try { await navigator.share({ files: [file], title: file.name }); }
    catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setShareError('Не удалось открыть меню «Поделиться». Воспользуйтесь кнопкой сохранения.'); }
  }
  return <div className={className}>
    <a href={url} download={file.name}><Download size={15} aria-hidden="true" />{label}</a>
    {canShareFile(file) && <button type="button" onClick={() => void share()}><Share2 size={15} aria-hidden="true" />Отправить в другое приложение</button>}
    {shareError && <p role="alert">{shareError}</p>}
  </div>;
}

/** Keeps a list of this user's unsaved recordings in sync with IndexedDB and other tabs. */
export function useUnsavedRecordings(userId: string | undefined) {
  const [items, setItems] = useState<RecordingSession[]>([]);
  const [available, setAvailable] = useState(true);
  useEffect(() => {
    let cancelled = false; let recheck = 0; let running = false; let again = false;
    async function refresh() {
      if (running) { again = true; return; }
      running = true;
      try {
        const all = await listRecordings(userId);
        if (cancelled) return;
        setAvailable(true);
        setItems(all.filter(item => !isRecordingElsewhere(item)));
        // A session that looks live elsewhere becomes "unsaved" once it stops being written to.
        window.clearTimeout(recheck);
        if (all.some(isRecordingElsewhere)) recheck = window.setTimeout(() => void refresh(), ACTIVE_ELSEWHERE_MS + 1000);
      } catch { if (!cancelled) { setAvailable(false); setItems([]); } }
      finally { running = false; if (again && !cancelled) { again = false; void refresh(); } }
    }
    void refresh();
    const unsubscribe = subscribeRecordings(() => void refresh());
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { cancelled = true; window.clearTimeout(recheck); unsubscribe(); document.removeEventListener('visibilitychange', visible); };
  }, [userId]);
  return { items, available };
}

/** App-level reminder that a recording never reached the archive and exists only on this device. */
export function UnsavedRecordings({ userId }: { userId: string }) {
  const { items } = useUnsavedRecordings(userId);
  const [open, setOpen] = useState(false);
  const [hiddenFor, setHiddenFor] = useState('');
  const signature = items.map(item => item.id).join(',');
  useEffect(() => { if (!items.length) setOpen(false); }, [items.length]);
  if (!items.length) return null;
  return <>
    {hiddenFor !== signature && <div className="app-notice is-compact-mobile" role="status">
      <Mic size={20} aria-hidden="true" />
      <div className="app-notice-text"><strong>{items.length === 1 ? 'На этом устройстве есть несохранённая запись' : `На этом устройстве есть несохранённые записи: ${items.length}`}</strong><p>{items.length === 1 ? 'Она не попала в семейный архив.' : 'Они не попали в семейный архив.'} Прослушайте и сохраните копию, чтобы не потерять.</p></div>
      <div className="app-notice-actions"><button type="button" className="button secondary" onClick={() => setOpen(true)}>Посмотреть</button><button type="button" className="icon-button" aria-label="Скрыть напоминание до следующей записи" onClick={() => setHiddenFor(signature)}><X size={18} /></button></div>
    </div>}
    {open && <Modal open onClose={() => setOpen(false)} title="Несохранённые записи">
      <div className="recordings-panel">
        <p className="recordings-intro">Эти записи есть только на этом устройстве — в семейный архив они не попали. Чтобы отправить запись, откройте диктофон в «Архиве» или в «Ассистенте» и нажмите «Использовать найденную запись».</p>
        <div className="recordings-list">{items.map(item => <RecoveredRecording key={item.id} session={item} />)}</div>
      </div>
    </Modal>}
  </>;
}

function RecoveredRecording({ session }: { session: RecordingSession }) {
  const [loaded, setLoaded] = useState<{ file: File; url: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const link = useRef<HTMLAnchorElement | null>(null);
  const pendingDownload = useRef(false);
  useEffect(() => () => { if (loaded) URL.revokeObjectURL(loaded.url); }, [loaded]);
  useEffect(() => { if (loaded && pendingDownload.current) { pendingDownload.current = false; link.current?.click(); } }, [loaded]);
  async function load(reason: 'listen' | 'save') {
    if (loaded) return loaded;
    setBusy(reason); setError('');
    try { const file = await loadRecording(session.id); const value = { file, url: URL.createObjectURL(file) }; setLoaded(value); return value; }
    catch { setError('Не удалось открыть запись на этом устройстве. Попробуйте ещё раз или обновите страницу.'); return null; }
    finally { setBusy(''); }
  }
  async function listen() { if (await load('listen')) setPlaying(true); }
  async function save() {
    if (loaded) { link.current?.click(); return; }
    pendingDownload.current = true;
    if (!await load('save')) pendingDownload.current = false;
  }
  async function remove() {
    if (!window.confirm(`Удалить «${recordingTitle(session)}» с этого устройства?\n\nЭто единственная копия: в семейный архив запись не попала, и восстановить её будет нельзя.`)) return;
    setBusy('delete'); setError('');
    try { await deleteRecording(session.id); }
    catch { setError('Не удалось удалить запись. Попробуйте ещё раз.'); setBusy(''); }
  }
  return <article className="recording-item">
    <h3>{recordingTitle(session)}</h3>
    <p className="recording-item-meta">{recordingDetails(session)}</p>
    {(!session.finished || session.partial) && <p className="recording-item-warning">{session.partial ? 'Копия на устройстве может быть неполной — прослушайте её.' : 'Запись прервалась: сохранилась часть до остановки.'}</p>}
    {loaded && playing && <audio controls autoPlay src={loaded.url} aria-label={`Прослушать: ${recordingTitle(session)}`} />}
    <div className="recording-item-actions">
      {!playing && <button type="button" className="button secondary" disabled={!!busy} onClick={() => void listen()}><Play size={16} aria-hidden="true" />{busy === 'listen' ? 'Открываем…' : 'Прослушать'}</button>}
      <button type="button" className="button secondary" disabled={!!busy} onClick={() => void save()}><Download size={16} aria-hidden="true" />{busy === 'save' ? 'Готовим файл…' : 'Сохранить на устройство'}</button>
      {loaded && canShareFile(loaded.file) && <button type="button" className="button secondary" disabled={!!busy} onClick={() => void navigator.share({ files: [loaded.file], title: loaded.file.name }).catch(() => {})}><Share2 size={16} aria-hidden="true" />Отправить в другое приложение</button>}
      <button type="button" className="button secondary recording-delete" disabled={!!busy} onClick={() => void remove()}><Trash2 size={16} aria-hidden="true" />{busy === 'delete' ? 'Удаляем…' : 'Удалить'}</button>
    </div>
    {loaded && <a ref={link} className="recording-item-hidden-link" href={loaded.url} download={loaded.file.name} tabIndex={-1} aria-hidden="true">{loaded.file.name}</a>}
    {error && <p className="recording-item-error" role="alert">{error}</p>}
  </article>;
}
