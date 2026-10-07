import { useRef, useState } from 'react';
import { ArrowLeftRight, Check, Copy, Download, Link, LoaderCircle, LogOut, MonitorSmartphone, RotateCcw, Save, Search, UserX, X } from 'lucide-react';
import type { AppState, CreatedInvitationLink, FamilyInfo, FamilySummary, InvitationLink, Role, User } from '../../shared/types';
import { api, download, json } from '../api';
import { Avatar, formatDate, Modal } from './ui';
import { ServerStatusSummary } from './ServerStatus';
import './Members.css';
import './Families.css';

interface MembersProps {
  state: AppState;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onMatchSelf: () => void;
  onLogout: () => Promise<void>;
  /** Called after "sign out everywhere": this device's session is gone as well. */
  onSessionEnded: () => void;
  /** Opens the family picker. */
  onSwitchFamily: () => void;
  /** The family name or surnames changed: refresh the list of families. */
  onFamilyChanged: () => Promise<void>;
}
const roleNames: Record<Role, string> = { admin: 'Администратор', member: 'Участник', viewer: 'Наблюдатель' };
const message = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить действие. Попробуйте ещё раз.';
const active = (user: User) => !user.status || user.status === 'active';

export default function Members({ state, onClose, onRefresh, onMatchSelf, onLogout, onSessionEnded, onSwitchFamily, onFamilyChanged }: MembersProps) {
  const admin = state.user.role === 'admin';
  const [guestRole, setGuestRole] = useState<'member' | 'viewer'>('member');
  const [approvalRoles, setApprovalRoles] = useState<Record<string, 'member' | 'viewer'>>({});
  const [busy, setBusy] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<{ context: string; value: CreatedInvitationLink } | null>(null);
  const lock = useRef(false);
  const familyName = state.family?.name || state.settings.name;
  const surnames = state.family?.surnames ?? state.settings.surnames ?? [];
  const applicants = admin ? state.users.filter(user => user.status === 'profile' || user.status === 'pending') : [];
  const rejected = admin ? state.users.filter(user => user.status === 'rejected') : [];
  const removed = admin ? state.users.filter(user => user.status === 'removed') : [];
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
  function closeAccess(user: User) {
    if (!window.confirm(`Закрыть доступ для «${user.name}»?\n\nЧеловек сразу выйдет на всех своих устройствах и не сможет войти. Всё, что он добавил, останется в семейном архиве. Доступ можно вернуть позже.`)) return;
    void mutate(`user-${user.id}`, () => api(`/api/users/${encodeURIComponent(user.id)}/deactivate`, json('POST', {})));
  }
  async function logoutEverywhere() {
    if (lock.current) return;
    if (!window.confirm('Выйти на всех устройствах, включая это?\n\nЧтобы продолжить, нужно будет войти заново. Несохранённые записи и черновики на этом устройстве останутся.')) return;
    const context = `user-${state.user.id}`;
    lock.current = true; setBusy('logout-all'); setErrors(current => ({ ...current, [context]: '' }));
    try { await api('/api/auth/logout-all', json('POST', {})); lock.current = false; onSessionEnded(); return; }
    catch (error) { setErrors(current => ({ ...current, [context]: message(error) })); }
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
    return <div className="members-created-link"><CopyLink key={link.invitation.id} url={`${window.location.origin}/#guest=${link.token}`} label="Ссылка-приглашение" showUrl /><p>Действует до {formatDate(link.invitation.expiresAt)} Скопируйте её сейчас: после закрытия окна можно будет создать новую.</p></div>;
  }

  async function exportData() {
    if (lock.current) return;
    lock.current = true; setBusy('export'); setErrors(current => ({ ...current, export: '' }));
    try { await download('/api/export', 'family-space.json'); }
    catch (error) { setErrors(current => ({ ...current, export: message(error) })); }
    finally { lock.current = false; setBusy(''); }
  }

  return <Modal open title="Участники семьи" onClose={onClose} wide>
    <div className="members-content">
      <div className="members-family"><div><strong>{familyName}</strong><small>{roleNames[state.user.role]}</small></div><button type="button" className="members-text-button" disabled={!!busy} onClick={onSwitchFamily}><ArrowLeftRight size={15} />Сменить семью</button></div>
      <section className="members-invite" aria-labelledby="members-invite-title">
        <div><h3 id="members-invite-title">Пригласить родственника</h3>{surnames.length > 0 && <p className="members-invite-surnames">{surnames.join(' · ')}</p>}<p>{admin ? 'Создайте ссылку-приглашение и отправьте её родственнику. По ней он попадёт именно в эту семью — через Telegram или без него.' : 'Приглашения создаёт администратор семьи. Попросите его прислать ссылку родственнику.'}</p></div>
        {admin && <div className="members-guest-actions"><label className="field">Доступ<select disabled={!!busy} value={guestRole} onChange={event => setGuestRole(event.target.value as 'member' | 'viewer')}><option value="member">Участник — добавляет и подтверждает</option><option value="viewer">Наблюдатель — только смотрит</option></select></label><button type="button" className="button primary" disabled={!!busy} onClick={() => createGuest('guest')}>{busy === 'guest' ? <LoaderCircle size={16} className="spin" /> : <Link size={16} />}Создать приглашение</button></div>}
        {admin && <p className="members-secondary-note">Ссылка действует 7 дней и используется один раз.</p>}
        {createdFor('guest')}{errorFor('guest')}
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
            {(self || admin) && <div className="members-person-actions">
              {self && <button type="button" className="members-text-button" disabled={!!busy} onClick={onMatchSelf}><Search size={15} />Найти себя в дереве</button>}
              {self && <button type="button" className="members-text-button" disabled={!!busy} onClick={() => void logoutEverywhere()}>{busy === 'logout-all' ? <LoaderCircle size={15} className="spin" /> : <MonitorSmartphone size={15} />}Выйти на всех устройствах</button>}
              {admin && user.authProvider === 'guest' && user.role !== 'admin' && <button type="button" className="members-text-button" disabled={!!busy} onClick={() => createGuest(context, user.id)}>{busy === context ? <LoaderCircle size={15} className="spin" /> : <Link size={15} />}Ссылка для входа</button>}
              {admin && !self && <button type="button" className="members-text-button members-danger" disabled={!!busy} onClick={() => closeAccess(user)}>{busy === context ? <LoaderCircle size={15} className="spin" /> : <UserX size={15} />}Закрыть доступ</button>}
            </div>}
            {self && person && <p className="members-linked-person">Вы связаны с карточкой «{person.name}».</p>}
            {createdFor(context)}{errorFor(context)}
          </article>;
        })}</div>
      </section>

      {admin && state.family && <FamilySettings family={state.family} onSaved={async () => { await onRefresh(); await onFamilyChanged(); }} />}

      {admin && <ServerStatusSummary settings={state.settings} />}

      {admin && <>
        {links.length > 0 && <details className="members-disclosure"><summary>Созданные приглашения · {links.length}</summary><div className="members-disclosure-content">
          <div className="members-links">{links.map(link => {
            const context = `link-${link.id}`;
            const status = linkStatus(link);
            const owner = link.userId ? state.users.find(user => user.id === link.userId) : null;
            return <article className="members-link-row" key={link.id}><div><strong>{owner ? `Вход: ${owner.name}` : `Приглашение · ${roleNames[link.role]}`}</strong><small>Создана {formatDate(link.createdAt)} · {status === 'Действует' ? `до ${formatDate(link.expiresAt)}` : status}</small></div>{status === 'Действует' && <button type="button" className="members-text-button" disabled={!!busy} onClick={() => void mutate(context, async () => { await api(`/api/guest-links/${encodeURIComponent(link.id)}/revoke`, json('POST', {})); if (created?.value.invitation.id === link.id) setCreated(null); })}>Отозвать</button>}{errorFor(context)}</article>;
          })}</div>
        </div></details>}
        {state.invitations.length > 0 && <details className="members-disclosure"><summary>Ранее приглашены по email</summary><div className="members-disclosure-content">{state.invitations.map(invitation => <div className="members-legacy-row" key={invitation.id}><strong>{invitation.email}</strong><span>{roleNames[invitation.role]} · {invitation.accepted ? 'Вошёл в пространство' : 'Ещё не вошёл'}</span></div>)}</div></details>}
        {removed.length > 0 && <details className="members-disclosure"><summary>Доступ закрыт · {removed.length}</summary><div className="members-disclosure-content">{removed.map(user => {
          const context = `removed-${user.id}`;
          return <article className="members-removed-row" key={user.id}><div className="members-person-main"><Avatar name={user.name} size={36} /><div><strong>{user.name || 'Участник'}</strong><small><span className="members-removed-label">Доступ закрыт</span>{user.phone ? ` · ${user.phone}` : ''}</small></div></div><button type="button" className="members-text-button" disabled={!!busy} onClick={() => void mutate(context, () => api(`/api/users/${encodeURIComponent(user.id)}/reactivate`, json('POST', {})))}>{busy === context ? <LoaderCircle size={15} className="spin" /> : <RotateCcw size={15} />}Вернуть доступ</button>{errorFor(context)}</article>;
        })}<p className="members-secondary-note">Добавленные ими материалы и сведения остаются в архиве.</p></div></details>}
        {rejected.length > 0 && <details className="members-disclosure"><summary>Отклонённые заявки · {rejected.length}</summary><div className="members-disclosure-content">{rejected.map(user => <div className="members-legacy-row" key={user.id}><strong>{user.name}</strong><span>{user.phone || 'Доступ не открыт'}</span></div>)}</div></details>}
        <button type="button" className="members-text-button members-export" disabled={!!busy} onClick={() => void exportData()}>{busy === 'export' ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}Скачать данные семьи</button>{errorFor('export')}
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

const MAX_SURNAMES = 5;
function formatBytes(bytes: number) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${new Intl.NumberFormat('ru', { maximumFractionDigits: unit < 2 ? 0 : 1 }).format(value)} ${units[unit]}`;
}

/** Admin-only: family name, public surnames shown on invitations, storage used. */
function FamilySettings({ family, onSaved }: { family: FamilyInfo; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(family.name);
  const [surnames, setSurnames] = useState(family.surnames.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const list = surnames.split(/[,;\n]/).map(item => item.trim()).filter(Boolean);
  const tooMany = list.length > MAX_SURNAMES;
  const dirty = name.trim() !== family.name || list.join('\n') !== family.surnames.join('\n');
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !name.trim() || tooMany || !dirty) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      await api<FamilySummary>(`/api/families/${encodeURIComponent(family.id)}`, json('PATCH', { name: name.trim(), surnames: list }));
      setSaved(true);
      try { await onSaved(); } catch { setError('Изменения сохранены, но экран не обновился. Обновите страницу.'); }
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  const limit = family.storageLimitBytes;
  const percent = limit ? Math.min(100, Math.round(family.storageBytes / limit * 100)) : 0;
  return <section className="members-section members-settings" aria-labelledby="members-settings-title">
    <div className="members-section-heading"><h3 id="members-settings-title">Настройки семьи</h3></div>
    <form className="form-stack" onSubmit={save}>
      <label className="field">Название семьи<input required maxLength={120} value={name} disabled={busy} onChange={event => { setName(event.target.value); setSaved(false); }} /></label>
      <label className="field">Фамилии в приглашении<input value={surnames} disabled={busy} placeholder="Ивановы, Петровы" aria-describedby="members-surnames-hint" onChange={event => { setSurnames(event.target.value); setSaved(false); }} /></label>
      <p id="members-surnames-hint" className={tooMany ? 'error-message' : 'form-hint'}>{tooMany ? `Можно указать не больше ${MAX_SURNAMES} фамилий.` : `До ${MAX_SURNAMES} фамилий через запятую. Их увидит родственник, открывший приглашение.`}</p>
      {error && <p className="error-message" role="alert">{error}</p>}
      {saved && !error && <p className="form-hint" role="status">Сохранено.</p>}
      <div><button type="submit" className="button secondary" disabled={busy || !name.trim() || tooMany || !dirty}>{busy ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}Сохранить</button></div>
    </form>
    <div className="members-storage">
      <span>Файлы семьи занимают {formatBytes(family.storageBytes)}{limit ? ` из ${formatBytes(limit)}` : ''}</span>
      {!!limit && <div className="members-storage-bar" role="progressbar" aria-label="Занятое место" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>}
    </div>
  </section>;
}
