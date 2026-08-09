const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relayDesktop", {
  installMcp: () => ipcRenderer.invoke("relay:install-mcp"),
  getStatus: () => ipcRenderer.invoke("relay:get-status"),
  copyUsagePrompt: () => ipcRenderer.invoke("relay:copy-usage-prompt"),
  quit: () => ipcRenderer.invoke("relay:quit"),
});
