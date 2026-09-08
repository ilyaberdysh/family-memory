import { execFile } from 'node:child_process';
import { open, stat, unlink, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export class MediaError extends Error { constructor(readonly status: number, message: string) { super(message); } }
type Stream = { codec_type: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; duration?: string; disposition?: { attached_pic?: number } };
type MediaInfo = { streams: Stream[]; format?: { duration?: string }; stream_groups?: { components?: { width?: number; height?: number; coded_width?: number; coded_height?: number }[] }[] };
export type PreparedMedia = { mime: string; previewPath?: string; previewMime?: string; previewSize?: number };
let activeConversions = 0;
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
async function identify(path: string): Promise<{ mime: string; info: MediaInfo }> {
  const handle = await open(path, 'r'); const bytes = Buffer.alloc(64); let length: number;
  try { length = (await handle.read(bytes, 0, bytes.length, 0)).bytesRead; } finally { await handle.close(); }
  const header = bytes.subarray(0, length); const ascii = (from: number, to: number) => header.toString('ascii', from, to);
  let mime = '';
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png';
  else if (header[0] === 255 && header[1] === 216 && header[2] === 255) mime = 'image/jpeg';
  else if (/^GIF8[79]a/.test(ascii(0, 6))) mime = 'image/gif';
  else if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') mime = 'image/webp';
  else if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') mime = 'audio/wav';
  else if (ascii(0, 4) === 'OggS') mime = 'audio/ogg';
  else if (ascii(0, 4) === 'fLaC') mime = 'audio/flac';
  else if (ascii(0, 3) === 'ID3' || (header[0] === 255 && (header[1] & 0xe0) === 0xe0)) mime = 'audio/mpeg';
  else if (ascii(4, 8) === 'ftyp') mime = /avif|avis/.test(ascii(8, 32)) ? 'image/avif' : /heic|heix|hevc|hevx|mif1/.test(ascii(8, 32)) ? 'image/heic' : ascii(8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  else if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) mime = 'video/webm';
  if (!mime) throw new MediaError(400, 'Этот формат не поддерживается. Загрузите фотографию, аудио или видео; SVG и документы не принимаются.');
  const info = await probe(path, mime === 'image/heic');
  const videos = info.streams.filter(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audios = info.streams.filter(stream => stream.codec_type === 'audio');
  if (mime.startsWith('image/')) {
    if (!videos.some(stream => (stream.width ?? 0) > 0 && (stream.height ?? 0) > 0)) throw new MediaError(400, 'Не удалось прочитать фотографию.');
  } else if (!audios.length && !videos.length) throw new MediaError(400, 'В файле не найдены аудио или видео.');
  else if (['video/mp4', 'video/quicktime'].includes(mime) && !videos.length && audios.length) mime = 'audio/mp4';
  else if (mime === 'video/webm' && !videos.length && audios.length) mime = 'audio/webm';
  else if (mime === 'audio/ogg' && videos.length) mime = 'video/ogg';
  if (!mime.startsWith('image/') && !Number.isFinite(duration(info))) throw new MediaError(400, 'Не удалось определить длительность записи.');
  return { mime, info };
}

/** Preserve original bytes; prepare only formats that need a broadly playable derivative. */
export async function prepareMedia(path: string): Promise<PreparedMedia> {
  const { mime, info } = await identify(path);
  const video = info.streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = info.streams.find(stream => stream.codec_type === 'audio');
  const compatibleVideo = mime === 'video/mp4' && video?.codec_name === 'h264' && video.pix_fmt === 'yuv420p' && (!audio || audio.codec_name === 'aac');
  const compatibleAudio = (mime === 'audio/mpeg' && audio?.codec_name === 'mp3') || (mime === 'audio/mp4' && audio?.codec_name === 'aac') || (mime === 'audio/wav' && ['pcm_s16le', 'pcm_s24le'].includes(audio?.codec_name || ''));
  const photo = mime === 'image/heic';
  if ((mime.startsWith('image/') && !photo) || compatibleAudio || compatibleVideo) return { mime };
  const maxDuration = boundedSetting('MEDIA_MAX_DURATION_SECONDS', 7200, 1, 86400);
  const timeout = boundedSetting('MEDIA_PREVIEW_TIMEOUT_MS', 180000, 1000, 600000);
  const maxBytes = boundedSetting('MEDIA_PREVIEW_MAX_MB', 500, 1, 2048) * 1024 * 1024;
  if (!photo && duration(info) > maxDuration) throw new MediaError(400, `Для подготовки просмотра запись должна быть не длиннее ${Math.floor(maxDuration / 60)} минут.`);
  if (video && ((video.width ?? 0) * (video.height ?? 0) > 100_000_000 || Math.max(video.width ?? 0, video.height ?? 0) > 32768)) throw new MediaError(400, 'Разрешение файла слишком большое для подготовки просмотра.');
  for (const group of info.stream_groups ?? []) for (const component of group.components ?? []) {
    const width = Math.max(component.width ?? 0, component.coded_width ?? 0); const height = Math.max(component.height ?? 0, component.coded_height ?? 0);
    if (width * height > 100_000_000 || Math.max(width, height) > 32768) throw new MediaError(400, 'Разрешение фотографии слишком большое для подготовки просмотра.');
  }
  if (activeConversions >= 2) throw new MediaError(429, 'Сейчас готовятся другие записи. Повторите загрузку через несколько минут.');
  const audioOnly = mime.startsWith('audio/');
  const extension = photo ? 'jpg' : audioOnly ? 'mp3' : 'mp4';
  const previewPath = `${path}.preview.${extension}`;
  const previewMime = photo ? 'image/jpeg' : audioOnly ? 'audio/mpeg' : 'video/mp4';
  const deadline = Date.now() + timeout;
  let temporaryDirectory: string | undefined;
  activeConversions++;
  try {
    let inputPath = path;
    if (photo) {
      // The complete primary HEIF image can span dozens of coded tiles. libheif
      // assembles them and applies image transforms; one FFmpeg stream is only a tile.
      temporaryDirectory = await mkdtemp(join(dirname(path), '.heic-preview-'));
      inputPath = join(temporaryDirectory, 'decoded.jpg');
      try {
        await execute(process.env.HEIF_CONVERT_PATH || 'heif-convert', ['-q', '90', path, inputPath], { timeout: Math.max(1, deadline - Date.now()), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: { ...process.env, OMP_NUM_THREADS: '2' } });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MediaError(503, 'Для HEIC на сервере нужен heif-convert (libheif-examples).');
        throw error;
      }
      const decoded = await stat(inputPath).catch(() => null);
      if (!decoded || decoded.size > maxBytes) throw new MediaError(400, 'Не удалось подготовить основную фотографию HEIC. Попробуйте сохранить её как JPEG.');
      const decodedInfo = await probe(inputPath);
      const dimensions = decodedInfo.streams.find(stream => stream.codec_type === 'video');
      if (!dimensions || (dimensions.width ?? 0) * (dimensions.height ?? 0) > 100_000_000) throw new MediaError(400, 'Разрешение фотографии слишком большое для подготовки просмотра.');
    }
    if (Date.now() >= deadline) throw new MediaError(400, 'Подготовка просмотра заняла слишком много времени.');
    const command = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-max_alloc', '268435456', '-protocol_whitelist', 'file,pipe', '-threads', '2', '-filter_threads', '2', '-i', inputPath, '-map_metadata', '-1', '-sn', '-dn'];
    if (photo) command.push('-map', '0:v:0', '-frames:v', '1', '-vf', "scale=w='min(4096,iw)':h='min(4096,ih)':force_original_aspect_ratio=decrease", '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2');
    else if (audioOnly) command.push('-map', '0:a:0', '-vn', '-t', String(maxDuration + 1), '-c:a', 'libmp3lame', '-b:a', '128k', '-ac', '2', '-ar', '44100', '-f', 'mp3');
    else command.push('-map', '0:v:0', '-map', '0:a:0?', '-t', String(maxDuration + 1), '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4');
    command.push('-threads', '2', '-fs', String(maxBytes), '-y', previewPath);
    await execute(process.env.FFMPEG_PATH || 'ffmpeg', command, { timeout: Math.max(1, deadline - Date.now()), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    const preview = await probe(previewPath); const bytes = (await stat(previewPath)).size;
    if (!bytes || bytes >= maxBytes - 65536) throw new MediaError(400, 'Версия для просмотра превышает допустимый размер. Исходная загрузка не сохранена.');
    if (!photo) {
      const actualDuration = duration(preview); const expectedDuration = duration(info);
      if (actualDuration <= 0 || actualDuration > maxDuration + 0.3 || (expectedDuration > 0 && Math.abs(actualDuration - expectedDuration) > Math.max(0.75, expectedDuration * 0.002))) throw new MediaError(400, 'Не удалось подготовить запись целиком. Исходная загрузка не сохранена.');
    }
    return { mime, previewPath: basename(previewPath), previewMime, previewSize: bytes };
  } catch (error) {
    await unlink(previewPath).catch(() => {});
    if (error instanceof MediaError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MediaError(503, 'Подготовка просмотра недоступна: на сервере нужен ffmpeg.');
    if ((error as { killed?: boolean }).killed) throw new MediaError(400, 'Подготовка просмотра заняла слишком много времени. Загрузите более короткую запись или MP4 H.264 / MP3.');
    throw new MediaError(400, 'Не удалось подготовить файл для просмотра. Попробуйте JPEG, MP3 или MP4 H.264.');
  } finally { activeConversions--; if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }); }
}
