import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  AiConfigError,
  AiTimeoutError,
  generateGeminiMasterStrategy,
  refineGeminiIteration,
} from './src/server/aiMastering.ts';
import { isValidAnalysisPayload, sanitizeAvailablePlugins, sanitizeVocalBalance } from './src/server/aiPayloadValidation.ts';
import { createRateLimiter } from './src/server/requestLimiter.mjs';
import { createAiSpendLimiter, createAiSpendMiddleware, readAiSpendLimitsFromEnv } from './src/server/aiSpendLimiter.mjs';
import { createAiGuestSession } from './src/server/aiAccess.ts';
import { createConcurrencyLimiter } from './src/server/aiConcurrencyLimiter.mjs';
import { validateChainAgainstInventory } from './src/director/processorInventory.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

// Only trust a known number of reverse-proxy hops. Leave unset when the deployment topology is unknown.
const trustedProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? (process.env.K_SERVICE ? 1 : 0));
if (Number.isInteger(trustedProxyHops) && trustedProxyHops > 0 && trustedProxyHops <= 5) {
  app.set('trust proxy', trustedProxyHops);
}

const allowAiRequest = createRateLimiter({ limit: 20, windowMs: 60_000, maxKeys: 10_000 });

function aiRateLimiter(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const result = allowAiRequest(ip);
  res.setHeader('X-RateLimit-Limit', '20');
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  if (!result.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({ error: 'Rate limit exceeded. Try again shortly.' });
    return;
  }
  next();
}
// Apply the AI limiter before JSON parsing so malformed or oversized requests are rate-limited too.
const aiGuestSession = createAiGuestSession({
  secret: process.env.SYN_MASTER_SESSION_SECRET,
  production: process.env.NODE_ENV === 'production',
});
const guestBootstrapLimiter = createRateLimiter({ limit: 20, windowMs: 60_000, maxKeys: 10_000 });
app.post('/api/ai/session', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const result = guestBootstrapLimiter(ip);
  if (!result.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
    res.status(429).json({ error: 'Cloud AI session setup is temporarily rate-limited. Try again shortly.' });
    return;
  }
  aiGuestSession.bootstrap(req, res);
});
// IP request limits run before signed guest-session validation. Session-based spend caps
// run only after a valid HttpOnly cookie has established an anonymous client identity.
const acquireAiSlot = createConcurrencyLimiter({ maxTotal: 8, maxPerKey: 2 });
function aiConcurrencyGuard(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const routePath = String(req.path || '').toLowerCase().replace(/\/+$/, '');
  if (req.method !== 'POST' || (routePath !== '/master' && routePath !== '/refine')) return next();
  const sessionId = String(res.locals.guestSessionId ?? '');
  const slot = acquireAiSlot(sessionId);
  if (!slot.allowed) {
    req.resume();
    res.setHeader('Retry-After', '5');
    res.status(429).json({
      error: 'Cloud AI is busy for this guest session. Wait for the current request to finish and try again.',
      code: 'ai_rate_limited',
      scope: 'burst',
      retryAfterSec: 5,
      fallback: 'local-dsp-planner',
    });
    return;
  }
  res.once('finish', slot.release);
  res.once('close', slot.release);
  next();
}
const aiSpendGuard = createAiSpendMiddleware(createAiSpendLimiter({ limits: readAiSpendLimitsFromEnv(process.env) }));
app.use('/api/ai', aiRateLimiter, aiGuestSession.middleware, aiConcurrencyGuard, aiSpendGuard);
// Offline codec jobs are CPU-intensive but must not compete with AI requests for the
// same budget, so export has its own per-client limiter.
const allowExportRequest = createRateLimiter({ limit: 30, windowMs: 60_000, maxKeys: 10_000 });
app.use('/api/export', (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const result = allowExportRequest(ip);
  res.setHeader('X-RateLimit-Limit', '30');
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  if (!result.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
    req.resume();
    res.status(429).json({ error: 'Export rate limit exceeded. Try again shortly.' });
    return;
  }
  next();
});
const MAX_EXPORT_BODY_BYTES = 512 * 1024 * 1024;
const MAX_CONCURRENT_EXPORT_JOBS = 2;
let activeExportJobs = 0;

