export {};

declare global {
  interface Window {
    synMasterDesktop?: {
      getAiAccessToken: () => Promise<string | null>;
    };
  }
}
