import { useMemo, useRef, useState } from 'react';
import { LoaderCircle, Search, X } from 'lucide-react';
import type { AppState } from '../../shared/types';
import { api, json } from '../api';
import { Avatar, formatDate, Modal } from './ui';
import './IdentityMatch.css';

interface IdentityMatchProps {
  state: AppState;
  onClose: () => void;
  onSaved: () => Promise<void>;
}
const nameTokens = (value: string) => [...new Set(value.toLocaleLowerCase('ru').replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) || [])];

export default function IdentityMatch({ state, onClose, onSaved }: IdentityMatchProps) {
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [savedId, setSavedId] = useState<string | null>(null);
  const lock = useRef(false);
  const candidates = useMemo(() => {
    const claimed = new Set(state.users.filter(user => user.id !== state.user.id && user.personId).map(user => user.personId));
    const mine = nameTokens(state.user.name);
    const search = nameTokens(query);
    return state.people.filter(person => !claimed.has(person.id)).map(person => {
      const tokens = nameTokens(person.name);
      return { person, tokens, overlap: mine.filter(token => tokens.includes(token)).length };
    }).filter(({ tokens, overlap }) => search.length ? search.every(token => tokens.some(part => part.includes(token))) : overlap >= (mine.length === 1 ? 1 : 2))
      .sort((a, b) => b.overlap - a.overlap || a.person.name.localeCompare(b.person.name, 'ru'));
  }, [state.people, state.users, state.user.id, state.user.name, query]);
  const searching = nameTokens(query).length > 0;
  const results = searching ? candidates : candidates.slice(0, 8);

  async function choose(personId: string) {
    if (lock.current) return;
    lock.current = true; setBusyId(personId); setError('');
    let persisted = savedId === personId;
    try {
      if (!persisted) {
        await api('/api/me/person', json('PATCH', { personId }));
        persisted = true; setSavedId(personId);
      }
      await onSaved(); onClose();
    } catch (cause) {
      setError(persisted ? 'Связь с карточкой сохранена, но данные не обновились. Нажмите «Обновить данные».' : cause instanceof Error ? cause.message : 'Не удалось связать аккаунт с карточкой. Попробуйте ещё раз.');
    } finally { lock.current = false; setBusyId(null); }
  }

  return <Modal open title="Вы уже есть в дереве?" onClose={() => { if (!lock.current) onClose(); }}>
    <div className="identity-match">
      <p className="identity-intro">Вы вошли как <strong>{state.user.name}</strong>. Если нашли свою карточку, нажмите «Это я».</p>
      <p className="identity-note">Это свяжет ваш аккаунт с карточкой. Сведения в дереве останутся без изменений.</p>
      <label className="identity-search"><Search size={18} /><input autoComplete="off" value={query} onChange={event => { setQuery(event.target.value); setError(''); }} placeholder="Имя или фамилия в дереве" aria-label="Найти себя в дереве" disabled={!!busyId} />{query && <button type="button" aria-label="Очистить поиск" disabled={!!busyId} onClick={() => setQuery('')}><X size={17} /></button>}</label>
      <div className="identity-results" aria-label={searching ? 'Результаты поиска' : 'Возможные совпадения'}>
        {results.length ? <><p className="identity-results-label">{searching ? `Найдено: ${results.length}` : 'Возможные совпадения'}</p>{results.map(({ person }) => {
          const birth = state.facts.find(fact => fact.personId === person.id && fact.key === 'birthDate')?.value;
          const linked = person.id === (savedId || state.user.personId);
          return <article className="identity-person" key={person.id}><Avatar name={person.name} fileId={person.avatarFileId} size={42} /><div><strong>{person.name}</strong>{birth && <small>{formatDate(birth)}</small>}{linked && <small className="identity-linked">Связана с вашим аккаунтом</small>}</div><button type="button" className="button secondary" disabled={!!busyId} aria-label={`Это я: ${person.name}`} onClick={() => void choose(person.id)}>{busyId === person.id ? <LoaderCircle size={16} className="spin" /> : null}{busyId === person.id ? 'Сохраняем…' : 'Это я'}</button></article>;
        })}</> : <div className="identity-empty"><h3>Совпадений пока нет</h3><p>{searching ? 'Попробуйте другую фамилию или часть имени.' : 'Попробуйте поиск по имени или фамилии.'} Свою карточку можно добавить в дерево позже.</p></div>}
      </div>
      {error && <div className="identity-error" role="alert"><p>{error}</p>{savedId && <button type="button" className="button secondary" disabled={!!busyId} onClick={() => void choose(savedId)}>Обновить данные</button>}</div>}
      <div className="identity-footer"><button type="button" className="button secondary" disabled={!!busyId} onClick={onClose}>Пропустить</button></div>
    </div>
  </Modal>;
}