app.use('/api/export/encode', (req, res, next) => {
  if (req.method !== 'POST') return next();
  if (activeExportJobs >= MAX_CONCURRENT_EXPORT_JOBS) {
    req.resume();
    res.status(503).json({ error: 'The export queue is full. Try again shortly.' });
    return;
  }
  activeExportJobs++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeExportJobs = Math.max(0, activeExportJobs - 1);
  };
  res.once('finish', release);
  res.once('close', release);
  next();
});

app.use(express.json({ limit: '4mb' }));

function sendSanitizedAiError(res: express.Response, err: unknown): void {
  if (err instanceof AiConfigError) {
    res.status(503).json({ error: err.message });
    return;
  }
  if (err instanceof AiTimeoutError) {
    res.status(504).json({ error: err.message });
    return;
  }
  if (err instanceof SyntaxError) {
    res.status(502).json({ error: 'AI returned malformed strategy JSON.' });
    return;
  }
  const msg = err instanceof Error ? err.message : 'AI mastering request failed.';
  console.error('[SYN-AI] Endpoint error:', msg);
  res.status(500).json({ error: 'AI mastering service could not complete the request.' });
}

async function measureEncodedLoudness(filePath: string): Promise<{ integratedLufs: number | null; truePeakDbtp: number | null }> {
  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostats', '-i', filePath, '-af', 'ebur128=peak=true', '-f', 'null', '-'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let log = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stderr.on('data', (chunk: Buffer) => { log = (log + chunk.toString()).slice(-20000); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code) => { clearTimeout(timeout); code === 0 ? resolve(log) : reject(new Error('ebur128 exited ' + code)); });
  });
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const lufsMatch = summary.match(/I:\s+(-?[\d.]+|-inf)\s+LUFS/);
  const peakMatch = summary.match(/True peak:\s+Peak:\s+(-?[\d.]+|-inf)\s+dBFS/);
  const parse = (m: RegExpMatchArray | null) => (m && m[1] !== '-inf' ? Number(m[1]) : null);
  return { integratedLufs: parse(lufsMatch), truePeakDbtp: parse(peakMatch) };
}

class ExportPayloadTooLargeError extends Error {
  constructor() {
    super('Rendered WAV upload exceeds the 512 MiB export limit.');
    this.name = 'ExportPayloadTooLargeError';
  }
}

function isSameOriginExportRequest(req: express.Request): boolean {
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    const forwardedProto = String(req.get('x-forwarded-proto') ?? req.protocol).split(',')[0].trim();
    return new URL(origin).origin === forwardedProto + '://' + req.get('host');
  } catch {
    return false;
  }
}

async function hasValidWavHeader(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, 12, 0);
    return bytesRead === 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE';
  } finally {
    await handle.close();
  }
}

