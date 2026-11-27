import type { MasterTargetGate } from '../director/masterTargets.ts';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { VocalBalanceContext } from '../ai/vocalBalancePrompt.ts';
import type {
  AudioAnalysis,
  CustomObjectiveSpec,
  DirectorOperatingMode,
  MasteringMode,
  MasteringObjectiveId,
  ProcessorModule,
  QCReport,
} from '../types/mastering.ts';
import {
  SYSTEM_PROMPT,
  buildRefineUserPrompt,
  buildStrategyUserPrompt,
  parseAiChain,
} from '../ai/masteringPrompt.ts';

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}

export class AiTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiTimeoutError';
  }
}

export const BUILTIN_GEMINI_MODEL = 'gemini-4-hydrogen';
export const FALLBACK_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_TIMEOUT_MS = 60_000;

export function extractJsonText(raw: string | undefined): string {
  if (!raw) return '{}';
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  return s || '{}';
}

async function executeGeminiContentWithFallback(
  ai: GoogleGenAI,
  contents: string,
  systemInstruction: string,
  schema: unknown,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<{ rawText: string; modelName: string }> {
  // Primary attempt: gemini-4-hydrogen with ThinkingLevel.LOW for fast low-latency strategy
  try {
    const response = await withTimeout(
      ai.models.generateContent({
        model: BUILTIN_GEMINI_MODEL,
        contents,
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      }),
      timeoutMs,
      timeoutMessage,
    );
    const rawText = extractJsonText(response.text);
    return { rawText, modelName: BUILTIN_GEMINI_MODEL };
  } catch (err) {
    const isHighDemandOrQuota =
      err instanceof Error &&
      /503|UNAVAILABLE|high demand|429|RESOURCE_EXHAUSTED|quota|rate.*limit/i.test(err.message);
    if (!isHighDemandOrQuota && err instanceof AiTimeoutError) {
      throw err;
    }
    console.warn(
      `[SYN-AI] ${BUILTIN_GEMINI_MODEL} unavailable or high demand (${err instanceof Error ? err.message : String(err)}). Falling back to ${FALLBACK_GEMINI_MODEL}.`,
    );
  }

  // High-availability fallback: gemini-3.1-flash-lite executes in ~2s and honors the same schema
  const fallbackResponse = await withTimeout(
    ai.models.generateContent({
      model: FALLBACK_GEMINI_MODEL,
      contents,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    }),
    timeoutMs,
    timeoutMessage,
  );
  const rawText = extractJsonText(fallbackResponse.text);
  return { rawText, modelName: FALLBACK_GEMINI_MODEL };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AiTimeoutError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AiConfigError('Cloud AI mastering is not configured on this server.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const PROCESSOR_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    type: {
      type: Type.STRING,
      description:
        'Must be one of: parametric-eq, dynamic-eq, compressor, multiband-comp, saturation, stereo-imager, restore, bass-enhancer, limiter, maximizer, transient-shaper, clipper, multiband-maximizer, dither, match-eq, vocal-rebalance',
    },
    name: { type: Type.STRING },
    intensity: { type: Type.NUMBER, description: '0 to 100' },
    wetDry: { type: Type.NUMBER, description: '0 to 100' },
    inputGainDb: { type: Type.NUMBER, description: '-12 to +12' },
    outputGainDb: { type: Type.NUMBER, description: '-12 to +12' },
    reason: { type: Type.STRING, description: 'Engineering justification referencing measured metrics & tradeoffs' },
    paramsJson: {
      type: Type.STRING,
      description:
        'Valid JSON string matching the exact parameter object schema for the chosen processor type.',
    },
  },
  required: ['type', 'name', 'intensity', 'wetDry', 'reason', 'paramsJson'],
};

export const STRATEGY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    genre: { type: Type.STRING },
    musicalStyle: { type: Type.STRING },
    instrumentationSummary: { type: Type.STRING },
    vocalPresence: { type: Type.STRING },
    tonalCharacteristics: { type: Type.STRING },
    issuesDetected: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    strategySummary: { type: Type.STRING },
    targetLufs: { type: Type.NUMBER },
    targetTruePeakDb: { type: Type.NUMBER },
    processors: {
      type: Type.ARRAY,
      items: PROCESSOR_SCHEMA,
    },
  },
  required: [
    'genre',
    'musicalStyle',
    'instrumentationSummary',
    'vocalPresence',
    'tonalCharacteristics',
    'issuesDetected',
    'strategySummary',
    'targetLufs',
    'targetTruePeakDb',
    'processors',
  ],
};

