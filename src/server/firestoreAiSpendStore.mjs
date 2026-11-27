const METADATA_ROOT = 'http://metadata.google.internal/computeMetadata/v1';
const FIRESTORE_ROOT = 'https://firestore.googleapis.com/v1';

export class SharedAiSpendStoreError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.name = 'SharedAiSpendStoreError';
    this.status = status;
  }
}

async function readJson(response, operation) {
  let data = {};
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    const reason = data?.error?.status || data?.error?.message || ('HTTP ' + response.status);
    throw new SharedAiSpendStoreError('Shared AI budget ' + operation + ' failed (' + String(reason).slice(0, 120) + ').', response.status);
  }
  return data;
}

/** Firestore-backed atomic daily counter for Cloud Run replicas, using the service identity. */
export function createFirestoreAiSpendStore(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const databaseId = options.databaseId ?? env.SYN_AI_SPEND_DATABASE ?? '(default)';
  let projectId = options.projectId ?? env.SYN_AI_SPEND_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT ?? env.GCLOUD_PROJECT;
  let accessTokenCache = null;
  let accessTokenExpiresAt = 0;

  async function resolveProjectId() {
    if (projectId) return projectId;
    const response = await fetchImpl(METADATA_ROOT + '/project/project-id', {
      headers: { 'Metadata-Flavor': 'Google' },
    });
    if (!response.ok) throw new SharedAiSpendStoreError('Could not resolve the Google Cloud project for shared AI budget storage.');
    projectId = (await response.text()).trim();
    if (!projectId) throw new SharedAiSpendStoreError('The Google Cloud project ID is empty.');
    return projectId;
  }

  async function getAccessToken() {
    if (options.getAccessToken) return options.getAccessToken();
    if (accessTokenCache && now() < accessTokenExpiresAt - 60_000) return accessTokenCache;
    const response = await fetchImpl(METADATA_ROOT + '/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
    });
    const data = await readJson(response, 'service identity lookup');
    if (typeof data.access_token !== 'string' || !data.access_token) {
      throw new SharedAiSpendStoreError('The Cloud Run service identity did not provide an access token.');
    }
    accessTokenCache = data.access_token;
    accessTokenExpiresAt = now() + Math.max(60, Number(data.expires_in) || 3600) * 1000;
    return accessTokenCache;
  }

  async function api(url, init, operation) {
    const token = await getAccessToken();
    const response = await fetchImpl(url, {
      ...init,
      headers: { Authorization: 'Bearer ' + token, ...(init?.headers ?? {}) },
    });
    return readJson(response, operation);
  }

  async function rollback(root, transaction) {
    try {
      await api(root + ':rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction }),
      }, 'transaction cleanup');
    } catch { /* transaction expiry also releases an abandoned transaction */ }
  }

  async function consumeGlobalDaily(limit) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('A positive integer global daily limit is required.');
    const project = await resolveProjectId();
    const database = encodeURIComponent(databaseId);
    const root = FIRESTORE_ROOT + '/projects/' + encodeURIComponent(project) + '/databases/' + database + '/documents';
    const day = new Date(now()).toISOString().slice(0, 10);
    const documentPath = root + '/synMasterAiSpendDaily/' + day;
    const retryAfterMs = Math.max(1000, Date.parse(day + 'T23:59:59.999Z') + 1 - now());

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const transactionResponse = await api(root + ':beginTransaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ options: { readWrite: {} } }),
      }, 'transaction start');
      const transaction = transactionResponse.transaction;
      if (typeof transaction !== 'string' || !transaction) {
        throw new SharedAiSpendStoreError('Firestore did not return a transaction ID.');
      }

      let exists = false;
      let count = 0;
      try {
        const readUrl = documentPath + '?transaction=' + encodeURIComponent(transaction);
        const response = await fetchImpl(readUrl, {
          headers: { Authorization: 'Bearer ' + await getAccessToken() },
        });
        if (response.status === 404) {
          exists = false;
        } else {
          const document = await readJson(response, 'counter read');
          exists = true;
          count = Number(document.fields?.count?.integerValue ?? 0);
          if (!Number.isSafeInteger(count) || count < 0) {
            await rollback(root, transaction);
            throw new SharedAiSpendStoreError('The shared AI budget counter contains an invalid value.');
          }
        }

        if (count >= limit) {
          await rollback(root, transaction);
          return { allowed: false, remaining: 0, retryAfterMs };
        }

        const nextCount = count + 1;
        const commit = await api(root + ':commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transaction,
            writes: [{
              update: {
                name: documentPath,
                fields: {
                  count: { integerValue: String(nextCount) },
                  day: { stringValue: day },
                },
              },
              updateMask: { fieldPaths: ['count', 'day'] },
              currentDocument: { exists },
            }],
          }),
        }, 'counter commit');
        if (!Array.isArray(commit.writeResults) || commit.writeResults.length !== 1) {
          throw new SharedAiSpendStoreError('Firestore did not confirm the shared AI budget update.');
        }
        return { allowed: true, remaining: Math.max(0, limit - nextCount), retryAfterMs: 0 };
      } catch (error) {
        if (error instanceof SharedAiSpendStoreError && error.status === 409 && attempt < 4) continue;
        await rollback(root, transaction);
        throw error;
      }
    }
    throw new SharedAiSpendStoreError('Shared AI budget transaction remained busy after retries.', 409);
  }

  return { consumeGlobalDaily };
}
