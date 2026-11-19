import type { ChainCommand, ProcessorModule } from '../types/mastering';
import { createProcessorModule, validateChain } from '../dsp/chainValidation';

function findTargetIndex(
  chain: ProcessorModule[],
  targetId?: string,
  processorType?: ProcessorModule['type'],
): number {
  if (targetId) {
    const byId = chain.findIndex((m) => m.id === targetId);
    if (byId >= 0) return byId;
  }
  if (processorType) {
    return chain.findIndex((m) => m.type === processorType);
  }
  return -1;
}

function deepMergeParams(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof next[k] === 'object' &&
      next[k] !== null &&
      !Array.isArray(next[k])
    ) {
      next[k] = deepMergeParams(
        next[k] as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      next[k] = v;
    }
  }
  return next;
}

export interface AppliedCommandsResult {
  chain: ProcessorModule[];
  appliedCount: number;
  skippedReasons: string[];
}

/**
 * SYN-CHAIN Intelligence: Structured programmatic execution of ChainCommand[]
 * on real mastering rack chains, enforcing parameter bounds via validateChain.
 */
export function applyStructuredChainCommands(
  initialChain: ProcessorModule[],
  commands: ChainCommand[],
): AppliedCommandsResult {
  let working: ProcessorModule[] = structuredClone(initialChain);
  let appliedCount = 0;
  const skippedReasons: string[] = [];

  for (const cmd of commands) {
    switch (cmd.op) {
      case 'add': {
        const newMod = createProcessorModule(cmd.processorType, {
          name: cmd.name,
          wetDry: cmd.wetDry ?? 100,
          intensity: cmd.intensity ?? 100,
          params: cmd.params as ProcessorModule['params'],
        });
        if (
          typeof cmd.position === 'number' &&
          cmd.position >= 0 &&
          cmd.position <= working.length
        ) {
          working.splice(cmd.position, 0, newMod);
        } else {
          // Keep final limiter/maximizer at end unless explicitly inserting after
          const endDynamicsIdx = working.findIndex(
            (m) => m.type === 'limiter' || m.type === 'maximizer',
          );
          if (
            endDynamicsIdx >= 0 &&
            cmd.processorType !== 'limiter' &&
            cmd.processorType !== 'maximizer'
          ) {
            working.splice(endDynamicsIdx, 0, newMod);
          } else {
            working.push(newMod);
          }
        }
        appliedCount++;
        break;
      }

      case 'remove': {
        const idx = findTargetIndex(working, cmd.targetId, cmd.processorType);
        if (idx >= 0) {
          working.splice(idx, 1);
          appliedCount++;
        } else {
          skippedReasons.push(
            `Remove skipped: target ${cmd.targetId ?? cmd.processorType ?? 'unknown'} not found.`,
          );
        }
        break;
      }

      case 'reorder': {
        const rank = new Map<ProcessorModule['type'], number>();
        cmd.order.forEach((t, idx) => rank.set(t, idx));
        working = [...working].sort((a, b) => {
          const ra = rank.get(a.type) ?? 999;
          const rb = rank.get(b.type) ?? 999;
          return ra - rb;
        });
        appliedCount++;
        break;
      }

      case 'configure': {
        const idx = findTargetIndex(working, cmd.targetId, cmd.processorType);
        if (idx >= 0) {
          const mod = working[idx];
          const merged = deepMergeParams(
            mod.params as unknown as Record<string, unknown>,
            cmd.paramsPatch,
          );
          working[idx] = createProcessorModule(mod.type, {
            ...mod,
            params: merged as unknown as ProcessorModule['params'],
          });
          appliedCount++;
        } else {
          skippedReasons.push(
            `Configure skipped: no active ${cmd.processorType} stage in chain.`,
          );
        }
        break;
      }

      case 'gain-stage': {
        const idx = findTargetIndex(working, cmd.targetId, cmd.processorType);
        if (idx >= 0) {
          const mod = working[idx];
          working[idx] = {
            ...mod,
            inputGainDb: cmd.inputGainDb ?? mod.inputGainDb,
            outputGainDb: cmd.outputGainDb ?? mod.outputGainDb,
          };
          appliedCount++;
        } else {
          skippedReasons.push(
            `Gain-stage skipped: no ${cmd.processorType} stage in chain.`,
          );
        }
        break;
      }

      case 'wet-dry': {
        const idx = findTargetIndex(working, cmd.targetId, cmd.processorType);
        if (idx >= 0) {
          const mod = working[idx];
          working[idx] = {
            ...mod,
            wetDry: cmd.wetDry,
            intensity: cmd.intensity ?? mod.intensity,
          };
          appliedCount++;
        } else {
          skippedReasons.push(`Wet/dry skipped: no ${cmd.processorType} stage in chain.`);
        }
        break;
      }

      case 'bypass': {
        const idx = findTargetIndex(working, cmd.targetId, cmd.processorType);
        if (idx >= 0) {
          working[idx] = { ...working[idx], bypassed: cmd.bypassed };
          appliedCount++;
        } else {
          skippedReasons.push(`Bypass skipped: no ${cmd.processorType} stage in chain.`);
        }
        break;
      }
    }
  }

  return {
    chain: validateChain(working),
    appliedCount,
    skippedReasons,
  };
}