app.post('/api/export/encode', async (req, res) => {
  const fetchSite = req.get('sec-fetch-site');
  if (!isSameOriginExportRequest(req) || (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none')) {
    req.resume();
    res.status(403).json({ error: 'Audio export requests must originate from this SYN MASTER page.' });
    return;
  }
  const declaredLength = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_EXPORT_BODY_BYTES) {
    req.resume();
    res.status(413).json({ error: 'Rendered WAV upload exceeds the 512 MiB export limit.' });
    return;
  }
  const allowedFormats = new Set(['wav', 'mp3', 'ogg', 'flac', 'm4a', 'webm-opus']);
  const format = String(req.query.format ?? '');
  if (!allowedFormats.has(format)) {
    req.resume();
    res.status(400).json({ error: 'Unsupported audio export format.' });
    return;
  }

  const sampleRate = Number(req.query.sampleRate ?? 48000);
  const channelMode = String(req.query.channels ?? 'stereo');
  const wavBitDepth = Number(req.query.wavBitDepth ?? 24);
  const flacBitDepth = Number(req.query.flacBitDepth ?? 24);
  const flacCompression = Number(req.query.flacCompression ?? 5);
  const mp3Bitrate = Number(req.query.mp3BitrateKbps ?? 320);
  const oggBitrate = Number(req.query.oggBitrateKbps ?? 192);
  const aacBitrate = Number(req.query.aacBitrateKbps ?? 320);
  const opusBitrate = Number(req.query.opusBitrateKbps ?? 192);
  const ceilingDb = Number(req.query.ceilingDb ?? -1);
  const normalizeToTarget = String(req.query.normalizeToTarget ?? 'false') === 'true';
  const targetLufs = Number(req.query.targetLufs ?? -14);
  const ditherMode = String(req.query.dither ?? 'none') === 'tpdf' ? 'triangular' : 'none';
  if (![44100, 48000, 88200, 96000].includes(sampleRate) || !['stereo', 'mono'].includes(channelMode) ||
      ![16, 24, 32].includes(wavBitDepth) || ![16, 24].includes(flacBitDepth) || !Number.isInteger(flacCompression) || flacCompression < 0 || flacCompression > 8 ||
      ![128, 192, 256, 320].includes(mp3Bitrate) || ![96, 128, 160, 192, 256, 320].includes(oggBitrate) ||
      ![128, 192, 256, 320].includes(aacBitrate) || ![96, 128, 160, 192, 256].includes(opusBitrate) ||
      !Number.isFinite(ceilingDb) || ceilingDb < -3 || ceilingDb > -0.1 ||
      !Number.isFinite(targetLufs) || targetLufs < -24 || targetLufs > -5) {
    req.resume();
    res.status(400).json({ error: 'One or more export settings are outside the supported range.' });
    return;
  }

  const cleanMetadata = (value: unknown, fallback: string) =>
    String(value ?? fallback).replace(/[\x00-\x1f]/g, ' ').slice(0, 160);
  const title = cleanMetadata(req.query.metadataTitle, '').trim();
  const artist = cleanMetadata(req.query.metadataArtist, '').trim();
  const extension = format === 'webm-opus' ? 'webm' : format;
  const mimeTypes: Record<string, string> = {
    wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', 'webm-opus': 'audio/webm',
  };
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'syn-master-export-'));
  const inputPath = path.join(tempDir, 'master-intermediate.wav');
  const outputPath = path.join(tempDir, 'master.' + extension);

  try {
    let uploadedBytes = 0;
    const byteLimit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        uploadedBytes += chunk.length;
        if (uploadedBytes > MAX_EXPORT_BODY_BYTES) callback(new ExportPayloadTooLargeError());
        else callback(null, chunk);
      },
    });
    await pipeline(req, byteLimit, createWriteStream(inputPath, { flags: 'wx' }));
    if (uploadedBytes < 44 || !(await hasValidWavHeader(inputPath))) {
      res.status(400).json({ error: 'A valid rendered WAV source is required for audio export.' });
      return;
    }
    const resampleOptions = [
      'aresample=' + sampleRate,
      'resampler=swr',
      'filter_size=512',
      'filter_type=blackman_nuttall',
      'phase_shift=10',
      'linear_interp=0',
    ];
    if (format === 'wav' && wavBitDepth < 32) {
      resampleOptions.push('osf=' + (wavBitDepth === 24 ? 's32' : 's16'));
      resampleOptions.push('output_sample_bits=' + wavBitDepth);
      if (ditherMode === 'triangular') resampleOptions.push('dither_method=triangular');
    }
    if (format === 'flac') {
      resampleOptions.push('osf=' + (flacBitDepth === 24 ? 's32' : 's16'));
      if (flacBitDepth === 24) resampleOptions.push('output_sample_bits=24');
      if (ditherMode === 'triangular') resampleOptions.push('dither_method=triangular');
    }
    const audioFilters = normalizeToTarget
      ? ['loudnorm=I=' + targetLufs + ':TP=' + ceilingDb + ':LRA=11', resampleOptions.join(':')]
      : [resampleOptions.join(':')];
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-vn',
      '-af', audioFilters.join(','),
      '-ar', String(sampleRate), '-ac', channelMode === 'mono' ? '1' : '2',
    ];
    if (title) args.push('-metadata', 'title=' + title);
    if (artist) args.push('-metadata', 'artist=' + artist);
    if (format === 'wav') args.push('-codec:a', wavBitDepth === 16 ? 'pcm_s16le' : wavBitDepth === 24 ? 'pcm_s24le' : 'pcm_f32le');
    if (format === 'mp3') args.push('-codec:a', 'libmp3lame', '-b:a', mp3Bitrate + 'k', '-id3v2_version', '3');
    if (format === 'ogg') args.push('-codec:a', 'libvorbis', '-b:a', oggBitrate + 'k');
    if (format === 'flac') args.push('-codec:a', 'flac', '-sample_fmt', flacBitDepth === 24 ? 's32' : 's16', '-bits_per_raw_sample', String(flacBitDepth), '-compression_level', String(flacCompression));
    if (format === 'm4a') args.push('-codec:a', 'aac', '-b:a', aacBitrate + 'k', '-movflags', '+faststart', '-f', 'ipod');
    if (format === 'webm-opus') args.push('-codec:a', 'libopus', '-b:a', opusBitrate + 'k', '-f', 'webm');
    args.push(outputPath);

    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
      child.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        if (error.code === 'ENOENT') reject(new Error('FFmpeg is not installed on the SYN MASTER server. Install FFmpeg and ensure the ffmpeg executable is on PATH to enable WAV, MP3, OGG, FLAC and M4A export.'));
        else reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(stderr || 'FFmpeg encoder exited with status ' + (code ?? 'unknown') + '.'));
      });
    });

    // Delivery check on the encoded file itself: resampling and lossy codecs can push
    // a master that met its ceiling in the float render over it.
    const measured = await measureEncodedLoudness(outputPath).catch(() => null);
    if (measured) {
      if (measured.integratedLufs !== null) res.setHeader('X-Syn-Integrated-Lufs', measured.integratedLufs.toFixed(2));
      if (measured.truePeakDbtp !== null) {
        res.setHeader('X-Syn-True-Peak-Dbtp', measured.truePeakDbtp.toFixed(2));
        res.setHeader('X-Syn-Over-Ceiling', measured.truePeakDbtp > ceilingDb + 0.05 ? '1' : '0');
      }
      res.setHeader('Access-Control-Expose-Headers', 'X-Syn-Integrated-Lufs, X-Syn-True-Peak-Dbtp, X-Syn-Over-Ceiling');
    }
    res.setHeader('Content-Type', mimeTypes[format]);
    res.setHeader('Content-Disposition', 'attachment; filename="SYN_Master.' + extension + '"');
    await pipeline(createReadStream(outputPath), res);
  } catch (error) {
    if (res.headersSent || res.destroyed) return;
    const message = error instanceof Error ? error.message : 'Audio codec export failed.';
    const unavailable = message.includes('FFmpeg is not installed');
    const tooLarge = error instanceof ExportPayloadTooLargeError;
    console.error('[SYN-RENDER] Codec export failed:', message);
    res.status(tooLarge ? 413 : unavailable ? 503 : 500).json({
      error: tooLarge
        ? 'Rendered WAV upload exceeds the 512 MiB export limit.'
        : unavailable ? message : 'The selected audio codec could not render this master. Check FFmpeg codec support on the server.',
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(process.env.GEMINI_API_KEY),
  });
});


