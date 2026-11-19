import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessorModule, validateChain } from './chainValidation';
import { renderMixedChain, type ExternalPluginProcessCallback } from './mixedChainRenderer';
import { encodeWavBlob } from './wavEncoder';
import type { ExportConfig, ExternalVST3Params, ParametricEQParams } from '../types/mastering';

function makeSine(sampleRate: number, seconds: number, freqHz: number, amp = 0.25): Float32Array[] {
  const n = Math.floor(sampleRate * seconds);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = amp * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
    l[i] = s;
    r[i] = -s;
  }
  return [l, r];
}

function measureRmsDb(buf: Float32Array, start = 512): number {
  let sum = 0;
  const end = buf.length - start;
  for (let i = start; i < end; i++) {
    sum += buf[i] * buf[i];
  }
  const rms = Math.sqrt(sum / Math.max(1, end - start));
  return 20 * Math.log10(Math.max(1e-12, rms));
}

test('Mixed Mastering Chain: validates external-vst3 roundtrip and refuses silent substitution when host offline', async () => {
  const extMod = createProcessorModule('external-vst3', {
    name: 'SYN Test Gain',
    params: {
      uid: 'vst3-test-gain',
      bundlePath: 'C:\\Program Files\\Common Files\\VST3\\syn_test_vst3_gain.vst3',
      pluginName: 'SYN Test Gain',
      manufacturer: 'SYN MASTER QA',
      version: '1.0.0',
      format: 'vst3',
      instanceId: null,
      latencySamples: 64,
      hasEditor: true,
      editorOpen: false,
      status: 'unloaded',
      lastError: '',
      stateBase64: '',
      parameters: [
        {
          id: 0,
          name: 'Gain',
          label: 'dB',
          valueNormalized: 0.75,
          defaultValueNormalized: 0.5,
          stepCount: 0,
          isAutomatable: true,
          isReadOnly: false,
          isBypass: false,
          displayValue: '+12.0 dB',
        },
      ],
    } satisfies ExternalVST3Params,
  });

  const validated = validateChain([createProcessorModule('parametric-eq'), extMod, createProcessorModule('maximizer')]);
  assert.equal(validated.length, 3);
  assert.equal(validated[1].type, 'external-vst3');
  assert.equal((validated[1].params as ExternalVST3Params).uid, 'vst3-test-gain');

  const src = makeSine(48000, 0.25, 1000, 0.2);
  await assert.rejects(
    () => renderMixedChain(src, 48000, validated),
    /requires a connected SYN-PLUGIN HOST/i,
  );
});

