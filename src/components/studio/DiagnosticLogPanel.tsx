import React, { useState } from 'react';
import { Download, FileJson, FileText, CheckCircle2, XCircle, AlertTriangle, CircleDot } from 'lucide-react';
import { diagnosticLogToText, type DiagnosticLog } from '../../director/diagnosticLog';

function download(name: string, mime: string, body: string) {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const statusIcon = (s: string) =>
  s === 'fixed' || s === 'pass' ? (
    <CheckCircle2 className="w-3.5 h-3.5 text-[#7BE0A0]" />
  ) : s === 'not-fixed' || s === 'fail' ? (
    <XCircle className="w-3.5 h-3.5 text-[#FF7A6B]" />
  ) : s === 'advisory' ? (
    <AlertTriangle className="w-3.5 h-3.5 text-[#E8C85A]" />
  ) : (
    <CircleDot className="w-3.5 h-3.5 text-[#C9B27A]" />
  );

/** Technical details: objective gate, measurements, passes and every issue with exact tool settings. */
export const DiagnosticLogPanel: React.FC<{ log: DiagnosticLog }> = ({ log }) => {
  const [tab, setTab] = useState<'issues' | 'metrics' | 'passes' | 'chain' | 'raw'>('issues');
  const base = log.trackName.replace(/\.[^/.]+$/, '').replace(/[^\w-]+/g, '_') || 'track';
  const passed = log.gate?.passed;

  return (
    <section className="syn2-panel" aria-label="Mastering diagnostic log">
      <div className="syn2-panel-head">
        <div>
          <div className="syn2-eyebrow">Diagnostic log · {log.phase === 'post-fix' ? 'after Fix' : 'before Fix'}</div>
          <div className={`syn2-verdict ${passed === true ? 'is-pass' : passed === false ? 'is-fail' : ''}`}>{log.verdict}</div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button type="button" className="syn2-btn-ghost" onClick={() => download(`${base}_syn_diagnostic.json`, 'application/json', JSON.stringify(log, null, 2))}>
            <FileJson className="w-3.5 h-3.5" /> JSON
          </button>
          <button type="button" className="syn2-btn-ghost" onClick={() => download(`${base}_syn_diagnostic.txt`, 'text/plain', diagnosticLogToText(log))}>
            <FileText className="w-3.5 h-3.5" /> Text
          </button>
        </div>
      </div>

      {log.gate && (
        <div className="syn2-gate" aria-label="Objective target checks">
          {log.gate.checks.map((c) => (
            <div key={c.id} className={`syn2-chip is-${c.status}`} title={c.fix ?? ''}>
              {statusIcon(c.status)}
              <span className="syn2-chip-label">{c.label}</span>
              <span className="syn2-chip-val">{c.measured}</span>
              <span className="syn2-chip-target">{c.target}</span>
            </div>
          ))}
        </div>
      )}

      <div className="syn2-tabs" role="tablist">
        {(['issues', 'metrics', 'passes', 'chain', 'raw'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)}>
            {t === 'issues' ? `Issues (${log.entries.length})` : t === 'metrics' ? 'Measurements' : t === 'passes' ? `Passes (${log.passes.length})` : t === 'chain' ? 'Tool settings' : 'Raw log'}
          </button>
        ))}
      </div>

      {tab === 'issues' && (
        <ul className="syn2-issues">
          {log.entries.length === 0 && <li className="text-xs text-[#B6A780]">No measured problems.</li>}
          {log.entries.map((e) => (
            <li key={e.id} className={`syn2-issue sev-${e.severity} is-${e.status}`}>
              <div className="syn2-issue-top">
                {statusIcon(e.status)}
                <span className="syn2-issue-title">{e.issue}</span>
                <span className="syn2-issue-cat">{e.category}</span>
                <span className={`syn2-issue-status is-${e.status}`}>{e.status.replace('-', ' ')}</span>
              </div>
              <div className="syn2-issue-row"><b>Measured</b> {e.measured}</div>
              <div className="syn2-issue-row"><b>Target</b> {e.target}</div>
              {e.tools.length > 0 && <div className="syn2-issue-row"><b>Tools</b> {e.tools.join(' · ')}</div>}
              {e.settings.map((s, i) => (
                <div key={i} className="syn2-issue-setting">{s}</div>
              ))}
            </li>
          ))}
        </ul>
      )}

      {tab === 'metrics' && (
        <table className="syn2-table">
          <thead>
            <tr><th>Metric</th><th>Source</th><th>Master</th></tr>
          </thead>
          <tbody>
            {Object.entries(log.source).map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{typeof v === 'number' ? Number(v.toFixed(3)) : v}</td>
                <td>{log.master ? (typeof log.master[k] === 'number' ? Number((log.master[k] as number).toFixed(3)) : log.master[k]) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === 'passes' && (
        <table className="syn2-table">
          <thead>
            <tr><th>Pass</th><th>LUFS</th><th>dBTP</th><th>Clicks</th><th>Gate</th><th>Outcome</th></tr>
          </thead>
          <tbody>
            {log.passes.length === 0 && (
              <tr><td colSpan={6}>No passes yet.</td></tr>
            )}
            {log.passes.map((p) => (
              <tr key={p.pass}>
                <td>#{p.pass}</td>
                <td>{p.lufs.toFixed(1)}</td>
                <td>{p.truePeakDb.toFixed(2)}</td>
                <td>{p.clicks}</td>
                <td>{p.gatePassed === null ? '—' : p.gatePassed ? 'PASS' : 'FAIL'}</td>
                <td>{p.outcome}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === 'chain' && (
        <ol className="syn2-chainlist">
          {log.chain.map((m, i) => (
            <li key={i}>
              <span className="syn2-chainlist-name">{i + 1}. {m.name}{m.bypassed ? ' (bypassed)' : ''}</span>
              <span className="syn2-chainlist-set">{m.settings}</span>
            </li>
          ))}
        </ol>
      )}

      {tab === 'raw' && <pre className="syn2-raw">{diagnosticLogToText(log)}</pre>}

      <div className="syn2-panel-foot">
        <Download className="w-3 h-3" /> The log is generated from measured values only. Re-download after each Fix run.
      </div>
    </section>
  );
};