app.post('/api/ai/master', async (req, res) => {
  try {
    const {
      analysis,
      mode,
      objective,
      customObjective,
      operatingMode,
      targetLufs,
      userGenreOverride,
      referenceAnalysis,
      availablePlugins,
      vocalBalance,
    } = req.body ?? {};
    if (!isValidAnalysisPayload(analysis)) {
      res.status(400).json({ error: 'Valid audio analysis telemetry is required.' });
      return;
    }
    if (
      targetLufs !== undefined &&
      (typeof targetLufs !== 'number' || !Number.isFinite(targetLufs) || targetLufs < -30 || targetLufs > -3)
    ) {
      res.status(400).json({ error: 'targetLufs must be a finite number between -30 and -3.' });
      return;
    }
    if (referenceAnalysis !== undefined && referenceAnalysis !== null && !isValidAnalysisPayload(referenceAnalysis)) {
      res.status(400).json({ error: 'Invalid reference analysis telemetry.' });
      return;
    }
    const pluginResult = sanitizeAvailablePlugins(availablePlugins);
    if (!pluginResult.valid) {
      res.status(400).json({ error: pluginResult.error });
      return;
    }
    const safePlugins = pluginResult.value;

    const strategy = await generateGeminiMasterStrategy({
      analysis,
      mode: mode ?? 'ai-auto',
      objective,
      customObjective,
      operatingMode,
      targetLufs,
      userGenreOverride: typeof userGenreOverride === 'string' ? userGenreOverride.slice(0, 60) : undefined,
      referenceAnalysis,
      availablePlugins: safePlugins,
      vocalBalance: sanitizeVocalBalance(vocalBalance),
    });
    res.json({ strategy });
  } catch (err) {
    sendSanitizedAiError(res, err);
  }
});

