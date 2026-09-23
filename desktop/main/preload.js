// Phase C preload: expose a narrow, registry-keyed runtime surface. The
// renderer can ask for runtime metadata/detection/status by backendKind —
// it can never supply an executable, args, cwd, env, or a command string,
// and it cannot read profile credential files or the process environment.
const { contextBridge, ipcRenderer } = require("electron");

const RUNTIME_CHANNELS = Object.freeze({
  list: "runtime:list",
  detect: "runtime:detect",
  getVersion: "runtime:getVersion",
  getStatus: "runtime:getStatus",
  getInstallInfo: "runtime:getInstallInfo",
  getUpdateInfo: "runtime:getUpdateInfo",
});

contextBridge.exposeInMainWorld("vocatryaRuntime", {
  list: () => ipcRenderer.invoke(RUNTIME_CHANNELS.list),
  detect: (backendKind) =>
    ipcRenderer.invoke(RUNTIME_CHANNELS.detect, { backendKind }),
  getVersion: (backendKind) =>
    ipcRenderer.invoke(RUNTIME_CHANNELS.getVersion, { backendKind }),
  getStatus: (backendKind, runtimeProfileRef) =>
    ipcRenderer.invoke(RUNTIME_CHANNELS.getStatus, {
      backendKind,
      runtimeProfileRef,
    }),
  getInstallInfo: (backendKind) =>
    ipcRenderer.invoke(RUNTIME_CHANNELS.getInstallInfo, { backendKind }),
  getUpdateInfo: (backendKind) =>
    ipcRenderer.invoke(RUNTIME_CHANNELS.getUpdateInfo, { backendKind }),
});
