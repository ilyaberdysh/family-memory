import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from '@assistant-ui/react';
import { Archive, ArrowDown, ArrowUp, Check, Download, FileAudio, FileText, Info, List, ListChecks, LoaderCircle, MessageSquare, Mic, Pencil, Plus, RotateCcw, Upload, X } from 'lucide-react';
import type { AppState, Conversation, ConversationMessage, ConversationSummary, UploadedFile } from '../../shared/types';
import { api, json, upload } from '../api';
import { formatDate } from './ui';
import { MaterialDetail } from './Archive';
import Recorder from './Recorder';
import './Assistant.css';

interface AssistantProps {
  state: AppState;
  onRefresh: () => Promise<void>;
  onPersonOpen: (id: string) => void;
  onActivityChange?: (blocked: boolean) => void;
}

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : 'Не удалось выполнить действие. Попробуйте ещё раз.';
const isWorking = (conversation: Conversation | ConversationSummary) => ['responding', 'transcribing', 'preparing'].includes(conversation.status);
const statusLabel = (status: Conversation['status']) => ({ idle: 'Сохранено', responding: 'Ассистент отвечает…', transcribing: 'Расшифровываем запись…', preparing: 'Готовим сведения…', error: 'Нужна проверка' })[status];
const route = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;
const asSummary = ({ messages, ...conversation }: Conversation): ConversationSummary => ({ ...conversation, messageCount: messages.length });
const byUpdated = (a: ConversationSummary, b: ConversationSummary) => b.updatedAt.localeCompare(a.updatedAt);

