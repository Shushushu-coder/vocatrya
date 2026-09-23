// Phase C preload: expose a narrow, registry-keyed runtime surface. The
// renderer can ask for runtime metadata/detection/status by backendKind —
// it can never supply an executable, args, cwd, env, or a command string,
// and it cannot read profile credential files or the process environment.
//
// Phase D adds vocatryaAi: account-login operations keyed by a
// session-minted ticket plus a connectionId. Still no executable, args,
// env, profile path, or free-form command crosses the bridge.
const { contextBridge, ipcRenderer } = require("electron");

const RUNTIME_CHANNELS = Object.freeze({
  list: "runtime:list",
  detect: "runtime:detect",
  getVersion: "runtime:getVersion",
  getStatus: "runtime:getStatus",
  getInstallInfo: "runtime:getInstallInfo",
  getUpdateInfo: "runtime:getUpdateInfo",
});

const AI_CONNECTION_CHANNELS = Object.freeze({
  startLogin: "aiConnection:startLogin",
  cancelOperation: "aiConnection:cancelOperation",
  reconnect: "aiConnection:reconnect",
  disconnect: "aiConnection:disconnect",
  verify: "aiConnection:verify",
  listModels: "aiConnection:listModels",
  runSmoke: "aiConnection:runSmoke",
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

contextBridge.exposeInMainWorld("vocatryaAi", {
  startLogin: ({ backendKind, ticket }) =>
    ipcRenderer.invoke(AI_CONNECTION_CHANNELS.startLogin, {
      backendKind,
      ticket,
    }),
  cancelOperation: ({ ticket, connectionId }) =>
    ipcRenderer.invoke(AI_CONNECTION_CHANNELS.cancelOperation, {
      ticket,
      connectionId,
    }),
  reconnect: ({ connectionId, ticket }) =>
    ipcRenderer.invoke(AI_CONNECTION_CHANNELS.reconnect, {
      connectionId,
      ticket,
    }),
  disconnect: ({ connectionId, ticket }) =>
    ipcRenderer.invoke(AI_CONNECTION_CHANNELS.disconnect, {
      connectionId,
      ticket,
    }),
  verify: ({ connectionId, ticket }) =>
    ipcRenderer.invoke(AI_CONNECTION_CHANNELS.verify, {
      connectionId,
      ticket,
    }),
  listModels: ({ connectionId, ticket }) =>
    ipcRenderer.invoke(AI_CONNECTION_CHANNELS.listModels, {
      connectionId,
      ticket,
    }),
  runSmoke: ({ connectionId, ticket, model }) =>
    ipcRenderer.invoke(AI_CONNECTION_CHANNELS.runSmoke, {
      connectionId,
      ticket,
      model,
    }),
});
