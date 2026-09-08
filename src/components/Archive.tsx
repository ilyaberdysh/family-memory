import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import { BookOpen, Camera, Check, ChevronRight, Clock3, FileAudio, Film, Image, Mic, Pencil, Plus, Search, FileText, ListChecks, Upload, X } from 'lucide-react';
import { FACT_LABELS, type AppState, type HistoryEntry, type Material, type MaterialKind, type Proposal, type UploadedFile } from '../../shared/types';
import { api, json, upload } from '../api';
import { Avatar, formatDate, Modal } from './ui';
import Recorder from './Recorder';
import { FamilyDateField } from './PeopleForms';
import ProposalReview from './ProposalReview';
import { dateInputError, formatFamilyDate } from '../../shared/person-fields';
import { buildArchiveEntries, matchesArchiveEntry, type ArchiveEntry } from '../archive-entries';
import './Archive.css';

const kinds: Record<MaterialKind, { label: string; plural: string; Icon: typeof BookOpen }> = {
  story: { label: 'История', plural: 'Истории', Icon: BookOpen },
  photo: { label: 'Фотография', plural: 'Фото', Icon: Image },
  audio: { label: 'Аудиозапись', plural: 'Аудио', Icon: FileAudio },
  video: { label: 'Видео', plural: 'Видео', Icon: Film },
};
const message = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить действие. Попробуйте ещё раз.';
const fileUrl = (id: string) => `/api/files/${encodeURIComponent(id)}`;
const busyStatus = (status: string) => status === 'queued' || status === 'processing';
function timestamp(seconds: number) { return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
function useUnsaved(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}

interface ArchiveProps { state: AppState; onRefresh: () => Promise<void>; initialPersonId?: string; onPersonOpen: (id: string) => void }

export default function Archive({ state, onRefresh, initialPersonId, onPersonOpen }: ArchiveProps) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<MaterialKind | 'all'>('all');
  const [personId, setPersonId] = useState(initialPersonId || '');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState<MaterialKind | null>(null);
  const [createDirty, setCreateDirty] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => setPersonId(initialPersonId || ''), [initialPersonId]);
  const entries = useMemo(() => buildArchiveEntries(state.materials), [state.materials]);
  const filtered = useMemo(() => entries.filter(entry => matchesArchiveEntry(entry, { query, kind, personId })), [entries, query, kind, personId]);
  const canAdd = state.user.role !== 'viewer';
  const hasFilters = !!query || kind !== 'all' || !!personId;
  const closeCreate = () => {
    if (createBusy) return;
    if (createDirty && !window.confirm('Закрыть без сохранения? Введённый текст и запись будут потеряны.')) return;
    setCreating(null); setCreateDirty(false);
  };
  return <section className="archive-page" aria-label="Семейный архив">
    <header className="archive-heading">
      <div><p className="archive-eyebrow">Наша семья</p><h1>Семейный архив</h1><p className="archive-intro">Истории, фотографии, аудио и видео</p></div>
      {canAdd && <button className="button primary" onClick={() => { setCreateDirty(false); setCreating('story'); }}><Plus size={18} /> Добавить материал</button>}
    </header>
    {notice && <div className="archive-notice" role="status"><Check size={17} />{notice}<button className="icon-button" onClick={() => setNotice('')} aria-label="Закрыть сообщение"><X size={16} /></button></div>}
    <div className="archive-toolbar">
      <div className="archive-kind-tabs" role="group" aria-label="Тип материала">
        <button className={kind === 'all' ? 'selected' : ''} aria-pressed={kind === 'all'} onClick={() => setKind('all')}>Всё <span>{entries.length}</span></button>
        {(Object.entries(kinds) as [MaterialKind, typeof kinds.story][]).map(([key, config]) => <button key={key} className={kind === key ? 'selected' : ''} aria-pressed={kind === key} onClick={() => setKind(key)}><config.Icon size={17} />{config.plural}</button>)}
      </div>
      <div className="archive-filters">
        <label className="archive-search"><Search size={18} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти в архиве" aria-label="Поиск в архиве" /></label>
        <select aria-label="Материалы о человеке" value={personId} onChange={event => setPersonId(event.target.value)}><option value="">Все люди</option>{state.people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select>
      </div>
    </div>
    {filtered.length ? <>
      <p className="archive-results muted">{hasFilters ? `Найдено: ${filtered.length}` : 'Недавно добавленное'}</p>
      <div className="archive-grid">{filtered.map(entry => <MaterialCard key={entry.material.id} entry={entry} state={state} onOpen={() => setSelectedId(entry.material.id)} />)}</div>
    </> : <div className="archive-empty">
      <div className="archive-empty-symbol"><BookOpen size={32} strokeWidth={1.5} /></div>
      <h2>{hasFilters ? 'Пока ничего не нашлось' : 'В архиве пока нет материалов'}</h2>
      <p>{hasFilters ? 'Попробуйте другое имя, тип материала или уберите фильтры.' : canAdd ? 'Добавьте историю, фотографию или запись. Связать их с людьми можно позже.' : 'Здесь появятся материалы, которыми поделится семья.'}</p>
      {hasFilters ? <button className="button secondary" onClick={() => { setQuery(''); setKind('all'); setPersonId(''); }}>Сбросить фильтры</button> : canAdd && <button className="button primary" onClick={() => setCreating('story')}><Plus size={18} /> Добавить первый материал</button>}
      {!hasFilters && canAdd && <button className="archive-text-button" onClick={() => setCreating('audio')}><Mic size={16} /> Или записать разговор</button>}
    </div>}
    <Modal open={creating !== null} onClose={closeCreate} title="Добавить материал" wide>
      {creating && <MaterialForm state={state} initialKind={creating} initialPersonId={personId} onDirtyChange={setCreateDirty} onBusyChange={setCreateBusy} onCancel={closeCreate} onSaved={async material => { setCreating(null); setCreateDirty(false); setNotice('Материал сохранён в семейном архиве.'); setSelectedId(material.id); await onRefresh(); }} />}
    </Modal>
    {selectedId && <MaterialDetail id={selectedId} state={state} onRefresh={onRefresh} onClose={() => setSelectedId(null)} onPersonOpen={onPersonOpen} />}
  </section>;
}

