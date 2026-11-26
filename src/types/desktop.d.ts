export {};

declare global {
  interface Window {
    // No privileged desktop bridge is exposed to the renderer.
  }
}
