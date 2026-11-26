import test from 'node:test';
import assert from 'node:assert/strict';
import { SynAudioEngine, type AuditionTarget } from './audioEngine';

test('mastered offline render remains the active buffer while the processor rack is bypassed', () => {
  const engine = new SynAudioEngine();
  const source = {} as AudioBuffer;
  const fadedRender = {} as AudioBuffer;
  const internals = engine as unknown as {
    sourceBuffer: AudioBuffer | null;
    overrideBuffers: Map<string, AudioBuffer>;
    auditionTarget: AuditionTarget;
    chainBypassed: boolean;
    getActiveBuffer: () => AudioBuffer | null;
    isLiveDspActive: () => boolean;
  };

  internals.sourceBuffer = source;
  internals.overrideBuffers.set('mastered-external', fadedRender);
  internals.auditionTarget = 'mastered';
  internals.chainBypassed = true;

  assert.equal(internals.getActiveBuffer(), fadedRender, 'timeline fades remain audible when the rack is bypassed');
  assert.equal(internals.isLiveDspActive(), false, 'the offline buffer must not pass through the live DSP chain again');
});

test('mastered offline render updates and clears hot-swap during bypassed playback', () => {
  const engine = new SynAudioEngine();
  const fakeBuffer = {} as AudioBuffer;
  const playedAt: number[] = [];
  const internals = engine as unknown as {
    createAudioBufferFromChannels: (channels: Float32Array[], sampleRate: number) => AudioBuffer;
    isPlaying: boolean;
    chainBypassed: boolean;
    auditionTarget: AuditionTarget;
    getCurrentTimeSec: () => number;
    play: (startAtSec?: number) => void;
    rebuildLiveGraph: () => void;
  };

  internals.createAudioBufferFromChannels = () => fakeBuffer;
  internals.isPlaying = true;
  internals.chainBypassed = true;
  internals.auditionTarget = 'mastered';
  internals.getCurrentTimeSec = () => 12.5;
  internals.play = (position = 0) => { playedAt.push(position); };
  internals.rebuildLiveGraph = () => { throw new Error('active playback should hot-swap, not only rebuild the graph'); };

  engine.setOverrideBuffer('mastered-external', [new Float32Array([0, 0])], 48000);
  engine.clearOverrideBuffer('mastered-external');

  assert.deepEqual(playedAt, [12.5, 12.5], 'buffer install and removal must preserve the playback position');
});
