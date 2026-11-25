/**
 * Platform Preview rules: predict (and let the user hear) how streaming platforms will play the
 * master. This is a MONITORING model only. Nothing here is part of the mastering chain, the
 * offline renderer, Fix All verification or export: it computes a playback gain, a predicted
 * true peak after normalisation, and codec-audition helpers.
 *
 * Every rule below is cited in README.md ("Platform Preview"). Where a platform publishes its
 * rules (Spotify, SoundCloud's mastering tips, Amazon's codec table) the profile is marked
 * `official`; where the number comes from independent measurement (Apple's -16 LUFS Sound Check
 * reference, YouTube / TIDAL / Amazon turn-down-only behaviour) it is marked `reported` and the
 * UI says so. Album normalisation is not modelled: the preview is track (shuffle/playlist) mode.
 */
// No runtime imports: this module is also loaded by the server's AI prompt builder under plain Node.

export type PlatformId = 'off' | 'spotify' | 'apple' | 'youtube' | 'tidal' | 'amazon' | 'soundcloud';
export type SpotifyLevel = 'normal' | 'loud' | 'quiet';
export type CodecId = 'vorbis-320' | 'aac-256' | 'opus-160' | 'opus-256';

/**
 * How the platform applies its gain.
 * - none: plays the file as mastered.
 * - down-only: turns loud masters down, never turns quiet masters up.
 * - peak-limited: turns up and down, but positive gain stops where the true peak would pass
 *   `headroomCeilingDbtp` (Spotify Normal/Quiet: "we only lift ... leave 1 dB headroom").
 * - limiter: turns up to the reference regardless of peaks, with a playback limiter
 *   (Spotify Loud: limiter engages at -1 dB sample values, 5 ms attack, 100 ms decay).
 */
export type GainPolicy = 'none' | 'down-only' | 'peak-limited' | 'limiter';

export interface PlaybackLimiterSpec {
  thresholdDbfs: number;
  attackMs: number;
  releaseMs: number;
}

export interface PlatformRule {
  platformId: PlatformId;
  label: string;
  referenceLufs: number | null;
  policy: GainPolicy;
  headroomCeilingDbtp?: number;
  limiter?: PlaybackLimiterSpec;
  /** 'official' = published by the platform; 'reported' = independent measurement / trade reports. */
  confidence: 'official' | 'reported';
  note: string;
}

export interface PlatformProfile {
  id: PlatformId;
  label: string;
  shortLabel: string;
  defaultCodec: CodecId | null;
}

export const PLATFORM_PROFILES: readonly PlatformProfile[] = [
  { id: 'off', label: 'Off (as mastered)', shortLabel: 'Off', defaultCodec: null },
  { id: 'spotify', label: 'Spotify', shortLabel: 'Spotify', defaultCodec: 'vorbis-320' },
  { id: 'apple', label: 'Apple Music', shortLabel: 'Apple', defaultCodec: 'aac-256' },
  { id: 'youtube', label: 'YouTube', shortLabel: 'YouTube', defaultCodec: 'opus-160' },
  { id: 'tidal', label: 'TIDAL', shortLabel: 'TIDAL', defaultCodec: null },
  { id: 'amazon', label: 'Amazon Music', shortLabel: 'Amazon', defaultCodec: 'opus-256' },
  { id: 'soundcloud', label: 'SoundCloud', shortLabel: 'SoundCloud', defaultCodec: 'aac-256' },
];

const SPOTIFY_LIMITER: PlaybackLimiterSpec = { thresholdDbfs: -1, attackMs: 5, releaseMs: 100 };

export function isPlatformId(value: unknown): value is PlatformId {
  return typeof value === 'string' && PLATFORM_PROFILES.some((p) => p.id === value);
}

export function getPlatformProfile(id: PlatformId): PlatformProfile {
  return PLATFORM_PROFILES.find((p) => p.id === id) ?? PLATFORM_PROFILES[0];
}

