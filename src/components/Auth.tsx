import { useEffect, useState } from 'react';
import { ArrowRight, Check, Clock3, Link2, LoaderCircle, Network, Send, ShieldCheck } from 'lucide-react';
import type { AuthConfig, AuthSession, GuestRedeemResult, InvitationPreview, NameParts } from '../../shared/types';
import { api, json, rememberFamily } from '../api';
import './Auth.css';

type Props = { config: AuthConfig; session: AuthSession; onChanged: () => Promise<void> };
const emptyName: NameParts = { firstName: '', lastName: '', patronymic: '' };
/** An invitation opened before a Telegram sign-in survives the round trip to Telegram in this tab. */
const PENDING_GUEST = 'family-memory:pending-guest';
export function guestTokenFromUrl(): string {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('guest');
  if (fromHash) return fromHash;
  try { return sessionStorage.getItem(PENDING_GUEST) || ''; } catch { return ''; }
}
function forgetGuestToken() {
  if (location.hash.includes('guest=')) history.replaceState(null, '', location.pathname);
  try { sessionStorage.removeItem(PENDING_GUEST); } catch { /* nothing stored */ }
}

export default function Auth({ config, session, onChanged }: Props) {
  const user = session.user;
  const [parts, setParts] = useState<NameParts>(user?.nameParts ?? emptyName);
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => new URLSearchParams(location.search).get('auth') === 'telegram_failed'
    ? 'Не удалось завершить вход через Telegram. Попробуйте ещё раз.' : '');
  const [guestToken, setGuestToken] = useState(guestTokenFromUrl);
  const [guest, setGuest] = useState<InvitationPreview | null>(null);
  const [guestLoading, setGuestLoading] = useState(Boolean(guestToken));
  const [guestError, setGuestError] = useState('');
  const invited = new URLSearchParams(location.search).get('join') === '1';

  useEffect(() => {
    setParts(user?.nameParts ?? emptyName);
    setPhone(user?.phone ?? '');
  }, [user?.id]);

  useEffect(() => {
    if (!guestToken || (user && user.status && user.status !== 'active')) { setGuestLoading(false); return; }
    let current = true;
    setGuestLoading(true);
    api<InvitationPreview>('/api/auth/guest-preview', json('POST', { token: guestToken }))
      .then(value => { if (current) { setGuest(value); setGuestError(''); } })
      .catch(e => { if (current) setGuestError((e as Error).message); })
      .finally(() => { if (current) setGuestLoading(false); });
    return () => { current = false; };
  }, [guestToken, user?.id]);

  useEffect(() => {
    if (user?.status !== 'pending') return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') onChanged().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [user?.status, onChanged]);

  function clearEntryLink() {
    forgetGuestToken();
    setGuestToken('');
    setGuest(null);
    setGuestError('');
  }

  async function action(work: () => Promise<void>) {
    setBusy(true); setError('');
    try { await work(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function telegram() {
    await action(async () => {
      if (guestToken) try { sessionStorage.setItem(PENDING_GUEST, guestToken); } catch { /* the link can be opened again */ }
      const result = await api<{ url: string }>('/api/auth/telegram/start', json('POST', {}));
      location.assign(result.url);
    });
  }

  async function acceptGuest() {
    await action(async () => {
      const result = await api<GuestRedeemResult>('/api/auth/guest', json('POST', { token: guestToken }));
      if (result?.familyId && result.user?.id) {
        rememberFamily(result.user.id, result.familyId);
        try { sessionStorage.setItem(`family-join:${result.user.id}:${result.familyId}`, '1'); } catch { /* matching can be started from Members */ }
      }
      clearEntryLink();
      await onChanged();
    });
  }

  async function submitProfile(event: React.FormEvent) {
    event.preventDefault();
    await action(async () => {
      await api('/api/auth/profile', json('POST', { nameParts: parts, phone }));
      clearEntryLink();
      await onChanged();
    });
  }

  async function notNow() {
    await action(async () => { clearEntryLink(); await onChanged(); });
  }

  async function logout() {
    await action(async () => { await api('/api/auth/logout', json('POST', {})); await onChanged(); });
  }

  async function local() {
    await action(async () => {
      const email = 'admin@local.invalid';
      const result = await api<{ devCode?: string }>('/api/auth/request-code', json('POST', { email, name: 'Локальный администратор' }));
      if (!result.devCode) throw new Error('Локальный просмотр недоступен.');
      await api('/api/auth/verify', json('POST', { email, code: result.devCode }));
      clearEntryLink();
      await onChanged();
    });
  }

  const profile = user?.status === 'profile';
  const pending = user?.status === 'pending';
  const rejected = user?.status === 'rejected';
  const signedIn = Boolean(user) && !profile && !pending && !rejected;
  const guestEntry = Boolean(guestToken) && (!user || signedIn);
  const inviteFamily = guest?.family;
  const familyName = inviteFamily?.name || '';

  return <div className="auth-page join-page">
    <div className="auth-brand"><span className="brand-mark"><Network size={23} /></span><span>{config.name}</span></div>
    <main className="auth-card join-card">
      <span className={`join-symbol ${pending ? 'join-symbol-waiting' : ''}`}>
        {pending ? <Clock3 size={29} /> : profile ? <Check size={29} /> : guestEntry ? <Link2 size={29} /> : <Network size={29} />}
      </span>
      <p className="join-space-name">{guestEntry && familyName ? 'Приглашение в семейное пространство' : config.name}</p>
      <h1>{profile ? 'Давайте познакомимся' : pending ? 'Заявка отправлена' : rejected ? 'Доступ не подтверждён'
        : guestEntry && familyName ? familyName
          : guestEntry || invited ? 'Вас пригласили в семейный архив' : 'Всё, что связывает семью'}</h1>
      {guestEntry && !!inviteFamily?.surnames?.length && <p className="join-surnames" aria-label="Фамилии этой семьи">{inviteFamily.surnames.join(' · ')}</p>}
      <p className="auth-description">
        {profile ? 'Расскажите, как вас зовут. После входа поможем найти вашу карточку в дереве.'
          : pending ? 'Администратор этого пространства подтвердит доступ. После этого откроются семейное дерево и архив.'
          : rejected ? 'Администратор пока не разрешил доступ. Свяжитесь с человеком, который вас пригласил.'
          : guestEntry && signedIn ? `Вы присоединитесь как ${user!.name}. Семья появится рядом с вашими — переключаться между ними можно по названию вверху.`
          : guestEntry ? 'Доступ уже разрешён. Осталось указать своё имя и телефон.'
          : 'Люди, истории и воспоминания. Войдите через Telegram, чтобы создать пространство своей семьи или открыть семьи, где вы участвуете.'}
      </p>

      {profile ? <form className="form-stack" onSubmit={submitProfile}>
        {(['lastName', 'firstName', 'patronymic'] as const).map(key => <label className="field" key={key}>
          {key === 'lastName' ? 'Фамилия' : key === 'firstName' ? 'Имя' : 'Отчество'}
          {key === 'patronymic' && <span className="join-optional">Необязательно</span>}
          <input required={key !== 'patronymic'} autoComplete={key === 'lastName' ? 'family-name' : key === 'firstName' ? 'given-name' : 'additional-name'}
            value={parts[key]} maxLength={100} onChange={e => setParts(previous => ({ ...previous, [key]: e.target.value }))} />
        </label>)}
        <label className="field">Телефон
          <input type="tel" inputMode="tel" autoComplete="tel" placeholder="+7 999 123-45-67" required value={phone} maxLength={30} onChange={e => setPhone(e.target.value)} />
          {user.phoneVerified && phone === user.phone && <span className="join-verified"><ShieldCheck size={13} />Подтверждён в Telegram</span>}
        </label>
        {error && <p className="error-message" role="alert">{error}</p>}
        <button className="button primary full" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />}
          Продолжить</button>
        <button type="button" className="text-button join-secondary" disabled={busy} onClick={logout}>Выйти</button>
      </form> : pending ? <div className="join-status" aria-live="polite">
        <div className="join-request-person"><strong>{user.name}</strong><span>{user.phone}</span></div>
        {error && <p className="error-message" role="alert">{error}</p>}
        <button className="button secondary full" disabled={busy} onClick={() => action(onChanged)}>
          {busy && <LoaderCircle className="spin" size={17} />}Проверить статус</button>
        <p className="form-hint">Можно закрыть страницу. Ваш вход сохранится.</p>
        <button className="text-button join-secondary" disabled={busy} onClick={logout}>Выйти</button>
      </div> : rejected ? <>
        {error && <p className="error-message" role="alert">{error}</p>}
        <button className="button secondary full" disabled={busy} onClick={logout}>Выйти</button>
      </> : guestEntry ? <div className="join-guest-entry">
        {guestLoading ? <p className="join-checking" role="status"><LoaderCircle className="spin" size={19} />Проверяем приглашение…</p>
          : guestError ? <><p className="error-message" role="alert">{guestError}</p><p className="form-hint">Попросите администратора прислать новую ссылку.</p>
            <button className="button secondary full" disabled={busy} onClick={signedIn ? notNow : clearEntryLink}>{signedIn ? 'Вернуться к своим семьям' : 'Перейти ко входу'}</button></>
            : guest && <><div className="join-access"><ShieldCheck size={18} /><span>{guest.role === 'viewer' ? 'Вы сможете смотреть дерево и архив' : 'Вы сможете добавлять истории и подтверждать сведения'}</span></div>
              {error && <p className="error-message" role="alert">{error}</p>}
              <button className="button primary full" disabled={busy} onClick={acceptGuest}>{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />}{signedIn ? 'Присоединиться' : 'Принять приглашение'}</button>
              {signedIn ? <button type="button" className="text-button join-secondary" disabled={busy} onClick={notNow}>Не сейчас</button>
                : config.telegramAvailable && <button type="button" className="text-button join-secondary" disabled={busy} onClick={telegram}><Send size={16} />У меня есть Telegram — войти через него</button>}</>}
      </div> : <div className="join-login">
        {error && <p className="error-message" role="alert">{error}</p>}
        <button className="button primary full telegram-login" onClick={telegram} disabled={busy || !config.telegramAvailable}>
          {busy ? <LoaderCircle className="spin" size={19} /> : <Send size={19} />}Войти через Telegram</button>
        {!config.telegramAvailable && <p className="form-hint">{config.devMode ? 'Подключаем Telegram для семейного доступа. Локальный просмотр уже работает.' : 'Вход временно недоступен. Попробуйте позже.'}</p>}
        <p className="join-login-note">После входа можно создать семью или открыть приглашение от родственника.</p>
        <details className="join-no-telegram"><summary>Нет Telegram?</summary><p>Попросите родственника, у которого уже есть семейное пространство, прислать ссылку-приглашение. По ней можно войти без Telegram.</p></details>
        {config.devMode && <div className="local-entry"><button className="button secondary full" disabled={busy} onClick={local}>Открыть локальный просмотр<ArrowRight size={16} /></button><small>Данные сохраняются на этом компьютере.</small></div>}
      </div>}
      <p className="auth-footnote"><ShieldCheck size={14} />Семейные данные доступны только участникам</p>
    </main>
  </div>;
}
