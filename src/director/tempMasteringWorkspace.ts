/**
 * Per-run scratch workspace for Fix All & Verify.
 * OPFS provides a sandboxed temporary folder without exposing user file paths.
 * A memory-only fallback preserves the mastering workflow where OPFS is unavailable.
 */
type ScratchFileHandle = {
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
};
type ScratchDirectoryHandle = {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ScratchDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<ScratchFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
};

export interface TemporaryMasteringWorkspace {
  storage: 'opfs' | 'memory';
  writeJson(relativePath: string, value: unknown): Promise<void>;
  cleanup(): Promise<void>;
}

function safeSegments(relativePath: string): string[] {
  const segments = relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, '_'));
  if (segments.length === 0) throw new Error('A temporary note filename is required.');
  return segments;
}

export async function createTemporaryMasteringWorkspace(
  runId: string,
): Promise<TemporaryMasteringWorkspace> {
  const folderName = runId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 90) || 'run-' + Date.now();
  const memory = new Map<string, string>();
  const storage = typeof navigator !== 'undefined' ? navigator.storage as unknown as {
    getDirectory?: () => Promise<ScratchDirectoryHandle>;
  } : undefined;

  try {
    if (!storage?.getDirectory) throw new Error('Origin Private File System unavailable');
    const root = await storage.getDirectory();
    const scratchRoot = await root.getDirectoryHandle('SYN-MASTER-TEMP', { create: true });
    const runFolder = await scratchRoot.getDirectoryHandle(folderName, { create: true });
    return {
      storage: 'opfs',
      async writeJson(relativePath, value) {
        const segments = safeSegments(relativePath);
        let dir = runFolder;
        for (const segment of segments.slice(0, -1)) {
          dir = await dir.getDirectoryHandle(segment, { create: true });
        }
        const file = await dir.getFileHandle(segments[segments.length - 1], { create: true });
        const writable = await file.createWritable();
        await writable.write(JSON.stringify(value, null, 2));
        await writable.close();
      },
      async cleanup() {
        await scratchRoot.removeEntry(folderName, { recursive: true }).catch(() => undefined);
      },
    };
  } catch {
    return {
      storage: 'memory',
      async writeJson(relativePath, value) {
        memory.set(safeSegments(relativePath).join('/'), JSON.stringify(value));
      },
      async cleanup() {
        memory.clear();
      },
    };
  }
}