export default function Assistant({ state, onRefresh, onPersonOpen, onActivityChange }: AssistantProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const selection = useRef(0);
  const sectionRef = useRef<HTMLElement | null>(null);
  const activityCallback = useRef(onActivityChange);
  activityCallback.current = onActivityChange;
  const canWrite = state.user.role !== 'viewer';

  useEffect(() => {
    const viewport = window.visualViewport;
    const section = sectionRef.current;
    if (!section) return;
    let frame = 0;
    const update = () => {
      if (viewport && viewport.scale !== 1) return;
      const mobile = window.matchMedia('(max-width: 759px)').matches;
      const keyboardOpen = mobile && !!viewport && window.innerHeight - viewport.height > 120;
      const workspace = section.closest('.main-workspace');
      const bottomInset = mobile && !keyboardOpen && workspace ? parseFloat(getComputedStyle(workspace).paddingBottom) || 0 : 0;
      const available = Math.max(0, (viewport?.height ?? window.innerHeight) + (viewport?.offsetTop ?? 0) - section.getBoundingClientRect().top - bottomInset);
      section.style.setProperty('--assistant-visible-height', `${available}px`);
      section.toggleAttribute('data-compact-height', available < 480);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    update();
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(frame); viewport?.removeEventListener('resize', schedule); viewport?.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api<ConversationSummary[]>('/api/conversations').then(async items => {
      if (cancelled) return;
      setConversations(items.sort(byUpdated));
      if (items[0]) {
        const first = await api<Conversation>(route(items[0].id));
        if (!cancelled) setConversation(first);
      }
    }).catch(cause => { if (!cancelled) setError(errorText(cause)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; selection.current += 1; activityCallback.current?.(false); };
  }, []);

  const activity = useCallback((value: boolean) => { setBlocked(value); activityCallback.current?.(value); }, []);
  const receive = useCallback((value: Conversation) => {
    setConversation(current => current?.id === value.id ? value : current);
    setConversations(current => [asSummary(value), ...current.filter(item => item.id !== value.id)].sort(byUpdated));
  }, []);

  function canSwitch() {
    return !blocked || window.confirm('Перейти к другому разговору? Неотправленный текст, запись или исправления будут потеряны.');
  }
  async function open(id: string) {
    if (conversation?.id === id) { setListOpen(false); return; }
    if (opening || !canSwitch()) return;
    const request = ++selection.current;
    setOpening(true); setError('');
    try {
      const next = await api<Conversation>(route(id));
      if (selection.current !== request) return;
      setConversation(next); activity(false); setListOpen(false);
    } catch (cause) { setError(errorText(cause)); }
    finally { if (selection.current === request) setOpening(false); }
  }
  async function create() {
    if (opening || !canWrite || !canSwitch()) return;
    const request = ++selection.current;
    setOpening(true); setError('');
    try {
      const next = await api<Conversation>('/api/conversations', json('POST', {}));
      if (selection.current !== request) return;
      setConversation(next); setConversations(current => [asSummary(next), ...current]);
      activity(false); setListOpen(false);
    } catch (cause) { setError(errorText(cause)); }
    finally { if (selection.current === request) setOpening(false); }
  }
  async function reloadList() {
    setError(''); setLoading(true);
    try { setConversations((await api<ConversationSummary[]>('/api/conversations')).sort(byUpdated)); }
    catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  }

  return <section ref={sectionRef} className="family-assistant" aria-label="Ассистент">
    <header className="assistant-page-header"><div><p className="assistant-breadcrumb">Наша семья</p><h1>Ассистент</h1><p>Рассказывайте о семье текстом или голосом</p></div><div className="assistant-header-actions"><button className="assistant-list-toggle" aria-label="Разговоры" aria-expanded={listOpen} onClick={() => setListOpen(value => !value)}><List size={19} /></button>{canWrite && <button className="button primary" aria-label="Новый разговор" disabled={opening || loading} onClick={() => void create()}><Plus size={18} /><span>Новый разговор</span></button>}</div></header>
    {error && <div className="assistant-page-error" role="alert">{error}<button className="button secondary" disabled={loading} onClick={() => void reloadList()}>Обновить список</button></div>}
    <div className={`assistant-layout ${listOpen ? 'is-list-open' : ''}`}>
      <aside className="assistant-conversations" aria-label="Сохранённые разговоры">
        <div className="assistant-list-heading"><h2>Разговоры</h2><button className="icon-button assistant-list-close" aria-label="Закрыть список разговоров" onClick={() => setListOpen(false)}><X size={20} /></button></div>
        {loading ? <p className="assistant-list-empty" role="status">Загружаем разговоры…</p> : !conversations.length ? <p className="assistant-list-empty">Здесь будут сохранённые разговоры.</p> : <nav>{conversations.map(item => <button key={item.id} className={`assistant-conversation-link ${conversation?.id === item.id ? 'selected' : ''}`} aria-current={conversation?.id === item.id ? 'page' : undefined} disabled={opening} onClick={() => void open(item.id)}><span><MessageSquare size={16} /><strong>{item.title || 'Новый разговор'}</strong></span><small>{conversation?.id !== item.id && isWorking(item) ? 'В работе' : formatDate(item.updatedAt)}</small></button>)}</nav>}
      </aside>
      <div className="assistant-chat-panel">
        {opening && <p className="assistant-opening" role="status"><LoaderCircle size={16} className="assistant-spinner" />Открываем разговор…</p>}
        {conversation ? <ConversationView key={conversation.id} conversation={conversation} state={state} onChange={receive} onRefresh={onRefresh} onActivityChange={activity} onReview={setReviewId} /> : <div className="assistant-welcome"><MessageSquare size={34} strokeWidth={1.5} /><h2>{loading ? 'Загружаем…' : 'Начните с того, что помните'}</h2><p>{canWrite ? 'Можно записать короткое воспоминание, рассказать о человеке или задать вопрос по своему рассказу.' : 'Здесь можно читать сохранённые разговоры.'}</p>{!loading && canWrite && <button className="button primary" disabled={opening} onClick={() => void create()}><Plus size={17} />Начать разговор</button>}<p className="assistant-welcome-note">Историю можно сохранить в архиве. Сведения попадут в дерево только после вашей проверки.</p><p className="assistant-privacy">Разговор виден вам и администратору. После сохранения в архив — всей семье.</p></div>}
      </div>
    </div>
    {reviewId && <MaterialDetail id={reviewId} initialView="proposals" state={state} onRefresh={onRefresh} onClose={() => setReviewId(null)} onPersonOpen={onPersonOpen} />}
  </section>;
}

interface ConversationViewProps {
  conversation: Conversation; state: AppState;
  onChange: (conversation: Conversation) => void;
  onRefresh: () => Promise<void>;
  onActivityChange: (blocked: boolean) => void;
  onReview: (materialId: string) => void;
}

function ConversationView({ conversation, state, onChange, onRefresh, onActivityChange, onReview }: ConversationViewProps) {
  const [draft, setDraft] = useState('');
  const [voice, setVoice] = useState<File | null>(null);
  const [recorderOpen, setRecorderOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState('');
  const [failedAction, setFailedAction] = useState<'retry' | 'archive' | 'prepare' | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const editVersion = useRef(0);
  const voiceInput = useRef<HTMLInputElement | null>(null);
  const uploadedVoice = useRef<{ file: File; uploaded: UploadedFile } | null>(null);
  const pendingMessage = useRef<{ id: string; text: string; fileId?: string; version: number } | null>(null);
  const mutationLock = useRef(false);
  const mutationEpoch = useRef(0);
  const mounted = useRef(true);
  const current = useRef(conversation);
  const refreshCallback = useRef(onRefresh);
  current.current = conversation; refreshCallback.current = onRefresh;
  const working = isWorking(conversation);
  const operation = working ? conversation.status : busy === 'prepare' ? 'preparing' : busy === 'retry' ? (conversation.errorOperation === 'transcribing' ? 'transcribing' : 'responding') : null;
  const processing = operation !== null;
  const empty = conversation.messages.length === 0;
  const material = state.materials.find(item => item.id === conversation.materialId);
  const currentSnapshot = !!conversation.materialId && conversation.archivedVersion === conversation.version;
  const prepared = currentSnapshot && material?.extractionStatus === 'done';
  const preparingFailure = failedAction === 'prepare' || (!failedAction && conversation.errorOperation === 'preparing');
  const displayedError = error || (!processing ? conversation.error : null);
  const retryAction = failedAction === 'archive' ? 'archive' : preparingFailure ? 'prepare' : 'retry';
  const retryLabel = retryAction === 'archive' ? 'Сохранить ещё раз' : preparingFailure ? 'Повторить подготовку' : conversation.errorOperation === 'transcribing' ? 'Повторить расшифровку' : 'Запросить ответ заново';
  const errorHeading = failedAction === 'archive' ? 'Не удалось сохранить историю' : preparingFailure ? 'Не удалось подготовить сведения' : conversation.errorOperation === 'transcribing' ? 'Не удалось расшифровать запись' : error && !failedAction ? 'Не удалось выполнить действие' : 'Не удалось получить ответ';
  const canWrite = state.user.role !== 'viewer' && (state.user.role === 'admin' || conversation.createdBy === state.user.id);
  const lastUser = [...conversation.messages].reverse().find(item => item.role === 'user');
  const editDirty = !!editing && editText !== conversation.messages.find(item => item.id === editing)?.text;
  const blocked = !!draft.trim() || !!voice || recording || editDirty || !!busy;
  const savedStatements = conversation.messages.some(item => item.role === 'user');
  const hasUnsent = !!draft.trim() || !!voice || recording;
  const voicePreview = useMemo(() => voice && !recorderOpen ? URL.createObjectURL(voice) : null, [voice, recorderOpen]);
  useEffect(() => () => { if (voicePreview) URL.revokeObjectURL(voicePreview); }, [voicePreview]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onActivityChange(blocked); }, [blocked, onActivityChange]);
  useEffect(() => {
    if (!blocked) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [blocked]);
  useEffect(() => {
    let cancelled = false;
    let timer: number;
    async function poll() {
      if (cancelled) return;
      if (mutationLock.current) { timer = window.setTimeout(() => void poll(), 1000); return; }
      try {
        const previous = current.current;
        const epoch = mutationEpoch.current;
        const next = await api<Conversation>(route(conversation.id));
        if (cancelled || mutationLock.current || mutationEpoch.current !== epoch) return;
        onChange(next); setPollError('');
        if (isWorking(previous) && !isWorking(next)) {
          await refreshCallback.current().catch(() => {});
        }
      } catch (cause) { if (!cancelled) setPollError(`Не удалось обновить разговор. ${errorText(cause)}`); }
      finally { if (!cancelled) timer = window.setTimeout(() => void poll(), isWorking(current.current) ? 1000 : 15000); }
    }
    timer = window.setTimeout(() => void poll(), working ? 1000 : 15000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [conversation.id, working, onChange]);

  async function append(message: AppendMessage) {
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
    if (mutationLock.current || !canWrite || working || recording || (!text && !voice)) return;
    if (voice && text) { setError('Текст и голос отправляются отдельными сообщениями. Сначала отправьте запись, затем добавьте текст.'); return; }
    if (voice && voice.size > state.settings.maxUploadMb * 1024 * 1024) { setError(`Запись слишком большая. Максимум — ${state.settings.maxUploadMb} МБ.`); return; }
    mutationLock.current = true; mutationEpoch.current += 1; setBusy('send'); setError(''); setNotice(''); setFailedAction(null);
    try {
      let fileId: string | undefined;
      if (voice) {
        if (uploadedVoice.current?.file === voice) fileId = uploadedVoice.current.uploaded.id;
        else { setProgress(0); const uploaded = await upload(voice, setProgress); uploadedVoice.current = { file: voice, uploaded }; fileId = uploaded.id; setProgress(null); }
      }
      const previous = pendingMessage.current;
      const request = previous?.text === text && previous.fileId === fileId ? previous : { id: crypto.randomUUID(), text, fileId, version: current.current.version };
      pendingMessage.current = request;
      let next: Conversation;
      try { next = await api<Conversation>(`${route(conversation.id)}/messages`, json('POST', request)); }
      catch (cause) {
        // A lost response may still have saved the message. Check its stable id before retrying.
        const fresh = await api<Conversation>(route(conversation.id)).catch(() => null);
        if (fresh?.messages.some(item => item.id === request.id)) next = fresh;
        else { if (fresh) { onChange(fresh); request.version = fresh.version; } throw cause; }
      }
      onChange(next); pendingMessage.current = null; uploadedVoice.current = null;
      if (mounted.current) { runtime.thread.composer.setText(''); setDraft(''); setVoice(null); setRecorderOpen(false); setNotice(''); }
    } catch (cause) { if (mounted.current) setError(`Не удалось подтвердить сохранение сообщения. ${errorText(cause)} Текст и запись остались в форме; повторная отправка использует тот же номер сообщения.`); }
    finally { mutationLock.current = false; if (mounted.current) { setBusy(''); setProgress(null); } }
  }

  const convertMessage = useCallback((item: ConversationMessage): ThreadMessageLike => ({
    id: item.id, role: item.role, content: item.text ? [{ type: 'text', text: item.text }] : [], createdAt: new Date(item.createdAt),
    ...(item.role === 'assistant' ? { status: item.interrupted && current.current.errorOperation !== 'preparing' ? { type: 'incomplete' as const, reason: 'error' as const } : current.current.status === 'responding' && current.current.messages.at(-1)?.id === item.id ? { type: 'running' as const } : { type: 'complete' as const, reason: 'stop' as const } } : {}),
    metadata: { custom: { original: item } },
  }), []);
  const runtime = useExternalStoreRuntime<ConversationMessage>({
    messages: conversation.messages, convertMessage, isRunning: working,
    isDisabled: !canWrite || !!busy || !!editing,
    isSendDisabled: working || recording || !!busy || !!editing,
    onNew: append,
  });
  useEffect(() => {
    const sync = () => setDraft(runtime.thread.composer.getState().text);
    sync(); return runtime.thread.composer.subscribe(sync);
  }, [runtime]);

  function send() {
    if (working || busy || recording || editing || (!draft.trim() && !voice)) return;
    runtime.thread.append({ role: 'user', content: [{ type: 'text', text: runtime.thread.composer.getState().text }] });
  }
  function chooseVoice(file: File | null) {
    setVoice(file); uploadedVoice.current = null; setError('');
    if (file && file.size > state.settings.maxUploadMb * 1024 * 1024) setError(`Запись слишком большая. Максимум — ${state.settings.maxUploadMb} МБ.`);
  }
  function clearVoice() {
    if ((voice || recording) && !window.confirm('Убрать неотправленную запись?')) return;
    setRecorderOpen(false); setRecording(false); chooseVoice(null);
  }
  async function action(type: 'retry' | 'archive' | 'prepare') {
    if (mutationLock.current || working || !canWrite) return;
    mutationLock.current = true; mutationEpoch.current += 1; setBusy(type); setError(''); setNotice(''); setFailedAction(null);
    try {
      const next = await api<Conversation>(`${route(conversation.id)}/${type}`, json('POST', { version: current.current.version }));
      onChange(next);
      if (type === 'archive' && next.materialId) await refreshCallback.current().catch(() => {});
    } catch (cause) { setFailedAction(type); setError(errorText(cause)); }
    finally { mutationLock.current = false; setBusy(''); }
  }
  async function saveEdit() {
    if (!editing || mutationLock.current || working) return;
    if (!editText.trim()) { setError('Добавьте текст сообщения.'); return; }
    mutationLock.current = true; mutationEpoch.current += 1; setBusy('edit'); setError(''); setFailedAction(null);
    try {
      const next = await api<Conversation>(`${route(conversation.id)}/messages/${encodeURIComponent(editing)}`, json('PATCH', { text: editText, version: editVersion.current }));
      onChange(next); setEditing(null); setNotice('Исправление сохранено. Можно запросить ответ заново.');
    } catch (cause) { setError(errorText(cause)); }
    finally { mutationLock.current = false; setBusy(''); }
  }

  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root className={`assistant-thread ${empty ? 'is-empty' : ''} ${processing ? 'is-processing' : ''}`}>
      <div className="assistant-thread-heading"><h2 title={conversation.title}>{conversation.title || 'Новый разговор'}</h2><span>{formatDate(conversation.createdAt)}</span></div>
      <ThreadPrimitive.Viewport className="assistant-viewport" autoScroll={!empty} aria-label="Сообщения разговора">
        {empty ? <div className="assistant-thread-empty"><p className="assistant-empty-label">Новый разговор</p><h3>Расскажите о человеке<br className="assistant-empty-break" /> или событии</h3><p>Напишите, что помните, или запишите голосом.{state.settings.aiAvailable ? ' Ассистент поможет уточнить детали.' : ' Рассказ можно сохранить в архив без обработки.'}</p></div> : <ConversationPrivacy aiAvailable={state.settings.aiAvailable} />}
        {!state.settings.aiAvailable && <div className="assistant-connection-note"><FileText size={18} /><p><strong>Ассистент ещё не подключён.</strong> Текст и записи сохраняются. Расшифровка и ответы пока недоступны.</p></div>}
        <ThreadPrimitive.Messages>{({ message }) => {
          const original = message.metadata.custom.original as ConversationMessage | undefined;
          if (!original || (original.role === 'assistant' && !original.text)) return null;
          const isUser = original.role === 'user';
          const lastAssistant = !isUser && conversation.messages.at(-1)?.id === original.id;
          return <MessagePrimitive.Root key={original.id} className={`assistant-message ${isUser ? 'is-user' : 'is-assistant'}`}>
            <div className="assistant-message-author">{isUser ? state.users.find(user => user.id === conversation.createdBy)?.name || 'Участник' : 'Ассистент'}<time dateTime={original.createdAt}>{new Date(original.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</time></div>
            <div className="assistant-message-content">
              {original.file && <VoiceMessage file={original.file} />}
              {editing === original.id ? <div className="assistant-message-editor"><label className="field">{original.file ? 'Текст записи' : 'Ваше сообщение'}<textarea autoFocus rows={5} maxLength={120000} value={editText} disabled={!!busy} onChange={event => setEditText(event.target.value)} /></label><p>Прежний ответ после этого сообщения будет сброшен. Оригинальная запись сохранится.</p><div><button className="button secondary" disabled={!!busy} onClick={() => { if (!editDirty || window.confirm('Отменить исправления сообщения?')) setEditing(null); }}>Отмена</button><button className="button primary" disabled={!!busy || !editText.trim()} onClick={() => void saveEdit()}>{busy === 'edit' ? 'Сохраняем…' : 'Сохранить исправление'}</button></div></div> : <>
                {original.automatic && original.text && <span className="assistant-transcript-label">Автоматическая расшифровка · проверьте имена и даты</span>}
                {original.text ? <div className="assistant-message-text"><MessagePrimitive.Parts /></div> : original.file && !processing ? <p className="assistant-message-placeholder">Текст записи ещё не добавлен.</p> : null}
                {original.interrupted && !preparingFailure && !processing && !displayedError && <p className="assistant-message-interrupted">Ответ не завершён.</p>}
              </>}
            </div>
            {canWrite && !processing && !busy && !editing && !hasUnsent && <div className="assistant-message-actions">
              {lastUser?.id === original.id && <button className="assistant-text-button" onClick={() => { setEditing(original.id); setEditText(original.text); editVersion.current = conversation.version; setError(''); setFailedAction(null); }}><Pencil size={14} />{original.file ? original.text ? 'Исправить текст' : 'Добавить текст записи' : 'Исправить'}</button>}
              {lastAssistant && !displayedError && state.settings.aiAvailable && <button className="assistant-text-button" onClick={() => void action('retry')}><RotateCcw size={14} />Ответить заново</button>}
            </div>}
          </MessagePrimitive.Root>;
        }}</ThreadPrimitive.Messages>
        {processing && <div className="assistant-processing-status" role="status"><LoaderCircle size={20} className="assistant-spinner" /><div><strong>{statusLabel(operation!)}</strong><p>{operation === 'preparing' ? 'Проверяем сведения и цитаты из рассказа. Дерево пока не меняется.' : operation === 'transcribing' ? 'Оригинал сохранён. Готовим текст голосового сообщения.' : 'Ответ появится здесь по мере готовности.'}</p><span>Можно закрыть разговор — работа продолжится.</span></div></div>}
        {!processing && displayedError && <div className="assistant-alert assistant-operation-error" role="alert"><h3>{errorHeading}</h3><p>{displayedError}</p>{preparingFailure && <span>Рассказ сохранён. Завершённые ответы и оригинальные записи не изменились.</span>}<div className="assistant-error-actions">{canWrite && (!!conversation.error || !!failedAction) && <button className="button primary" disabled={(retryAction !== 'archive' && !state.settings.aiAvailable) || !!busy || !!editing || hasUnsent} onClick={() => void action(retryAction)}><RotateCcw size={16} />{retryLabel}</button>}{preparingFailure && conversation.materialId && <button className="assistant-text-button" onClick={() => onReview(conversation.materialId!)}>Открыть сохранённый рассказ</button>}</div></div>}
        {!processing && notice && <div className="assistant-notice" role="status"><Check size={16} />{notice}<button className="icon-button" aria-label="Закрыть сообщение" onClick={() => setNotice('')}><X size={15} /></button></div>}
        {pollError && <div className="assistant-alert" role="alert"><p>{pollError}</p><button className="button secondary" onClick={() => void api<Conversation>(route(conversation.id)).then(next => { onChange(next); setPollError(''); }).catch(cause => setPollError(errorText(cause)))}>Обновить разговор</button></div>}
        {!processing && !displayedError && !hasUnsent && !editing && <>
          {prepared && conversation.materialId ? <div className="assistant-archive-result"><span className="assistant-result-icon"><ListChecks size={23} /></span><div><h3>Разбор завершён</h3><p>Проверьте предложения и выберите нужные. Принятые сведения появятся в дереве неподтверждёнными.</p>{!!material?.extractionRejectedCount && <p>Часть предложений требует уточнения: {material.extractionRejectedCount}. Остальные можно проверить.</p>}<button className="button primary" onClick={() => onReview(conversation.materialId!)}>Проверить результат</button></div></div> : <>
            {conversation.materialId && <div className="assistant-saved-story"><Check size={16} /><span>{currentSnapshot ? 'История сохранена в архиве' : 'В архиве есть предыдущая версия рассказа'}</span><button className="assistant-text-button" onClick={() => onReview(conversation.materialId!)}>Открыть</button></div>}
            {canWrite && savedStatements && <div className="assistant-story-actions"><div className="assistant-next-actions">{state.settings.aiAvailable && <button className="button primary" disabled={!!busy} onClick={() => void action('prepare')}><ListChecks size={17} />Подготовить сведения</button>}{!currentSnapshot && <button className="button secondary" disabled={!!busy} onClick={() => void action('archive')}><Archive size={17} />{busy === 'archive' ? 'Сохраняем…' : 'Сохранить историю'}</button>}</div>{state.settings.aiAvailable && <p className="assistant-action-note">Подготовка сведений также сохраняет рассказ в общем архиве. Дерево изменится только после вашей проверки.</p>}</div>}
          </>}
        </>}
      </ThreadPrimitive.Viewport>
      <div className="assistant-scroll-control"><ThreadPrimitive.ScrollToBottom className="assistant-scroll-bottom" aria-label="К последним сообщениям"><ArrowDown size={18} /></ThreadPrimitive.ScrollToBottom></div>
      {canWrite && <div className="assistant-bottom">
        <ComposerPrimitive.Root className="assistant-composer" onSubmit={event => { event.preventDefault(); send(); }}>
          <div className="assistant-composer-content">
            {recorderOpen && <div className="assistant-recorder-panel"><div className="assistant-attachment-heading"><strong>Голосовое сообщение</strong><button className="icon-button" type="button" disabled={!!busy} onClick={clearVoice} aria-label="Убрать запись"><X size={18} /></button></div><Recorder onRecorded={chooseVoice} onActiveChange={setRecording} disabled={!!busy || working} />{voice && <p className="assistant-voice-hint">Запись пока на этом устройстве. Нажмите «Отправить», чтобы сохранить её в разговоре.</p>}</div>}
            {voice && !recorderOpen && <div className="assistant-uploaded-voice"><span><FileAudio size={18} /><strong>{voice.name}</strong><button type="button" className="icon-button" onClick={clearVoice} disabled={!!busy} aria-label="Убрать аудиофайл"><X size={18} /></button></span>{voicePreview && <audio controls src={voicePreview} aria-label="Прослушать запись перед отправкой" />}</div>}
            <ComposerPrimitive.Input placeholder={voice || recorderOpen ? 'Текст можно отправить отдельным сообщением.' : processing ? 'Можно набрать следующее сообщение…' : 'Напишите, что помните…'} aria-label="Сообщение ассистенту" minRows={empty ? 3 : 2} maxRows={8} submitMode="none" cancelOnEscape={false} addAttachmentOnPaste={false} disabled={!canWrite || !!busy || !!editing || recorderOpen || !!voice} maxLength={20000} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); send(); } }} />
            {progress !== null && <div className="assistant-upload-progress" role="status"><progress value={progress} max={100} /><span>{progress >= 100 ? 'Запись загружена. Подготавливаем воспроизведение…' : `Загружаем запись: ${Math.round(progress)}%`}</span></div>}
          </div>
          <div className="assistant-composer-actions"><div>{processing ? <span className="assistant-draft-label">Черновик следующего сообщения</span> : <><button type="button" className="assistant-text-button assistant-record-button" aria-label={recorderOpen ? 'Скрыть диктофон' : 'Записать голосом'} disabled={!!busy || !!editing || recording || !!voice || !!draft.trim()} onClick={() => setRecorderOpen(value => !value)}><Mic size={18} /><span>{recorderOpen ? 'Скрыть диктофон' : 'Записать голосом'}</span></button><button type="button" className="icon-button" disabled={!!busy || !!editing || recording || !!voice || !!draft.trim()} onClick={() => voiceInput.current?.click()} aria-label="Загрузить аудиофайл"><Upload size={18} /></button></>}<input ref={voiceInput} hidden type="file" accept="audio/*,.m4a,.webm,.ogg" onChange={event => { setRecorderOpen(false); chooseVoice(event.target.files?.[0] || null); event.target.value = ''; }} /></div><button className="button primary assistant-send" type="submit" disabled={working || !!busy || recording || !!editing || (!draft.trim() && !voice)}><ArrowUp size={18} />{busy === 'send' ? 'Сохраняем…' : 'Отправить'}</button></div>
        </ComposerPrimitive.Root>
        {empty && <ConversationPrivacy aiAvailable={state.settings.aiAvailable} />}
      </div>}
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider>;
}

function ConversationPrivacy({ aiAvailable }: { aiAvailable: boolean }) {
  return <details className="assistant-context-details"><summary><Info size={15} />О приватности и обработке</summary><div><p>Разговор виден вам и администратору. После сохранения в архив — всей семье.</p><p>{aiAvailable ? 'Для ответа текст и запись передаются в OpenAI. Сведения добавляются только после вашего решения; затем их подтверждает другой родственник.' : 'Заметки и аудио сохраняются без ответа ассистента. Историю можно добавить в архив без AI.'}</p></div></details>;
}

function VoiceMessage({ file }: { file: UploadedFile }) {
  const [error, setError] = useState(false);
  return <div className="assistant-voice-message"><span><Mic size={16} />Голосовое сообщение</span><audio controls preload="metadata" src={file.url} onError={() => setError(true)} aria-label="Прослушать голосовое сообщение" />{error && <p role="alert">Браузер не смог воспроизвести запись. Скачайте оригинал и откройте его на устройстве.</p>}<a href={`${file.url}?original=1`} download={file.name}><Download size={14} />Скачать оригинал</a></div>;
}