test('Mixed Mastering Chain: sequential [ParametricEQ -> External Callback -> Maximizer], bypass, wetDry, and WAV export roundtrip', async () => {
  const sr = 48000;
  const src = makeSine(sr, 0.4, 1000, 0.25);

  const eq = createProcessorModule('parametric-eq');
  (eq.params as ParametricEQParams).bands[2].freq = 1000;
  (eq.params as ParametricEQParams).bands[2].gain = 3.0;

  const ext = createProcessorModule('external-vst3', {
    name: 'Test External +6dB',
    inputGainDb: 0,
    outputGainDb: 0,
    wetDry: 100,
    params: {
      uid: 'builtin.qa.gain',
      bundlePath: 'C:\\VST3\\syn_test_vst3_gain.vst3',
      pluginName: 'Test External +6dB',
      manufacturer: 'SYN MASTER QA',
      version: '1.0.0',
      format: 'vst3',
      instanceId: 'inst-1',
      latencySamples: 64,
      hasEditor: true,
      editorOpen: false,
      status: 'active',
      lastError: '',
      stateBase64: '',
      parameters: [
        {
          id: 0,
          name: 'Gain',
          label: 'dB',
          valueNormalized: 0.625,
          defaultValueNormalized: 0.5,
          stepCount: 0,
          isAutomatable: true,
          isReadOnly: false,
          isBypass: false,
          displayValue: '+6.0 dB',
        },
      ],
    } satisfies ExternalVST3Params,
  });

  const limiter = createProcessorModule('limiter', {
    params: {
      thresholdDb: -0.5,
      ceilingDb: -1.0,
      releaseMs: 50,
      lookaheadMs: 2,
      truePeak: true,
      oversampling: 4,
    },
  });

  let callbackCalls = 0;
  const gainLin = Math.pow(10, 6 / 20);
  const externalCallback: ExternalPluginProcessCallback = async (channels) => {
    callbackCalls += 1;
    const outL = new Float32Array(channels[0].length);
    const outR = new Float32Array(channels[1].length);
    for (let i = 0; i < channels[0].length; i++) {
      outL[i] = channels[0][i] * gainLin;
      outR[i] = channels[1][i] * gainLin;
    }
    return { channels: [outL, outR], latencySamples: 64 };
  };

  // 1. Sequential hybrid render: EQ (+3dB @ 1kHz) -> External (+6dB) -> Limiter (-1.0 dBTP ceiling)
  const hybrid = await renderMixedChain(src, sr, [eq, ext, limiter], externalCallback);
  assert.equal(callbackCalls, 1);
  assert.equal(hybrid.usedExternalHost, true);
  assert.equal(hybrid.totalExternalLatencySamples, 64);
  assert.equal(hybrid.telemetry.length, 3);

  const inDb = measureRmsDb(src[0]);
  const outDb = measureRmsDb(hybrid.channels[0]);
  assert.ok(outDb > inDb + 5.0, `Expected hybrid EQ+External+Limiter chain boost, got in=${inDb.toFixed(2)} out=${outDb.toFixed(2)}`);

  // Verify ceiling limit is strictly respected after external boost
  let maxAbs = 0;
  for (let i = 0; i < hybrid.channels[0].length; i++) {
    maxAbs = Math.max(maxAbs, Math.abs(hybrid.channels[0][i]), Math.abs(hybrid.channels[1][i]));
  }
  assert.ok(maxAbs <= Math.pow(10, -0.95 / 20), `Expected limiter to constrain external +6dB output under ceiling, got linear peak ${maxAbs}`);

  // 2. Parallel 50% wetDry blend on standalone external module: (1 + 2.0) * 0.5 = 1.5x (+3.52 dB)
  const halfMixExt: typeof ext = { ...ext, wetDry: 50 };
  const halfRes = await renderMixedChain(src, sr, [halfMixExt], externalCallback);
  const halfGainDb = measureRmsDb(halfRes.channels[0]) - inDb;
  const expectedHalfDb = 20 * Math.log10((1 + gainLin) * 0.5);
  assert.ok(Math.abs(halfGainDb - expectedHalfDb) < 0.15, `Expected ~${expectedHalfDb.toFixed(2)} dB wetDry gain, got ${halfGainDb.toFixed(2)} dB`);

  // 3. Bypassed external plugin must pass source audio bit-identically without invoking callback
  callbackCalls = 0;
  const bypassedExt: typeof ext = { ...ext, bypassed: true };
  const bpRes = await renderMixedChain(src, sr, [bypassedExt], externalCallback);
  assert.equal(callbackCalls, 0);
  for (let i = 0; i < src[0].length; i++) {
    assert.equal(bpRes.channels[0][i], src[0][i]);
    assert.equal(bpRes.channels[1][i], src[1][i]);
  }

  // 4. WAV Export roundtrip (32-bit float RIFF WAVE preserves exact mixed-chain PCM)
  const exportCfg: ExportConfig = {
    filename: 'mixed_chain_qa',
    format: 'wav',
    wavBitDepth: 32,
    sampleRate: 48000,
    channels: 'stereo',
    dither: 'none',
    normalizeToTarget: false,
    targetLufs: -14,
    ceilingDb: -0.5,
    deliveryProfile: 'archive',
    metadataTitle: 'Mixed QA',
    metadataArtist: 'SYN MASTER',
  };
  const blob = encodeWavBlob(hybrid.channels, sr, exportCfg);
  const ab = await blob.arrayBuffer();
  const view = new DataView(ab);
  assert.equal(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)), 'RIFF');
  assert.equal(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)), 'WAVE');
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(34, true), 32);
  // Find 'data' chunk and verify exported RMS matches hybrid output
  let offset = 12;
  let dataStart = -1;
  let dataLen = 0;
  while (offset + 8 <= ab.byteLength) {
    const id = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
    const sz = view.getUint32(offset + 4, true);
    if (id === 'data') {
      dataStart = offset + 8;
      dataLen = sz;
      break;
    }
    offset += 8 + sz;
  }
  assert.ok(dataStart > 0 && dataLen === hybrid.channels[0].length * 2 * 4);
  const reimportedL = new Float32Array(hybrid.channels[0].length);
  for (let i = 0; i < reimportedL.length; i++) {
    reimportedL[i] = view.getFloat32(dataStart + i * 8, true);
  }
  assert.ok(Math.abs(measureRmsDb(reimportedL) - outDb) < 0.01);
});