/** Resolve the loudness rule for a platform (and Spotify's listener volume level). */
export function getPlatformRule(id: PlatformId, spotifyLevel: SpotifyLevel = 'normal'): PlatformRule {
  switch (id) {
    case 'spotify':
      if (spotifyLevel === 'loud') {
        return {
          platformId: id, label: 'Spotify (Loud)', referenceLufs: -11, policy: 'limiter', limiter: SPOTIFY_LIMITER,
          confidence: 'official', note: 'Loud: -11 LUFS regardless of true peak; playback limiter at -1 dB (sample), 5 ms attack, 100 ms decay.',
        };
      }
      if (spotifyLevel === 'quiet') {
        return {
          platformId: id, label: 'Spotify (Quiet)', referenceLufs: -19, policy: 'peak-limited', headroomCeilingDbtp: -1,
          confidence: 'official', note: 'Quiet: -19 LUFS. Positive gain keeps 1 dB of true-peak headroom.',
        };
      }
      return {
        platformId: id, label: 'Spotify (Normal)', referenceLufs: -14, policy: 'peak-limited', headroomCeilingDbtp: -1,
        confidence: 'official', note: 'Normal: -14 LUFS (ITU 1770). Positive gain only up to 1 dB below 0 dBTP; no limiter.',
      };
    case 'apple':
      return {
        platformId: id, label: 'Apple Music (Sound Check)', referenceLufs: -16, policy: 'peak-limited', headroomCeilingDbtp: -1,
        confidence: 'reported', note: 'Sound Check raises or lowers playback (Apple); about -16 LUFS by measurement. Positive gain is modelled peak-limited at -1 dBTP (Apple publishes no number).',
      };
    case 'youtube':
      return {
        platformId: id, label: 'YouTube', referenceLufs: -14, policy: 'down-only',
        confidence: 'reported', note: 'Turns loud uploads down to about -14 LUFS; never turns quiet ones up (measured, not published).',
      };
    case 'tidal':
      return {
        platformId: id, label: 'TIDAL', referenceLufs: -14, policy: 'down-only',
        confidence: 'reported', note: 'About -14 LUFS, turn-down only (reported; album mode aligns the loudest track). Track mode modelled.',
      };
    case 'amazon':
      return {
        platformId: id, label: 'Amazon Music', referenceLufs: -14, policy: 'down-only',
        confidence: 'reported', note: 'Loudness Normalization is a listener setting; about -14 LUFS, turn-down only by measurement.',
      };
    case 'soundcloud':
      return {
        platformId: id, label: 'SoundCloud', referenceLufs: -14, policy: 'down-only',
        confidence: 'official', note: 'SoundCloud applies loudness normalisation and advises -14 LUFS / -1 dBTP (-2 dBTP when louder). Whether it turns quiet tracks up is not published: modelled turn-down only.',
      };
    default:
      return { platformId: 'off', label: 'Off', referenceLufs: null, policy: 'none', confidence: 'official', note: 'Plays the master as mastered.' };
  }
}

export interface MasterLevels {
  integratedLufs: number;
  truePeakDb: number;
  /** Sample peak in dBFS; used by the Spotify Loud limiter model. Defaults to the true peak. */
  samplePeakDb?: number;
}

export type PlatformRisk = 'ok' | 'lossy-headroom' | 'clip';

