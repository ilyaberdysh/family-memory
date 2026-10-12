import { useEffect, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { ArrowRight } from 'lucide-react';
import type { TreeState } from '../../shared/types';
import { Composer, type ComposerHandle } from './Composer';
import { Markdown } from './Markdown';
import { isToolPart, ToolChip, type ToolPart } from './ToolChip';
import { isResearchPart, ResearchCard } from './FindingsCard';
import { plural } from '../plural';

const STORAGE_KEY = 'roots.conversation';

const SUGGESTIONS = [
  'Моя фамилия — ',
  'Знаю, как звали прадеда: ',
  'Семья родом из деревни ',
  'Дедушка воевал, звали его ',
];

type SourceStatus = 'live' | 'link' | 'paused' | 'soon';
const STATUS_LABEL: Record<SourceStatus, string> = { live: 'ищет сам', link: 'по ссылке', paused: 'на паузе', soon: 'скоро' };

export const SOURCES: { name: string; note: string; status: SourceStatus }[] = [
  { name: 'ОБД «Мемориал»', note: 'погибшие и пропавшие 1941–1945', status: 'live' },
  { name: 'Память народа', note: 'участники войны, награды', status: 'link' },
  { name: 'FamilySearch', note: 'деревья и записи', status: 'link' },
  { name: 'Яндекс Поиск по архивам', note: 'метрические книги — сервис временно недоступен', status: 'paused' },
  { name: 'Familio', note: 'сканы по фамилии и месту', status: 'soon' },
  { name: 'ГИС УИАД', note: 'каталоги государственных архивов', status: 'soon' },
];

function loadMessages(): UIMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as UIMessage[]) : [];
  } catch {
    return [];
  }
}

export function clearConversation() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
}

function textOf(message: UIMessage): string {
  return message.parts.map(part => (part.type === 'text' ? part.text : '')).join('');
}

type Props = {
  tree: TreeState;
  onTreeChanged: () => void;
  onOpenTree: () => void;
  onActiveChange: (active: boolean) => void;
};

export function AgentView({ tree, onTreeChanged, onOpenTree, onActiveChange }: Props) {
  const { messages, sendMessage, status, error, regenerate, stop } = useChat({
    messages: loadMessages(),
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });
  const composer = useRef<ComposerHandle>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const busy = status === 'submitted' || status === 'streaming';
  const started = messages.length > 0;

  useEffect(() => {
    onActiveChange(started);
    if (status === 'streaming' || status === 'submitted') return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages)); } catch { /* storage unavailable */ }
  }, [messages, status, started, onActiveChange]);

  const toolOutputs = messages.reduce(
    (count, message) => count + message.parts.filter(part => isToolPart(part) && (part as { state: string }).state === 'output-available').length,
    0,
  );
  useEffect(() => {
    if (toolOutputs > 0) onTreeChanged();
  }, [toolOutputs, onTreeChanged]);

  useEffect(() => {
    if (started) bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages, status, started]);

  const send = (text: string) => sendMessage({ text });

  if (!started) {
    return (
      <section className="welcome">
        <p className="eyebrow">Семейный исследователь</p>
        <h1 className="display">С кого начнём?</h1>
        <p className="lede">
          Расскажите, что знаете: фамилию, имя прадеда, откуда семья родом. Я подскажу, где искать, и соберу древо.
        </p>
        <Composer ref={composer} onSend={send} busy={busy} autoFocus placeholder="Например: моя фамилия Соколов, дед родом из-под Твери…" />
        <div className="suggestions">
          {SUGGESTIONS.map(text => (
            <button key={text} className="chip" onClick={() => composer.current?.fill(text)}>
              {text.replace(/[:\s]+$/, '').replace(/ —$/, '')}
            </button>
          ))}
        </div>
        <div className="sources-line" aria-label="Источники">
          <span>Будем искать в</span>
          {SOURCES.filter(source => source.status !== 'paused').slice(0, 5).map(source => <b key={source.name}>{source.name}</b>)}
        </div>
      </section>
    );
  }

  const last = messages[messages.length - 1];
  const waiting = status === 'submitted' || (status === 'streaming' && last?.role === 'assistant' && !textOf(last) && !last.parts.some(isToolPart));

  return (
    <section className="conversation">
      <div className="thread-column">
        <div className="thread" aria-live="polite">
          {messages.map(message => {
            if (message.role === 'user') return <div key={message.id} className="message user">{textOf(message)}</div>;
            const tools = message.parts.filter(isToolPart) as unknown as ToolPart[];
            const chips = tools.filter(part => !isResearchPart(part));
            const research = tools.filter(isResearchPart);
            const text = textOf(message);
            if (!text && tools.length === 0) return null;
            return (
              <div key={message.id} className="message assistant">
                {chips.length > 0 && (
                  <div className="tool-chips">
                    {chips.map(part => <ToolChip key={part.toolCallId} part={part} onOpen={onOpenTree} />)}
                  </div>
                )}
                {research.map(part => <ResearchCard key={part.toolCallId} part={part} />)}
                {text && <Markdown text={text} />}
              </div>
            );
          })}
          {waiting && <div className="thinking" aria-label="Агент думает"><i /><i /><i /></div>}
          {error && (
            <div className="error-note" role="alert">
              <span>{readableError(error)}</span>
              <button onClick={() => regenerate()}>Повторить</button>
            </div>
          )}
          <div ref={bottom} className="thread-end" />
        </div>
        <div className="dock">
          <Composer ref={composer} onSend={send} busy={busy} onStop={stop} placeholder="Ответьте или расскажите ещё…" autoFocus />
          <p className="dock-note">Агент ведёт древо и ищет в ОБД «Мемориал». Найденное — кандидаты, родство подтверждаете вы.</p>
        </div>
      </div>

      <aside className="findings" aria-label="Находки">
        <button type="button" className="tree-summary" onClick={onOpenTree} disabled={tree.people.length === 0}>
          <span>
            <strong>Древо</strong>
            <small>{tree.people.length === 0 ? 'появится по ходу разговора' : treeSummary(tree)}</small>
          </span>
          {tree.people.length > 0 && <ArrowRight aria-hidden />}
        </button>

        <h2 className="panel-title">Находки</h2>
        <p className="panel-sub">Агент сам ищет в подключённых источниках. Каждая запись — со ссылкой на оригинал; родство подтверждаете вы.</p>
        <ul className="source-list">
          {SOURCES.map(source => (
            <li key={source.name}>
              <span className="source-name">{source.name}<small>{source.note}</small></span>
              <span className="pill" data-status={source.status}>{STATUS_LABEL[source.status]}</span>
            </li>
          ))}
        </ul>
      </aside>
    </section>
  );
}

function treeSummary(tree: TreeState): string {
  const people = plural(tree.people.length, ['человек', 'человека', 'человек']);
  const hypotheses = tree.people.filter(p => p.provenance === 'hypothesis').length;
  return hypotheses ? `${people} · ${plural(hypotheses, ['гипотеза', 'гипотезы', 'гипотез'])}` : people;
}

function readableError(error: Error): string {
  try {
    const body = JSON.parse(error.message) as { error?: string };
    if (body.error) return body.error;
  } catch { /* not JSON */ }
  return error.message || 'Что-то пошло не так.';
}
