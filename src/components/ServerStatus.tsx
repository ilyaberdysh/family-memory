import { useState } from 'react';
import { HardDrive, X } from 'lucide-react';
import type { AppState, BackupStatus, StorageStatus } from '../../shared/types';
import { formatBytes } from './LocalRecordings';

type Settings = AppState['settings'];

export function relativeTime(value: string | null | undefined) {
  if (!value) return '';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return '';
  const seconds = Math.round((time - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return 'только что';
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return format.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86400 * 30) return format.format(Math.round(seconds / 86400), 'day');
  return new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(time));
}

const clip = (text: string, length = 220) => text.length > length ? `${text.slice(0, length)}…` : text;

/** Problems an administrator should notice without opening settings. */
export function serverProblems(settings: Settings): string[] {
  const problems: string[] = [];
  const { backup, storage } = settings;
  if (storage?.low) problems.push('На сервере заканчивается место — новые загрузки скоро будут недоступны.');
  if (backup) {
    if (backup.lastResult === 'failed') problems.push(`Последняя резервная копия не создана${backup.lastError ? `: ${clip(backup.lastError)}` : '.'}`);
    else if (backup.lastResult === 'degraded') problems.push(`Последняя резервная копия создана не полностью${backup.problemFiles ? ` — файлов с ошибками: ${backup.problemFiles}` : ''}.`);
    if (backup.stale) problems.push(backup.lastSuccessAt ? `Резервная копия давно не обновлялась: последняя успешная — ${relativeTime(backup.lastSuccessAt)}.` : 'Резервных копий пока нет.');
  }
  return problems;
}

const DISMISS_KEY = 'family-memory:server-warning-dismissed';
function readDismissed() { try { return sessionStorage.getItem(DISMISS_KEY) || ''; } catch { return ''; } }

/** Visible to admins only; can be hidden for this browser session until the problem set changes. */
export function AdminStatusBanner({ settings, onOpen }: { settings: Settings; onOpen: () => void }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const problems = serverProblems(settings);
  const signature = problems.join('|');
  if (!problems.length || dismissed === signature) return null;
  function dismiss() { try { sessionStorage.setItem(DISMISS_KEY, signature); } catch { /* hidden until reload */ } setDismissed(signature); }
  return <div className="app-notice is-warning" role="status">
    <HardDrive size={20} aria-hidden="true" />
    <div className="app-notice-text"><strong>Нужно внимание администратора</strong>{problems.map(problem => <p key={problem}>{problem}</p>)}</div>
    <div className="app-notice-actions"><button type="button" className="button secondary" onClick={onOpen}>Подробнее</button><button type="button" className="icon-button" aria-label="Скрыть предупреждение до следующего входа" onClick={dismiss}><X size={18} /></button></div>
  </div>;
}

function backupLines(backup: BackupStatus) {
  const lines: { label: string; value: string; problem?: boolean }[] = [];
  lines.push({ label: 'Последняя успешная', value: backup.lastSuccessAt ? `${relativeTime(backup.lastSuccessAt)}` : 'ещё не было', problem: backup.stale });
  lines.push({ label: 'Автоматически', value: backup.automatic ? backup.intervalHours ? `да, каждые ${backup.intervalHours} ч` : 'включено' : 'выключено' });
  if (backup.running) lines.push({ label: 'Сейчас', value: 'создаётся резервная копия…' });
  if (backup.lastResult === 'failed') lines.push({ label: 'Последняя попытка', value: `${relativeTime(backup.lastAttemptAt)} — не удалась${backup.lastError ? `: ${clip(backup.lastError)}` : ''}`, problem: true });
  else if (backup.lastResult === 'degraded') lines.push({ label: 'Последняя попытка', value: `${relativeTime(backup.lastAttemptAt)} — частично${backup.problemFiles ? `, файлов с ошибками: ${backup.problemFiles}` : ''}`, problem: true });
  return lines;
}
function storageLine(storage: StorageStatus) {
  if (storage.freeBytes === null) return { label: 'Место на сервере', value: storage.low ? 'заканчивается' : 'нет сведений', problem: storage.low };
  return { label: 'Свободно на сервере', value: `${formatBytes(storage.freeBytes)}${storage.totalBytes ? ` из ${formatBytes(storage.totalBytes)}` : ''}${storage.low ? ' — заканчивается' : ''}`, problem: storage.low };
}

/** Calm operational summary for the Members dialog (admins only). */
export function ServerStatusSummary({ settings }: { settings: Settings }) {
  if (!('backup' in settings) && !('storage' in settings)) return null;
  const { backup, storage } = settings;
  const lines = [...(backup ? backupLines(backup) : [{ label: 'Резервные копии', value: 'сведений пока нет' }]), ...(storage ? [storageLine(storage)] : [])];
  const problems = serverProblems(settings);
  return <section className="members-section members-server" aria-labelledby="members-server-title">
    <div className="members-section-heading"><h3 id="members-server-title">Резервные копии и место</h3>{problems.length ? <span className="members-server-flag">Нужно внимание</span> : backup ? <span>Всё в порядке</span> : null}</div>
    <dl>{lines.map(line => <div key={line.label} className={line.problem ? 'is-problem' : ''}><dt>{line.label}</dt><dd>{line.value}</dd></div>)}</dl>
    {storage?.low && <p className="members-server-note">На сервере заканчивается место — новые загрузки скоро будут недоступны. Освободите место или увеличьте диск.</p>}
  </section>;
}
