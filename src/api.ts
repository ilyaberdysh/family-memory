import type { UploadedFile } from '../shared/types';

/** network: no response at all; format: the server answered something that is not our JSON;
 * cancelled/stalled/timeout: the upload was stopped on this device and the file is still here. */
export type ApiErrorKind = 'http' | 'network' | 'format' | 'cancelled' | 'stalled' | 'timeout';
export class ApiError extends Error {
  readonly status: number;
  readonly kind: ApiErrorKind;
  /** Machine-readable reason from the server, e.g. 'family_required' or 'not_member'. */
  readonly code?: string;
  constructor(message: string, status: number, kind: ApiErrorKind = 'http', code?: string) { super(message); this.name = 'ApiError'; this.status = status; this.kind = kind; this.code = code; }
}

/* ---- current family: every family-scoped request carries X-Family-Id ---- */
const FAMILY_KEY = 'family-memory:family:v1';
let currentFamilyId: string | null = null;
const familyLostListeners = new Set<(familyId: string | null) => void>();
export function getCurrentFamily() { return currentFamilyId; }
export function setCurrentFamily(id: string | null) { currentFamilyId = id; }
/** The family last opened by this person on this device. */
export function lastFamily(userId: string): string | null { try { return localStorage.getItem(`${FAMILY_KEY}:${userId}`); } catch { return null; } }
export function rememberFamily(userId: string, familyId: string | null) {
  try { if (familyId) localStorage.setItem(`${FAMILY_KEY}:${userId}`, familyId); else localStorage.removeItem(`${FAMILY_KEY}:${userId}`); } catch { /* remembered for this page only */ }
}
/** Called when the server says the current family is missing or not ours; the app shows the family chooser. */
export function onFamilyLost(listener: (familyId: string | null) => void): () => void { familyLostListeners.add(listener); return () => { familyLostListeners.delete(listener); }; }
const FAMILY_CODES = new Set(['family_required', 'not_member']);
function familyHeaders(): Record<string, string> { return currentFamilyId ? { 'X-Family-Id': currentFamilyId } : {}; }
function checkFamilyError(status: number, value: unknown): string | undefined {
  const code = value && typeof value === 'object' && typeof (value as { code?: unknown }).code === 'string' ? (value as { code: string }).code : undefined;
  if (code && FAMILY_CODES.has(code) && (status === 400 || status === 403 || status === 404)) {
    const lost = currentFamilyId;
    for (const listener of [...familyLostListeners]) listener(lost);
  }
  return code;
}

const KEPT = 'файл остался на устройстве';
const uploadMessages = {
  tooLarge: 'Файл слишком большой для сервера или прокси. Он остался на устройстве — сохраните его там и сообщите администратору.',
  gateway: `Сервер не дождался окончания загрузки — проверьте соединение и попробуйте ещё раз; ${KEPT}.`,
  network: `Загрузка прервалась: нет связи с сервером. Проверьте соединение и попробуйте ещё раз; ${KEPT}.`,
  stalled: `Загрузка остановилась: больше минуты не передавалось ни байта. Проверьте соединение и попробуйте ещё раз; ${KEPT}.`,
  timeout: `Сервер слишком долго не подтверждает загрузку. Проверьте соединение и попробуйте ещё раз; ${KEPT}.`,
  cancelled: `Загрузка отменена; ${KEPT}. Её можно отправить ещё раз.`,
  format: `Сервер ответил неожиданно — возможно, истёк вход или мешает прокси. Обновите страницу и попробуйте ещё раз; ${KEPT}.`,
};

function statusMessage(status: number, uploading: boolean): string | null {
  if (status === 413) return uploading ? uploadMessages.tooLarge : 'Слишком большой объём данных для сервера или прокси.';
  if (status === 502 || status === 504) return uploading ? uploadMessages.gateway : 'Сервер не ответил вовремя. Проверьте соединение и попробуйте ещё раз.';
  if (status === 503) return 'Сервер временно недоступен. Попробуйте ещё раз через минуту.';
  if (status === 0) return uploading ? uploadMessages.network : 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.';
  return null;
}
function parse(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }
function serverMessage(value: unknown): string | null {
  return value && typeof value === 'object' && typeof (value as { error?: unknown }).error === 'string' && (value as { error: string }).error.trim() ? (value as { error: string }).error : null;
}

export function json(method: string, body: unknown): RequestInit { return { method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }; }
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { ...options, credentials:'same-origin', headers:{'X-Requested-With':'family-space',...familyHeaders(),...options.headers} }); }
  catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(statusMessage(0, false)!, 0, 'network');
  }
  const text = await response.text().catch(() => '');
  const value = parse(text);
  if (!response.ok) {
    const code = checkFamilyError(response.status, value);
    throw new ApiError(serverMessage(value) || statusMessage(response.status, false) || `Не удалось выполнить действие (ошибка ${response.status}). Попробуйте ещё раз.`, response.status, 'http', code);
  }
  if (response.status === 204) return undefined as T;
  // A 2xx page that is not JSON is usually a proxy login page or the app shell: never report it as success.
  if (value === undefined) throw new ApiError('Сервер ответил неожиданно — возможно, истёк вход или мешает прокси. Обновите страницу и попробуйте ещё раз.', response.status, 'format');
  return value as T;
}