function MaterialCard({ entry, state, onOpen }: { entry: ArchiveEntry; state: AppState; onOpen: () => void }) {
  const { material, attachments } = entry;
  const { Icon, label } = kinds[material.kind];
  const people = state.people.filter(person => entry.personIds.includes(person.id));
  const firstRecording = attachments[0];
  const formatLabel = attachments.length ? entry.kinds.map(kind => kind === 'story' ? 'История' : kinds[kind].plural).join(' · ') : label;
  return <article className={`archive-card archive-card-${material.kind}`}>
    <button className="archive-card-cover" onClick={onOpen} aria-label={`Открыть: ${material.title}`}>
      {(material.kind === 'photo' || material.kind === 'story') && material.file ? <img src={fileUrl(material.file.id)} alt={material.title} loading="lazy" /> : material.kind === 'story' ? <><BookOpen size={22} strokeWidth={1.5} /><p>{material.body || 'Семейная история'}</p></> : <><Icon size={36} strokeWidth={1.5} /><span>{label}</span></>}
    </button>
    <div className="archive-card-content">
      <div className="archive-card-meta"><span><Icon size={13} />{formatLabel}</span><time>{formatFamilyDate(material.occurredAt) || formatDate(material.createdAt)}</time></div>
      <button className="archive-card-title" onClick={onOpen}><h3>{material.title}</h3></button>
      {material.narrator && <p className="archive-card-narrator">Рассказывает {material.narrator}</p>}
      {material.kind === 'audio' && material.file && <audio className="archive-card-player" controls preload="metadata" src={fileUrl(material.file.id)} aria-label={material.title} />}
      {firstRecording?.file && (firstRecording.kind === 'video' ? <video className="archive-card-video-player" controls playsInline preload="metadata" src={fileUrl(firstRecording.file.id)} aria-label={`Запись: ${material.title}`} /> : <audio className="archive-card-player" controls preload="metadata" src={fileUrl(firstRecording.file.id)} aria-label={`Запись: ${material.title}`} />)}
      {attachments.length > 1 && <button className="archive-text-button" onClick={onOpen}>Все записи · {attachments.length}<ChevronRight size={15} /></button>}
      <div className="archive-card-footer"><div className="archive-card-people">{people.slice(0, 3).map(person => <Avatar key={person.id} name={person.name} fileId={person.avatarFileId} size={25} />)}<span>{people.length === 1 ? people[0].name : people.length ? `${people.length} чел.` : 'Без привязки к людям'}</span></div><button className="icon-button" onClick={onOpen} aria-label={`Подробнее: ${material.title}`}><ChevronRight size={17} /></button></div>
    </div>
  </article>;
}

