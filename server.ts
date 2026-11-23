import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  AiConfigError,
  AiTimeoutError,
  generateGeminiMasterStrategy,
  refineGeminiIteration,
} from './src/server/aiMastering.ts';
import { isValidAnalysisPayload, sanitizeAvailablePlugins } from './src/server/aiPayloadValidation.ts';
import { createRateLimiter } from './src/server/requestLimiter.mjs';
import { validateChainAgainstInventory } from './src/director/processorInventory.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

// Only trust a known number of reverse-proxy hops. Leave unset when the deployment topology is unknown.
const trustedProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
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
app.use('/api/ai', aiRateLimiter);
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
    res.status(429).json({ error: 'Export rate limit exceeded. Try again shortly.' });
    return;
  }
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

app.post('/api/export/encode', express.raw({ type: 'application/octet-stream', limit: '512mb' }), async (req, res) => {
  const allowedFormats = new Set(['wav', 'mp3', 'ogg', 'flac', 'm4a', 'webm-opus']);
  const format = String(req.query.format ?? '');
  if (!allowedFormats.has(format)) {
    res.status(400).json({ error: 'Unsupported audio export format.' });
    return;
  }
  if (!Buffer.isBuffer(req.body) || req.body.length < 44 || req.body.toString('ascii', 0, 4) !== 'RIFF' || req.body.toString('ascii', 8, 12) !== 'WAVE') {
    res.status(400).json({ error: 'A valid rendered WAV source is required for audio export.' });
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
  const ditherMode = String(req.query.dither ?? 'none') === 'tpdf' ? 'triangular' : 'none';
  if (![44100, 48000, 88200, 96000].includes(sampleRate) || !['stereo', 'mono'].includes(channelMode) ||
      ![16, 24, 32].includes(wavBitDepth) || ![16, 24].includes(flacBitDepth) || !Number.isInteger(flacCompression) || flacCompression < 0 || flacCompression > 8 ||
      ![128, 192, 256, 320].includes(mp3Bitrate) || ![96, 128, 160, 192, 256, 320].includes(oggBitrate) ||
      ![128, 192, 256, 320].includes(aacBitrate) || ![96, 128, 160, 192, 256].includes(opusBitrate) ||
      !Number.isFinite(ceilingDb)) {
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
    await writeFile(inputPath, req.body);
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
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-vn',
      '-af', resampleOptions.join(':'),
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

    const output = await readFile(outputPath);
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
    res.send(output);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Audio codec export failed.';
    const unavailable = message.includes('FFmpeg is not installed');
    console.error('[SYN-RENDER] Codec export failed:', message);
    res.status(unavailable ? 503 : 500).json({
      error: unavailable ? message : 'The selected audio codec could not render this master. Check FFmpeg codec support on the server.',
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

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`SYN MASTER server listening on http://localhost:${PORT}`);
  });
}

startServer();
