import React from 'react';
import { changeViewMode, VIEW_FRAME_PARAM } from './viewMode';

/** Wide-screen "Mobile view": the same page in a phone-width frame so the real mobile layout applies. */
export const MobileViewFrame: React.FC = () => {
  const url = new URL(window.location.href);
  url.searchParams.set(VIEW_FRAME_PARAM, '1');
  return (
    <div className="syn-view-frame-shell">
      <div className="syn-view-frame-bar">
        <span>SYN-MASTER · Mobile view preview</span>
        <button type="button" onClick={() => changeViewMode('auto')}>Back to automatic layout</button>
      </div>
      <iframe title="SYN-MASTER mobile view" src={url.toString()} className="syn-view-frame" allow="autoplay; clipboard-write" />
    </div>
  );
};
