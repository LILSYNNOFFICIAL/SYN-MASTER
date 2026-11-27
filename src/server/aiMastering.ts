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
  AI_PROCESSOR_TYPES,
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

/**
 * Gemini answered, but with nothing usable: an empty body or a safety block. Thrown without
 * trying the fallback model (no extra upstream call) so the real cause reaches the log.
 */
export class AiUpstreamResponseError extends Error {
  readonly failureCode: 'empty-response' | 'upstream-safety-block';
  constructor(failureCode: 'empty-response' | 'upstream-safety-block', message: string) {
    super(message);
    this.name = 'AiUpstreamResponseError';
    this.failureCode = failureCode;
  }
}

const SAFETY_FINISH_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']);

/** Throws AiUpstreamResponseError when a Gemini response is safety-blocked or empty. */
export function assertUsableGeminiResponse(response: {
  text?: string;
  promptFeedback?: { blockReason?: unknown } | null;
  candidates?: Array<{ finishReason?: unknown } | null> | null;
}): string {
  const blockReason = response.promptFeedback?.blockReason;
  const finishReason = response.candidates?.[0]?.finishReason;
  if (
    (blockReason !== undefined && blockReason !== null && String(blockReason) !== 'BLOCKED_REASON_UNSPECIFIED') ||
    (typeof finishReason === 'string' && SAFETY_FINISH_REASONS.has(finishReason))
  ) {
    throw new AiUpstreamResponseError('upstream-safety-block', 'Cloud AI declined to answer (safety filter).');
  }
  let text: string | undefined;
  try {
    text = response.text;
  } catch {
    text = undefined;
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new AiUpstreamResponseError('empty-response', 'Cloud AI returned an empty response.');
  }
  return text;
}

export const BUILTIN_GEMINI_MODEL = 'gemini-4-hydrogen';
export const FALLBACK_GEMINI_MODEL = 'gemini-3.1-flash-lite';
export const GEMINI_TIMEOUT_MS = 60_000;

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
  let primaryResponse: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
  try {
    primaryResponse = await withTimeout(
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
  } catch (err) {
    const isHighDemandOrQuota =
      err instanceof Error &&
      /503|UNAVAILABLE|high demand|429|RESOURCE_EXHAUSTED|quota|rate.*limit/i.test(err.message);
    if (!isHighDemandOrQuota && err instanceof AiTimeoutError) {
      throw err;
    }
    console.warn(
      `[SYN-AI] ${BUILTIN_GEMINI_MODEL} unavailable or high demand (${err instanceof Error ? err.message.replace(/key=[^&\s]+/gi, 'key=***').slice(0, 200) : 'unknown error'}). Falling back to ${FALLBACK_GEMINI_MODEL}.`,
    );
  }
  if (primaryResponse) {
    // Checked outside the try above: an empty or safety-blocked answer is reported as-is
    // instead of silently triggering a second model call (no automatic retries).
    const rawText = extractJsonText(assertUsableGeminiResponse(primaryResponse));
    return { rawText, modelName: BUILTIN_GEMINI_MODEL };
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
  const rawText = extractJsonText(assertUsableGeminiResponse(fallbackResponse));
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

export const PROCESSOR_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    type: {
      type: Type.STRING,
      enum: [...AI_PROCESSOR_TYPES],
      description:
        'Must be one of: parametric-eq, dynamic-eq, compressor, multiband-comp, saturation, stereo-imager, restore, bass-enhancer, limiter, maximizer, transient-shaper, clipper, multiband-maximizer, dither, match-eq, vocal-rebalance',
    },
    name: { type: Type.STRING },
    enabled: { type: Type.BOOLEAN, description: 'false = stage kept in the chain but switched off (default true)' },
    bypassed: { type: Type.BOOLEAN, description: 'true = stage bypassed (default false)' },
    intensity: { type: Type.NUMBER, description: '0 to 100' },
    wetDry: { type: Type.NUMBER, description: '0 to 100' },
    inputGainDb: { type: Type.NUMBER, description: '-12 to +12' },
    outputGainDb: { type: Type.NUMBER, description: '-12 to +12' },
    rationale: { type: Type.STRING, description: 'Optional short rationale citing the measurement; same meaning as reason, so send one of them, not both' },
    reason: { type: Type.STRING, description: 'Engineering justification referencing measured metrics & tradeoffs (alias of rationale)' },
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
    `AI mastering strategy timed out after ${GEMINI_TIMEOUT_MS / 1000}s.`,
  );

  const responseTimeMs = Math.max(0, Math.round(performance.now() - startedMs));
  const data = JSON.parse(rawText);
  const rawProcessors = Array.isArray(data.processors) ? data.processors : [];
  const aiReturnedModules = rawProcessors.map((p: { type?: unknown }) => String(p?.type ?? '')).filter(Boolean);
  const { chain, reasoning, paramCorrections } = parseAiChain(rawProcessors);

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
    paramCorrections,
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
    `AI refinement pass timed out after ${GEMINI_TIMEOUT_MS / 1000}s.`,
  );

  const responseTimeMs = Math.max(0, Math.round(performance.now() - startedMs));
  const data = JSON.parse(rawText);
  const rawProcessors = Array.isArray(data.processors) ? data.processors : [];
  const aiReturnedModules = rawProcessors.map((p: { type?: unknown }) => String(p?.type ?? '')).filter(Boolean);
  const { chain, reasoning, paramCorrections } = parseAiChain(rawProcessors);

  return {
    strategySummary: String(data.strategySummary || 'Refined mastering pass parameters.'),
    issuesDetected: Array.isArray(data.issuesDetected) ? data.issuesDetected.map(String) : [],
    reasoningPerProcessor: reasoning,
    chain: chain.length > 0 ? chain : input.currentChain,
    paramCorrections,
    aiMeta: {
      modelName,
      responseTimeMs,
      promptChars,
      aiReturnedModules,
    },
  };
}