interface MaterialFormProps {
  state: AppState; material?: Material; initialKind?: MaterialKind; initialPersonId?: string;
  onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
  onCancel: () => void; onSaved: (material: Material) => Promise<void>;
}

function MaterialForm({ state, material, initialKind = 'story', initialPersonId, onDirtyChange, onBusyChange, onCancel, onSaved }: MaterialFormProps) {
  const [kind, setKind] = useState<MaterialKind>(material?.kind || initialKind);
  const [title, setTitle] = useState(material?.title || '');
  const [body, setBody] = useState(material?.body || '');
  const [narrator, setNarrator] = useState(material?.narrator || '');
  const [occurredAt, setOccurredAt] = useState(formatFamilyDate(material?.occurredAt || ''));
  const [personIds, setPersonIds] = useState<string[]>(material?.personIds || (initialPersonId ? [initialPersonId] : []));
  const [file, setFile] = useState<File | null>(null);
  const [uploaded, setUploaded] = useState<UploadedFile | null>(null);
  const [audioSource, setAudioSource] = useState<'file' | 'record'>('file');
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const baseline = useRef(JSON.stringify({ title, body, narrator, occurredAt, personIds, kind }));
  const dirty = recording || !!file || baseline.current !== JSON.stringify({ title, body, narrator, occurredAt, personIds, kind });
  useUnsaved(dirty);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(saving), [saving, onBusyChange]);
  function chooseFile(next: File | null) {
    setFile(next); setUploaded(null); setError('');
    if (next && next.size > state.settings.maxUploadMb * 1024 * 1024) setError(`Файл слишком большой. Максимум — ${state.settings.maxUploadMb} МБ.`);
    if (next && !title.trim()) setTitle(next.name.replace(/\.[^.]+$/, ''));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || recording) return;
    setError('');
    if (!title.trim()) { setError('Добавьте название материала.'); return; }
    const dateError = dateInputError(occurredAt); if (dateError) { setError(dateError); return; }
    if (!material && kind !== 'story' && !file) { setError('Выберите файл или запишите разговор.'); return; }
    if (file && file.size > state.settings.maxUploadMb * 1024 * 1024) { setError(`Файл слишком большой. Максимум — ${state.settings.maxUploadMb} МБ.`); return; }
    setSaving(true);
    try {
      let attachment = uploaded;
      if (file && !attachment) { setProgress(0); attachment = await upload(file, setProgress); setUploaded(attachment); setProgress(null); }
      const fields = { title: title.trim(), body, narrator: narrator.trim(), occurredAt: occurredAt.trim(), personIds };
      const saved = material ? await api<Material>(`/api/materials/${material.id}`, json('PATCH', { ...fields, version: material.version })) : await api<Material>('/api/materials', json('POST', { ...fields, kind, fileId: attachment?.id }));
      baseline.current = JSON.stringify({ title, body, narrator, occurredAt, personIds, kind });
      setFile(null); onDirtyChange(false); onBusyChange(false);
      await onSaved(saved);
    } catch (cause) { setError(message(cause)); }
    finally { setSaving(false); setProgress(null); }
  }
  return <form className="archive-form" onSubmit={submit}>
    <fieldset disabled={saving}>
      {!material && <div className="archive-format-choice" role="group" aria-label="Тип нового материала">{(Object.entries(kinds) as [MaterialKind, typeof kinds.story][]).map(([key, value]) => <button key={key} type="button" aria-pressed={key === kind} className={key === kind ? 'selected' : ''} disabled={recording} onClick={() => { if (kind === key) return; if (file && !window.confirm('Сменить тип материала? Выбранный файл будет убран из формы.')) return; setKind(key); setFile(null); setUploaded(null); }}><value.Icon size={20} />{value.label}</button>)}</div>}
      <label className="field">Название<input autoFocus required maxLength={240} value={title} onChange={event => setTitle(event.target.value)} placeholder="Как назовём эту историю?" /></label>
      {!material && kind !== 'story' && <div className="archive-file-area">
        {kind === 'audio' && <div className="archive-source-toggle" role="group" aria-label="Как добавить аудио"><button type="button" className={audioSource === 'file' ? 'selected' : ''} disabled={recording} onClick={() => { if (audioSource === 'file') return; if (audioSource === 'record' && file && !window.confirm('Перейти к загрузке файла? Запись будет убрана из формы.')) return; setAudioSource('file'); chooseFile(null); }}>Загрузить файл</button><button type="button" className={audioSource === 'record' ? 'selected' : ''} disabled={recording} onClick={() => { if (audioSource === 'record') return; if (audioSource === 'file' && file && !window.confirm('Перейти к диктофону? Выбранный файл будет убран из формы.')) return; setAudioSource('record'); chooseFile(null); }}>Записать сейчас</button></div>}
        {kind === 'audio' && audioSource === 'record' ? <Recorder onRecorded={chooseFile} onActiveChange={setRecording} disabled={saving} /> : <label className="archive-upload"><Upload size={25} /><strong>{file ? file.name : 'Выберите файл'}</strong><span>{file ? `${(file.size / 1024 / 1024).toFixed(1)} МБ · нажмите, чтобы заменить` : `${kinds[kind].label} · до ${state.settings.maxUploadMb} МБ`}</span><input type="file" accept={kind === 'photo' ? 'image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/avif' : kind === 'audio' ? 'audio/*,.m4a,.ogg,.webm' : 'video/*'} onChange={event => chooseFile(event.target.files?.[0] || null)} /></label>}
      </div>}
      <label className="field">{kind === 'story' ? 'История' : 'Описание'}<textarea rows={kind === 'story' ? 7 : 3} value={body} onChange={event => setBody(event.target.value)} placeholder={kind === 'story' ? 'Запишите, как всё было. Можно сохранить и совсем короткое воспоминание.' : 'Что происходит в записи или на фотографии? Необязательно.'} /></label>
      {!material && kind === 'story' && <details className="archive-story-attachment"><summary><Camera size={16} />Добавить фотографию к истории</summary><label className="archive-upload"><Upload size={23} /><strong>{file?.name || 'Выберите фотографию'}</strong><span>Необязательно · до {state.settings.maxUploadMb} МБ</span><input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/avif" onChange={event => chooseFile(event.target.files?.[0] || null)} /></label>{file && <button type="button" className="archive-text-button" onClick={() => chooseFile(null)}><X size={14} />Убрать фотографию</button>}</details>}
      <div className="form-grid"><label className="field">Кто рассказывает <span className="muted">необязательно</span><input value={narrator} onChange={event => setNarrator(event.target.value)} maxLength={200} placeholder="Имя рассказчика" /></label><FamilyDateField label="Когда это было" value={occurredAt} onChange={setOccurredAt} /></div>
      {!!state.people.length && <fieldset className="archive-people-picker"><legend>Кто есть в этой истории <span className="muted">необязательно</span></legend><div>{state.people.map(person => <label key={person.id} className={personIds.includes(person.id) ? 'selected' : ''}><input type="checkbox" checked={personIds.includes(person.id)} onChange={event => setPersonIds(previous => event.target.checked ? [...previous, person.id] : previous.filter(id => id !== person.id))} /><Avatar name={person.name} fileId={person.avatarFileId} size={25} /><span>{person.name}</span></label>)}</div></fieldset>}
    </fieldset>
    {error && <div className="archive-error" role="alert">{error}</div>}
    {progress !== null && <div className="archive-upload-progress" role="status"><progress value={progress} max={100} /><span>{progress >= 100 ? 'Файл загружен. Подготавливаем для просмотра и прослушивания…' : `Загружаем файл: ${Math.round(progress)}%`}</span></div>}
    <div className="archive-form-footer"><button type="button" className="button secondary" disabled={saving} onClick={onCancel}>Отмена</button><button type="submit" className="button primary" disabled={saving || recording}>{saving ? progress !== null ? progress >= 100 ? 'Подготавливаем…' : 'Загрузка…' : 'Сохраняем…' : material ? 'Сохранить изменения' : 'Сохранить материал'}</button></div>
  </form>;
}

