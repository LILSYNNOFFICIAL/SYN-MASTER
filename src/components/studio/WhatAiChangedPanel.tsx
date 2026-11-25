import React, { useMemo, useState } from 'react';
import { RotateCcw, Redo2 } from 'lucide-react';
import type { ProcessorModule } from '../../types/mastering';
import {
  diffChains,
  diffEntryStatus,
  formatDiffValue,
  reapplyDiffEntry,
  revertAllDiffEntries,
  revertDiffEntry,
  type ChainDiffEntry,
  type ChainDiffStatus,
} from '../../director/chainDiff';

export interface WhatAiChangedPanelProps {
  /** Chain from before the FIX ALL run. */
  before: ProcessorModule[];
  /** Final chain the run retained. */
  after: ProcessorModule[];
  /** Live chain (may have been edited / undone since the run). */
  current: ProcessorModule[];
  /** Must route through updateChainWithHistory so global undo/redo keeps working. */
  onApplyChain: (next: ProcessorModule[], label: string) => void;
  disabled?: boolean;
  /** Surface id used to keep heading ids unique when shown in two places. */
  idPrefix: string;
}

const KIND_LABEL: Record<ChainDiffEntry['kind'], string> = { added: 'Added', removed: 'Removed', changed: 'Changed' };
const STATUS_LABEL: Record<ChainDiffStatus, string> = { applied: '', reverted: 'Undone', diverged: 'Edited since' };
const MAX_ROWS = 4;

function EntryRow({ entry, status, onUndo, onRedo, disabled }: {
  entry: ChainDiffEntry; status: ChainDiffStatus; onUndo: () => void; onRedo: () => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rows = open ? entry.changes : entry.changes.slice(0, MAX_ROWS);
  const hidden = entry.changes.length - rows.length;
  const kindLabel = entry.kind === 'changed' && entry.changes.length === 0 && entry.moved ? 'Moved' : KIND_LABEL[entry.kind];
  return (
    <li className={`syn-aichg-item is-${entry.kind} is-${status}`} data-testid="ai-change-entry" data-kind={entry.kind} data-status={status}>
      <div className="syn-aichg-head">
        <span className={`syn-aichg-badge is-${entry.kind}`}>{kindLabel}</span>
        <span className="syn-aichg-name">
          {entry.name}
          {entry.before && entry.after && entry.before.name !== entry.after.name && (
            <small className="syn-aichg-was">was {entry.before.name}</small>
          )}
        </span>
        {entry.moved && <span className="syn-aichg-move">slot {entry.moved.from} → {entry.moved.to}</span>}
        {STATUS_LABEL[status] && <span className="syn-aichg-status">{STATUS_LABEL[status]}</span>}
        {status === 'reverted' ? (
          <button type="button" className="syn-aichg-btn" onClick={onRedo} disabled={disabled}
            aria-label={`Reapply AI change to ${entry.name}`}>
            <Redo2 className="w-3 h-3" aria-hidden="true" /> Reapply
          </button>
        ) : (
          <button type="button" className="syn-aichg-btn" onClick={onUndo} disabled={disabled}
            aria-label={`Undo AI change to ${entry.name}`}>
            <RotateCcw className="w-3 h-3" aria-hidden="true" /> Undo
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <ul className="syn-aichg-params">
          {rows.map((c) => (
            <li key={c.path} className={c.afterText !== undefined ? 'is-band' : undefined}>
              <span className="syn-aichg-plabel">{c.label}</span>
              <span className="syn-aichg-pvals">
                {entry.kind === 'changed' ? (
                  <>
                    <span className="syn-aichg-before">{c.beforeText ?? formatDiffValue(c.before, c.path)}</span>
                    <span aria-hidden="true"> → </span><span className="sr-only">to</span>
                    <span className="syn-aichg-after">{c.afterText ?? formatDiffValue(c.after, c.path)}</span>
                  </>
                ) : (
                  <span className={entry.kind === 'removed' ? 'syn-aichg-before' : 'syn-aichg-after'}>{c.afterText ?? formatDiffValue(c.after, c.path)}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {(hidden > 0 || open) && entry.changes.length > MAX_ROWS && (
        <button type="button" className="syn-aichg-more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Show less' : `+${hidden} more`}
        </button>
      )}
    </li>
  );
}

export const WhatAiChangedPanel: React.FC<WhatAiChangedPanelProps> = ({ before, after, current, onApplyChain, disabled, idPrefix }) => {
  const entries = useMemo(() => diffChains(before, after), [before, after]);
  const statuses = useMemo(() => entries.map((e) => diffEntryStatus(current, e)), [entries, current]);
  const headingId = `${idPrefix}-ai-changes-title`;
  const anyLeft = statuses.some((s) => s !== 'reverted');

  return (
    <section className="syn-aichg" aria-labelledby={headingId} data-testid="ai-changes-panel">
      <div className="syn-aichg-top">
        <h3 id={headingId} className="syn-aichg-title">What AI changed <span className="syn-aichg-count">{entries.length}</span></h3>
        {entries.length > 0 && (
          <button type="button" className="syn-aichg-btn is-all" disabled={disabled || !anyLeft}
            onClick={() => onApplyChain(revertAllDiffEntries(current, entries, before), 'Undid all FIX ALL changes')}>
            <RotateCcw className="w-3 h-3" aria-hidden="true" /> Undo all
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="syn-aichg-empty">FIX ALL kept your chain exactly as it was.</p>
      ) : (
        <ul className="syn-aichg-list">
          {entries.map((e, i) => (
            <EntryRow key={e.key} entry={e} status={statuses[i]} disabled={disabled}
              onUndo={() => {
                const next = revertDiffEntry(current, e, before);
                if (next !== current) onApplyChain(next, `Undid AI change: ${e.name}`);
              }}
              onRedo={() => {
                const next = reapplyDiffEntry(current, e, after);
                if (next !== current) onApplyChain(next, `Reapplied AI change: ${e.name}`);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
};

export default WhatAiChangedPanel;
