import test from 'node:test';
import assert from 'node:assert/strict';
import * as workspaceModule from './tempMasteringWorkspace';

type StoredFile = {
  text(): Promise<string>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
};

class FakeFile implements StoredFile {
  value = '';
  async text(): Promise<string> {
    return this.value;
  }
  async createWritable() {
    return {
      write: async (data: string) => { this.value = data; },
      close: async () => undefined,
    };
  }
}

class FakeDirectory {
  private readonly directories = new Map<string, FakeDirectory>();
  private readonly files = new Map<string, FakeFile>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) throw new Error('Directory not found: ' + name);
    const created = new FakeDirectory();
    this.directories.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFile> {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options?.create) throw new Error('File not found: ' + name);
    const created = new FakeFile();
    this.files.set(name, created);
    return created;
  }

  async removeEntry(name: string): Promise<void> {
    this.directories.delete(name);
    this.files.delete(name);
  }
}

class FakeStorageIndex {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test('completed Fix All diagnostics survive workspace closure and can be reopened for export', async () => {
  const storageRoot = new FakeDirectory();
  const fileStorage = { getDirectory: async () => storageRoot };
  const indexStorage = new FakeStorageIndex();
  const createWorkspace = workspaceModule.createTemporaryMasteringWorkspace as unknown as (
    runId: string,
    storage: typeof fileStorage,
    index: FakeStorageIndex,
  ) => Promise<{
    storage: 'opfs' | 'memory';
    complete: (summary: unknown, bundle: unknown) => Promise<{ persisted: boolean }>;
    writeJson: (path: string, value: unknown) => Promise<void>;
  }>;

  const workspace = await createWorkspace('fix-all-track-001', fileStorage, indexStorage);
  assert.equal(workspace.storage, 'opfs');
  await workspace.writeJson('baseline/analysis.json', { integratedLufs: -16.2 });

  const summary = {
    runId: 'fix-all-track-001',
    createdAt: 1795370000000,
    trackName: 'Test Track',
    objectiveId: 'streaming',
    operatingMode: 'autonomous',
    status: 'partially-corrected',
    storage: 'opfs',
  };
  const bundle = {
    schemaVersion: 1,
    summary,
    baseline: { integratedLufs: -16.2 },
    diagnosis: [{ id: 'diag-mud', severity: 'moderate' }],
    corrections: [{ processor: 'dynamic-eq', frequencyHz: 260, maxCutDb: -2 }],
    verification: { unresolvedFindingCount: 1 },
  };

  const completion = await workspace.complete(summary, bundle);
  assert.deepEqual(completion, { persisted: true });

  const listRuns = workspaceModule.listMasteringDiagnosticRuns as unknown as (
    storage: typeof fileStorage,
    index: FakeStorageIndex,
  ) => Promise<Array<typeof summary>>;
  const loadBundle = workspaceModule.loadMasteringDiagnosticBundle as unknown as (
    runId: string,
    storage: typeof fileStorage,
  ) => Promise<unknown | null>;

  const listed = await listRuns(fileStorage, indexStorage);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].runId, 'fix-all-track-001');

  const reopened = await loadBundle('fix-all-track-001', fileStorage);
  assert.deepEqual(reopened, bundle);
});

test('memory fallback remains downloadable in-session but is not falsely listed as durable', async () => {
  const unavailableStorage = { getDirectory: async () => { throw new Error('OPFS unavailable'); } };
  const indexStorage = new FakeStorageIndex();
  const createWorkspace = workspaceModule.createTemporaryMasteringWorkspace as unknown as (
    runId: string,
    storage: typeof unavailableStorage,
    index: FakeStorageIndex,
  ) => Promise<{
    storage: 'opfs' | 'memory';
    complete: (summary: unknown, bundle: unknown) => Promise<{ persisted: boolean }>;
  }>;
  const workspace = await createWorkspace('memory-only-run', unavailableStorage, indexStorage);
  assert.equal(workspace.storage, 'memory');

  const summary = {
    runId: 'memory-only-run',
    createdAt: 1795370000001,
    trackName: 'Memory Track',
    objectiveId: 'streaming',
    operatingMode: 'autonomous',
    status: 'completed',
    storage: 'memory',
  };
  const result = await workspace.complete(summary, { schemaVersion: 1, summary });
  assert.deepEqual(result, { persisted: false });

  const listRuns = workspaceModule.listMasteringDiagnosticRuns as unknown as (
    storage: typeof unavailableStorage,
    index: FakeStorageIndex,
  ) => Promise<Array<typeof summary>>;
  assert.deepEqual(await listRuns(unavailableStorage, indexStorage), []);
});