app.post('/api/ai/refine', async (req, res) => {
  try {
    const {
      preAnalysis,
      postAnalysis,
      currentChain,
      targetLufs,
      targetTruePeakDb,
      preserveDynamics,
      qcReport,
      targetGate,
      vocalBalance,
    } = req.body ?? {};
    if (
      !isValidAnalysisPayload(preAnalysis) ||
      !isValidAnalysisPayload(postAnalysis) ||
      !Array.isArray(currentChain) ||
      currentChain.length > 12
    ) {
      res.status(400).json({ error: 'Valid pre/post analysis and currentChain (<= 12 stages) are required.' });
      return;
    }
    const parsedTargetLufs = Number(targetLufs ?? -14);
    const parsedTargetTp = Number(targetTruePeakDb ?? -1.0);
    if (
      (targetLufs !== undefined && (typeof targetLufs !== 'number' || !Number.isFinite(targetLufs) || targetLufs < -30 || targetLufs > -3)) ||
      (targetTruePeakDb !== undefined && (typeof targetTruePeakDb !== 'number' || !Number.isFinite(targetTruePeakDb) || targetTruePeakDb < -6 || targetTruePeakDb > 0))
    ) {
      res.status(400).json({ error: 'Mastering targets are outside the supported loudness / true-peak range.' });
      return;
    }
    const chainValidation = currentChain.length > 0
      ? validateChainAgainstInventory(currentChain)
      : { valid: true, errors: [], sanitizedChain: [] };
    if (!chainValidation.valid) {
      res.status(400).json({ error: chainValidation.errors[0] || 'Invalid mastering chain.' });
      return;
    }

    const refined = await refineGeminiIteration({
      preAnalysis,
      postAnalysis,
      currentChain: chainValidation.sanitizedChain,
      targetLufs: parsedTargetLufs,
      targetTruePeakDb: parsedTargetTp,
      preserveDynamics: preserveDynamics !== false,
      qcReport,
      targetGate,
      vocalBalance: sanitizeVocalBalance(vocalBalance),
    });
    res.json({ refined });
  } catch (err) {
    sendSanitizedAiError(res, err);
  }
});

async function startServer() {
  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
        allowedHosts: true,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    console.log(`SYN MASTER server listening on http://localhost:${PORT}`);
  });
}

startServer();
