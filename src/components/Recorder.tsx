import { useEffect, useRef, useState } from 'react';
import { Mic, Square, Play, Pause, RotateCcw } from 'lucide-react';

interface Props {
  onRecorded: (file: File | null) => void;
  onActiveChange: (active: boolean) => void;
  disabled?: boolean;
}

export default function Recorder({ onRecorded, onActiveChange, disabled }: Props) {
  const [status, setStatus] = useState<'idle' | 'requesting' | 'recording' | 'paused' | 'done'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  const requestId = useRef(0);
  const onRecordedRef = useRef(onRecorded);
  const onActiveRef = useRef(onActiveChange);
  onRecordedRef.current = onRecorded;
  onActiveRef.current = onActiveChange;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestId.current += 1;
      if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
      stream.current?.getTracks().forEach(track => track.stop());
      onActiveRef.current(false);
    };
  }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => {
    if (status !== 'recording') return;
    const timer = window.setInterval(() => setSeconds(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [status]);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden && recorder.current?.state === 'recording') {
        setError('Страница скрыта. Браузер может прервать запись — вернитесь и проверьте звук перед сохранением.');
      }
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
      const chunks: Blob[] = [];
      next.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      next.onerror = () => {
        if (mounted.current) setError('Запись прервалась. Прослушайте сохранившуюся часть перед добавлением в архив.');
        if (next.state !== 'inactive') next.stop();
      };
      media.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
        if (next.state !== 'inactive') {
          if (mounted.current) setError('Микрофон отключился. Сохранена доступная часть записи — проверьте её перед добавлением.');
          next.stop();
        }
      }));
      next.onstop = () => {
        media?.getTracks().forEach(track => track.stop());
        stream.current = null;
        if (!mounted.current || currentRequest !== requestId.current) return;
        onActiveRef.current(false);
        const type = next.mimeType || chunks[0]?.type || 'audio/webm';
        const blob = new Blob(chunks, { type });
        if (!blob.size) {
          setError('В записи нет звука. Попробуйте ещё раз или загрузите готовый файл.');
          setStatus('idle');
          return;
        }
        const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const file = new File([blob], `Запись ${new Date().toISOString().slice(0, 10)}.${extension}`, { type });
        setPreview(URL.createObjectURL(blob));
        onRecordedRef.current(file);
        setStatus('done');
      };
      setPreview('');
      onRecordedRef.current(null);
      setSeconds(0);
      next.start(1000);
      setStatus('recording');
    } catch (cause) {
      media?.getTracks().forEach(track => track.stop());
      if (!mounted.current || currentRequest !== requestId.current) return;
      const denied = cause instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(cause.name);
      setError(denied ? 'Нет доступа к микрофону. Разрешите его в настройках браузера или загрузите готовую запись.' : 'Не удалось включить микрофон. Проверьте его подключение и попробуйте ещё раз.');
      setStatus('idle');
      onActiveRef.current(false);
    }
  }

  function stop() {
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
  }
  function togglePause() {
    if (recorder.current?.state === 'recording') {
      recorder.current.pause(); setStatus('paused');
    } else if (recorder.current?.state === 'paused') {
      recorder.current.resume(); setStatus('recording');
    }
  }

  return <div className="archive-recorder">
    <div className="archive-recorder-heading"><span className={`archive-recorder-icon ${status === 'recording' ? 'is-recording' : ''}`}><Mic size={23} /></span><div><strong>Записать разговор</strong><p className="muted">Оставьте эту страницу открытой во время записи.</p></div></div>
    {(status === 'recording' || status === 'paused') ? <div className="archive-recorder-controls">
      <output className="archive-recorder-time" aria-label="Продолжительность записи">{Math.floor(seconds / 60).toString().padStart(2, '0')}:{(seconds % 60).toString().padStart(2, '0')}</output>
      <span className="muted" role="status">{status === 'paused' ? 'На паузе' : 'Идёт запись'}</span>
      <button type="button" className="icon-button" onClick={togglePause} aria-label={status === 'paused' ? 'Продолжить запись' : 'Приостановить запись'}>{status === 'paused' ? <Play size={18} /> : <Pause size={18} />}</button>
      <button type="button" className="button secondary" onClick={stop}><Square size={15} fill="currentColor" /> Остановить</button>
    </div> : <>
      {preview && <audio controls src={preview} aria-label="Прослушать записанный разговор" />}
      <button type="button" className="button secondary" onClick={() => { if (!preview || window.confirm('Удалить эту запись и записать заново?')) void start(); }} disabled={disabled || status === 'requesting'}>
        {preview ? <RotateCcw size={17} /> : <Mic size={17} />}{status === 'requesting' ? 'Ждём разрешение на микрофон…' : preview ? 'Записать заново' : 'Начать запись'}
      </button>
    </>}
    {error && <p className="archive-error" role="alert">{error}</p>}
    {status === 'done' && <p className="muted">Запись пока на этом устройстве. Нажмите «Сохранить материал», чтобы добавить её в архив.</p>}
  </div>;
}
