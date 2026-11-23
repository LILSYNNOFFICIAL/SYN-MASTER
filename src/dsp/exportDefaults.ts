import type { ExportConfig } from '../types/mastering';

const DEFAULT_EXPORT_CONFIG: ExportConfig = {
  filename: 'SYN_Master_Output',
  format: 'wav',
  wavBitDepth: 24,
  flacBitDepth: 24,
  flacCompression: 5,
  mp3BitrateKbps: 320,
  oggBitrateKbps: 192,
  aacBitrateKbps: 320,
  opusBitrateKbps: 192,
  // Contract defaults: preserve the 48 kHz source rate, 24-bit WAV/FLAC, MP3 320 kbps.
  // Dither off so the 24-bit FLAC is sample-identical to the 24-bit WAV.
  sampleRate: 48000,
  channels: 'stereo',
  dither: 'none',
  resampler: 'sinc-512',
  includeMasteringChain: true,
  saveLoopMarkers: true,
  midiTempoBpm: 120,
  normalizeToTarget: false,
  targetLufs: -14,
  ceilingDb: -1.0,
  // Contract: no fixed loudness target, so the default delivery objective preserves dynamics.
  deliveryProfile: 'archive',
  metadataTitle: '',
  metadataArtist: '',
};
