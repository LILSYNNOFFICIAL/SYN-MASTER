import test from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryStore } from './telemetryStore.ts';

test('initializes stopped and publishes state changes to subscribers', () => {
  const store = new TelemetryStore();
  assert.deepEqual(store.getSnapshot(), { isPlaying: false, currentTimeSec: 0, live: null });
  assert.equal(store.getListenerCount(), 0);

  const updates: Array<{ isPlaying: boolean; currentTimeSec: number }> = [];
  const unsubscribe = store.subscribe((state) => {
    updates.push({ isPlaying: state.isPlaying, currentTimeSec: state.currentTimeSec });
  });

  store.publish({ isPlaying: true, currentTimeSec: 12.5 });
  store.publish({ currentTimeSec: 13 });
  assert.deepEqual(updates, [
    { isPlaying: true, currentTimeSec: 12.5 },
    { isPlaying: true, currentTimeSec: 13 },
  ]);

  unsubscribe();
  store.publish({ currentTimeSec: 14 });
  assert.equal(updates.length, 2);
  assert.equal(store.getListenerCount(), 0);
});

test('reset clears playback, position, and live meter snapshot', () => {
  const store = new TelemetryStore();
  store.publish({ isPlaying: true, currentTimeSec: 9, live: null });
  store.reset();
  assert.deepEqual(store.getSnapshot(), { isPlaying: false, currentTimeSec: 0, live: null });
});

test('normalizes invalid/negative playhead values and isolates subscriber failures', () => {
  const store = new TelemetryStore();
  let notified = false;
  store.subscribe(() => { throw new Error('simulated subscriber fault'); });
  store.subscribe(() => { notified = true; });

  const originalError = console.error;
  console.error = () => {};
  try {
    store.publish({ currentTimeSec: Number.NaN, isPlaying: true });
    store.publish({ currentTimeSec: -5 });
  } finally {
    console.error = originalError;
  }
  assert.equal(store.getSnapshot().currentTimeSec, 0);
  assert.equal(notified, true);
});
