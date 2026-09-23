import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import os from 'os';
import { rm } from 'fs/promises';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import multer from 'multer';
import dotenv from 'dotenv';
import { DEMO_MEETING_1, DEMO_MEETING_2, DEMO_MEETING_3_KZ } from './src/data/mockData';
import {
  parseRawTranscriptText,
} from './src/services/analyzer';
import { buildAudioReport, type LocalAsrResult } from './src/services/reportBuilder';
import { normalizeMeetingReport } from './src/services/reportNormalizer';
import { buildIntegrationBundle, type IntegrationKind } from './src/services/integrationService';
import type { MeetingReport } from './src/types';

dotenv.config();

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    console.warn(`${name}=${raw} некорректен; используется значение ${fallback}`);
    return fallback;
  }
  return value;
}

const app = express();
const port = boundedInteger('PORT', 3000, 1, 65_535);
const host = process.env.HOST || '127.0.0.1';
const maxAudioMb = boundedInteger('MAX_AUDIO_MB', 100, 1, 1_024);
const maxConcurrentAsrJobs = boundedInteger('MAX_CONCURRENT_ASR_JOBS', 1, 1, 16);
const allowedAudioExtensions = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.mp4']);
const allowedAudioMimeTypes = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/vnd.wave',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'application/ogg',
  'audio/webm',
  'video/webm',
  'video/mp4',
  // Windows and some browsers do not provide a useful MIME type for local files.
  // The extension is still checked and ffmpeg validates the actual container later.
  'application/octet-stream',
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const extension = path.extname(file.originalname).toLowerCase();
      cb(null, `meeting-assistant-${randomUUID()}${extension}`);
    },
  }),
  limits: {
    fileSize: maxAudioMb * 1024 * 1024,
    files: 1,
    fields: 4,
    parts: 5,
    fieldSize: 16 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype.toLowerCase();
    if (!allowedAudioExtensions.has(extension) || !allowedAudioMimeTypes.has(mime)) {
      return cb(new Error('UNSUPPORTED_AUDIO_TYPE'));
    }
    cb(null, true);
  },
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const python = process.env.ASR_PYTHON || 'python3';
const asrScript = path.resolve(process.env.ASR_SCRIPT || 'scripts/transcribe_local.py');
const asrTimeoutMs = boundedInteger('ASR_TIMEOUT_MS', 15 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000);
let activeAsrJobs = 0;

interface OutboxReceipt {
  id: string;
  kind: IntegrationKind;
  report_id: string;
  created_at: string;
  status: 'queued_local';
  external_transmission: false;
  items: number;
}

// Privacy-first demo outbox: only audit metadata is retained in RAM. Protocol
// text, audio and recipient excerpts are not persisted by this connector.
const integrationOutbox: OutboxReceipt[] = [];

function runPython(args: string[], timeoutMs = asrTimeoutMs, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [asrScript, ...args], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let terminationReason: Error | null = null;
    const terminate = (reason: Error) => {
      if (terminationReason) return;
      terminationReason = reason;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () => terminate(new Error(`Локальная обработка превысила ${Math.round(timeoutMs / 1000)} сек.`)),
      timeoutMs,
    );
    const abortHandler = () => terminate(new Error('Клиент отменил обработку аудио'));
    signal?.addEventListener('abort', abortHandler, { once: true });

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 20 * 1024 * 1024) {
        terminate(new Error('ASR вернул слишком большой результат'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 2 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      if (terminationReason) reject(terminationReason);
      else if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `ASR завершился с кодом ${code}`));
    });
  });
}

async function localAsrStatus() {
  try {
    const output = await runPython(['--check'], 20_000);
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('ASR health-check вернул некорректный ответ');
    }
    const value = parsed as Record<string, unknown>;
    return {
      ready: value.ready === true,
      asr: value.asr === true,
      diarization: value.diarization === true,
      ffmpeg: value.ffmpeg === true,
      ffprobe: value.ffprobe === true,
      local_only: value.local_only === true,
      detail: typeof value.detail === 'string' ? value.detail : 'Статус локальных моделей не определён',
    };
  } catch (error: unknown) {
    return {
      ready: false,
      asr: false,
      diarization: false,
      ffmpeg: false,
      ffprobe: false,
      local_only: !['1', 'true', 'yes', 'on'].includes((process.env.ALLOW_MODEL_DOWNLOAD || '').trim().toLowerCase()),
      detail: error instanceof Error ? error.message : 'Не удалось проверить локальные модели',
    };
  }
}

