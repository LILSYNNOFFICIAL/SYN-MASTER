/**
 * Vocal Rebalance stem cache helpers loaded on demand by rebalanceStemStore: the device
 * assessment (pure, unit-tested) and best-effort OPFS persistence (`syn-master-rebalance-v1/`,
 * latest two tracks), so a reload does not re-separate.
 */
import { REBALANCE_STEM_IDS, type RebalanceStemId, type RebalanceStemSet } from '../dsp/vocalRebalance.ts';

// ---------------------------------------------------------------------------------------------
// Device assessment (pure, unit-tested)
// ---------------------------------------------------------------------------------------------

export interface RebalanceDeviceInfo {
  deviceMemoryGb?: number;
  isMobile?: boolean;
  hasOpfs?: boolean;
  hasWorker?: boolean;
}

export interface RebalanceResourceAssessment {
  level: 'ok' | 'warn' | 'block';
  /** Peak working memory estimate for separation plus resident stems, MB. */
  estimatedMb: number;
  budgetMb: number;
  message: string;
}

/**
 * Separation holds four stereo stems plus resampling copies; afterwards three stereo stems stay
 * resident on the main thread and three more in the DSP worker. Budget follows Stem Studio's
 * rule (deviceMemory x 512 MB, clamped 768-2048 MB).
 */
export function assessRebalanceResources(durationSec: number, sampleRate: number, device: RebalanceDeviceInfo): RebalanceResourceAssessment {
  const frames = Math.max(0, durationSec) * Math.max(44_100, sampleRate);
  const peakBytes = frames * 4 * 16; // ~16 mono float channels at peak
  const estimatedMb = Math.ceil(peakBytes / (1024 * 1024));
  const mem = device.deviceMemoryGb ?? 4;
  const budgetMb = Math.round(Math.min(2_048, Math.max(768, mem * 512)));
  if (device.hasWorker === false) {
    return { level: 'block', estimatedMb, budgetMb, message: 'This browser cannot run the separation worker. Skip Vocal Rebalance on this device.' };
  }
  if (device.hasOpfs === false) {
    return { level: 'block', estimatedMb, budgetMb, message: 'This browser has no temporary disk storage (OPFS), which stem separation needs. Use current Chrome or Edge over HTTPS, or skip Vocal Rebalance.' };
  }
  if (estimatedMb > budgetMb * 1.5) {
    return {
      level: 'block',
      estimatedMb,
      budgetMb,
      message: `Separating this track needs about ${estimatedMb} MB, well above this device's ~${budgetMb} MB safe budget. Skip Vocal Rebalance here, or run it on a desktop browser.`,
    };
  }
  if (device.isMobile || mem <= 4 || estimatedMb > budgetMb * 0.6) {
    return {
      level: 'warn',
      estimatedMb,
      budgetMb,
      message: `Separation is slow and needs about ${estimatedMb} MB (device budget ~${budgetMb} MB)${device.isMobile ? ' on a phone or tablet' : ''}. The tab may be slowed or reloaded. Continue, or skip Vocal Rebalance.`,
    };
  }
  return { level: 'ok', estimatedMb, budgetMb, message: `Separation needs about ${estimatedMb} MB and takes a while; stems are cached for this track.` };
}

export function detectDevice(): RebalanceDeviceInfo {
  const nav = (typeof navigator !== 'undefined' ? navigator : undefined) as (Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } }) | undefined;
  const ua = nav?.userAgent ?? '';
  const coarse = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return {
    deviceMemoryGb: nav?.deviceMemory,
    isMobile: nav?.userAgentData?.mobile === true || /Android|iPhone|iPad|Mobile/i.test(ua) || coarse,
    hasOpfs: Boolean(nav?.storage?.getDirectory),
    hasWorker: typeof Worker !== 'undefined',
  };
}

// ---------------------------------------------------------------------------------------------
// OPFS persistence (best effort)
// ---------------------------------------------------------------------------------------------

const OPFS_DIR = 'syn-master-rebalance-v1';
const OPFS_KEEP = 2;

async function cacheDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    return root ? await root.getDirectoryHandle(OPFS_DIR, { create: true }) : null;
  } catch {
    return null;
  }
}
const fileFor = (fp: string, id: RebalanceStemId, ch: 0 | 1) => `${fp}.${id}.${ch ? 'R' : 'L'}.f32`;

export async function saveToOpfs(set: RebalanceStemSet): Promise<void> {
  const dir = await cacheDir();
  if (!dir) return;
  try {
    for (const id of REBALANCE_STEM_IDS) {
      for (const ch of [0, 1] as const) {
        const handle = await dir.getFileHandle(fileFor(set.fingerprint, id, ch), { create: true });
        const writable = await handle.createWritable();
        await writable.write(set.stems[id][ch] as Float32Array<ArrayBuffer>);
        await writable.close();
      }
    }
    const meta = await dir.getFileHandle(`${set.fingerprint}.json`, { create: true });
    const w = await meta.createWritable();
    await w.write(JSON.stringify({ sampleRate: set.sampleRate, length: set.length, savedAt: Date.now() }));
    await w.close();
    await pruneOpfs(dir, set.fingerprint);
  } catch {
    // Persistence is optional; the in-memory cache still serves this session.
  }
}

async function pruneOpfs(dir: FileSystemDirectoryHandle, keep: string): Promise<void> {
  const metas: Array<{ fp: string; savedAt: number }> = [];
  const iterable = dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> };
  for await (const [name, handle] of iterable.entries()) {
    if (!name.endsWith('.json') || handle.kind !== 'file') continue;
    try {
      const text = await (await (handle as FileSystemFileHandle).getFile()).text();
      metas.push({ fp: name.slice(0, -5), savedAt: Number(JSON.parse(text).savedAt) || 0 });
    } catch { /* ignore unreadable meta */ }
  }
  metas.sort((a, b) => b.savedAt - a.savedAt);
  const drop = metas.filter((m) => m.fp !== keep).slice(Math.max(0, OPFS_KEEP - 1));
  for (const m of drop) {
    await dir.removeEntry(`${m.fp}.json`).catch(() => undefined);
    for (const id of REBALANCE_STEM_IDS) for (const ch of [0, 1] as const) await dir.removeEntry(fileFor(m.fp, id, ch)).catch(() => undefined);
  }
}

export async function loadFromOpfs(fingerprint: string, sampleRate: number, length: number): Promise<RebalanceStemSet | null> {
  const dir = await cacheDir();
  if (!dir) return null;
  try {
    const meta = JSON.parse(await (await (await dir.getFileHandle(`${fingerprint}.json`)).getFile()).text());
    if (meta.sampleRate !== sampleRate || meta.length !== length) return null;
    const stems = {} as RebalanceStemSet['stems'];
    for (const id of REBALANCE_STEM_IDS) {
      const pair: Float32Array[] = [];
      for (const ch of [0, 1] as const) {
        const file = await (await dir.getFileHandle(fileFor(fingerprint, id, ch))).getFile();
        if (file.size !== length * 4) return null;
        pair.push(new Float32Array(await file.arrayBuffer()));
      }
      stems[id] = [pair[0], pair[1]];
    }
    return { fingerprint, sampleRate, length, stems };
  } catch {
    return null;
  }
}
