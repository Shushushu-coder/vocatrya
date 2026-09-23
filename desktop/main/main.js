const { app, BrowserWindow, dialog, ipcMain, shell, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { DESKTOP_APP_ID } = require("./installer-identity");

app.setAppUserModelId(DESKTOP_APP_ID);
const {
  DEFAULT_PORT_ATTEMPTS,
  allocateLoopbackPort,
  buildBackendEnvironment,
  isAllowedNavigation,
  isExternalHttpUrl,
  resolveNodeExecutable,
  spawnBackend,
  startBackendWithRetry,
  terminateChildTree,
  waitForReadiness,
} = require("./runtime");
const { resolveAndEnsureDesktopLayout, buildDesktopFilesystemConfig } = require("./local-data");
const { loadOrCreateDesktopSecrets } = require("./secrets");
const { prepareDatabase } = require("./database-migration");
const { runStartupSequence } = require("./startup");
const { createRuntimeStatusService } = require("./runtime/service");
const { registerRuntimeIpcHandlers } = require("./runtime/ipc");
const { createConnectionService } = require("./runtime/connection-service");
const { registerConnectionIpcHandlers } = require("./runtime/connection-ipc");
const { createBackendClient } = require("./runtime/backend-client");

// Windows desktop local-data foundation. This resolves BEFORE the
// single-instance lock and before app ready so the Chromium singleton lock,
// session state, and os_crypt all live inside the stable local-first root
// instead of roaming %APPDATA%\Electron (whose stale locks/keys fail closed).
// Packaged runtime always uses %LOCALAPPDATA%\Vocatrya. Development/POC uses
// the foundation only when the internal VOCATRYA_DESKTOP_DATA_ROOT override is
// set; otherwise the legacy disposable .codex-tmp/desktop-poc layout is kept
// so the real user profile is never touched during ordinary development.
function shouldUseDesktopFoundation() {
  if (app.isPackaged) return true;
  return Boolean((process.env.VOCATRYA_DESKTOP_DATA_ROOT || "").trim());
}

let foundationLayout = null;
let foundationConfig = null;
let foundationInitError = null;
if (shouldUseDesktopFoundation()) {
  try {
    foundationLayout = resolveAndEnsureDesktopLayout();
    foundationConfig = buildDesktopFilesystemConfig(foundationLayout);
    // Pin Chromium/Electron session state inside the local-first boundary
    // before app ready. Database files, uploads, and secret ciphertext
    // never live under this session directory.
    app.setPath("userData", foundationLayout.electronDir);
    try {
      app.setPath("sessionData", foundationLayout.electronDir);
    } catch {
      // Older Electron builds honor userData pinning only; session state
      // then stays within the pinned profile by default.
    }
  } catch (error) {
    foundationInitError = error;
  }
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  let mainWindow;
  let backend;
  let backendPort;
  let migrationChild = null;
  let shuttingDown = false;
  let backendExpectedExit = false;
  let logDirectory;

  function runtimeRoot() {
    return app.isPackaged
      ? path.join(process.resourcesPath, "backend")
      : path.resolve(__dirname, "..", "..", ".codex-tmp", "desktop-poc", "backend");
  }

  function stateRoot() {
    return app.isPackaged
      ? path.join(app.getPath("userData"), "desktop-poc")
      : path.resolve(__dirname, "..", "..", ".codex-tmp", "desktop-poc");
  }

  function dataRoot() {
    return path.join(stateRoot(), "data");
  }

  // Managed runtime profiles live inside the app-owned local-first root —
  // never under the repo, Downloads, or the user's native ~/.codex etc.
  function runtimeProfilesRoot() {
    return foundationLayout
      ? foundationLayout.runtimeProfilesDir
      : path.join(stateRoot(), "runtime-profiles");
  }

  // Vocatrya-owned scratch space for inference smoke runs — an exec working
  // directory that is never the repo root or a user folder.
  function smokeWorkRoot() {
    const tmpBase = foundationLayout
      ? foundationLayout.tmpDir
      : path.join(stateRoot(), "tmp");
    return path.join(tmpBase, "codex-smoke");
  }

  // Per-launch bearer for the backend's internal AI-connection endpoints.
  // Generated in main, injected into the backend env, never leaves main.
  const internalToken = createPocSecret();

  function createConnectionOpsService() {
    return createConnectionService({
      profilesRoot: runtimeProfilesRoot(),
      smokeWorkRoot: smokeWorkRoot(),
      backend: createBackendClient({
        getBaseUrl: () => `http://127.0.0.1:${backendPort}`,
        token: internalToken,
      }),
      diag: (event) => {
        // Structured internal diagnostics only — operation, codes, opaque
        // refs. No stdout/stderr, URLs, env, or credential material.
        console.log("ai-connection op", JSON.stringify(event));
      },
    });
  }

  function showStartupFailure(error) {
    const message = `Vocatrya desktop backend failed to start.\n\n${error.message}\n\nLogs: ${logDirectory}`;
    console.error(message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<h1>Vocatrya startup failed</h1><p>${message.replaceAll("\n", "<br>")}</p>`)}`);
    } else {
      dialog.showErrorBox("Vocatrya startup failed", message);
    }
  }

  function showBackendCrash(code, signal) {
    if (shuttingDown) return;
    const detail = `Backend exited unexpectedly (code ${code ?? "unknown"}, signal ${signal ?? "none"}).`;
    console.error(`${detail} Logs: ${logDirectory}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<h1>Vocatrya backend stopped</h1><p>${detail}</p><p>Logs: ${logDirectory}</p>`)}`);
    } else {
      dialog.showErrorBox("Vocatrya backend stopped", `${detail}\n\nLogs: ${logDirectory}`);
    }
  }

  function configureNavigation(window, origin) {
    const contents = window.webContents;
    contents.on("will-navigate", (event, url) => {
      if (isAllowedNavigation(url, origin)) return;
      event.preventDefault();
      if (isExternalHttpUrl(url)) void shell.openExternal(url);
    });
    contents.on("will-redirect", (event, url) => {
      if (isAllowedNavigation(url, origin)) return;
      event.preventDefault();
      if (isExternalHttpUrl(url)) void shell.openExternal(url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isExternalHttpUrl(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
  }

  async function startBackend() {
    if (foundationInitError) {
      throw foundationInitError;
    }
    const backendRoot = runtimeRoot();
    const serverPath = path.join(backendRoot, "server.js");
    if (!fs.existsSync(serverPath)) {
      throw new Error(`Standalone backend not found: ${serverPath}. Run npm run desktop:assemble first.`);
    }
    const nodeExecutable = resolveNodeExecutable({
      isPackaged: app.isPackaged,
      appPath: app.isPackaged ? process.resourcesPath : process.cwd(),
      env: process.env,
    });
    if (foundationConfig) {
      fs.mkdirSync(foundationConfig.logDirectory, { recursive: true });
      logDirectory = foundationConfig.logDirectory;
      // Secrets resolve only after app ready with DPAPI-backed safeStorage.
      // Fail-closed: corruption or unavailable encryption aborts startup
      // without regenerating, deleting, or logging secret values.
      const secrets = loadOrCreateDesktopSecrets({
        secretStorePath: foundationConfig.secretStorePath,
        safeStorage,
      });
      // Formal startup chain: database preparation runs exactly ONCE per
      // launch and must succeed before any backend spawn is attempted.
      // Backend port/readiness retries stay inside startBackend and never
      // re-run migration or backup. Any backup/migration/integrity failure
      // is fail-closed: no backend start, no window.
      await runStartupSequence({
        prepareDatabase: () =>
          prepareDatabase({
            backendRoot,
            databasePath: foundationConfig.databasePath,
            databaseUrl: foundationConfig.databaseUrl,
            tmpDir: foundationLayout.tmpDir,
            backupsDir: foundationLayout.backupsDir,
            logDirectory: foundationConfig.logDirectory,
            appVersion: app.getVersion(),
            nodeExecutable,
            baseEnv: process.env,
            onMigrationChild: (child) => {
              migrationChild = child;
            },
          }),
        startBackend: async () => {
          const started = await startBackendWithRetry({
            attempts: DEFAULT_PORT_ATTEMPTS,
            allocatePort: allocateLoopbackPort,
            spawnChild: async (port) => {
              const env = buildBackendEnvironment({
                port,
                dataDir: foundationLayout.dataDir,
                baseEnv: process.env,
                secret: secrets.authSecret,
                encryptionKey: secrets.encryptionKey,
                uploadsDir: foundationConfig.uploadsDir,
                databaseUrl: foundationConfig.databaseUrl,
                internalToken,
                // app.getVersion() only reflects the packaged installer
                // version when packaged; dev/foundation probes must not leak
                // Electron's own version into the backend.
                appVersion: app.isPackaged ? app.getVersion() : undefined,
              });
              backendExpectedExit = true;
              const child = spawnBackend({
                nodeExecutable,
                serverPath,
                cwd: backendRoot,
                env,
                logDirectory,
              });
              backend = child;
              backendPort = port;
              child.once("exit", (code, signal) => {
                if (!backendExpectedExit && !shuttingDown) showBackendCrash(code, signal);
              });
              return child;
            },
            waitReady: (port, child) => waitForReadiness(`http://127.0.0.1:${port}/signin`, { child }),
            terminate: terminateChildTree,
          });
          backendExpectedExit = false;
          console.log(`Desktop backend ready at http://127.0.0.1:${started.port} using ${nodeExecutable}`);
          return started;
        },
        createWindow: async () => {
          await createMainWindow();
        },
        onFailure: async () => {
          migrationChild = null;
        },
      });
      migrationChild = null;
      return true;
    }
    fs.mkdirSync(dataRoot(), { recursive: true });
    logDirectory = path.join(stateRoot(), "logs");
    const started = await startBackendWithRetry({
      attempts: DEFAULT_PORT_ATTEMPTS,
      allocatePort: allocateLoopbackPort,
      spawnChild: async (port) => {
        const env = buildBackendEnvironment({
          port,
          dataDir: dataRoot(),
          baseEnv: process.env,
          internalToken,
        });
        backendExpectedExit = true;
        const child = spawnBackend({
          nodeExecutable,
          serverPath,
          cwd: backendRoot,
          env,
          logDirectory,
        });
        backend = child;
        backendPort = port;
        child.once("exit", (code, signal) => {
          if (!backendExpectedExit && !shuttingDown) showBackendCrash(code, signal);
        });
        return child;
      },
      waitReady: (port, child) => waitForReadiness(`http://127.0.0.1:${port}/signin`, { child }),
      terminate: terminateChildTree,
    });
    backendExpectedExit = false;
    console.log(`Desktop backend ready at http://127.0.0.1:${started.port} using ${nodeExecutable}`);
    return false;
  }

  async function createMainWindow() {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 640,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, "preload.js"),
      },
    });
    const origin = `http://127.0.0.1:${backendPort}`;
    configureNavigation(mainWindow, origin);
    await mainWindow.loadURL(`${origin}/signin`);
    mainWindow.on("closed", () => {
      mainWindow = undefined;
    });
  }

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  function readBuildInfo() {
    try {
      const infoPath = path.join(process.resourcesPath, "build-info.json");
      return JSON.parse(fs.readFileSync(infoPath, "utf8"));
    } catch {
      return null;
    }
  }

  app.whenReady().then(async () => {
    try {
      // Registry-keyed runtime IPC: detection/version/status only. No
      // arbitrary command execution crosses this boundary.
      registerRuntimeIpcHandlers(
        ipcMain,
        createRuntimeStatusService({ profilesRoot: runtimeProfilesRoot() }),
      );
      // Account-login IPC: connection lifecycle operations keyed by
      // backend-minted tickets. backendPort is read lazily at call time, so
      // registering before the backend starts is safe.
      registerConnectionIpcHandlers(ipcMain, createConnectionOpsService());
      const buildInfo = readBuildInfo();
      if (buildInfo) {
        console.log(
          `Vocatrya ${buildInfo.appVersion} commit ${buildInfo.buildCommit} (${DESKTOP_APP_ID})`,
        );
      }
      const windowOpened = await startBackend();
      if (!windowOpened) {
        await createMainWindow();
      }
    } catch (error) {
      if (!shuttingDown) {
        showStartupFailure(error);
      }
      await terminateChildTree(backend);
      setTimeout(() => app.quit(), 100);
    }
  });

  app.on("before-quit", (event) => {
    const ownedMigrationChild = migrationChild && migrationChild.exitCode === null ? migrationChild : null;
    if ((!backend && !ownedMigrationChild) || shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    backendExpectedExit = true;
    // Only owned startup children are terminated here; unrelated
    // Node/Prisma processes are never touched.
    Promise.all([terminateChildTree(ownedMigrationChild), terminateChildTree(backend)]).finally(() => app.quit());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
