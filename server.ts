import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
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
