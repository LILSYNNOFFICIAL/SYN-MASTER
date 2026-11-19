import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRateLimiter } from './src/server/requestLimiter.mjs';
import {
  AiConfigError,
  AiTimeoutError,
  generateGeminiMasterStrategy,
  refineGeminiIteration,
} from './src/server/aiMastering.ts';
import { validateChainAgainstInventory } from './src/director/processorInventory.ts';
import { isValidAnalysisPayload, sanitizeAvailablePlugins } from './src/server/aiPayloadValidation.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

// Only trust a known number of reverse-proxy hops. Leave unset when the
// deployment topology is unknown; do not blindly trust client-supplied XFF.
const trustedProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
if (Number.isInteger(trustedProxyHops) && trustedProxyHops > 0 && trustedProxyHops <= 5) {
  app.set('trust proxy', trustedProxyHops);
}

// Apply the AI limiter before parsing request bodies. This ensures repeated
// oversized or malformed requests cannot consume JSON parsing work indefinitely.
const allowAiRequest = createRateLimiter({ limit: 20, windowMs: 60_000 });
app.use('/api/ai', (req, res, next) => {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const result = allowAiRequest(key);
  if (!result.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
    res.status(429).json({ error: 'AI request limit reached. Please wait before trying again.' });
    return;
  }
  next();
});

app.use(express.json({ limit: '4mb' }));

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
      res.status(400).json({ error: 'Valid complete audio analysis telemetry is required.' });
      return;
    }
    if (referenceAnalysis !== undefined && referenceAnalysis !== null && !isValidAnalysisPayload(referenceAnalysis)) {
      res.status(400).json({ error: 'Invalid reference analysis telemetry.' });
      return;
    }
    if (targetLufs !== undefined && (
      typeof targetLufs !== 'number' || !Number.isFinite(targetLufs) || targetLufs < -30 || targetLufs > -3
    )) {
      res.status(400).json({ error: 'targetLufs must be a finite number between -30 and -3.' });
      return;
    }
    const pluginResult = sanitizeAvailablePlugins(availablePlugins);
    if (!pluginResult.valid) {
      res.status(400).json({ error: pluginResult.error });
      return;
    }

    const strategy = await generateGeminiMasterStrategy({
      analysis,
      mode: mode ?? 'ai-auto',
      objective,
      customObjective,
      operatingMode,
      targetLufs,
      userGenreOverride: typeof userGenreOverride === 'string' ? userGenreOverride.slice(0, 60) : undefined,
      referenceAnalysis,
      availablePlugins: pluginResult.value,
    });
    res.json({ strategy });
  } catch (err) {
    if (err instanceof AiConfigError) {
      res.status(503).json({ error: 'AI mastering is not configured on this server.' });
      return;
    }
    if (err instanceof AiTimeoutError) {
      res.status(504).json({ error: 'AI mastering timed out. Please try again.' });
      return;
    }
    console.error('[SYN MASTER] AI mastering request failed:', err);
    res.status(502).json({ error: 'AI mastering is temporarily unavailable. Please try again.' });
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
      res.status(400).json({ error: 'Valid pre/post analysis and a currentChain of at most 12 processors are required.' });
      return;
    }
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
      targetLufs: targetLufs ?? -14,
      targetTruePeakDb: targetTruePeakDb ?? -1.0,
      preserveDynamics: preserveDynamics !== false,
      qcReport,
    });
    res.json({ refined });
  } catch (err) {
    if (err instanceof AiConfigError) {
      res.status(503).json({ error: 'AI mastering is not configured on this server.' });
      return;
    }
    if (err instanceof AiTimeoutError) {
      res.status(504).json({ error: 'AI refinement timed out. Please try again.' });
      return;
    }
    console.error('[SYN MASTER] AI refinement request failed:', err);
    res.status(502).json({ error: 'AI refinement is temporarily unavailable. Please try again.' });
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