export interface PlatformPlayback {
  platformId: PlatformId;
  label: string;
  /** Gain the platform applies to playback (dB, negative = turned down). */
  gainDb: number;
  /** Gain the platform would need to reach its reference without any restriction. */
  requestedGainDb: number;
  direction: 'down' | 'up' | 'none';
  /** Why the applied gain differs from the requested gain. */
  limitedBy: 'turn-down-only' | 'peak-headroom' | null;
  limiterEngaged: boolean;
  /** Peak reduction the playback limiter has to apply (dB, >= 0). */
  limiterReductionDb: number;
  predictedLufs: number;
  predictedTruePeakDb: number;
  predictedSamplePeakDb: number;
  risk: PlatformRisk;
  /** Platform delivery advice the master breaks (e.g. Spotify/SoundCloud: louder than -14 LUFS needs TP below -2 dBTP). */
  deliveryAdvice: string | null;
  confidence: PlatformRule['confidence'];
  note: string;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Gain maths per platform. Pure; uses only integrated LUFS and peaks of the master.
 * Predictions after a limiter are estimates (the limiter's exact output depends on the music).
 */
export function predictPlatformPlayback(levels: MasterLevels, rule: PlatformRule): PlatformPlayback {
  const lufs = levels.integratedLufs;
  const tp = levels.truePeakDb;
  const sp = Math.min(levels.samplePeakDb ?? tp, tp);
  const base = {
    platformId: rule.platformId,
    label: rule.label,
    confidence: rule.confidence,
    note: rule.note,
  };
  const valid = Number.isFinite(lufs) && Number.isFinite(tp) && lufs > -70;
  if (rule.policy === 'none' || rule.referenceLufs === null || !valid) {
    return {
      ...base, gainDb: 0, requestedGainDb: 0, direction: 'none', limitedBy: null, limiterEngaged: false, limiterReductionDb: 0,
      predictedLufs: round2(lufs), predictedTruePeakDb: round2(tp), predictedSamplePeakDb: round2(sp),
      risk: riskFor(tp), deliveryAdvice: deliveryAdviceFor(rule, lufs, tp),
    };
  }
  const requested = rule.referenceLufs - lufs;
  let gain = requested;
  let limitedBy: PlatformPlayback['limitedBy'] = null;
  if (rule.policy === 'down-only' && requested > 0) {
    gain = 0;
    limitedBy = 'turn-down-only';
  } else if (rule.policy === 'peak-limited' && requested > 0) {
    const ceiling = rule.headroomCeilingDbtp ?? -1;
    const headroom = Math.max(0, ceiling - tp);
    if (requested > headroom) {
      gain = headroom;
      limitedBy = 'peak-headroom';
    }
  }
  let predictedTp = tp + gain;
  let predictedSp = sp + gain;
  let limiterEngaged = false;
  let limiterReductionDb = 0;
  if (rule.policy === 'limiter' && rule.limiter && predictedSp > rule.limiter.thresholdDbfs) {
    limiterEngaged = true;
    limiterReductionDb = predictedSp - rule.limiter.thresholdDbfs;
    // The limiter works on sample values, so the inter-sample overshoot above the sample peak survives.
    const overshoot = Math.max(0, tp - sp);
    predictedSp = rule.limiter.thresholdDbfs;
    predictedTp = Math.min(tp + gain, rule.limiter.thresholdDbfs + overshoot);
  }
  return {
    ...base,
    gainDb: round2(gain),
    requestedGainDb: round2(requested),
    direction: gain < -0.005 ? 'down' : gain > 0.005 ? 'up' : 'none',
    limitedBy,
    limiterEngaged,
    limiterReductionDb: round2(limiterReductionDb),
    predictedLufs: round2(lufs + gain),
    predictedTruePeakDb: round2(predictedTp),
    predictedSamplePeakDb: round2(predictedSp),
    risk: riskFor(predictedTp),
    deliveryAdvice: deliveryAdviceFor(rule, lufs, tp),
  };
}

function riskFor(truePeakDb: number): PlatformRisk {
  if (truePeakDb > 0) return 'clip';
  if (truePeakDb > -1) return 'lossy-headroom';
  return 'ok';
}

function deliveryAdviceFor(rule: PlatformRule, lufs: number, tp: number): string | null {
  // Spotify and SoundCloud both publish: master louder than -14 LUFS -> keep TP below -2 dBTP; else below -1 dBTP.
  if (rule.platformId !== 'spotify' && rule.platformId !== 'soundcloud') return null;
  if (!Number.isFinite(lufs) || !Number.isFinite(tp)) return null;
  if (lufs > -14 && tp > -2) return `Louder than -14 LUFS: ${rule.platformId === 'spotify' ? 'Spotify' : 'SoundCloud'} advises a true peak below -2 dBTP (master is ${tp.toFixed(1)} dBTP).`;
  if (tp > -1) return `${rule.platformId === 'spotify' ? 'Spotify' : 'SoundCloud'} advises a true peak below -1 dBTP for lossy encodes (master is ${tp.toFixed(1)} dBTP).`;
  return null;
}

/** Convenience wrapper for UI: platform id + Spotify level -> prediction. */
export function predictForPlatform(levels: MasterLevels, id: PlatformId, spotifyLevel: SpotifyLevel = 'normal'): PlatformPlayback {
  return predictPlatformPlayback(levels, getPlatformRule(id, spotifyLevel));
}

// -------------------------------------------------------------------------------------------
// QC / AI hints (read-only; never part of a gate)
// -------------------------------------------------------------------------------------------

export interface PlatformQcHint {
  platformId: PlatformId;
  label: string;
  gainDb: number;
  predictedTruePeakDb: number;
  limiterEngaged: boolean;
  risk: PlatformRisk;
}

const HINT_RULES: Array<[PlatformId, SpotifyLevel]> = [
  ['spotify', 'normal'], ['spotify', 'loud'], ['apple', 'normal'], ['youtube', 'normal'],
  ['tidal', 'normal'], ['amazon', 'normal'], ['soundcloud', 'normal'],
];

export function buildPlatformHints(levels: MasterLevels): PlatformQcHint[] {
  if (!Number.isFinite(levels.integratedLufs) || !Number.isFinite(levels.truePeakDb)) return [];
  return HINT_RULES.map(([id, level]) => {
    const p = predictForPlatform(levels, id, level);
    return {
      platformId: id,
      label: p.label,
      gainDb: p.gainDb,
      predictedTruePeakDb: p.predictedTruePeakDb,
      limiterEngaged: p.limiterEngaged,
      risk: p.risk,
    };
  });
}

/**
 * Prompt text for the AI. The QC report reaches the server from the browser, so every value is
 * re-validated here: labels come from our own rule table, numbers must be finite and bounded.
 */
export function formatPlatformHintsForPrompt(hints: unknown): string {
  if (!Array.isArray(hints) || hints.length === 0) return '';
  const lines: string[] = [];
  for (const raw of hints.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') continue;
    const h = raw as Record<string, unknown>;
    if (!isPlatformId(h.platformId) || h.platformId === 'off') continue;
    const gain = Number(h.gainDb);
    const tp = Number(h.predictedTruePeakDb);
    if (!Number.isFinite(gain) || !Number.isFinite(tp) || Math.abs(gain) > 60 || Math.abs(tp) > 60) continue;
    const label = String(h.label ?? '').match(/^[A-Za-z ()]{1,40}$/) ? String(h.label) : getPlatformProfile(h.platformId).label;
    const risk = h.risk === 'clip' ? ' CLIP RISK' : h.risk === 'lossy-headroom' ? ' (under 1 dB headroom for lossy codecs)' : '';
    lines.push(`- ${label}: playback gain ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB, predicted true peak ${tp.toFixed(1)} dBTP${h.limiterEngaged === true ? ', playback limiter engages' : ''}${risk}`);
  }
  if (lines.length === 0) return '';
  return [
    'PLATFORM PLAYBACK PREDICTION (read-only hint, not a pass/fail target; do not change the objective because of it):',
    ...lines,
    'Prefer true-peak ceilings that stay platform-safe (at or below -1 dBTP after normalisation, -2 dBTP when the master is louder than -14 LUFS) when this costs nothing against the objective.',
  ].join('\n');
}

/** Web Audio DynamicsCompressorNode adds automatic makeup gain; this is the amount to cancel (dB). */
export function compressorMakeupDb(thresholdDb: number, ratio: number): number {
  // Per the Web Audio spec (knee 0): fullRangeGain = curve(0 dBFS); makeup = (1 / fullRangeGain)^0.6.
  const outAtZero = thresholdDb + (0 - thresholdDb) / ratio;
  return round2(-outAtZero * 0.6);
}
