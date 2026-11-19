import type {
  AppSettings,
  MasteringPreset,
  ProjectRecord,
  SavedChainRecord,
} from '../types/mastering';

const DB_NAME = 'syn_master_workstation_db';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_PRESETS = 'custom_presets';
const STORE_CHAINS = 'saved_chains';
const STORE_SETTINGS = 'settings';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PRESETS)) {
        db.createObjectStore(STORE_PRESETS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CHAINS)) {
        db.createObjectStore(STORE_CHAINS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
}

async function getAllFromStore<T>(storeName: string): Promise<T[]> {
  try {
    const db = await openDb();
    return await new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result as T[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function putInStore<T>(storeName: string, value: T): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(value);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Graceful no-op in restricted environments
  }
}

async function deleteFromStore(storeName: string, key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore
  }
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const list = await getAllFromStore<ProjectRecord>(STORE_PROJECTS);
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveProject(project: ProjectRecord): Promise<void> {
  await putInStore(STORE_PROJECTS, { ...project, updatedAt: Date.now() });
}

export async function removeProject(id: string): Promise<void> {
  await deleteFromStore(STORE_PROJECTS, id);
}

export async function listCustomPresets(): Promise<MasteringPreset[]> {
  return getAllFromStore<MasteringPreset>(STORE_PRESETS);
}

export async function saveCustomPreset(preset: MasteringPreset): Promise<void> {
  await putInStore(STORE_PRESETS, preset);
}

export async function removeCustomPreset(id: string): Promise<void> {
  await deleteFromStore(STORE_PRESETS, id);
}

export async function listSavedChains(): Promise<SavedChainRecord[]> {
  const chains = await getAllFromStore<SavedChainRecord>(STORE_CHAINS);
  return chains.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveChainRecord(record: SavedChainRecord): Promise<void> {
  await putInStore(STORE_CHAINS, record);
}

export async function removeChainRecord(id: string): Promise<void> {
  await deleteFromStore(STORE_CHAINS, id);
}

export async function loadAppSettings(): Promise<AppSettings | null> {
  try {
    const db = await openDb();
    return await new Promise<AppSettings | null>((resolve) => {
      const tx = db.transaction(STORE_SETTINGS, 'readonly');
      const req = tx.objectStore(STORE_SETTINGS).get('app_settings');
      req.onsuccess = () => {
        const res = req.result as { key: string; value: AppSettings } | undefined;
        resolve(res?.value ?? null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
  await putInStore(STORE_SETTINGS, { key: 'app_settings', value: settings });
}
