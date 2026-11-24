import assert from 'node:assert/strict';
import test from 'node:test';
import { needsDesktopViewport, parseViewMode, readViewMode, resolveViewShell, VIEW_MODE_STORAGE_KEY, writeViewMode } from './viewMode';

test('parseViewMode falls back to auto for unknown values', () => {
  assert.equal(parseViewMode('desktop'), 'desktop');
  assert.equal(parseViewMode('mobile'), 'mobile');
  assert.equal(parseViewMode('tablet'), 'auto');
  assert.equal(parseViewMode(null), 'auto');
});

test('view mode persists in storage and auto clears it', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  writeViewMode('mobile', storage);
  assert.equal(store.get(VIEW_MODE_STORAGE_KEY), 'mobile');
  assert.equal(readViewMode(storage), 'mobile');
  writeViewMode('auto', storage);
  assert.equal(store.has(VIEW_MODE_STORAGE_KEY), false);
  assert.equal(readViewMode(storage), 'auto');
  assert.equal(readViewMode({ getItem: () => { throw new Error('blocked'); } }), 'auto');
});

test('mobile mode frames the app only on wide screens and never inside the frame', () => {
  assert.equal(resolveViewShell('mobile', { screenWidth: 1440, inFrame: false }), 'mobile-frame');
  assert.equal(resolveViewShell('mobile', { screenWidth: 412, inFrame: false }), 'app');
  assert.equal(resolveViewShell('mobile', { screenWidth: 1440, inFrame: true }), 'app');
  assert.equal(resolveViewShell('auto', { screenWidth: 1440, inFrame: false }), 'app');
  assert.equal(resolveViewShell('desktop', { screenWidth: 1440, inFrame: false }), 'app');
});

test('desktop mode widens the viewport only on narrow screens', () => {
  assert.equal(needsDesktopViewport('desktop', 412), true);
  assert.equal(needsDesktopViewport('desktop', 1440), false);
  assert.equal(needsDesktopViewport('auto', 412), false);
});
