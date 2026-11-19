import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateGeminiMasterStrategy,
  refineGeminiIteration,
} from './src/server/aiMastering.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

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
    if (!analysis || typeof analysis.integratedLufs !== 'number') {
      res.status(400).json({ error: 'Valid audio analysis telemetry is required.' });
      return;
    }
    const strategy = await generateGeminiMasterStrategy({
      analysis,
      mode: mode ?? 'ai-auto',
      objective,
      customObjective,
      operatingMode,
      targetLufs,
      userGenreOverride,
      referenceAnalysis,
      availablePlugins: Array.isArray(availablePlugins) ? availablePlugins : undefined,
    });
    res.json({ strategy });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'AI mastering request failed';
    res.status(500).json({ error: message });
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
    if (!preAnalysis || !postAnalysis || !Array.isArray(currentChain)) {
      res.status(400).json({ error: 'Pre/post analysis and currentChain are required.' });
      return;
    }
    const refined = await refineGeminiIteration({
      preAnalysis,
      postAnalysis,
      currentChain,
      targetLufs: Number(targetLufs ?? -14),
      targetTruePeakDb: Number(targetTruePeakDb ?? -1.0),
      preserveDynamics: preserveDynamics !== false,
      qcReport,
    });
    res.json({ refined });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'AI refinement request failed';
    res.status(500).json({ error: message });
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
