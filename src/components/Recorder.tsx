import { useEffect, useRef, useState } from 'react';
import { Mic, Square, Play, Pause, RotateCcw, History } from 'lucide-react';
import { forgetRecording, holdRecording, loadRecording, recordingFileName, releaseRecording, rememberRecording, startRecordingBackup, type RecordingBackup, type RecordingSession } from '../recording-store';
import { SaveCopyActions, formatDuration, recordingDetails, recordingTitle, useUnsavedRecordings } from './LocalRecordings';

interface Props {
  onRecorded: (file: File | null) => void;
  onActiveChange: (active: boolean) => void;
  disabled?: boolean;
  /** Scopes the device copy so relatives sharing a phone only see their own unsaved recordings. */
  userId?: string;
  /** Where the recording was made, shown if it has to be recovered later. */
  context?: string;
}

const BACKUP_UNAVAILABLE = 'Резервная копия на этом устройстве недоступна — запись хранится только на открытой странице. Не закрывайте её, пока запись не сохранена.';
const MUTED = 'Микрофон перестал передавать звук — не блокируйте телефон и не переключайтесь в другие приложения.';

export default function Recorder({ onRecorded, onActiveChange, disabled, userId, context = 'Запись' }: Props) {
  const [status, setStatus] = useState<'idle' | 'requesting' | 'recording' | 'paused' | 'done'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const [backupNote, setBackupNote] = useState('');
  const [muted, setMuted] = useState(false);
  const [gap, setGap] = useState(false);
  const [current, setCurrent] = useState<{ file: File; url: string } | null>(null);
  const [opening, setOpening] = useState('');
  const { items: found } = useUnsavedRecordings(userId);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const sessionId = useRef<string | null>(null);
  const backupRef = useRef<RecordingBackup | null>(null);
  const clock = useRef<{ total: number; since: number | null }>({ total: 0, since: null });
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const wantWakeLock = useRef(false);
  const acquiring = useRef(false);
  const mounted = useRef(true);
  const requestId = useRef(0);
  const onRecordedRef = useRef(onRecorded);
  const onActiveRef = useRef(onActiveChange);
  onRecordedRef.current = onRecorded;
  onActiveRef.current = onActiveChange;

  const elapsed = () => (clock.current.total + (clock.current.since !== null ? Date.now() - clock.current.since : 0)) / 1000;
  const pauseClock = () => { if (clock.current.since !== null) { clock.current.total += Date.now() - clock.current.since; clock.current.since = null; } };

  async function acquireWakeLock() {
    const lock = navigator.wakeLock;
    if (!wantWakeLock.current || wakeLock.current || acquiring.current || !lock?.request || document.visibilityState !== 'visible') return;
    acquiring.current = true;
    try {
      const sentinel = await lock.request('screen');
      if (!wantWakeLock.current) { void sentinel.release().catch(() => {}); return; }
      wakeLock.current = sentinel;
      sentinel.addEventListener('release', () => { if (wakeLock.current === sentinel) wakeLock.current = null; });
    } catch { /* unsupported, denied or battery saver: the on-screen hint still applies */ }
    finally { acquiring.current = false; }
  }
  function releaseWakeLock() {
    wantWakeLock.current = false;
    const sentinel = wakeLock.current; wakeLock.current = null;
    if (sentinel) void sentinel.release().catch(() => {});
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestId.current += 1;
      releaseWakeLock();
      // Stopping finishes the device copy (see onstop); a finished take stays on the device as "unsaved"
      // until the parent confirms it was saved on the server.
      if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
      else if (sessionId.current) releaseRecording(sessionId.current);
      stream.current?.getTracks().forEach(track => track.stop());
      onActiveRef.current(false);
    };
  }, []);
  useEffect(() => () => { if (current) URL.revokeObjectURL(current.url); }, [current]);
  useEffect(() => {
    if (status !== 'recording') return;
    const tick = () => setSeconds(Math.floor(elapsed()));
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [status]);
  useEffect(() => {
    if (status !== 'paused') return;
    const timer = window.setInterval(() => backupRef.current?.touch(elapsed()), 4000);
    return () => window.clearInterval(timer);
  }, [status]);
  useEffect(() => {
    const visibility = () => {
      const active = recorder.current;
      if (document.hidden) {
        if (active?.state === 'recording') {
          // Push the last second to the device copy before the browser may freeze the page.
          try { active.requestData(); } catch { /* not supported while paused or stopping */ }
          setError('Страница скрыта. Браузер может прервать запись — вернитесь и проверьте звук перед сохранением.');
        }
      } else void acquireWakeLock();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);

  async function start() {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError('Диктофон недоступен. Откройте страницу по HTTPS или загрузите запись из диктофона телефона.');
      return;
    }
    const previous = current;
    const currentRequest = ++requestId.current;
    setStatus('requesting');
    onActiveRef.current(true);
    let media: MediaStream | null = null;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current || currentRequest !== requestId.current) {
        media.getTracks().forEach(track => track.stop());
        return;
      }
      stream.current = media;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
      const next = mimeType ? new MediaRecorder(media, { mimeType }) : new MediaRecorder(media);
      recorder.current = next;
      // The person confirmed replacing the previous take; it was never saved, so remove it from the device too.
      if (previous) void forgetRecording(previous.file);
      const backup: RecordingBackup = startRecordingBackup({ mimeType: next.mimeType || mimeType || '', userId, context }, () => { if (mounted.current) setBackupNote(BACKUP_UNAVAILABLE); });
      sessionId.current = backup.id; backupRef.current = backup;
      const startedAt = new Date();
      const chunks: Blob[] = [];
      next.ondataavailable = event => { if (event.data.size) { chunks.push(event.data); backup.append(event.data, elapsed()); } };
      next.onerror = () => {
        if (mounted.current) setError('Запись прервалась. Прослушайте сохранившуюся часть перед добавлением в архив.');
        if (next.state !== 'inactive') next.stop();
      };
      media.getAudioTracks().forEach(track => {
        track.addEventListener('ended', () => {
          if (next.state !== 'inactive') {
            if (mounted.current) setError('Микрофон отключился. Сохранена доступная часть записи — проверьте её перед добавлением.');
            next.stop();
          }
        });
        track.addEventListener('mute', () => { if (next.state !== 'inactive' && mounted.current) { setMuted(true); setGap(true); } });
        track.addEventListener('unmute', () => { if (mounted.current) setMuted(false); });
      });
      next.onstop = () => {
        media?.getTracks().forEach(track => track.stop());
        if (stream.current === media) stream.current = null;
        pauseClock();
        const duration = elapsed();
        const stale = !mounted.current || currentRequest !== requestId.current;
        if (!stale) { releaseWakeLock(); setMuted(false); }
        const type = next.mimeType || chunks[0]?.type || 'audio/webm';
        const blob = new Blob(chunks, { type });
        if (!blob.size) {
          void backup.finish(duration).then(() => releaseRecording(backup.id));
          if (stale) return;
          sessionId.current = null;
          onActiveRef.current(false);
          setError('В записи нет звука. Попробуйте ещё раз или загрузите готовый файл.');
          setStatus('idle');
          return;
        }
        const file = new File([blob], recordingFileName(type, startedAt), { type });
        rememberRecording(file, backup.id);
        // Even when this view is gone, the copy on the device is complete and will be offered for recovery.
        void backup.finish(duration).then(complete => {
          if (stale) releaseRecording(backup.id);
          else if (!complete && mounted.current) setBackupNote(BACKUP_UNAVAILABLE);
        });
        if (stale) return;
        onActiveRef.current(false);
        setSeconds(Math.floor(duration));
        setCurrent({ file, url: URL.createObjectURL(blob) });
        onRecordedRef.current(file);
        setStatus('done');
      };
      setCurrent(null); setBackupNote(''); setMuted(false); setGap(false);
      onRecordedRef.current(null);
      clock.current = { total: 0, since: Date.now() };
      setSeconds(0);
      next.start(1000);
      setStatus('recording');
      wantWakeLock.current = true;
      void acquireWakeLock();
    } catch (cause) {
      media?.getTracks().forEach(track => track.stop());
      if (stream.current === media) stream.current = null;
      if (!mounted.current || currentRequest !== requestId.current) return;
      const denied = cause instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(cause.name);
      setError(denied ? 'Нет доступа к микрофону. Разрешите его в настройках браузера или загрузите готовую запись.' : 'Не удалось включить микрофон. Проверьте его подключение и попробуйте ещё раз.');
      setStatus(previous ? 'done' : 'idle');
      onActiveRef.current(false);
    }
  }

  function stop() {
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
  }
  function togglePause() {
    const active = recorder.current;
    if (active?.state === 'recording') {
      try { active.requestData(); } catch { /* the pause still works */ }
      active.pause(); pauseClock(); setSeconds(Math.floor(elapsed())); setStatus('paused');
    } else if (active?.state === 'paused') {
      active.resume(); clock.current.since = Date.now(); setStatus('recording');
    }
  }
  async function takeFound(item: RecordingSession) {
    setError(''); setOpening(item.id);
    try {
      const file = await loadRecording(item.id);
      if (!mounted.current) return;
      holdRecording(item.id);
      sessionId.current = item.id;
      setCurrent({ file, url: URL.createObjectURL(file) });
      setSeconds(Math.round(item.durationSeconds)); setGap(false); setBackupNote('');
      onRecordedRef.current(file);
      setStatus('done');
    } catch {
      if (mounted.current) setError('Не удалось открыть найденную запись. Попробуйте ещё раз или сохраните её на устройство из списка несохранённых записей.');
    } finally { if (mounted.current) setOpening(''); }
  }

  const live = status === 'recording' || status === 'paused';
  return <div className="archive-recorder">
    <div className="archive-recorder-heading"><span className={`archive-recorder-icon ${status === 'recording' ? 'is-recording' : ''}`}><Mic size={23} /></span><div><strong>Записать разговор</strong><p className="muted">Не блокируйте экран во время записи и оставьте эту страницу открытой.</p></div></div>
    {live ? <div className="archive-recorder-controls">
      <output className="archive-recorder-time" aria-label="Продолжительность записи">{formatDuration(seconds)}</output>
      <span className="muted" role="status">{status === 'paused' ? 'На паузе' : 'Идёт запись'}</span>
      <button type="button" className="icon-button" onClick={togglePause} aria-label={status === 'paused' ? 'Продолжить запись' : 'Приостановить запись'}>{status === 'paused' ? <Play size={18} /> : <Pause size={18} />}</button>
      <button type="button" className="button secondary" onClick={stop}><Square size={15} fill="currentColor" /> Остановить</button>
    </div> : <>
      {current && <audio controls src={current.url} aria-label="Прослушать записанный разговор" />}
      {current && <SaveCopyActions file={current.file} url={current.url} />}
      <button type="button" className="button secondary" onClick={() => { if (!current || window.confirm('Удалить эту запись и записать заново?\n\nОна ещё не сохранена в архиве и будет удалена и с этого устройства.')) void start(); }} disabled={disabled || status === 'requesting' || !!opening}>
        {current ? <RotateCcw size={17} /> : <Mic size={17} />}{status === 'requesting' ? 'Ждём разрешение на микрофон…' : current ? 'Записать заново' : 'Начать запись'}
      </button>
      {status === 'idle' && !current && found.length > 0 && <div className="archive-recorder-found" role="group" aria-label="Несохранённые записи на этом устройстве">
        <p><History size={16} aria-hidden="true" /><span><strong>{found.length === 1 ? 'На этом устройстве есть несохранённая запись.' : `На этом устройстве есть несохранённые записи: ${found.length}.`}</strong> Её можно отправить вместо новой.</span></p>
        {found.slice(0, 3).map(item => <div className="archive-recorder-found-row" key={item.id}><span>{recordingTitle(item)}<small>{recordingDetails(item)}</small></span><button type="button" className="button secondary" disabled={disabled || !!opening} onClick={() => void takeFound(item)}>{opening === item.id ? 'Открываем…' : 'Использовать найденную запись'}</button></div>)}
      </div>}
    </>}
    {muted && live && <p className="archive-recorder-warning" role="alert">{MUTED}</p>}
    {gap && !(muted && live) && <p className="archive-recorder-warning">Во время записи был перерыв в звуке. Прослушайте запись перед сохранением.</p>}
    {error && <p className="archive-error" role="alert">{error}</p>}
    {backupNote && <p className="archive-recorder-backup" role="status">{backupNote}</p>}
    {status === 'done' && <p className="muted">Запись пока на этом устройстве. Нажмите «Сохранить материал», чтобы добавить её в архив.</p>}
  </div>;
}
