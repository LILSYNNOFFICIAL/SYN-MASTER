import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { Portal } from '../../ui/Portal';

interface Props {
  onClose: () => void;
}

const CloudAiHelpDialog: React.FC<Props> = ({ onClose }) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <Portal>
      <div
        className="syn-modal-backdrop fixed inset-0 flex items-center justify-center p-4"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <section
          className="syn-modal w-full max-w-lg max-h-[90vh] overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-labelledby="syn-cloud-ai-first-use-title"
        >
          <header className="flex items-center justify-between gap-4 border-b border-[#29435E] px-5 py-4">
            <div>
              <h2 id="syn-cloud-ai-first-use-title" className="text-base font-black tracking-wide text-[#EAF6FF]">Cloud AI is included</h2>
              <p className="mt-1 text-[11px] text-[#9BB4CC]">No personal API key or account setup required</p>
            </div>
            <button type="button" aria-label="Close Cloud AI help" onClick={onClose} className="rounded-lg border border-[#35516E] p-2 text-[#BBD8F2] hover:bg-[#16304B]">
              <X className="h-4 w-4" />
            </button>
          </header>
          <div className="flex flex-col gap-3 p-5 text-sm leading-relaxed text-[#C8D9E8]">
            <p><strong className="text-white">Built-in Cloud AI is provided by SYN-MASTER.</strong> You do not need a Google AI Studio account, personal Gemini API key, GitHub account, or operator token. The app creates an anonymous guest session automatically.</p>
            <p>Cloud AI helps analyze the track and plan/refine processor settings. SYN-DSP still performs the audio rendering locally. If Cloud AI is unavailable or a fair-use limit is reached, local mastering continues.</p>
            <p>Short-term and daily usage limits protect service availability. The app explains when to retry, and your local mastering work is not blocked.</p>
            <a href="https://github.com/LILSYNNOFFICIAL/SYN-MASTER#cloud-ai" target="_blank" rel="noreferrer" className="font-semibold text-[#3FE0FF] underline underline-offset-4">Cloud AI help and usage limits</a>
            <button type="button" onClick={onClose} className="mt-2 self-end rounded-lg border border-[#3FE0FF]/50 bg-[#0B2940] px-5 py-2 text-xs font-bold tracking-wide text-[#EAF6FF] hover:bg-[#123B5C]">Got it</button>
          </div>
        </section>
      </div>
    </Portal>
  );
};

export default CloudAiHelpDialog;
