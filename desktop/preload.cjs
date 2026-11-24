const { contextBridge, ipcRenderer } = require('electron');

// Expose only the one narrow desktop bridge needed by the browser UI.
// Node integration remains disabled in the renderer.
contextBridge.exposeInMainWorld('synMasterDesktop', {
  getAiAccessToken: () => ipcRenderer.invoke('syn-master:get-ai-access-token'),
});
