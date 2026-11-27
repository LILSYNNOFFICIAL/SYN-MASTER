import React, { useEffect, useState } from 'react';
import { Bot, Loader2 } from 'lucide-react';
import { BUILTIN_PROVIDER_ID, getPreset } from '../ai/providerPresets';
import { useActiveAiCall, useProviderSettings } from '../ai/providerStore';

/** Top-bar status chip: active provider, plus "agent is working" timer and Cancel during a call. */
export const AiProviderChip: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
  const settings = useProviderSettings();
  const call = useActiveAiCall();
  const preset = getPreset(settings.presetId);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!call) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [call]);

  const short = preset.id === BUILTIN_PROVIDER_ID ? 'Gemini (built-in)' : preset.label.replace(/ \(.*\)$/, '');
  if (call) {
    const secs = Math.max(0, Math.round((now - call.startedAt) / 1000));
    return (
      <span className="px-2 py-1 rounded border border-[#D4AF37]/60 bg-[#D4AF37]/10 text-[11px] font-semibold text-[#F2CA52] flex items-center gap-1.5 whitespace-nowrap" role="status">
        <Loader2 className="w-3 h-3 animate-spin" />
        {call.agentic ? 'Agent is working' : 'AI thinking'} · {short} · {secs}s
        <button type="button" onClick={call.cancel} className="ml-1 px-1.5 rounded bg-[#181A22] border border-[#2B2E3A] text-[#C5CDD8] hover:border-[#F87171] hover:text-[#F87171]">
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title="AI provider for mastering decisions (click to change)"
      className="px-2 py-1 rounded border border-[#2B2E3A] bg-[#181A22] text-[11px] font-semibold text-[#C5CDD8] hover:border-[#D4AF37] flex items-center gap-1 whitespace-nowrap"
    >
      <Bot className="w-3 h-3 text-[#D4AF37]" />
      AI: {short}
    </button>
  );
};