export async function generateGeminiMasterStrategy(input: {
  analysis: AudioAnalysis;
  mode: MasteringMode;
  objective?: MasteringObjectiveId;
  customObjective?: Partial<CustomObjectiveSpec> | null;
  operatingMode?: DirectorOperatingMode;
  targetLufs?: number;
  userGenreOverride?: string;
  referenceAnalysis?: AudioAnalysis | null;
  availablePlugins?: Array<{ name: string; role: string; manufacturer: string }>;
  vocalBalance?: VocalBalanceContext | null;
}) {
  const ai = getAiClient();
  const prompt = buildStrategyUserPrompt(input);
  const promptChars = SYSTEM_PROMPT.length + prompt.length;
  const startedMs = performance.now();

  const { rawText, modelName } = await executeGeminiContentWithFallback(
    ai,
    prompt,
    SYSTEM_PROMPT,
    STRATEGY_SCHEMA,
    GEMINI_TIMEOUT_MS,
    'AI mastering strategy timed out after 60s.',
  );

  const responseTimeMs = Math.max(0, Math.round(performance.now() - startedMs));
  const data = JSON.parse(rawText);
  const rawProcessors = Array.isArray(data.processors) ? data.processors : [];
  const aiReturnedModules = rawProcessors.map((p: { type?: unknown }) => String(p?.type ?? '')).filter(Boolean);
  const { chain, reasoning } = parseAiChain(rawProcessors);

  return {
    id: `ai-${Date.now()}`,
    timestamp: Date.now(),
    source: 'gemini-ai' as const,
    genre: String(data.genre || 'Contemporary Mix'),
    musicalStyle: String(data.musicalStyle || input.objective || input.mode),
    instrumentationSummary: String(data.instrumentationSummary || ''),
    vocalPresence: String(data.vocalPresence || ''),
    tonalCharacteristics: String(data.tonalCharacteristics || ''),
    issuesDetected: Array.isArray(data.issuesDetected) ? data.issuesDetected.map(String) : [],
    strategySummary: String(data.strategySummary || ''),
    targetLufs: Number(data.targetLufs ?? input.targetLufs ?? -14),
    targetTruePeakDb: Number(data.targetTruePeakDb ?? -1.0),
    reasoningPerProcessor: reasoning,
    chain,
    aiMeta: {
      modelName,
      responseTimeMs,
      promptChars,
      aiReturnedModules,
    },
  };
}

export async function refineGeminiIteration(input: {
  preAnalysis: AudioAnalysis;
  postAnalysis: AudioAnalysis;
  currentChain: ProcessorModule[];
  mode?: MasteringMode;
  objective?: MasteringObjectiveId;
  targetLufs: number;
  targetTruePeakDb: number;
  preserveDynamics: boolean;
  qcReport?: QCReport | null;
  targetGate?: MasterTargetGate | null;
  vocalBalance?: VocalBalanceContext | null;
}) {
  const ai = getAiClient();
  const prompt = buildRefineUserPrompt(input);
  const promptChars = SYSTEM_PROMPT.length + prompt.length;
  const startedMs = performance.now();

  const { rawText, modelName } = await executeGeminiContentWithFallback(
    ai,
    prompt,
    SYSTEM_PROMPT,
    STRATEGY_SCHEMA,
    GEMINI_TIMEOUT_MS,
    'AI refinement pass timed out after 60s.',
  );

  const responseTimeMs = Math.max(0, Math.round(performance.now() - startedMs));
  const data = JSON.parse(rawText);
  const rawProcessors = Array.isArray(data.processors) ? data.processors : [];
  const aiReturnedModules = rawProcessors.map((p: { type?: unknown }) => String(p?.type ?? '')).filter(Boolean);
  const { chain, reasoning } = parseAiChain(rawProcessors);

  return {
    strategySummary: String(data.strategySummary || 'Refined mastering pass parameters.'),
    issuesDetected: Array.isArray(data.issuesDetected) ? data.issuesDetected.map(String) : [],
    reasoningPerProcessor: reasoning,
    chain: chain.length > 0 ? chain : input.currentChain,
    aiMeta: {
      modelName,
      responseTimeMs,
      promptChars,
      aiReturnedModules,
    },
  };
}
