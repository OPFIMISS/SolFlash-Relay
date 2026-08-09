const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relayDesktop", {
  installMcp: () => ipcRenderer.invoke("relay:install-mcp"),
  getStatus: () => ipcRenderer.invoke("relay:get-status"),
  copyUsagePrompt: () => ipcRenderer.invoke("relay:copy-usage-prompt"),
  onFocusTask: (listener) => {
    const wrapped = (_event, taskId) => listener(taskId);
    ipcRenderer.on("relay:focus-task", wrapped);
    return () => ipcRenderer.removeListener("relay:focus-task", wrapped);
  },
  quit: () => ipcRenderer.invoke("relay:quit"),
});
