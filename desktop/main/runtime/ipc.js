// Phase C Electron main IPC boundary for managed runtimes.
//
// The renderer may request ONLY registry-keyed operations — it supplies a
// backendKind and nothing else. There is deliberately no channel that
// accepts an executable path, args, cwd, env, or a command string; install
// and update expose structured metadata while execution stays disabled.
const { isRegisteredBackendKind } = require("./registry");

const RUNTIME_IPC_CHANNELS = Object.freeze({
  list: "runtime:list",
  detect: "runtime:detect",
  getVersion: "runtime:getVersion",
  getStatus: "runtime:getStatus",
  getInstallInfo: "runtime:getInstallInfo",
  getUpdateInfo: "runtime:getUpdateInfo",
  checkUpdate: "runtime:checkUpdate",
});

function readBackendKind(payload) {
  const backendKind =
    payload && typeof payload === "object" ? payload.backendKind : null;
  if (!isRegisteredBackendKind(backendKind)) {
    const error = new Error("Unknown or missing backendKind");
    error.code = "UNKNOWN_BACKEND_KIND";
    throw error;
  }
  return backendKind;
}

// registerRuntimeIpcHandlers(ipcMain, service) — service is the facade from
// service.js. Returns the channel map so preload can mirror the names
// without duplicating strings.
function registerRuntimeIpcHandlers(ipcMain, service) {
  ipcMain.handle(RUNTIME_IPC_CHANNELS.list, () => service.listRuntimes());

  ipcMain.handle(RUNTIME_IPC_CHANNELS.detect, (_event, payload) =>
    service.detectRuntime(readBackendKind(payload)),
  );

  ipcMain.handle(RUNTIME_IPC_CHANNELS.getVersion, (_event, payload) =>
    service.getRuntimeVersion(readBackendKind(payload)),
  );

  ipcMain.handle(RUNTIME_IPC_CHANNELS.getStatus, (_event, payload) =>
    service.getRuntimeStatus(readBackendKind(payload), {
      runtimeProfileRef:
        payload && typeof payload === "object"
          ? payload.runtimeProfileRef
          : undefined,
    }),
  );

  ipcMain.handle(RUNTIME_IPC_CHANNELS.getInstallInfo, (_event, payload) =>
    service.getInstallInfo(readBackendKind(payload)),
  );

  ipcMain.handle(RUNTIME_IPC_CHANNELS.getUpdateInfo, (_event, payload) =>
    service.getUpdateInfo(readBackendKind(payload)),
  );

  // Online update check. The renderer may only say whether to bypass the
  // shared cache (manual recheck) — it cannot pick a source, a URL, or
  // trigger any install/update execution.
  ipcMain.handle(RUNTIME_IPC_CHANNELS.checkUpdate, (_event, payload) =>
    service.checkRuntimeUpdate(readBackendKind(payload), {
      force:
        payload && typeof payload === "object" && payload.force === true,
    }),
  );

  return RUNTIME_IPC_CHANNELS;
}

module.exports = { RUNTIME_IPC_CHANNELS, registerRuntimeIpcHandlers };
