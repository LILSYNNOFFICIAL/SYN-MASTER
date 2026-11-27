import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreAiSpendStore, SharedAiSpendStoreError } from './firestoreAiSpendStore.mjs';

function jsonResponse(status, body = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('shared global daily cap atomically counts across calls and resets by UTC date', async () => {
  let now = Date.UTC(2026, 0, 2, 23, 59, 59);
  const documents = new Map();
  const transactions = new Set();
  const requests = [];
  let nextTransaction = 0;
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith(':beginTransaction')) {
      const transaction = 'tx-' + (++nextTransaction);
      transactions.add(transaction);
      return jsonResponse(200, { transaction });
    }
    if (String(url).includes('/synMasterAiSpendDaily/')) {
      const path = String(url).split('?')[0];
      if (init.method === 'GET' || !init.method) {
        return documents.has(path)
          ? jsonResponse(200, { fields: { count: { integerValue: String(documents.get(path)) } } })
          : jsonResponse(404, { error: { status: 'NOT_FOUND' } });
      }
    }
    if (String(url).endsWith(':commit')) {
      const body = JSON.parse(init.body);
      assert.ok(transactions.has(body.transaction));
      const write = body.writes[0];
      documents.set(write.update.name, Number(write.update.fields.count.integerValue));
      return jsonResponse(200, { writeResults: [{}] });
    }
    if (String(url).endsWith(':rollback')) return jsonResponse(200, {});
    throw new Error('Unexpected Firestore request: ' + url);
  };

  const store = createFirestoreAiSpendStore({
    projectId: 'syn-master-test',
    getAccessToken: async () => 'test-access-token',
    fetchImpl,
    now: () => now,
  });

  assert.deepEqual(await store.consumeGlobalDaily(1), { allowed: true, remaining: 0, retryAfterMs: 0 });
  const denied = await store.consumeGlobalDaily(1);
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.ok(denied.retryAfterMs > 0);
  assert.equal([...documents.values()].reduce((sum, value) => sum + value, 0), 1);
  assert.ok(requests.every(({ init }) => init.headers.Authorization === 'Bearer test-access-token'));

  now += 2000;
  assert.deepEqual(await store.consumeGlobalDaily(1), { allowed: true, remaining: 0, retryAfterMs: 0 });
  assert.equal(documents.size, 2, 'a new UTC date uses an independent counter document');
});

test('shared global daily cap fails closed when Firestore rejects a write', async () => {
  const store = createFirestoreAiSpendStore({
    projectId: 'syn-master-test',
    getAccessToken: async () => 'test-access-token',
    now: () => Date.UTC(2026, 0, 2),
    fetchImpl: async (url) => {
      if (String(url).endsWith(':beginTransaction')) return jsonResponse(200, { transaction: 'tx' });
      if (String(url).includes('/synMasterAiSpendDaily/')) return jsonResponse(404);
      if (String(url).endsWith(':commit')) return jsonResponse(403, { error: { status: 'PERMISSION_DENIED' } });
      return jsonResponse(200, {});
    },
  });

  await assert.rejects(store.consumeGlobalDaily(4), (error) =>
    error instanceof SharedAiSpendStoreError && error.status === 403);
});
