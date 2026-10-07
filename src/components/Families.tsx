import { useEffect, useState } from 'react';
import { ArrowRight, Check, ChevronDown, Clock3, LoaderCircle, Network, Plus, ShieldCheck, Users } from 'lucide-react';
import type { FamilySummary, User } from '../../shared/types';
import { api, json } from '../api';
import { Modal } from './ui';
import './Auth.css';
import './Families.css';

const roleNames: Record<FamilySummary['role'], string> = { admin: 'Администратор', member: 'Участник', viewer: 'Наблюдатель' };
const message = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить действие. Попробуйте ещё раз.';
function plural(n: number, one: string, few: string, many: string) { return n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many; }

/** Name field + button; the creator becomes the family's administrator. */
export function CreateFamilyForm({ onCreated, autoFocus = false }: { onCreated: (family: FamilySummary) => Promise<void> | void; autoFocus?: boolean }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true); setError('');
    try { const family = await api<FamilySummary>('/api/families', json('POST', { name: name.trim() })); await onCreated(family); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  return <form className="form-stack family-create" onSubmit={submit}>
    <label className="field">Название семьи
      <input required autoFocus={autoFocus} maxLength={120} placeholder="Семья Ивановых" value={name} onChange={e => setName(e.target.value)} />
    </label>
    {error && <p className="error-message" role="alert">{error}</p>}
    <button className="button primary full" disabled={busy || !name.trim()}>{busy ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}Создать семейное пространство</button>
  </form>;
}

function FamilyRow({ family, current, onOpen }: { family: FamilySummary; current?: boolean; onOpen?: () => void }) {
  const detail = family.status === 'pending' ? 'Ждём одобрения администратора'
    : family.status === 'active' ? `${roleNames[family.role]}${family.memberCount ? ` · ${family.memberCount} ${plural(family.memberCount, 'участник', 'участника', 'участников')}` : ''}`
      : family.status === 'rejected' ? 'Заявка не одобрена' : 'Доступ закрыт';
  const body = <><span className="family-row-mark">{family.status === 'pending' ? <Clock3 size={18} /> : <Users size={18} />}</span>
    <span className="family-row-text"><strong>{family.name}</strong><small>{detail}</small></span>
    {current ? <Check size={18} aria-label="Открыта сейчас" /> : onOpen ? <ArrowRight size={17} /> : null}</>;
  return onOpen && !current
    ? <button type="button" className="family-row" onClick={onOpen}>{body}</button>
    : <div className={`family-row ${current ? 'current' : 'static'}`} aria-current={current ? 'true' : undefined}>{body}</div>;
}

interface HomeProps {
  serviceName: string;
  user: User;
  families: FamilySummary[];
  onOpen: (familyId: string) => void;
  onCreated: (family: FamilySummary) => Promise<void>;
  onRefresh: () => Promise<void>;
  onLogout: () => Promise<void>;
}

