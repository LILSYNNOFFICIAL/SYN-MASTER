/**
 * Persistent per-run diagnostic workspace for Fix All & Verify.
 *
 * OPFS stores full diagnostic bundles without exposing user file paths.
 * A small localStorage index makes completed runs discoverable after reload.
 * The in-memory fallback keeps the current bundle exportable when durable
 * browser storage is unavailable, but never claims that it survived a reload.
 */
type ScratchFileHandle = {
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
  getFile(): Promise<{ text(): Promise<string> }>;
};

type ScratchDirectoryHandle = {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ScratchDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<ScratchFileHandle>;
};

export interface MasteringDiagnosticRunSummary {
  runId: string;
  createdAt: number;
  trackName: string;
  objectiveId: string;
  operatingMode: string;
  status: string;
  storage: 'opfs' | 'memory';
}

export interface MasteringDiagnosticBundle {
  schemaVersion: 1;
  summary: MasteringDiagnosticRunSummary;
  session: Record<string, unknown>;
}

export interface MasteringDiagnosticWorkspace {
  runId: string;
  storage: 'opfs' | 'memory';
  writeJson(relativePath: string, value: unknown): Promise<void>;
  complete(
    summary: MasteringDiagnosticRunSummary,
    bundle: MasteringDiagnosticBundle,
  ): Promise<{ persisted: boolean }>;
}

type ScratchStorage = {
  getDirectory?: () => Promise<ScratchDirectoryHandle>;
};

type DiagnosticIndexStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const SCRATCH_ROOT_NAME = 'SYN-MASTER-TEMP';
const DIAGNOSTIC_INDEX_KEY = 'syn-master:diagnostic-runs:v1';
const MAX_INDEXED_RUNS = 100;

function safeSegments(relativePath: string): string[] {
  const segments = relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, '_'));
  if (segments.length === 0) throw new Error('A diagnostic filename is required.');
  return segments;
}

function safeRunId(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 90);
  if (!safe || safe === '.' || safe === '..') {
    throw new Error('A valid diagnostic run ID is required.');
  }
  return safe;
}

function resolveFileStorage(override?: ScratchStorage): ScratchStorage | undefined {
  if (override) return override;
  try {
    return (globalThis.navigator as Navigator & { storage?: ScratchStorage } | undefined)?.storage;
  } catch {
    return undefined;
  }
}

function resolveIndexStorage(override?: DiagnosticIndexStorage): DiagnosticIndexStorage | undefined {
  if (override) return override;
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readIndex(indexStorage?: DiagnosticIndexStorage): MasteringDiagnosticRunSummary[] {
  if (!indexStorage) return [];
  try {
    const raw = indexStorage.getItem(DIAGNOSTIC_INDEX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is MasteringDiagnosticRunSummary => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Partial<MasteringDiagnosticRunSummary>;
      return (
        typeof candidate.runId === 'string' &&
        typeof candidate.createdAt === 'number' &&
        typeof candidate.trackName === 'string' &&
        typeof candidate.objectiveId === 'string' &&
        typeof candidate.operatingMode === 'string' &&
        typeof candidate.status === 'string' &&
        candidate.storage === 'opfs'
      );
    }).sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

function writeIndex(
  summary: MasteringDiagnosticRunSummary,
  indexStorage?: DiagnosticIndexStorage,
): boolean {
  if (!indexStorage) return false;
  try {
    const next = [
      summary,
      ...readIndex(indexStorage).filter((entry) => entry.runId !== summary.runId),
    ].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_INDEXED_RUNS);
    indexStorage.setItem(DIAGNOSTIC_INDEX_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

async function writeJsonToDirectory(
  runFolder: ScratchDirectoryHandle,
  relativePath: string,
  value: unknown,
): Promise<void> {
  const segments = safeSegments(relativePath);
  let dir = runFolder;
  for (const segment of segments.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  const file = await dir.getFileHandle(segments[segments.length - 1], { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(value, null, 2));
  await writable.close();
}

export async function createTemporaryMasteringWorkspace(
  runId: string,
  storageOverride?: ScratchStorage,
  indexOverride?: DiagnosticIndexStorage,
): Promise<MasteringDiagnosticWorkspace> {
  const folderName = safeRunId(runId);
  const storage = resolveFileStorage(storageOverride);
  const indexStorage = resolveIndexStorage(indexOverride);
  const memory = new Map<string, string>();

  try {
    if (!storage?.getDirectory) throw new Error('Origin Private File System unavailable');
    const root = await storage.getDirectory();
    const scratchRoot = await root.getDirectoryHandle(SCRATCH_ROOT_NAME, { create: true });
    const runFolder = await scratchRoot.getDirectoryHandle(folderName, { create: true });

    const writeJson = (relativePath: string, value: unknown) =>
      writeJsonToDirectory(runFolder, relativePath, value);

    return {
      runId: folderName,
      storage: 'opfs',
      writeJson,
      async complete(summary, bundle) {
        const durableSummary: MasteringDiagnosticRunSummary = {
          ...summary,
          runId: folderName,
          storage: 'opfs',
        };
        const durableBundle: MasteringDiagnosticBundle = {
          ...bundle,
          summary: durableSummary,
        };
        await writeJson('manifest.json', durableSummary);
        await writeJson('final/diagnostic-bundle.json', durableBundle);
        return { persisted: writeIndex(durableSummary, indexStorage) };
      },
    };
  } catch {
    return {
      runId: folderName,
      storage: 'memory',
      async writeJson(relativePath, value) {
        memory.set(safeSegments(relativePath).join('/'), JSON.stringify(value, null, 2));
      },
      async complete(summary, bundle) {
        const memorySummary: MasteringDiagnosticRunSummary = {
          ...summary,
          runId: folderName,
          storage: 'memory',
        };
        memory.set('manifest.json', JSON.stringify(memorySummary, null, 2));
        memory.set(
          'final/diagnostic-bundle.json',
          JSON.stringify({ ...bundle, summary: memorySummary }, null, 2),
        );
        // Memory fallback is deliberately not indexed as persistent storage.
        return { persisted: false };
      },
    };
  }
}

export async function listMasteringDiagnosticRuns(
  _storageOverride?: ScratchStorage,
  indexOverride?: DiagnosticIndexStorage,
): Promise<MasteringDiagnosticRunSummary[]> {
  return readIndex(resolveIndexStorage(indexOverride));
}

export async function loadMasteringDiagnosticBundle(
  runId: string,
  storageOverride?: ScratchStorage,
): Promise<MasteringDiagnosticBundle | null> {
  const storage = resolveFileStorage(storageOverride);
  if (!storage?.getDirectory) return null;

  try {
    const root = await storage.getDirectory();
    const scratchRoot = await root.getDirectoryHandle(SCRATCH_ROOT_NAME);
    const runFolder = await scratchRoot.getDirectoryHandle(safeRunId(runId));
    const finalFolder = await runFolder.getDirectoryHandle('final');
    const file = await finalFolder.getFileHandle('diagnostic-bundle.json');
    const parsed: unknown = JSON.parse(await (await file.getFile()).text());
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<MasteringDiagnosticBundle>;
    if (candidate.schemaVersion !== 1 || !candidate.summary || !candidate.session) return null;
    return candidate as MasteringDiagnosticBundle;
  } catch {
    return null;
  }
}