function parseSpeakerMapping(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const entries = Object.entries(value);
    if (entries.length > 100) throw new Error();
    if (entries.some(([key, name]) => !/^SPEAKER_[A-Za-z0-9_-]+$/.test(key) || typeof name !== 'string' || !name.trim() || name.length > 200)) {
      throw new Error();
    }
    return Object.fromEntries(entries.map(([key, name]) => [key, (name as string).trim()]));
  } catch {
    throw new Error('Сопоставление спикеров должно быть валидным JSON-объектом');
  }
}

function parseAudioSource(raw: unknown): 'local_audio' | 'mic_recording' {
  if (raw === undefined || raw === null || raw === '' || raw === 'local_audio') return 'local_audio';
  if (raw === 'mic_recording') return 'mic_recording';
  throw new Error('Источник аудио должен быть local_audio или mic_recording');
}

function parseMeetingReportPayload(value: unknown): MeetingReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Поле report должно содержать объект протокола');
  }
  const candidate = value as Partial<MeetingReport>;
  if (
    typeof candidate.id !== 'string' || candidate.id.length > 300 ||
    typeof candidate.title !== 'string' || candidate.title.length > 500 ||
    !Array.isArray(candidate.actions) || candidate.actions.length > 10_000 ||
    !Array.isArray(candidate.segments) || candidate.segments.length > 100_000 ||
    !Array.isArray(candidate.summary) || candidate.summary.length > 10_000
  ) {
    throw new Error('Некорректная структура протокола');
  }
  return normalizeMeetingReport(candidate as MeetingReport);
}

app.get('/api/health', async (_req, res) => {
  const local = await localAsrStatus();
  res.status(local.ready ? 200 : 503).json({
    status: local.ready ? 'ok' : 'degraded',
    local_only: local.local_only,
    asr_model: local.asr,
    diarization_model: local.diarization,
    ffmpeg: local.ffmpeg,
    ffprobe: local.ffprobe,
    demo_available: true,
    detail: local.detail,
    local_time: new Date().toISOString(),
  });
});

app.get('/api/demo/:id', (req, res) => {
  const reports: Record<string, MeetingReport> = {
    '1': DEMO_MEETING_1,
    '2': DEMO_MEETING_2,
    '3': DEMO_MEETING_3_KZ,
  };
  const report = reports[req.params.id];
  return report
    ? res.json({ report: normalizeMeetingReport(report) })
    : res.status(404).json({ error: 'Демо не найдено' });
});

app.post('/api/analyze-text', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { text, title, organization } = body;
    if (typeof text !== 'string' || text.trim().length < 3) {
      return res.status(400).json({ error: 'Добавьте непустой текст стенограммы' });
    }
    if (text.length > 1_000_000) return res.status(413).json({ error: 'Текст превышает лимит 1 000 000 символов' });
    const report = parseRawTranscriptText(text.trim(), typeof title === 'string' ? title.trim() : undefined);
    if (report.segments.length === 0) {
      return res.status(422).json({ error: 'В тексте не найдены реплики участников' });
    }
    if (typeof organization === 'string' && organization.trim()) report.organization = organization.trim();
    return res.json({ report });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Не удалось проанализировать текст' });
  }
});

app.get('/api/integrations/outbox', (_req, res) => {
  return res.json({
    mode: 'local_mock',
    external_transmission: false,
    entries: integrationOutbox,
  });
});

app.post('/api/integrations/outbox', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const kind = (body as { kind?: unknown }).kind;
    if (kind !== 'sed' && kind !== 'distribution') {
      return res.status(400).json({ error: 'kind должен быть sed или distribution' });
    }
    const report = parseMeetingReportPayload((body as { report?: unknown }).report);
    if (report.review_required || report.stats.needs_review > 0) {
      return res.status(409).json({
        error: 'Сначала утвердите протокол и заполните обязательные поля поручений',
        code: 'APPROVAL_REQUIRED',
      });
    }

    const createdAt = new Date().toISOString();
    const bundle = buildIntegrationBundle(report, createdAt);
    const items = kind === 'sed' ? report.actions.length : bundle.distribution.recipients.length;
    const receipt: OutboxReceipt = {
      id: `outbox-${randomUUID()}`,
      kind,
      report_id: report.id,
      created_at: createdAt,
      status: 'queued_local',
      external_transmission: false,
      items,
    };
    integrationOutbox.unshift(receipt);
    if (integrationOutbox.length > 100) integrationOutbox.length = 100;

    return res.status(202).json({
      receipt,
      package: kind === 'sed' ? bundle.sed : bundle.distribution,
      notice: 'Демо-режим: пакет помещён только в локальный RAM-outbox, внешняя отправка не выполнялась.',
    });
  } catch (error: unknown) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Некорректный запрос интеграции' });
  }
});

