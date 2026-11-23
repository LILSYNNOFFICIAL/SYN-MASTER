/**
 * Delivery loudness targets (applied as the Fix-All objective). Values follow each
 * platform's published normalization reference; the true-peak ceiling leaves room for
 * lossy encoding.
 */
export interface LoudnessTargetPreset {
  id: string;
  label: string;
  targetLufs: number;
  maxTruePeakDb: number;
  minDynamicRangeDb: number;
  note: string;
}

export const LOUDNESS_TARGET_PRESETS: LoudnessTargetPreset[] = [
  { id: 'spotify', label: 'Spotify', targetLufs: -14, maxTruePeakDb: -1, minDynamicRangeDb: 7, note: 'Normal playback level -14 LUFS' },
  { id: 'spotify-loud', label: 'Spotify Loud', targetLufs: -11, maxTruePeakDb: -2, minDynamicRangeDb: 6, note: 'Loud mode -11 LUFS, -2 dBTP' },
  { id: 'apple', label: 'Apple Music', targetLufs: -16, maxTruePeakDb: -1, minDynamicRangeDb: 8, note: 'Sound Check -16 LUFS' },
  { id: 'youtube', label: 'YouTube', targetLufs: -14, maxTruePeakDb: -1, minDynamicRangeDb: 7, note: '-14 LUFS reference' },
  { id: 'tidal', label: 'Tidal', targetLufs: -14, maxTruePeakDb: -1, minDynamicRangeDb: 7, note: '-14 LUFS' },
  { id: 'amazon', label: 'Amazon Music', targetLufs: -14, maxTruePeakDb: -2, minDynamicRangeDb: 7, note: '-14 LUFS, -2 dBTP' },
  { id: 'soundcloud', label: 'SoundCloud', targetLufs: -10, maxTruePeakDb: -1, minDynamicRangeDb: 6, note: 'No normalization; competitive level' },
  { id: 'club', label: 'Club / DJ', targetLufs: -8, maxTruePeakDb: -0.5, minDynamicRangeDb: 5, note: 'Loud club master' },
  { id: 'broadcast', label: 'Broadcast EBU R128', targetLufs: -23, maxTruePeakDb: -1, minDynamicRangeDb: 10, note: 'EBU R128' },
];
