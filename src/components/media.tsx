import { LoaderCircle } from 'lucide-react';
import type { UploadedFile } from '../../shared/types';

/** The browser copy (HEIC→JPEG, webm→mp3, …) is still being prepared; the original is served meanwhile. */
export const previewPending = (file?: UploadedFile | null) => file?.previewStatus === 'pending' || file?.previewStatus === 'processing';
export const previewFailed = (file?: UploadedFile | null) => file?.previewStatus === 'failed';
/** Changes once the preview is ready so media elements reload instead of keeping the original response. */
export function mediaSrc(file: UploadedFile) {
  const base = `/api/files/${encodeURIComponent(file.id)}`;
  return file.previewStatus === 'ready' ? `${base}?v=ready` : base;
}
export const originalHref = (file: UploadedFile) => `${file.url}?original=1`;

/** `link={false}` when a "Скачать оригинал" link is already right next to the media. */
export function PreviewNote({ file, className = '', link = true }: { file?: UploadedFile | null; className?: string; link?: boolean }) {
  if (!file) return null;
  if (previewPending(file)) return <p className={`media-preview-note ${className}`} role="status"><LoaderCircle size={15} className="spin" aria-hidden="true" />Готовим версию для просмотра…</p>;
  if (previewFailed(file)) return <p className={`media-preview-note is-failed ${className}`} role="status">Просмотр в браузере недоступен — оригинал сохранён.{link && <> <a href={originalHref(file)} download={file.name}>Скачать оригинал</a></>}</p>;
  return null;
}
