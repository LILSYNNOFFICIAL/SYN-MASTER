import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DIRECTOR_OPERATING_MODE } from './operatingModeDefaults';

test('fresh Director sessions default to AI Automatic', () => {
  assert.equal(DEFAULT_DIRECTOR_OPERATING_MODE, 'autonomous');
});
