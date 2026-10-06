import { execFile } from 'node:child_process';
import { open, stat, unlink, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fsyncDirectory, fsyncPath, sha256File } from './files.js';

const execute = promisify(execFile);
export class MediaError extends Error { constructor(readonly status: number, message: string) { super(message); } }
type Stream = { codec_type: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; duration?: string; disposition?: { attached_pic?: number } };
type MediaInfo = { streams: Stream[]; format?: { duration?: string }; stream_groups?: { components?: { width?: number; height?: number; coded_width?: number; coded_height?: number }[] }[] };
export type IdentifiedMedia = { mime: string; info: MediaInfo; needsPreview: boolean };
export type PreparedPreview = { previewPath: string; previewMime: string; previewSize: number; previewSha256: string };
const boundedSetting = (key: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[key] || fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new MediaError(503, `Проверьте настройку сервера ${key}.`);
  return value;
};
async function probe(path: string, groups = false): Promise<MediaInfo> {
  try {
    const { stdout } = await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', ...(groups ? ['-show_stream_groups'] : []), '-of', 'json', path], { timeout: 20000, maxBuffer: 1024 * 1024 });
    const data = JSON.parse(stdout) as MediaInfo;
    if (!Array.isArray(data.streams)) throw new Error('No media streams');
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MediaError(503, 'Проверка файлов недоступна: на сервере нужен ffmpeg.');
    throw new MediaError(400, 'Файл повреждён или его формат не удалось прочитать.');
  }
}
function duration(info: MediaInfo) {
  return Math.max(0, ...[info.format?.duration, ...info.streams.map(stream => stream.duration)].map(value => Number(value) || 0));
}
const ASF = Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]);
/** Content sniffing only; ffprobe confirms the streams. Formats common in digitised family archives are welcome. */
function sniff(header: Buffer): string {
  const ascii = (from: number, to: number) => header.toString('latin1', from, to);
  const packets = (offset: number, size: number) => [0, 1, 2].every(i => header[offset + i * size] === 0x47);
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(ascii(0, 6))) return 'image/gif';
  if (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*') return 'image/tiff';
  if (ascii(0, 2) === 'BM' && [12, 40, 52, 56, 64, 108, 124].includes(header.readUInt32LE(14))) return 'image/bmp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'AVI ') return 'video/x-msvideo';
  if (ascii(0, 4) === 'FORM' && /^AIF[FC]$/.test(ascii(8, 12))) return 'audio/aiff';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(0, 5) === '#!AMR') return 'audio/amr';
  if (ascii(0, 3) === 'FLV' && header[3] === 1) return 'video/x-flv';
  if (header.subarray(0, 16).equals(ASF)) return 'video/x-ms-asf';
  if (header.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0xba]))) return 'video/mpeg';
  if (packets(0, 188) || packets(4, 192)) return 'video/mp2t';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  // MPEG audio frames use layer bits 01–11; ADTS AAC shares the 0xFFF sync word with layer 00.
  if (header[0] === 255 && (header[1] & 0xf0) === 0xf0 && (header[1] & 0x06) === 0) return 'audio/aac';
  if (header[0] === 255 && (header[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (ascii(4, 8) === 'ftyp') return /avif|avis/.test(ascii(8, 32)) ? 'image/avif' : /heic|heix|hevc|hevx|mif1/.test(ascii(8, 32)) ? 'image/heic' : ascii(8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return ascii(0, 64).includes('webm') ? 'video/webm' : 'video/x-matroska';
  return '';
}
/** Recognised media keeps its original bytes; `needsPreview` asks for a browser copy prepared in the background. */
export async function identifyMedia(path: string): Promise<IdentifiedMedia> {
  const handle = await open(path, 'r'); const bytes = Buffer.alloc(512); let length: number;
  try { length = (await handle.read(bytes, 0, bytes.length, 0)).bytesRead; } finally { await handle.close(); }
  let mime = sniff(bytes.subarray(0, length).length >= 512 ? bytes : Buffer.concat([bytes.subarray(0, length), Buffer.alloc(512 - length)]));
  if (!mime) throw new MediaError(400, 'Этот формат не поддерживается. Загрузите фотографию, аудио или видео; SVG и документы не принимаются.');
  const info = await probe(path, mime === 'image/heic');
  const videos = info.streams.filter(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audios = info.streams.filter(stream => stream.codec_type === 'audio');
  if (mime.startsWith('image/')) {
    if (!videos.some(stream => (stream.width ?? 0) > 0 && (stream.height ?? 0) > 0)) throw new MediaError(400, 'Не удалось прочитать фотографию.');
  } else if (!audios.length && !videos.length) throw new MediaError(400, 'В файле не найдены аудио или видео.');
  else if (!videos.length && audios.length) mime = ({ 'video/mp4': 'audio/mp4', 'video/quicktime': 'audio/mp4', 'video/webm': 'audio/webm', 'video/x-matroska': 'audio/x-matroska', 'video/x-ms-asf': 'audio/x-ms-wma', 'video/x-msvideo': 'audio/x-msvideo', 'video/x-flv': 'audio/x-flv', 'video/mpeg': 'audio/mpeg', 'video/mp2t': 'audio/mp2t' } as Record<string, string>)[mime] ?? mime;
  else if (mime === 'audio/ogg' && videos.length) mime = 'video/ogg';
  const video = videos[0]; const audio = audios[0];
  const compatibleVideo = mime === 'video/mp4' && video?.codec_name === 'h264' && video.pix_fmt === 'yuv420p' && (!audio || audio.codec_name === 'aac');
  const compatibleAudio = (mime === 'audio/mpeg' && audio?.codec_name === 'mp3') || (mime === 'audio/mp4' && audio?.codec_name === 'aac') || (mime === 'audio/wav' && ['pcm_s16le', 'pcm_s24le'].includes(audio?.codec_name || ''));
  const largeImage = mime.startsWith('image/') && videos.some(stream => Math.max(stream.width ?? 0, stream.height ?? 0) > 12000 || (stream.width ?? 0) * (stream.height ?? 0) > 50_000_000);
  const browserImage = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(mime) && !largeImage;
  return { mime, info, needsPreview: !(browserImage || compatibleAudio || compatibleVideo) };
}

/**
 * Prepares a browser copy next to an immutable original. Failure never touches the original:
 * the caller records the reason and keeps serving the original for download.
 */
export async function createPreview(path: string, signal?: AbortSignal): Promise<PreparedPreview> {
  const { mime, info } = await identifyMedia(path);
  const video = info.streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const photo = mime.startsWith('image/');
  const maxDuration = boundedSetting('MEDIA_MAX_DURATION_SECONDS', 7200, 1, 86400);
  const timeout = boundedSetting('MEDIA_PREVIEW_TIMEOUT_MS', 900000, 1000, 7200000);
  const maxBytes = boundedSetting('MEDIA_PREVIEW_MAX_MB', 1024, 1, 4096) * 1024 * 1024;
  if (!photo && duration(info) > maxDuration) throw new MediaError(400, `Версия для просмотра готовится для записей до ${Math.floor(maxDuration / 60)} минут. Оригинал сохранён и доступен для скачивания.`);
  if (video && !photo && ((video.width ?? 0) * (video.height ?? 0) > 100_000_000 || Math.max(video.width ?? 0, video.height ?? 0) > 32768)) throw new MediaError(400, 'Разрешение файла слишком большое для подготовки просмотра.');
  for (const group of info.stream_groups ?? []) for (const component of group.components ?? []) {
    const width = Math.max(component.width ?? 0, component.coded_width ?? 0); const height = Math.max(component.height ?? 0, component.coded_height ?? 0);
    if (width * height > 250_000_000 || Math.max(width, height) > 65535) throw new MediaError(400, 'Разрешение фотографии слишком большое для подготовки просмотра.');
  }
  if (photo && video && (video.width ?? 0) * (video.height ?? 0) > 250_000_000) throw new MediaError(400, 'Разрешение фотографии слишком большое для подготовки просмотра.');
  const audioOnly = mime.startsWith('audio/');
  const extension = photo ? 'jpg' : audioOnly ? 'mp3' : 'mp4';
  const previewPath = `${path}.preview.${extension}`;
  const previewMime = photo ? 'image/jpeg' : audioOnly ? 'audio/mpeg' : 'video/mp4';
  const deadline = Date.now() + timeout;
  let temporaryDirectory: string | undefined;
  try {
    let inputPath = path;
    if (mime === 'image/heic') {
      // The complete primary HEIF image can span dozens of coded tiles. libheif
      // assembles them and applies image transforms; one FFmpeg stream is only a tile.
      temporaryDirectory = await mkdtemp(join(dirname(path), '.heic-preview-'));
      inputPath = join(temporaryDirectory, 'decoded.jpg');
      try {
        await execute(process.env.HEIF_CONVERT_PATH || 'heif-convert', ['-q', '90', path, inputPath], { timeout: Math.max(1, deadline - Date.now()), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, signal, env: { ...process.env, OMP_NUM_THREADS: '2' } });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MediaError(503, 'Для просмотра HEIC на сервере нужен heif-convert (libheif-examples). Оригинал сохранён.');
        throw error;
      }
      const decoded = await stat(inputPath).catch(() => null);
      if (!decoded || decoded.size > maxBytes) throw new MediaError(400, 'Не удалось подготовить основную фотографию HEIC. Оригинал сохранён.');
      const decodedInfo = await probe(inputPath);
      const dimensions = decodedInfo.streams.find(stream => stream.codec_type === 'video');
      if (!dimensions || (dimensions.width ?? 0) * (dimensions.height ?? 0) > 250_000_000) throw new MediaError(400, 'Разрешение фотографии слишком большое для подготовки просмотра.');
    }
    if (Date.now() >= deadline) throw new MediaError(400, 'Подготовка просмотра заняла слишком много времени.');
    const command = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-max_alloc', '1073741824', '-protocol_whitelist', 'file,pipe', '-threads', '2', '-filter_threads', '2', '-i', inputPath, '-map_metadata', '-1', '-sn', '-dn'];
    if (photo) command.push('-map', '0:v:0', '-frames:v', '1', '-vf', "scale=w='min(4096,iw)':h='min(4096,ih)':force_original_aspect_ratio=decrease", '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2');
    else if (audioOnly) command.push('-map', '0:a:0', '-vn', '-t', String(maxDuration + 1), '-c:a', 'libmp3lame', '-b:a', '128k', '-ac', '2', '-ar', '44100', '-f', 'mp3');
    else command.push('-map', '0:v:0', '-map', '0:a:0?', '-t', String(maxDuration + 1), '-vf', "yadif=deint=interlaced,scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4');
    command.push('-threads', '2', '-fs', String(maxBytes), '-y', previewPath);
    await execute(process.env.FFMPEG_PATH || 'ffmpeg', command, { timeout: Math.max(1, deadline - Date.now()), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, signal });
    const preview = await probe(previewPath); const bytes = (await stat(previewPath)).size;
    if (!bytes || bytes >= maxBytes - 65536) throw new MediaError(400, 'Версия для просмотра получилась слишком большой. Оригинал сохранён и доступен для скачивания.');
    if (!photo) {
      const actualDuration = duration(preview); const expectedDuration = duration(info);
      if (actualDuration <= 0 || actualDuration > maxDuration + 0.3 || (expectedDuration > 0 && Math.abs(actualDuration - expectedDuration) > Math.max(0.75, expectedDuration * 0.002))) throw new MediaError(400, 'Версия для просмотра получилась неполной. Оригинал сохранён и доступен для скачивания.');
    }
    await fsyncPath(previewPath); await fsyncDirectory(dirname(previewPath));
    return { previewPath: basename(previewPath), previewMime, previewSize: bytes, previewSha256: await sha256File(previewPath) };
  } catch (error) {
    await unlink(previewPath).catch(() => {});
    if (error instanceof MediaError) throw error;
    if (signal?.aborted) throw new MediaError(503, 'Подготовка просмотра прервана остановкой сервера.');
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MediaError(503, 'Подготовка просмотра недоступна: на сервере нужен ffmpeg. Оригинал сохранён.');
    if ((error as { killed?: boolean }).killed) throw new MediaError(400, 'Подготовка просмотра заняла слишком много времени. Оригинал сохранён и доступен для скачивания.');
    throw new MediaError(400, 'Не удалось подготовить версию для просмотра. Оригинал сохранён и доступен для скачивания.');
  } finally { if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }); }
}
