import { useRef, useState } from 'react';
import { Check, Copy, Download, Link, LoaderCircle, LogOut, Search, X } from 'lucide-react';
import type { AppState, CreatedInvitationLink, InvitationLink, Role, User } from '../../shared/types';
import { api, json } from '../api';
import { Avatar, formatDate, Modal } from './ui';
import './Members.css';

interface MembersProps {
  state: AppState;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onMatchSelf: () => void;
  onLogout: () => Promise<void>;
}
const roleNames: Record<Role, string> = { admin: 'Администратор', member: 'Участник', viewer: 'Наблюдатель' };
const message = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить действие. Попробуйте ещё раз.';
const active = (user: User) => !user.status || user.status === 'active';

export default function Members({ state, onClose, onRefresh, onMatchSelf, onLogout }: MembersProps) {
  const admin = state.user.role === 'admin';
  const [guestRole, setGuestRole] = useState<'member' | 'viewer'>('member');
  const [approvalRoles, setApprovalRoles] = useState<Record<string, 'member' | 'viewer'>>({});
  const [busy, setBusy] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<{ context: string; value: CreatedInvitationLink } | null>(null);
  const lock = useRef(false);
  const invitationUrl = `${window.location.origin}/?join=1`;
  const applicants = admin ? state.users.filter(user => user.status === 'profile' || user.status === 'pending') : [];
  const rejected = admin ? state.users.filter(user => user.status === 'rejected') : [];
  const participants = state.users.filter(active);
  const links = [...(state.invitationLinks || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  async function mutate(context: string, operation: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true; setBusy(context); setErrors(current => ({ ...current, [context]: '' }));
    try {
      await operation();
      try { await onRefresh(); }
      catch { setErrors(current => ({ ...current, [context]: 'Изменение сохранено, но список не обновился. Обновите его ещё раз.' })); }
    } catch (error) { setErrors(current => ({ ...current, [context]: message(error) })); }
    finally { lock.current = false; setBusy(''); }
  }
  function createGuest(context: string, userId?: string) {
    void mutate(context, async () => {
      const value = await api<CreatedInvitationLink>('/api/guest-links', json('POST', userId ? { userId } : { role: guestRole }));
      setCreated({ context, value });
    });
  }
  function errorFor(context: string) {
    return errors[context] ? <div className="members-error" role="alert"><p>{errors[context]}</p><button type="button" className="members-text-button" disabled={!!busy} onClick={() => void mutate(context, async () => {})}>Обновить список</button></div> : null;
  }
  function createdFor(context: string) {
    if (created?.context !== context) return null;
    const link = created.value;
    return <div className="members-created-link"><CopyLink key={link.invitation.id} url={`${window.location.origin}/#guest=${link.token}`} label="Гостевая ссылка" showUrl /><p>Действует до {formatDate(link.invitation.expiresAt)} Скопируйте её сейчас: после закрытия окна можно будет создать новую.</p></div>;
  }

  return <Modal open title="Участники пространства" onClose={onClose} wide>
    <div className="members-content">
      <section className="members-invite" aria-labelledby="members-invite-title">
        <div><h3 id="members-invite-title">Пригласить родственника</h3>{!!state.settings.surnames?.length && <p className="members-invite-surnames">{state.settings.surnames.join(' · ')}</p>}<p>Родственник войдёт через Telegram, укажет ФИО и телефон. Администратор одобрит доступ.</p></div>
        <CopyLink url={invitationUrl} label="Приглашение" actionLabel="Скопировать приглашение" primary />
        {state.settings.devMode && <p className="members-local-note">Сейчас это локальный адрес. Для входа с другого устройства приложение нужно разместить на сервере.</p>}
      </section>

      {admin && applicants.length > 0 && <section className="members-section" aria-labelledby="members-requests-title">
        <div className="members-section-heading"><h3 id="members-requests-title">Заявки на доступ</h3><span>{applicants.length}</span></div>
        <div className="members-rows">{applicants.map(user => {
          const submitted = user.status === 'pending' && !!user.nameParts?.firstName.trim() && !!user.nameParts?.lastName.trim() && !!user.phone?.trim();
          const context = `request-${user.id}`;
          return <article className="members-person members-applicant" key={user.id}>
            <div className="members-person-main"><Avatar name={user.name} size={40} /><div><strong>{user.name || 'Новый участник'}</strong><small>{user.phone || 'Телефон ещё не указан'}{user.phone && !user.phoneVerified ? ' · указан пользователем' : ''}</small><small>{user.authProvider === 'guest' ? 'Гостевой вход' : user.authProvider === 'telegram' ? 'Вход через Telegram' : 'Новый аккаунт'}</small></div></div>
            {submitted ? <div className="members-request-actions"><label className="members-role-label">Доступ<select aria-label={`Доступ для ${user.name}`} disabled={!!busy} value={approvalRoles[user.id] || 'member'} onChange={event => setApprovalRoles(current => ({ ...current, [user.id]: event.target.value as 'member' | 'viewer' }))}><option value="member">Участник</option><option value="viewer">Наблюдатель</option></select></label><button type="button" className="button primary" disabled={!!busy} onClick={() => void mutate(context, () => api(`/api/users/${encodeURIComponent(user.id)}/approve`, json('POST', { role: approvalRoles[user.id] || 'member' })))}>{busy === context ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}Одобрить</button><button type="button" className="button secondary members-reject" disabled={!!busy} onClick={() => void mutate(context, () => api(`/api/users/${encodeURIComponent(user.id)}/reject`, json('POST', {})))}><X size={16} />Отклонить</button></div> : <p className="members-profile-status">Заполняет профиль</p>}
            {errorFor(context)}
          </article>;
        })}</div>
      </section>}

      <section className="members-section" aria-labelledby="members-people-title">
        <div className="members-section-heading"><h3 id="members-people-title">Участники</h3><span>{participants.length}</span></div>
        <div className="members-rows">{participants.map(user => {
          const self = user.id === state.user.id;
          const person = state.people.find(item => item.id === user.personId);
          const context = `user-${user.id}`;
          return <article className="members-person" key={user.id}>
            <div className="members-person-row"><div className="members-person-main"><Avatar name={user.name} fileId={person?.avatarFileId} size={40} /><div><strong>{user.name}{self && <span className="members-self"> · вы</span>}</strong><small>{user.authProvider === 'guest' ? 'Гостевой вход' : user.authProvider === 'telegram' ? 'Telegram' : user.email || roleNames[user.role]}</small>{(admin || self) && user.phone && <small>{user.phone}</small>}</div></div>
              {admin ? <select className="members-role-select" aria-label={`Роль ${user.name}`} disabled={!!busy} value={user.role} onChange={event => void mutate(context, () => api(`/api/users/${encodeURIComponent(user.id)}`, json('PATCH', { role: event.target.value as Role })))}>{(user.authProvider !== 'guest' || user.role === 'admin') && <option value="admin">Администратор</option>}<option value="member">Участник</option><option value="viewer">Наблюдатель</option></select> : <span className="members-role-name">{roleNames[user.role]}</span>}
            </div>
            {(self || admin && user.authProvider === 'guest' && user.role !== 'admin') && <div className="members-person-actions">{self && <button type="button" className="members-text-button" disabled={!!busy} onClick={onMatchSelf}><Search size={15} />Найти себя в дереве</button>}{admin && user.authProvider === 'guest' && user.role !== 'admin' && <button type="button" className="members-text-button" disabled={!!busy} onClick={() => createGuest(context, user.id)}>{busy === context ? <LoaderCircle size={15} className="spin" /> : <Link size={15} />}Ссылка для входа</button>}</div>}
            {self && person && <p className="members-linked-person">Вы связаны с карточкой «{person.name}».</p>}
            {createdFor(context)}{errorFor(context)}
          </article>;
        })}</div>
      </section>

      {admin && <>
        <details className="members-disclosure"><summary>Для тех, у кого нет Telegram</summary><div className="members-disclosure-content"><p>Создайте одноразовую ссылку для гостевого входа. После заполнения ФИО и телефона родственник получит выбранный доступ.</p><div className="members-guest-actions"><label className="field">Доступ<select disabled={!!busy} value={guestRole} onChange={event => setGuestRole(event.target.value as 'member' | 'viewer')}><option value="member">Участник — добавляет и подтверждает</option><option value="viewer">Наблюдатель — только смотрит</option></select></label><button type="button" className="button secondary" disabled={!!busy} onClick={() => createGuest('guest')}>{busy === 'guest' ? <LoaderCircle size={16} className="spin" /> : <Link size={16} />}Создать гостевую ссылку</button></div><p className="members-secondary-note">Ссылка действует 7 дней и используется один раз.</p>{createdFor('guest')}{errorFor('guest')}
          {links.length > 0 && <div className="members-links"><h4>Созданные ссылки</h4>{links.map(link => {
            const context = `link-${link.id}`;
            const status = linkStatus(link);
            const owner = link.userId ? state.users.find(user => user.id === link.userId) : null;
            return <article className="members-link-row" key={link.id}><div><strong>{owner ? `Вход: ${owner.name}` : `Гостевой доступ · ${roleNames[link.role]}`}</strong><small>Создана {formatDate(link.createdAt)} · {status === 'Действует' ? `до ${formatDate(link.expiresAt)}` : status}</small></div>{status === 'Действует' && <button type="button" className="members-text-button" disabled={!!busy} onClick={() => void mutate(context, async () => { await api(`/api/guest-links/${encodeURIComponent(link.id)}/revoke`, json('POST', {})); if (created?.value.invitation.id === link.id) setCreated(null); })}>Отозвать</button>}{errorFor(context)}</article>;
          })}</div>}
        </div></details>
        {state.invitations.length > 0 && <details className="members-disclosure"><summary>Ранее приглашены по email</summary><div className="members-disclosure-content">{state.invitations.map(invitation => <div className="members-legacy-row" key={invitation.id}><strong>{invitation.email}</strong><span>{roleNames[invitation.role]} · {invitation.accepted ? 'Вошёл в пространство' : 'Ещё не вошёл'}</span></div>)}</div></details>}
        {rejected.length > 0 && <details className="members-disclosure"><summary>Отклонённые заявки · {rejected.length}</summary><div className="members-disclosure-content">{rejected.map(user => <div className="members-legacy-row" key={user.id}><strong>{user.name}</strong><span>{user.phone || 'Доступ не открыт'}</span></div>)}</div></details>}
        <a href="/api/export" className="members-text-button members-export"><Download size={16} />Скачать данные пространства</a>
      </>}
      <div className="members-disclosure"><button type="button" className="members-text-button" disabled={!!busy} onClick={() => void onLogout()}><LogOut size={16} />Выйти</button></div>
    </div>
  </Modal>;
}

function linkStatus(link: InvitationLink) {
  if (link.revokedAt) return 'Отозвана';
  if (link.usedAt || link.uses > 0) return 'Использована';
  if (Date.parse(link.expiresAt) <= Date.now()) return 'Срок истёк';
  return 'Действует';
}

function CopyLink({ url, label, actionLabel = 'Скопировать ссылку', showUrl = false, primary = false }: { url: string; label: string; actionLabel?: string; showUrl?: boolean; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [copying, setCopying] = useState(false);
  async function copy() {
    setCopied(false); setError(''); setCopying(true);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable');
      await navigator.clipboard.writeText(url); setCopied(true);
    } catch { setError('Не удалось скопировать автоматически. Выделите ссылку и скопируйте её вручную.'); }
    finally { setCopying(false); }
  }
  return <div className="members-copy-link">{(showUrl || error) && <label className="field">{label}<input value={url} readOnly onFocus={event => event.target.select()} aria-label={label} /></label>}<button type="button" className={`button ${primary ? 'primary' : 'secondary'}`} disabled={copying} onClick={() => void copy()}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? 'Ссылка скопирована' : actionLabel}</button>{error && <p className="members-copy-error" role="alert">{error}</p>}</div>;
}
