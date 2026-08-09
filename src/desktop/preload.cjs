const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relayDesktop", {
  installMcp: () => ipcRenderer.invoke("relay:install-mcp"),
  quit: () => ipcRenderer.invoke("relay:quit"),
});
