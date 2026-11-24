import React from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders overlays (dialogs, floating windows, drawers, menus) directly under document.body so
 * no ancestor stacking context (backdrop-filter, transform, z-index) can trap them below the
 * header or the bottom tab bar. Layer order comes from the --z-* scale in src/skin/skin.css.
 */
export const Portal: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  typeof document === 'undefined' ? <>{children}</> : createPortal(children, document.body);
