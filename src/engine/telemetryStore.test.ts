import test from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryStore } from './telemetryStore';

test('TelemetryStore initializes with stopped default state and notifies subscribers cleanly', () => {
  const store = new TelemetryStore();
  assert.deepEqual(store.getSnapshot(), {
    isPlaying: false,
    currentTimeSec: 0,
    live: null,
  });
  assert.equal(store.getListenerCount(), 0);

  const updates: Array<{ isPlaying: boolean; currentTimeSec: number }> = [];
  const unsub1 = store.subscribe((state) => {
    updates.push({ isPlaying: state.isPlaying, currentTimeSec: state.currentTimeSec });
  });
  const unsub2 = store.subscribe(() => {});
  assert.equal(store.getListenerCount(), 2);

  store.publish({ isPlaying: true, currentTimeSec: 12.5 });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { isPlaying: true, currentTimeSec: 12.5 });

  store.publish({ currentTimeSec: 13.0 });
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1], { isPlaying: true, currentTimeSec: 13.0 });

  unsub1();
  assert.equal(store.getListenerCount(), 1);
  store.publish({ currentTimeSec: 14.0 });
  assert.equal(updates.length, 2, 'Unsubscribed listener must not receive further notifications');

  store.reset();
  assert.deepEqual(store.getSnapshot(), {
    isPlaying: false,
    currentTimeSec: 0,
    live: null,
  });

  unsub2();
  assert.equal(store.getListenerCount(), 0);
});
