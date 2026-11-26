/**
 * Platform Preview codec-audition and measurement helpers (browser + tests). The loudness rules
 * live in platformRules.ts (re-exported here) so the server prompt builder can load them without
 * the analyzer.
 */
import { linearToDb, maxInterSampleAbsAt, measureIntegratedLufs } from './analyzer';

export * from './platformRules.ts';
import type { CodecId, PlatformId, PlatformPlayback } from './platformRules.ts';

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Plain-language rule behind each prediction, keyed by rule label (cited in README). */
export const PLATFORM_RULE_NOTES: Record<string, string> = {
  'Spotify (Loud)': 'Loud: -11 LUFS regardless of true peak; playback limiter at -1 dB (sample), 5 ms attack, 100 ms decay.',
  'Spotify (Quiet)': 'Quiet: -19 LUFS. Positive gain keeps 1 dB of true-peak headroom.',
  'Spotify (Normal)': 'Normal: -14 LUFS (ITU 1770). Positive gain only up to 1 dB below 0 dBTP; no limiter.',
  'Apple Music (Sound Check)': 'Sound Check raises or lowers playback (Apple); about -16 LUFS by measurement. Positive gain is modelled peak-limited at -1 dBTP (Apple publishes no number).',
  'YouTube': 'Turns loud uploads down to about -14 LUFS; never turns quiet ones up (measured, not published).',
  'TIDAL': 'About -14 LUFS, turn-down only (reported; album mode aligns the loudest track). Track mode modelled.',
  'Amazon Music': 'Loudness Normalization is a listener setting; about -14 LUFS, turn-down only by measurement.',
  'SoundCloud': 'SoundCloud applies loudness normalisation and advises -14 LUFS / -1 dBTP (-2 dBTP when louder). Whether it turns quiet tracks up is not published: modelled turn-down only.',
  'Off': 'Plays the master as mastered.',
};

/** What each platform streams (cited in README "Platform Preview"). */
export const PLATFORM_CODEC_NOTES: Record<PlatformId, string> = {
  off: 'No platform model.',
  spotify: 'Ogg Vorbis up to ~320 kbps (Premium "Very high"); AAC 256 on the web player; FLAC when Lossless is on.',
  apple: 'AAC 256 kbps (Apple AAC encoder); ALAC when Lossless is on.',
  youtube: 'Opus around 128-160 kbps (no 320 kbps stream); AAC fallback.',
  tidal: 'Lossless FLAC for subscribers: no codec loss to audition (pick a codec to compare anyway).',
  amazon: 'SD tier is Opus at 48/192/320 kbps (HD/UHD are FLAC). The export encoder tops out at 256 kbps Opus, the closest available.',
  soundcloud: 'AAC: 256 kbps HQ (Go+), 160/96 kbps standard.',
};

/** One-line summary: "Spotify (Normal) turns your master down by 4.0 dB". */
export function describePlatformGain(p: PlatformPlayback): string {
  if (p.platformId === 'off') return 'Playing as mastered (no platform model).';
  const amount = Math.abs(p.gainDb).toFixed(1);
  if (p.direction === 'down') return `${p.label} will turn your master down by ${amount} dB.`;
  if (p.direction === 'up') return `${p.label} will turn your master up by ${amount} dB${p.limiterEngaged ? ' and limit its peaks' : ''}.`;
  if (p.limitedBy === 'turn-down-only') return `${p.label} will not turn your master up (it is ${Math.abs(p.requestedGainDb).toFixed(1)} dB under the reference and plays quieter).`;
  if (p.limitedBy === 'peak-headroom') return `${p.label} cannot turn your master up: its true peak leaves no headroom.`;
  return `${p.label} will play your master at its level.`;
}


// -------------------------------------------------------------------------------------------
// Codec audition (server FFmpeg /api/export/encode is reused; no new backend)
// -------------------------------------------------------------------------------------------

export interface CodecOption {
  id: CodecId;
  label: string;
  format: 'ogg' | 'm4a' | 'webm-opus';
  kbps: number;
  /** Opus only encodes at 48 kHz. */
  forceSampleRate?: 48000;
}

export const CODEC_OPTIONS: readonly CodecOption[] = [
  { id: 'vorbis-320', label: 'Ogg Vorbis 320', format: 'ogg', kbps: 320 },
  { id: 'aac-256', label: 'AAC 256', format: 'm4a', kbps: 256 },
  { id: 'opus-160', label: 'Opus 160', format: 'webm-opus', kbps: 160, forceSampleRate: 48000 },
  { id: 'opus-256', label: 'Opus 256', format: 'webm-opus', kbps: 256, forceSampleRate: 48000 },
];

export function getCodecOption(id: CodecId): CodecOption {
  return CODEC_OPTIONS.find((c) => c.id === id) ?? CODEC_OPTIONS[0];
}