function MediaDisplay({ material, mediaRef }: { material: Material; mediaRef: RefObject<HTMLMediaElement | null> }) {
  const [error, setError] = useState(false);
  if (!material.file) return null;
  const src = fileUrl(material.file.id);
  return <div className={`archive-media archive-media-${material.kind}`}>
    {(material.kind === 'photo' || material.kind === 'story') ? <img src={src} alt={material.title} onError={() => setError(true)} /> : material.kind === 'audio' ? <><div className="archive-audio-art"><Mic size={40} strokeWidth={1.2} /><span>Аудиозапись</span></div><audio ref={node => { mediaRef.current = node; }} controls preload="metadata" src={src} onError={() => setError(true)} aria-label={material.title} /></> : material.kind === 'video' ? <video ref={node => { mediaRef.current = node; }} controls playsInline preload="metadata" src={src} onError={() => setError(true)} aria-label={material.title} /> : null}
    {error && <p className="archive-error" role="alert">Браузер не смог открыть этот формат. <a href={`${material.file.url}?original=1`} download={material.file.name}>Скачать оригинал</a> и открыть на устройстве.</p>}
  </div>;
}

export function MaterialDetail({ id, state, onRefresh, onClose, onPersonOpen, initialView = 'material' }: { initialView?: 'material' | 'proposals'; id: string; state: AppState; onRefresh: () => Promise<void>; onClose: () => void; onPersonOpen: (id: string) => void }) {
  const [view, setView] = useState<'material' | 'proposals'>(initialView);
  const [material, setMaterial] = useState<Material | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [editDirty, setEditDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [transcriptEditing, setTranscriptEditing] = useState(false);
  const [transcriptText, setTranscriptText] = useState('');
  const [proposalDirty, setProposalDirty] = useState(false);
  const [action, setAction] = useState('');
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const transcriptDirty = transcriptEditing && transcriptText !== (material?.transcript?.text || '');
  const dirty = editDirty || transcriptDirty || proposalDirty;
  useUnsaved(dirty);
  useEffect(() => {
    let cancelled = false;
    api<Material>(`/api/materials/${id}`).then(result => { if (!cancelled) setMaterial(result); }).catch(cause => { if (!cancelled) setError(message(cause)); });
    return () => { cancelled = true; };
  }, [id]);
  const processing = !!material && (busyStatus(material.transcriptionStatus) || busyStatus(material.extractionStatus));
  useEffect(() => {
    if (!processing || editing || transcriptEditing) return;
    let cancelled = false;
    let waiting = false;
    const timer = window.setInterval(async () => {
      if (waiting) return;
      waiting = true;
      try {
        const fresh = await api<Material>(`/api/materials/${id}`);
        if (!cancelled) {
          setMaterial(fresh);
          if (!busyStatus(fresh.transcriptionStatus) && !busyStatus(fresh.extractionStatus)) await onRefresh();
        }
      } catch (cause) { if (!cancelled) setError(message(cause)); }
      finally { waiting = false; }
    }, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [id, processing, editing, transcriptEditing, onRefresh]);
  function close() {
    if (saving || action) return;
    if (dirty && !window.confirm('Закрыть без сохранения изменений?')) return;
    onClose();
  }
  function cancelEdit() {
    if (saving || (editDirty && !window.confirm('Отменить изменения материала?'))) return;
    setEditing(false); setEditDirty(false);
  }
  async function process(type: 'transcribe' | 'extract') {
    if (!material || action) return;
    if (transcriptDirty || proposalDirty) { setError('Сначала сохраните или отмените изменения ниже.'); return; }
    if (type === 'transcribe' && material.transcript && !window.confirm('Заменить существующую расшифровку новой автоматической? Несохранённые предложения потребуется пересмотреть.')) return;
    if (type === 'extract' && material.proposals?.some(item => item.status === 'pending') && !window.confirm('Подготовить предложения заново? Текущий список непринятых предложений будет заменён.')) return;
    setError(''); setAction(type);
    try {
      await api(`/api/materials/${id}/${type}`, json('POST', {}));
      const next = await api<Material>(`/api/materials/${id}`); setMaterial(next);
      setNotice(type === 'transcribe' ? 'Запись отправлена на расшифровку. Можно закрыть материал — работа продолжится.' : 'Ищем сведения в тексте. Дерево изменится только после вашего решения.');
    } catch (cause) { setError(message(cause)); }
    finally { setAction(''); }
  }
  async function saveTranscript() {
    if (!material || action) return;
    setError(''); setAction('transcript');
    try {
      const next = await api<Material>(`/api/materials/${id}/transcript`, json('PATCH', { text: transcriptText, version: material.transcript?.version ?? 0 }));
      setMaterial(next); setTranscriptEditing(false); setProposalDirty(false);
      setNotice('Расшифровка сохранена. Ранее принятые сведения остались в дереве.'); await onRefresh();
    } catch (cause) { setError(message(cause)); }
    finally { setAction(''); }
  }
  function seek(seconds: number) {
    setView('material');
    const player = mediaRef.current;
    if (!player) return;
    player.currentTime = seconds;
    requestAnimationFrame(() => player.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }));
    void player.play().catch(() => setNotice('Нажмите воспроизведение, чтобы прослушать выбранный фрагмент.'));
  }
  const canEdit = material && state.user.role !== 'viewer' && (state.user.role === 'admin' || material.createdBy === state.user.id);
  const canReview = !!canEdit;
  const hasProposalsView = !!material && (material.kind === 'story' || !!material.transcript || !!material.proposals?.length);
  const creator = material && state.users.find(user => user.id === material.createdBy);
  const entry = useMemo(() => material ? buildArchiveEntries([...state.materials.filter(item => item.id !== material.id), material]).find(item => item.material.id === material.id) : undefined, [material, state.materials]);
  const recordings = entry?.attachments || [];
  if (recordingId) return <MaterialDetail key={recordingId} id={recordingId} state={state} onRefresh={onRefresh} onClose={() => setRecordingId(null)} onPersonOpen={id => { onClose(); onPersonOpen(id); }} />;
  return <Modal open onClose={close} title={editing ? 'Редактировать материал' : material?.title || 'Материал'} wide>
    {!material ? <div className="archive-detail-loading">{error ? <div className="archive-error" role="alert">{error}<button className="button secondary" onClick={() => { setError(''); void api<Material>(`/api/materials/${id}`).then(setMaterial).catch(cause => setError(message(cause))); }}>Попробовать снова</button></div> : <p className="muted" role="status">Открываем материал…</p>}</div> : editing ? <MaterialForm state={state} material={material} onDirtyChange={setEditDirty} onBusyChange={setSaving} onCancel={cancelEdit} onSaved={async saved => { setMaterial(saved); setEditing(false); setEditDirty(false); setNotice('Изменения сохранены.'); await onRefresh(); }} /> : <div className="archive-detail">
      <div className="archive-detail-meta"><span className="badge">{kinds[material.kind].label}</span>{material.occurredAt && <span>{formatFamilyDate(material.occurredAt)}</span>}{canEdit && <button className="archive-text-button" onClick={() => { if (transcriptDirty || proposalDirty) { setError('Сначала сохраните или отмените изменения ниже.'); return; } setEditing(true); }}><Pencil size={15} /> Редактировать</button>}</div>
      {notice && <div className="archive-notice" role="status"><Check size={16} />{notice}</div>}
      {error && <div className="archive-error" role="alert">{error}<button className="icon-button" onClick={() => setError('')} aria-label="Закрыть ошибку"><X size={16} /></button></div>}
      {hasProposalsView && <div className="archive-detail-tabs" role="tablist" aria-label="Материал и сведения"><button id="archive-material-tab" role="tab" aria-selected={view === 'material'} aria-controls="archive-material-panel" onClick={() => setView('material')}>Материал</button><button id="archive-proposals-tab" role="tab" aria-selected={view === 'proposals'} aria-controls="archive-proposals-panel" onClick={() => setView('proposals')}>Сведения для дерева{material.proposals?.some(item => item.status === 'pending') ? ` · ${material.proposals.filter(item => item.status === 'pending').length}` : ''}</button></div>}
      <div id="archive-material-panel" role="tabpanel" aria-labelledby={hasProposalsView ? 'archive-material-tab' : undefined} hidden={hasProposalsView && view !== 'material'}>
      <MediaDisplay material={material} mediaRef={mediaRef} />
      {material.narrator && <p className="archive-narrator"><Mic size={17} />Рассказывает <strong>{material.narrator}</strong></p>}
      {!!recordings.length && <section className="archive-conversation-recordings"><h3>{recordings.length === 1 ? 'Запись разговора' : 'Записи разговора'}</h3>{recordings.map((item, index) => <div className="archive-recording" key={item.id}>
        {recordings.length > 1 && <strong>Запись {index + 1}</strong>}
        {item.kind === 'video' ? <video controls playsInline preload="metadata" src={fileUrl(item.file!.id)} aria-label={`Запись ${index + 1}: ${material.title}`} /> : <audio controls preload="metadata" src={fileUrl(item.file!.id)} aria-label={`Запись ${index + 1}: ${material.title}`} />}
        <div className="archive-recording-actions"><a href={`${item.file!.url}?original=1`} download={item.file!.name}>Скачать оригинал</a><button className="archive-text-button" onClick={() => { if (dirty) { setError('Сначала сохраните или отмените изменения в этом материале.'); return; } setRecordingId(item.id); }}>Открыть запись отдельно</button></div>
      </div>)}</section>}
      {material.body && <>{!!recordings.length && <h3 className="archive-conversation-text-heading">Текст разговора</h3>}<div className={`archive-story-text ${material.kind === 'story' ? 'standalone' : ''}`}>{material.body}</div></>}
      {!!material.personIds.length && <section className="archive-detail-section"><h3>В этой истории</h3><div className="archive-person-links">{state.people.filter(person => material.personIds.includes(person.id)).map(person => <button key={person.id} onClick={() => { if (dirty && !window.confirm('Открыть человека без сохранения изменений?')) return; onClose(); onPersonOpen(person.id); }}><Avatar name={person.name} fileId={person.avatarFileId} size={32} />{person.name}<ChevronRight size={16} /></button>)}</div></section>}
      <div className="archive-provenance"><span>Добавил(а) {creator?.name || 'участник семьи'}</span><span>{formatDate(material.createdAt)}</span>{material.file && <a href={`${material.file.url}?original=1`} download={material.file.name}>Скачать оригинал</a>}</div>

      {(material.kind === 'audio' || material.kind === 'video' || material.transcript) && <section className="archive-detail-section">
        <div className="archive-section-heading"><h3>Расшифровка</h3>{material.transcript && <span className="badge">{material.transcript.automatic ? 'Автоматическая · возможны ошибки' : 'Исправлена человеком'}</span>}</div>
        {transcriptEditing ? <div className="archive-transcript-editor"><label className="field">Текст расшифровки<textarea rows={12} value={transcriptText} onChange={event => setTranscriptText(event.target.value)} /></label><p className="muted">При сохранении непринятые предложения будут сброшены. Принятые сведения останутся в дереве.</p><div className="archive-inline-actions"><button className="button secondary" disabled={!!action} onClick={() => { if (!transcriptDirty || window.confirm('Отменить исправления расшифровки?')) setTranscriptEditing(false); }}>Отмена</button><button className="button primary" disabled={!!action || !transcriptText.trim()} onClick={() => void saveTranscript()}>{action === 'transcript' ? 'Сохраняем…' : 'Сохранить расшифровку'}</button></div></div> : material.transcript ? <>
          <div className="archive-transcript">{material.transcript.segments.length ? material.transcript.segments.map((segment, index) => <div key={index}><button className="archive-timestamp" onClick={() => seek(segment.start)} disabled={!material.file || material.kind === 'photo'}>{timestamp(segment.start)}</button><p>{segment.text}</p></div>) : <p>{material.transcript.text}</p>}</div>
          {canEdit && <button className="archive-text-button" disabled={processing} onClick={() => { if (proposalDirty && !window.confirm('Отменить выбор предложений и исправить расшифровку?')) return; setProposalDirty(false); setTranscriptText(material.transcript?.text || ''); setTranscriptEditing(true); }}><Pencil size={14} />Исправить расшифровку</button>}
        </> : <p className="muted">Запись можно слушать и хранить без расшифровки. При желании добавьте текст вручную или создайте его из аудио.</p>}
        {canEdit && !transcriptEditing && <div className="archive-inline-actions"><button className="button secondary" onClick={() => void process('transcribe')} disabled={!state.settings.aiAvailable || !!action || processing}><FileText size={16} />{busyStatus(material.transcriptionStatus) ? material.transcriptionStatus === 'queued' ? 'Ожидает расшифровки…' : 'Расшифровываем…' : material.transcriptionStatus === 'error' ? 'Повторить расшифровку' : material.transcript ? 'Расшифровать заново' : 'Создать расшифровку'}</button>{!material.transcript && <button className="archive-text-button" disabled={processing} onClick={() => { setTranscriptText(''); setTranscriptEditing(true); }}>Добавить текст вручную</button>}</div>}
        {canEdit && <p className="archive-processing-note">{state.settings.aiAvailable ? 'При запуске записи передаются в OpenAI для расшифровки. Текст и оригинал сохраняются в семейном архиве.' : 'Обработка записей ещё не подключена. Можно слушать оригинал и добавлять текст вручную.'}</p>}
      </section>}

      </div>
      {hasProposalsView && <section id="archive-proposals-panel" role="tabpanel" aria-labelledby="archive-proposals-tab" hidden={view !== 'proposals'} className="archive-detail-section archive-review-section">
        <div className="archive-section-heading"><h3>Сведения для дерева</h3><ListChecks size={18} /></div><p className="muted">Проверьте предложения и сохраните решения. Добавленные сведения сможет подтвердить другой участник.</p>
        {!!material.extractionRejectedCount && <p className="archive-processing-result" role="status">Для части предложений ({material.extractionRejectedCount}) не нашлось точного фрагмента рассказа. Остальные можно проверить, а пропущенные сведения — добавить вручную.</p>}
        {canEdit && <details className="archive-extract-options" open={!material.proposals?.length}><summary>{material.proposals?.length ? 'Найти сведения заново' : 'Подготовить предложения'}</summary><button className="button secondary" onClick={() => void process('extract')} disabled={!state.settings.aiAvailable || !!action || processing || !(material.transcript?.text || material.body).trim()}><ListChecks size={16} />{busyStatus(material.extractionStatus) ? material.extractionStatus === 'queued' ? 'Ожидает разбора…' : 'Ищем сведения…' : material.extractionStatus === 'error' ? 'Повторить поиск сведений' : 'Найти сведения в тексте'}</button><p className="archive-processing-note">{state.settings.aiAvailable ? 'При запуске текст и необходимые сведения о людях передаются в OpenAI. Дерево изменится только после принятия предложений.' : 'Обработка записей ещё не подключена. Людей и сведения можно добавлять вручную из дерева.'}</p></details>}
        {!transcriptEditing && !!material.proposals?.some(item => item.status === 'pending') && <ProposalReview key={`${material.id}:${material.transcript?.version ?? 0}:${material.proposals.filter(p => p.status === 'pending').map(p => p.id).join(',')}`} material={material} state={state} canReview={canReview} onDirtyChange={setProposalDirty} onBusyChange={setSaving} onSeek={seek} onSaved={async saved => { setMaterial(saved); setProposalDirty(false); setNotice('Решения сохранены. Принятые сведения добавлены как неподтверждённые.'); await onRefresh(); }} />}
        {material.extractionStatus === 'done' && !material.proposals?.length && <p className="archive-processing-result">В тексте не нашлось достаточно определённых сведений для дерева. История сохранена в архиве.</p>}
        {!!material.proposals?.filter(item => item.status !== 'pending').length && <details className="archive-reviewed-proposals"><summary>Ранее рассмотренные предложения ({material.proposals.filter(item => item.status !== 'pending').length})</summary>{material.proposals.filter(item => item.status !== 'pending').map(item => <div key={item.id}><span className="badge">{item.status === 'accepted' ? 'Принято' : 'Отклонено'}</span><span>{proposalLabel(item)}{item.personName ? ` · ${item.personName}` : ''}{item.value ? `: ${item.value}` : ''}</span></div>)}</details>}
      </section>}
      {material.processingError && <div className="archive-error" role="alert">{material.processingError}</div>}
      <details hidden={hasProposalsView && view !== 'material'} className="archive-history" onToggle={event => { if (event.currentTarget.open && history === null) void api<HistoryEntry[]>(`/api/history/materials/${id}`).then(setHistory).catch(cause => setError(message(cause))); }}><summary><Clock3 size={15} />История изменений материала</summary>{history === null ? <p className="muted">Загружаем историю…</p> : history.length ? history.map(entry => <div key={entry.id}><strong>{state.users.find(user => user.id === entry.actorId)?.name || 'Участник'}</strong><span>{historyLabel(entry.action)}</span><time>{formatDate(entry.createdAt)}</time>{entry.before && <details><summary>Предыдущее содержимое</summary><pre>{readHistory(entry.before)}</pre></details>}</div>) : <p className="muted">Изменений пока нет.</p>}</details>
    </div>}
  </Modal>;
}

function historyLabel(action: string) { return ({ archive_conversation: 'Сохранение разговора', archive_recording: 'Сохранение записи разговора', extract_conversation: 'Подготовка сведений из разговора', create: 'Добавление', edit: 'Изменение', edit_transcript: 'Исправление расшифровки', review_proposals: 'Рассмотрение предложений', update: 'Изменение', transcript: 'Расшифровка', transcribe: 'Расшифровка', extract: 'Разбор сведений', proposals: 'Рассмотрение предложений' } as Record<string, string>)[action] || 'Изменение материала'; }
function readHistory(value: string) { try { const data = JSON.parse(value); return Object.entries(data).filter(([key]) => ['title', 'body', 'narrator', 'occurredAt', 'text'].includes(key)).map(([key, text]) => `${({ title: 'Название', body: 'Текст', narrator: 'Рассказчик', occurredAt: 'Дата', text: 'Расшифровка' } as Record<string, string>)[key]}: ${text}`).join('\n') || 'Изменены связанные люди или состояние обработки'; } catch { return value; } }
function proposalLabel(proposal: Proposal) { return proposal.action === 'create_person' ? 'Добавить человека' : proposal.action === 'create_relation' ? 'Добавить связь' : proposal.action === 'link_material' ? 'Связать с материалом' : proposal.key ? FACT_LABELS[proposal.key] : 'Добавить сведение'; }