/** Shown after sign-in when no family is open: onboarding, waiting for approval, or choosing a family. */
export function FamilyHome({ serviceName, user, families, onOpen, onCreated, onRefresh, onLogout }: HomeProps) {
  const active = families.filter(family => family.status === 'active');
  const pending = families.filter(family => family.status === 'pending');
  const closed = families.filter(family => family.status === 'removed' || family.status === 'rejected');
  const [creating, setCreating] = useState(!active.length && !pending.length);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!pending.length) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') onRefresh().catch(() => {}); }, 8000);
    return () => clearInterval(timer);
  }, [pending.length, onRefresh]);

  async function act(work: () => Promise<void>) {
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }

  const waiting = !active.length && pending.length > 0;
  return <div className="auth-page join-page">
    <div className="auth-brand"><span className="brand-mark"><Network size={23} /></span><span>{serviceName}</span></div>
    <main className="auth-card join-card family-home">
      <span className={`join-symbol ${waiting ? 'join-symbol-waiting' : ''}`}>{waiting ? <Clock3 size={29} /> : <Users size={29} />}</span>
      <p className="join-space-name">{user.name}</p>
      <h1>{waiting ? 'Ждём одобрения администратора' : active.length ? 'Выберите семью' : 'Создайте семейное пространство'}</h1>
      <p className="auth-description">{waiting
        ? 'Администратор семьи подтвердит доступ. После этого откроются дерево и архив. Можно закрыть страницу — вход сохранится.'
        : active.length ? 'Вы участвуете в нескольких семьях. Откройте нужную — её можно сменить в любой момент.'
          : 'Здесь соберутся люди, истории, фотографии и записи вашей семьи. Вы станете администратором и сможете пригласить родственников.'}</p>

      <div className="join-status">
        {active.length > 0 && <div className="family-list" role="list" aria-label="Ваши семьи">{active.map(family => <div role="listitem" key={family.id}><FamilyRow family={family} onOpen={() => onOpen(family.id)} /></div>)}</div>}
        {pending.length > 0 && <div className="family-list" role="list" aria-label="Ожидают одобрения">{pending.map(family => <div role="listitem" key={family.id}><FamilyRow family={family} /></div>)}</div>}
        {pending.length > 0 && <button className="button secondary full" disabled={busy} onClick={() => void act(onRefresh)}>{busy && <LoaderCircle className="spin" size={17} />}Проверить статус</button>}
        {closed.length > 0 && <p className="form-hint">{closed.map(family => `«${family.name}»: ${family.status === 'rejected' ? 'заявка не одобрена' : 'доступ закрыт'}`).join('; ')}. Свяжитесь с администратором этой семьи.</p>}
        {error && <p className="error-message" role="alert">{error}</p>}

        {creating ? <CreateFamilyForm onCreated={onCreated} autoFocus={!active.length && !pending.length} />
          : <button className="button secondary full" onClick={() => setCreating(true)}><Plus size={17} />Создать новую семью</button>}
        <div className="join-access"><ShieldCheck size={18} /><span>Чтобы присоединиться к уже существующей семье, попросите родственника, у которого есть пространство, прислать вам ссылку-приглашение и откройте её.</span></div>
        <button type="button" className="text-button join-secondary" disabled={busy} onClick={() => void act(onLogout)}>Выйти</button>
      </div>
    </main>
  </div>;
}

/** Compact button with the current family name; opens the family picker. */
export function FamilySwitcherButton({ name, onClick, className = '' }: { name: string; onClick: () => void; className?: string }) {
  return <button type="button" className={`family-switcher ${className}`} onClick={onClick} aria-label={`Семья: ${name}. Сменить семью`}>
    <span>{name}</span><ChevronDown size={15} aria-hidden="true" />
  </button>;
}

export function FamilyPicker({ families, currentId, onSwitch, onCreated, onClose }: { families: FamilySummary[]; currentId: string | null; onSwitch: (familyId: string) => void; onCreated: (family: FamilySummary) => Promise<void>; onClose: () => void }) {
  const [creating, setCreating] = useState(false);
  const visible = families.filter(family => family.status === 'active' || family.status === 'pending');
  return <Modal open title="Ваши семьи" onClose={onClose}>
    <div className="form-stack">
      <div className="family-list" role="list">{visible.map(family => <div role="listitem" key={family.id}>
        <FamilyRow family={family} current={family.id === currentId} onOpen={family.status === 'active' ? () => onSwitch(family.id) : undefined} />
      </div>)}</div>
      {creating ? <CreateFamilyForm onCreated={onCreated} autoFocus /> : <button type="button" className="button secondary full" onClick={() => setCreating(true)}><Plus size={17} />Создать новую семью</button>}
      <p className="form-hint">Чтобы попасть в семью родственника, откройте ссылку-приглашение от него — семья появится в этом списке.</p>
    </div>
  </Modal>;
}
