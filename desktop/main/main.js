const { app, BrowserWindow, dialog, ipcMain, shell, safeStorage, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { DESKTOP_APP_ID } = require("./installer-identity");
const { registerWindowThemeIpc } = require("./window-theme");

app.setAppUserModelId(DESKTOP_APP_ID);
const {
  DEFAULT_PORT_ATTEMPTS,
  allocateLoopbackPort,
  buildBackendEnvironment,
  createPocSecret,
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
const { registerResumePrintIpc } = require("./resume-print");
const { createConnectionService } = require("./runtime/connection-service");
const { registerConnectionIpcHandlers } = require("./runtime/connection-ipc");
const { createBackendClient } = require("./runtime/backend-client");
const { startExecutionServer } = require("./runtime/execute-server");
const { createHostedSessionStore, startHostedSessionBroker } = require("./hosted-session");
const { startCredentialBroker } = require("./credential-broker");

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
  let execServer = null;
  let connectionOps = null;
  let execServerUrl = null;
  let hostedSessionBroker = null;
  let credentialBroker = null;
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

  // Fresh per-request working directories for business TEXT_ONLY execution —
  // the runtime sees an empty Vocatrya-owned cwd, never a user directory.
  function execWorkRoot() {
    const tmpBase = foundationLayout
      ? foundationLayout.tmpDir
      : path.join(stateRoot(), "tmp");
    return path.join(tmpBase, "ai-exec");
  }

  // Per-launch bearer for the backend's internal AI-connection endpoints.
  // Generated in main, injected into the backend env, never leaves main.
  const internalToken = createPocSecret();

  // Injected when the credential broker could not bind: the backend must
  // still see "desktop" (URL present) so BYOK OS-protected writes fail
  // closed there instead of silently degrading to the shared application
  // cipher. Port 9 (discard) is unreachable, so every call fails fast.
  const CREDENTIAL_BROKER_DOWN_URL = "http://127.0.0.1:9/";

  function credentialBrokerUrl() {
    return credentialBroker ? credentialBroker.url : CREDENTIAL_BROKER_DOWN_URL;
  }

  function createConnectionOpsService() {
    return createConnectionService({
      profilesRoot: runtimeProfilesRoot(),
      smokeWorkRoot: smokeWorkRoot(),
      execWorkRoot: execWorkRoot(),
      backend: createBackendClient({
        getBaseUrl: () => `http://127.0.0.1:${backendPort}`,
        token: internalToken,
      }),
      diag: (event) => {
        // Structured internal diagnostics only — operation, codes, opaque
        // refs. No stdout/stderr, URLs, env, or credential material.
        console.log("ai-connection op", JSON.stringify(event));
      },
      // Some runtimes (OpenCode) cannot open a browser when spawned
      // non-interactively — the adapter surfaces the vendor's authorize
      // URL and we forward it to the renderer so the user can open it.
      notifyOAuthUrl: ({ url }) => {
        if (mainWindow && !mainWindow.isDestroyed() && typeof url === "string") {
          mainWindow.webContents.send("aiConnection:oauthUrl", url);
        }
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
                desktopExecUrl: execServerUrl || undefined,
                credentialUrl: credentialBrokerUrl(),
                // app.getVersion() only reflects the packaged installer
                // version when packaged; dev/foundation probes must not leak
                // Electron's own version into the backend.
                appVersion: app.isPackaged ? app.getVersion() : undefined,
              });
              if (hostedSessionBroker) env.VOCATRYA_HOSTED_SESSION_URL = hostedSessionBroker.url;
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
          desktopExecUrl: execServerUrl || undefined,
          credentialUrl: credentialBrokerUrl(),
        });
        if (hostedSessionBroker) env.VOCATRYA_HOSTED_SESSION_URL = hostedSessionBroker.url;
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
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, "icon.ico")
      : path.join(__dirname, "..", "assets", "icon.ico");
    mainWindow = new BrowserWindow({
      icon: iconPath,
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
    if (process.platform === "win32") {
      mainWindow.setAppDetails({
        appId: DESKTOP_APP_ID,
        appIconPath: iconPath,
      });
    }
    const origin = `http://127.0.0.1:${backendPort}`;
    configureNavigation(mainWindow, origin);
    const unregisterResumePrint = registerResumePrintIpc({ ipcMain, BrowserWindow, window: mainWindow, origin });
    const unregisterTheme = registerWindowThemeIpc({
      ipcMain, nativeTheme, window: mainWindow, origin,
      assetsRoot: app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "assets"),
    });
    await mainWindow.loadURL(`${origin}/signin`);
    mainWindow.on("closed", () => {
      unregisterTheme();
      unregisterResumePrint();
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
      hostedSessionBroker = await startHostedSessionBroker({ token: internalToken,
        store: createHostedSessionStore({ directory: path.join(stateRoot(), "hosted-sessions"), safeStorage }),
      });
      // Registry-keyed runtime IPC: detection/version/status only. No
      // arbitrary command execution crosses this boundary.
      registerRuntimeIpcHandlers(
        ipcMain,
        createRuntimeStatusService({ profilesRoot: runtimeProfilesRoot() }),
      );
      // Account-login IPC: connection lifecycle operations keyed by
      // backend-minted tickets. backendPort is read lazily at call time, so
      // registering before the backend starts is safe. One shared service
      // instance also backs the internal execution endpoint below.
      connectionOps = createConnectionOpsService();
      registerConnectionIpcHandlers(ipcMain, connectionOps);
      // Business TEXT_ONLY execution channel: loopback HTTP endpoint the
      // backend reaches with the shared internal bearer. Binds before the
      // backend spawns so its URL can be injected into the backend env.
      // A bind failure is degradable — business AI reports
      // RUNTIME_NOT_AVAILABLE instead of aborting app startup.
      try {
        const started = await startExecutionServer({
          token: internalToken,
          service: connectionOps,
        });
        execServer = started.server;
        execServerUrl = `http://127.0.0.1:${started.port}`;
      } catch (error) {
        console.error(
          "AI execution channel failed to bind; business AI execution is unavailable",
          error,
        );
      }
      // BYOK credential broker: the backend's safeStorage seal/unseal
      // oracle for OS-protected API keys. A bind failure is degradable —
      // the backend still receives a credential URL marker and fails
      // closed on OS-store operations rather than dropping to the shared
      // application cipher on a Windows build.
      try {
        credentialBroker = await startCredentialBroker({
          token: internalToken,
          safeStorage,
        });
      } catch (error) {
        console.error(
          "BYOK credential store channel failed to bind; OS-protected key storage is unavailable",
        );
      }
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
    try {
      connectionOps?.dispose?.();
    } catch {
      // Persistent Codex children are best-effort on shutdown.
    }
    try {
      execServer?.close();
      hostedSessionBroker?.server.close();
      credentialBroker?.server.close();
    } catch {
      // Closing the loopback listener must never block shutdown.
    }
    Promise.all([terminateChildTree(ownedMigrationChild), terminateChildTree(backend)]).finally(() => app.quit());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
