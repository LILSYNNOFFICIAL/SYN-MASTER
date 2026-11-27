/**
 * Browser-side memory of what the AI actually proposed, keyed by validated module id.
 *
 * The AI result travels through the app (provider routing, Vocal Rebalance policy gate) before the
 * Director sees it. Recording the validated AI modules here lets the Director compare the AI's
 * own values with what it finally renders, and attach the AI parameter corrections to the pass
 * trace, without changing any of the code paths in between. Bounded; entries are removed when
 * the Director takes them.
 */
import type { ProcessorModule } from '../types/mastering.ts';
import type { AiParamCorrection } from './aiParamCorrections.ts';

interface ProvenanceEntry {
  snapshot: ProcessorModule;
  corrections: AiParamCorrection[];
}

const MAX_ENTRIES = 256;
const registry = new Map<string, ProvenanceEntry>();

export function recordAiChainProvenance(chain: unknown, corrections?: unknown): void {
  if (!Array.isArray(chain)) return;
  const list = Array.isArray(corrections) ? (corrections as AiParamCorrection[]) : [];
  const ids = new Set<string>();
  for (const m of chain) {
    if (!m || typeof m !== 'object' || typeof (m as ProcessorModule).id !== 'string') continue;
    const mod = m as ProcessorModule;
    ids.add(mod.id);
    registry.delete(mod.id);
    registry.set(mod.id, {
      snapshot: structuredClone(mod),
      corrections: list.filter((c) => c.moduleId === mod.id),
    });
  }
  // Corrections not tied to a surviving module (a dropped stage) ride on the first module.
  const orphans = list.filter((c) => !c.moduleId || !ids.has(c.moduleId));
  const firstId = [...ids][0];
  if (orphans.length > 0 && firstId) registry.get(firstId)!.corrections.push(...orphans);
  while (registry.size > MAX_ENTRIES) {
    const oldest = registry.keys().next().value;
    if (oldest === undefined) break;
    registry.delete(oldest);
  }
}

/** Returns (and forgets) the AI snapshots and corrections for the modules of this chain. */
export function takeAiChainProvenance(chain: ProcessorModule[] | null | undefined): {
  snapshots: Map<string, ProcessorModule>;
  corrections: AiParamCorrection[];
} | null {
  if (!chain || chain.length === 0) return null;
  const snapshots = new Map<string, ProcessorModule>();
  const corrections: AiParamCorrection[] = [];
  for (const m of chain) {
    const entry = registry.get(m.id);
    if (!entry) continue;
    snapshots.set(m.id, entry.snapshot);
    corrections.push(...entry.corrections);
    registry.delete(m.id);
  }
  return snapshots.size > 0 ? { snapshots, corrections } : null;
}

export function clearAiChainProvenance(): void {
  registry.clear();
}
