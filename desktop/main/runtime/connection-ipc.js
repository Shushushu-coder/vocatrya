// Phase D Electron main IPC boundary for AIConnection account-login
// operations. The renderer passes ONLY identifiers — a backendKind, a
// connectionId, an operation ticket, an optional model id — and a
// session-minted ticket carries the ownership proof. Executable paths,
// args, env, profile dirs, and command strings can never cross this
// boundary.
const AI_CONNECTION_IPC_CHANNELS = Object.freeze({
  startLogin: "aiConnection:startLogin",
  cancelOperation: "aiConnection:cancelOperation",
  reconnect: "aiConnection:reconnect",
  disconnect: "aiConnection:disconnect",
  verify: "aiConnection:verify",
  listModels: "aiConnection:listModels",
  runSmoke: "aiConnection:runSmoke",
});

// Main → renderer events (webContents.send — not invokable channels).
// oauthUrl carries the vendor's authorize URL for runtimes that cannot
// open a browser themselves; it is the login entry point, not a secret.
const AI_CONNECTION_EVENTS = Object.freeze({
  oauthUrl: "aiConnection:oauthUrl",
});

function readString(payload, key) {
  const value = payload && typeof payload === "object" ? payload[key] : null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readConnectionId(payload) {
  return readString(payload, "connectionId") ?? "";
}

// registerConnectionIpcHandlers(ipcMain, service) — service is the facade
// from connection-service.js. Returns the channel map so preload can mirror
// the names without duplicating strings.
function registerConnectionIpcHandlers(ipcMain, service) {
  ipcMain.handle(AI_CONNECTION_IPC_CHANNELS.startLogin, (_event, payload) =>
    service.startLogin({
      backendKind: readString(payload, "backendKind") ?? "",
      ticket: readString(payload, "ticket"),
    }),
  );

  ipcMain.handle(
    AI_CONNECTION_IPC_CHANNELS.cancelOperation,
    (_event, payload) =>
      service.cancelOperation({
        ticket: readString(payload, "ticket") ?? undefined,
        connectionId: readString(payload, "connectionId") ?? undefined,
      }),
  );

  ipcMain.handle(AI_CONNECTION_IPC_CHANNELS.reconnect, (_event, payload) =>
    service.reconnect({
      connectionId: readConnectionId(payload),
      ticket: readString(payload, "ticket"),
    }),
  );

  ipcMain.handle(AI_CONNECTION_IPC_CHANNELS.disconnect, (_event, payload) =>
    service.disconnect({
      connectionId: readConnectionId(payload),
      ticket: readString(payload, "ticket"),
    }),
  );

  ipcMain.handle(AI_CONNECTION_IPC_CHANNELS.verify, (_event, payload) =>
    service.verify({
      connectionId: readConnectionId(payload),
      ticket: readString(payload, "ticket"),
    }),
  );

  ipcMain.handle(AI_CONNECTION_IPC_CHANNELS.listModels, (_event, payload) =>
    service.listModels({
      connectionId: readConnectionId(payload),
      ticket: readString(payload, "ticket"),
    }),
  );

  ipcMain.handle(AI_CONNECTION_IPC_CHANNELS.runSmoke, (_event, payload) =>
    service.runSmoke({
      connectionId: readConnectionId(payload),
      ticket: readString(payload, "ticket"),
      model: readString(payload, "model") ?? undefined,
    }),
  );

  return AI_CONNECTION_IPC_CHANNELS;
}

module.exports = {
  AI_CONNECTION_EVENTS,
  AI_CONNECTION_IPC_CHANNELS,
  registerConnectionIpcHandlers,
};
