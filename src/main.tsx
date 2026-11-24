import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import './skin/skin.css';
import { MobileViewFrame } from './ui/MobileViewFrame';
import { applyStoredViewMode } from './ui/viewMode';

// Layout follows the screen size unless Settings forces Desktop or Mobile view.
const shell = applyStoredViewMode();
createRoot(document.getElementById('root')!).render(shell === 'mobile-frame' ? <MobileViewFrame /> : <App />);

// Installability/offline shell support is production-only. API and model paths are excluded by sw.js.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, { once: true });
}