app.post('/api/process-audio', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Аудиофайл обязателен' });

  const audioPath = req.file.path;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  let mapping: Record<string, string>;
  let source: 'local_audio' | 'mic_recording';
  try {
    mapping = parseSpeakerMapping(body.speakerMapping || body.speakers);
    source = parseAudioSource(body.source);
    for (const [field, value] of [['title', body.title], ['organization', body.organization]] as const) {
      if (value !== undefined && (typeof value !== 'string' || value.length > 300)) {
        throw new Error(`Поле ${field} должно быть строкой длиной до 300 символов`);
      }
    }
  } catch (error: any) {
    await rm(audioPath, { force: true }).catch(() => undefined);
    return res.status(400).json({ error: error.message });
  }
  if (activeAsrJobs >= maxConcurrentAsrJobs) {
    await rm(audioPath, { force: true }).catch(() => undefined);
    return res.status(429).json({
      error: 'Локальный модуль распознавания занят. Повторите запрос позже.',
      code: 'ASR_BUSY',
    });
  }
  activeAsrJobs += 1;
  const controller = new AbortController();
  const abortHandler = () => controller.abort();
  const closeHandler = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once('aborted', abortHandler);
  res.once('close', closeHandler);
  try {
    const raw = await runPython([audioPath], asrTimeoutMs, controller.signal);
    const result = JSON.parse(raw) as LocalAsrResult;
    if (!Array.isArray(result.segments) || result.segments.length === 0) {
      throw new Error('Локальная модель не вернула сегменты речи');
    }
    if (result.segments.length > 100_000 || result.segments.some((segment) =>
      typeof segment.text !== 'string' || typeof segment.speaker !== 'string' ||
      !Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
      segment.start < 0 || segment.end < segment.start
    )) throw new Error('Локальная модель вернула некорректный формат сегментов');
    return res.json({
      report: buildAudioReport(result, body.title?.trim(), body.organization?.trim(), mapping, source),
    });
  } catch (error: any) {
    console.error('Local audio processing error:', error.message);
    if (controller.signal.aborted && (res.destroyed || res.writableEnded)) return;
    const status = error.message.includes('превысила')
      ? 504
      : error.message.includes('длительность аудио')
        ? 413
      : error instanceof SyntaxError || error.message.includes('некорректный формат')
        ? 502
        : error.message.includes('ffmpeg не смог декодировать') || error.message.includes('ffprobe не смог прочитать')
          ? 422
          : 503;
    return res.status(status).json({
      error: 'Локальное распознавание недоступно',
      code: 'LOCAL_ASR_UNAVAILABLE',
      detail: error.message,
    });
  } finally {
    activeAsrJobs -= 1;
    req.removeListener('aborted', abortHandler);
    res.removeListener('close', closeHandler);
    await rm(audioPath, { force: true }).catch((error) => console.error('Не удалось удалить временный файл:', error.message));
  }
});

app.all('/api/*', (_req, res) => {
  return res.status(404).json({ error: 'API-маршрут не найден' });
});

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const requestError = error as { status?: number; type?: string };
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: error.code === 'LIMIT_FILE_SIZE' ? `Файл превышает лимит ${maxAudioMb} МБ` : error.message });
  }
  if (error instanceof Error && error.message === 'UNSUPPORTED_AUDIO_TYPE') {
    return res.status(415).json({ error: 'Поддерживаются MP3, WAV, M4A, OGG, WebM и MP4' });
  }
  if (requestError.status === 413 || requestError.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Тело запроса превышает допустимый размер' });
  }
  if (error instanceof SyntaxError || requestError.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Некорректный JSON в теле запроса' });
  }
  console.error('Unhandled request error:', error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static('dist'));
    app.get('*', (_req, res) => res.sendFile(path.resolve('dist/index.html')));
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: process.env.DISABLE_HMR !== 'true' },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }
  const server = app.listen(port, host, () => {
    console.log(`Meeting Assistant запущен: http://localhost:${port}`);
    console.log('Не закрывайте это окно. Для остановки нажмите Ctrl+C.');
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Порт ${port} уже занят. Закройте предыдущий сервер или задайте PORT=3001 в .env.`);
    } else {
      console.error('Не удалось запустить сервер:', error.message);
    }
    process.exitCode = 1;
  });
}

startServer().catch((error) => {
  console.error('Ошибка запуска Meeting Assistant:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
