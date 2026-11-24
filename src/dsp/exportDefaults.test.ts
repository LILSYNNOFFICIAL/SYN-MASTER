import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_EXPORT_CONFIG } from './exportDefaults';

test('contract-confirmed default export settings remain unchanged', () => {
  assert.deepEqual(DEFAULT_EXPORT_CONFIG, {
    filename: 'SYN_Master_Output',
    format: 'wav',
    selectedFormats: ['wav'],
    wavBitDepth: 24,
    flacBitDepth: 24,
    flacCompression: 5,
    mp3BitrateKbps: 320,
    oggBitrateKbps: 192,
    aacBitrateKbps: 320,
    opusBitrateKbps: 192,
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
    deliveryProfile: 'archive',
    metadataTitle: '',
    metadataArtist: '',
  });
});