const EXPORT_SAMPLE_RATES = [44100, 48000, 88200, 96000];

/** Query parameters for the existing /api/export/encode route (values inside its validated ranges). */
export function buildCodecEncodeParams(codec: CodecId, sourceSampleRate: number): Record<string, string> {
  const opt = getCodecOption(codec);
  const sampleRate = opt.forceSampleRate ?? (EXPORT_SAMPLE_RATES.includes(sourceSampleRate) ? sourceSampleRate : 48000);
  const params: Record<string, string> = {
    format: opt.format,
    sampleRate: String(sampleRate),
    channels: 'stereo',
    // The over-ceiling header is reported against 0 dBTP: codec clipping, not delivery headroom.
    ceilingDb: '0',
    normalizeToTarget: 'false',
    dither: 'none',
  };
  if (opt.format === 'ogg') params.oggBitrateKbps = String(opt.kbps);
  if (opt.format === 'm4a') params.aacBitrateKbps = String(opt.kbps);
  if (opt.format === 'webm-opus') params.opusBitrateKbps = String(opt.kbps);
  return params;
}

/**
 * Minimal 32-bit float stereo WAV for the codec snippet. Unlike the export WAV encoder it never
 * clamps samples, so the codec sees exactly the rendered master.
 */
export function encodeFloatWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const numCh = Math.max(1, channels.length);
  const len = channels[0]?.length ?? 0;
  const dataBytes = len * numCh * 4;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 4, true);
  view.setUint16(32, numCh * 4, true);
  view.setUint16(34, 32, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      view.setFloat32(off, channels[c]?.[i] ?? 0, true);
      off += 4;
    }
  }
  return buf;
}

/** Copy a [startSec, startSec + lengthSec) window of the master (clamped to the track). */
export function sliceSnippet(channels: Float32Array[], sampleRate: number, startSec: number, lengthSec: number): { channels: Float32Array[]; startSec: number } {
  const total = channels[0]?.length ?? 0;
  const want = Math.max(1, Math.round(lengthSec * sampleRate));
  let start = Math.max(0, Math.round(startSec * sampleRate));
  if (start + want > total) start = Math.max(0, total - want);
  const end = Math.min(total, start + want);
  return { channels: channels.map((c) => c.slice(start, end)), startSec: start / sampleRate };
}

/** 4x-oversampled true peak (same ITU-style interpolator as the analyzer) in dBTP. */
export function measureTruePeakDb(channels: Float32Array[]): number {
  let max = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = maxInterSampleAbsAt(ch, i, ch.length, 4);
      if (v > max) max = v;
    }
  }
  return linearToDb(max);
}

export interface CodecClippingReport {
  /** True peak of the decoded codec audio (dBTP). */
  truePeakDb: number;
  samplePeakDb: number;
  /** Sample positions whose sample or inter-sample value exceeds 0 dBFS. */
  overCount: number;
  /** True when the decoded audio has inter-sample (or sample) peaks above 0 dBTP. */
  clipping: boolean;
  /** Decoded true peak after the platform's playback gain. */
  truePeakAfterGainDb: number;
  clippingAfterGain: boolean;
}

/**
 * Codec clipping detection on DECODED audio: a lossy decode can produce inter-sample peaks over
 * 0 dBTP even when the master was under it; a fixed-point decoder clips them. The platform gain
 * is applied after decoding, so both readings are reported.
 */
export function detectCodecClipping(decoded: Float32Array[], platformGainDb = 0): CodecClippingReport {
  let tpLin = 0;
  let spLin = 0;
  let overCount = 0;
  for (const ch of decoded) {
    for (let i = 0; i < ch.length; i++) {
      const s = Math.abs(ch[i]);
      if (s > spLin) spLin = s;
      const v = maxInterSampleAbsAt(ch, i, ch.length, 4);
      if (v > tpLin) tpLin = v;
      if (v > 1) overCount++;
    }
  }
  const truePeakDb = round2(linearToDb(tpLin));
  const after = round2(truePeakDb + platformGainDb);
  return {
    truePeakDb,
    samplePeakDb: round2(linearToDb(spLin)),
    overCount,
    clipping: truePeakDb > 0,
    truePeakAfterGainDb: after,
    clippingAfterGain: after > 0,
  };
}

/** Gain that loudness-matches the decoded snippet to the uncompressed one (clamped to +/-6 dB). */
export function codecMatchTrimDb(original: Float32Array[], decoded: Float32Array[], sampleRate: number, decodedSampleRate = sampleRate): number {
  const a = measureIntegratedLufs(original, sampleRate);
  const b = measureIntegratedLufs(decoded, decodedSampleRate);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < -70 || b < -70) return 0;
  return round2(Math.max(-6, Math.min(6, a - b)));
}
