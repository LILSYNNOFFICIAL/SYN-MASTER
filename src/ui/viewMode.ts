/**
 * Layout view mode: one codebase that picks the desktop or touch/mobile layout by
 * screen size (CSS breakpoints) unless the user forces one in Settings.
 *
 *  - auto:    CSS media queries decide (desktop ≥1024 px, touch layout below).
 *  - desktop: on a narrow device the layout viewport is widened to 1280 CSS px
 *             (same mechanism as the browser's "Desktop site"), so the desktop
 *             layout renders and the user can pinch-zoom.
 *  - mobile:  on a wide screen the app renders inside a phone-width frame (an iframe of
 *             this same page flagged with ?syn-view-frame=1), so the real mobile media
 *             queries apply. Same origin: storage, OPFS and the server API are shared.
 *
 * Pure presentation: nothing here touches audio, DSP or AI state.
 */
export type ViewMode = 'auto' | 'desktop' | 'mobile';

export const VIEW_MODE_STORAGE_KEY = 'syn-master:view-mode';
export const VIEW_FRAME_PARAM = 'syn-view-frame';
const DESKTOP_VIEWPORT = 'width=1280, viewport-fit=cover';

export function parseViewMode(value: unknown): ViewMode {
  return value === 'desktop' || value === 'mobile' ? value : 'auto';
}

export function readViewMode(storage: Pick<Storage, 'getItem'> | null | undefined = safeLocalStorage()): ViewMode {
  try {
    return parseViewMode(storage?.getItem(VIEW_MODE_STORAGE_KEY));
  } catch {
    return 'auto';
  }
}

export function writeViewMode(mode: ViewMode, storage: Pick<Storage, 'setItem' | 'removeItem'> | null | undefined = safeLocalStorage()): void {
  try {
    if (mode === 'auto') storage?.removeItem(VIEW_MODE_STORAGE_KEY);
    else storage?.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Private mode / storage disabled: the choice simply is not persisted.
  }
}

/** What the entry point should render for a mode on a screen of the given width. */
export function resolveViewShell(mode: ViewMode, opts: { screenWidth: number; inFrame: boolean }): 'app' | 'mobile-frame' {
  if (opts.inFrame) return 'app';
  return mode === 'mobile' && opts.screenWidth >= 768 ? 'mobile-frame' : 'app';
}

/** Whether the layout viewport must be widened so a narrow device renders the desktop layout. */
export function needsDesktopViewport(mode: ViewMode, screenWidth: number): boolean {
  return mode === 'desktop' && screenWidth < 1280;
}

export function isViewFrame(search: string = typeof location !== 'undefined' ? location.search : ''): boolean {
  return new URLSearchParams(search).get(VIEW_FRAME_PARAM) === '1';
}

/** Applies the stored mode before React renders; returns which shell to mount. */
export function applyStoredViewMode(): 'app' | 'mobile-frame' {
  if (typeof window === 'undefined') return 'app';
  const mode = readViewMode();
  const screenWidth = Math.min(window.screen?.width || window.innerWidth, window.innerWidth || Infinity);
  if (needsDesktopViewport(mode, window.screen?.width || window.innerWidth)) {
    document.querySelector('meta[name="viewport"]')?.setAttribute('content', DESKTOP_VIEWPORT);
  }
  if (isViewFrame()) document.documentElement.dataset.synViewFrame = 'true';
  return resolveViewShell(mode, { screenWidth: Math.max(screenWidth, window.innerWidth), inFrame: isViewFrame() });
}

/** Persist a new mode and reload the top-level page so the shell is re-chosen. */
export function changeViewMode(mode: ViewMode): void {
  writeViewMode(mode);
  try {
    (window.top ?? window).location.reload();
  } catch {
    window.location.reload();
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