export interface UploadOptions {
  onProgress?: (percent: number) => void;
  /** Abort to cancel the upload; the promise then rejects with an ApiError of kind 'cancelled'. */
  signal?: AbortSignal;
  /** No upload progress for this long aborts the transfer (default 60 s). */
  stallTimeoutMs?: number;
  /** After the last byte is sent, how long to wait for the server's answer (default 3 min). */
  responseTimeoutMs?: number;
}

export function upload(file: File, options: UploadOptions | ((percent: number) => void) = {}): Promise<UploadedFile> {
  const { onProgress, signal, stallTimeoutMs = 60000, responseTimeoutMs = 180000 } = typeof options === 'function' ? { onProgress: options } as UploadOptions : options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ApiError(uploadMessages.cancelled, 0, 'cancelled')); return; }
    const xhr = new XMLHttpRequest();
    let settled = false; let sent = false; let lastActivity = Date.now(); let failure: ApiError | null = null;
    const stop = (error: ApiError) => { if (settled || failure) return; failure = error; xhr.abort(); };
    // Hidden pages (a locked phone) may be paused by the browser; give a fresh minute after coming back.
    const watchdog = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - lastActivity > (sent ? responseTimeoutMs : stallTimeoutMs)) stop(sent ? new ApiError(uploadMessages.timeout, 0, 'timeout') : new ApiError(uploadMessages.stalled, 0, 'stalled'));
    }, 2000);
    const visibility = () => { if (document.visibilityState === 'visible') lastActivity = Date.now(); };
    const cancel = () => stop(new ApiError(uploadMessages.cancelled, 0, 'cancelled'));
    document.addEventListener('visibilitychange', visibility);
    signal?.addEventListener('abort', cancel);
    const settle = (action: () => void) => {
      if (settled) return; settled = true;
      window.clearInterval(watchdog); document.removeEventListener('visibilitychange', visibility); signal?.removeEventListener('abort', cancel);
      action();
    };
    xhr.open('POST', '/api/files');
    xhr.setRequestHeader('X-Requested-With', 'family-space');
    for (const [name, value] of Object.entries(familyHeaders())) xhr.setRequestHeader(name, value);
    xhr.withCredentials = true;
    xhr.upload.onprogress = event => { lastActivity = Date.now(); if (event.lengthComputable && event.total > 0) onProgress?.(Math.min(100, Math.round(event.loaded / event.total * 100))); };
    xhr.upload.onload = () => { sent = true; lastActivity = Date.now(); onProgress?.(100); };
    xhr.onerror = () => settle(() => reject(failure ?? new ApiError(uploadMessages.network, 0, 'network')));
    xhr.onabort = () => settle(() => reject(failure ?? new ApiError(uploadMessages.cancelled, 0, 'cancelled')));
    xhr.onload = () => settle(() => {
      const data = parse(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        if (data && typeof data === 'object' && typeof (data as UploadedFile).id === 'string') resolve(data as UploadedFile);
        else reject(new ApiError(uploadMessages.format, xhr.status, 'format'));
        return;
      }
      const code = checkFamilyError(xhr.status, data);
      reject(new ApiError(serverMessage(data) || statusMessage(xhr.status, true) || `Не удалось загрузить файл (ошибка ${xhr.status}); ${KEPT}.`, xhr.status, 'http', code));
    });
    const form = new FormData(); form.append('file', file);
    try { xhr.send(form); } catch { settle(() => reject(new ApiError(uploadMessages.network, 0, 'network'))); }
  });
}

/** Downloads a family-scoped file (e.g. the export) with the family header, which a plain link cannot send. */
export async function download(path: string, fallbackName: string): Promise<void> {
  let response: Response;
  try { response = await fetch(path, { credentials: 'same-origin', headers: { 'X-Requested-With': 'family-space', ...familyHeaders() } }); }
  catch { throw new ApiError(statusMessage(0, false)!, 0, 'network'); }
  if (!response.ok) {
    const value = parse(await response.text().catch(() => ''));
    const code = checkFamilyError(response.status, value);
    throw new ApiError(serverMessage(value) || statusMessage(response.status, false) || `Не удалось скачать файл (ошибка ${response.status}).`, response.status, 'http', code);
  }
  const blob = await response.blob();
  const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(response.headers.get('Content-Disposition') || '')?.[1];
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name ? decodeURIComponent(name) : fallbackName;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
