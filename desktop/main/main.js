const { app, BrowserWindow, dialog, ipcMain, shell, safeStorage, nativeTheme, nativeImage, Menu, Tray, session, globalShortcut } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { DESKTOP_APP_ID, PRODUCT_NAME } = require("./installer-identity");

const appUserModelId = app.isPackaged ? DESKTOP_APP_ID : `${DESKTOP_APP_ID}.development`;
app.setAppUserModelId(appUserModelId);
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
const { runStartupSequence, startupPageUrl } = require("./startup");
const { createRuntimeStatusService } = require("./runtime/service");
const { registerRuntimeIpcHandlers } = require("./runtime/ipc");
const { createMainWindowIpcRegistry } = require("./window-ipc");
const { createConnectionService } = require("./runtime/connection-service");
const { registerConnectionIpcHandlers } = require("./runtime/connection-ipc");
const { createBackendClient } = require("./runtime/backend-client");
const { startExecutionServer } = require("./runtime/execute-server");
const { createHostedSessionStore, resolveHostedSessionDirectory, startHostedSessionBroker } = require("./hosted-session");
const { startCredentialBroker } = require("./credential-broker");
const { createDictationTransport } = require("./dictation-transport");
const { createDesktopSettingsStore, DESKTOP_SETTINGS_FILE_NAME } = require("./desktop-settings");
const { createKeybindingsStore, KEYBINDINGS_FILE_NAME } = require("./keybindings");
const { createGlobalToggleHotkey } = require("./global-shortcuts");
const { registerShortcutsIpc } = require("./shortcuts-ipc");
const { createZoomController, registerZoomIpc, ZOOM_FILE_NAME } = require("./zoom");
const { registerInputPreferencesIpc } = require("./input-preferences");
const { registerResumePreviewPreferencesIpc } = require("./resume-preview-preferences");
const { registerAgentRoleSlotsIpc, AGENT_ROLE_SLOTS_FILE_NAME } = require("./agent-role-slots");
const { createDesktopLifecycle, shouldQuitWhenAllWindowsClosed } = require("./lifecycle");
const { resolveColdStartEntry } = require("./cold-start");
const { createQuitCoordinator, flushDefaultSession, runRegisteredReleaseHooks } = require("./shutdown");

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
  let backendReady = false;
  let splashPainted = false;
  let splashLoad;
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
    dialog.showErrorBox("Vocatrya startup failed", message);
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
      // is fail-closed: no backend start or application page.
      await runStartupSequence({
        prepareDatabase: () =>
          prepareDatabase({
            backendRoot,
            databasePath: foundationConfig.databasePath,
            databaseUrl: foundationConfig.databaseUrl,
            tmpDir: foundationLayout.tmpDir,
            backupsDir: foundationLayout.backupsDir,
            logDirectory: foundationConfig.logDirectory,
            // Mirrors the backend spawn gate below: dev/foundation probes
            // must not label migration logs or pre-migration backups with
            // Electron's own version.
            appVersion: app.isPackaged ? app.getVersion() : undefined,
            nodeExecutable,
            baseEnv: process.env,
            onMigrationChild: (child) => {
              migrationChild = child;
            },
          }),
        startBackend: async () => {
          if (desktopLifecycle.isQuitting()) throw new Error("Desktop is shutting down");
          const started = await startBackendWithRetry({
            attempts: DEFAULT_PORT_ATTEMPTS,
            allocatePort: allocateLoopbackPort,
            spawnChild: async (port) => {
              const buildInfo = app.isPackaged ? readBuildInfo() : null;
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
                buildCommit: buildInfo?.buildCommit,
                builtAt: buildInfo?.builtAt,
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
          await openMainWindow();
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

  function desktopIconPath() {
    return app.isPackaged
      ? path.join(process.resourcesPath, "icon.ico")
      : path.join(__dirname, "..", "assets", "icon.ico");
  }

  // Device-level lifecycle: settings live in the app-owned config directory
  // (foundation root when active, the disposable dev state root otherwise).
  // The lifecycle owns the tray, close-to-tray interception, the explicit
  // quit latch, launch-minimized, and login-item state — all read from real
  // state at decision time.
  const desktopSettingsStore = createDesktopSettingsStore({
    filePath: path.join(
      foundationLayout ? foundationLayout.configDir : path.join(stateRoot(), "config"),
      DESKTOP_SETTINGS_FILE_NAME,
    ),
  });
  // Device-level keybindings sit beside desktop-settings.json in the same
  // app-owned config directory — window-scope rebinds plus the global
  // show/hide hotkey intent.
  const configDir = foundationLayout
    ? foundationLayout.configDir
    : path.join(stateRoot(), "config");
  const keybindingsStore = createKeybindingsStore({
    filePath: path.join(configDir, KEYBINDINGS_FILE_NAME),
  });
  const zoomController = createZoomController({
    filePath: path.join(configDir, ZOOM_FILE_NAME),
    getWindow: () => mainWindow,
    nativeTheme,
    logger: console,
  });
  const desktopLifecycle = createDesktopLifecycle({
    app,
    Tray,
    Menu,
    nativeImage,
    trayIconPath: desktopIconPath(),
    settingsStore: desktopSettingsStore,
    getWindow: () => backendReady || splashPainted ? mainWindow : null,
    createWindow: async () => {
      if (backendReady) await openMainWindow();
    },
  });

  // Global show/hide hotkey: registered against the live window state so
  // it keeps working while the window sits hidden in the tray. Disabled
  // by default — nothing registers until the user opts in.
  const globalToggleHotkey = createGlobalToggleHotkey({
    globalShortcut,
    store: keybindingsStore,
    getWindow: () => mainWindow,
    showMainWindow: () => desktopLifecycle.showMainWindow(),
  });

  // Per-window IPC ownership: window:setTheme and resume:printToPDF are
  // process-wide channels bound to the current main window — the registry
  // arms their release on "closed" before the first load settles.
  const mainWindowIpc = createMainWindowIpcRegistry();

  function createMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

    const iconPath = desktopIconPath();
    const startMinimized = desktopLifecycle.shouldStartMinimized();
    const createdWindow = new BrowserWindow({
      icon: iconPath,
      title: PRODUCT_NAME,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#09090b" : "#ffffff",
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 640,
      autoHideMenuBar: true,
      show: false,
      // Windows controls-overlay titlebar: the renderer draws the bar itself
      // (preload marks documents data-desktop, DesktopTitleBar fills the
      // strip), while the OS keeps the native caption buttons so Snap
      // layouts, hover states, and system hit-testing keep working.
      ...(process.platform === "win32"
        ? {
            titleBarStyle: "hidden",
            titleBarOverlay: zoomController.overlayOptions(),
          }
        : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, "preload.js"),
        zoomFactor: zoomController.factor(),
      },
    });
    mainWindow = createdWindow;
    if (process.platform === "win32") {
      createdWindow.setAppDetails({
        appId: appUserModelId,
        appIconPath: app.isPackaged ? process.execPath : iconPath,
        appIconIndex: 0,
        ...(app.isPackaged && {
          relaunchCommand: `"${process.execPath}"`,
          relaunchDisplayName: PRODUCT_NAME,
        }),
      });
    }
    desktopLifecycle.attachWindow(createdWindow);
    zoomController.attach(createdWindow);
    createdWindow.once("ready-to-show", () => {
      splashPainted = true;
      if (!startMinimized && !createdWindow.isDestroyed() && !desktopLifecycle.isQuitting()) {
        createdWindow.show();
      }
    });
    createdWindow.on("closed", () => {
      if (mainWindow === createdWindow) mainWindow = undefined;
    });
    return createdWindow;
  }

  async function openMainWindow() {
    await splashLoad;
    if (desktopLifecycle.isQuitting()) return;

    backendReady = true;
    const createdWindow = createMainWindow();
    const origin = `http://127.0.0.1:${backendPort}`;
    configureNavigation(createdWindow, origin);
    // IPC cleanup is armed on "closed" BEFORE loadURL: a window closed
    // mid-load still releases its channels so a later window can register.
    mainWindowIpc.registerWindowIpc({
      ipcMain, BrowserWindow, nativeTheme, window: createdWindow, origin,
      assetsRoot: app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "assets"),
      titleBarOverlay: (theme) => zoomController.overlayOptions(theme),
    });
    await createdWindow.loadURL(resolveColdStartEntry(origin));
    if (createdWindow.isDestroyed()) return;
    const history = createdWindow.webContents.navigationHistory;
    if (history.getEntryAtIndex(0)?.url.startsWith("data:text/html")) {
      history.removeEntryAtIndex(0);
    }
  }

  app.on("second-instance", () => {
    void desktopLifecycle.showMainWindow();
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
      // The app has no menu-driven features: dropping the default
      // File/Edit/View/Window menu frees the top of the window for the
      // custom titlebar. Text-editing accelerators (Ctrl+C/V/X/A/Z/Y) are
      // native to Chromium edit controls and keep working without it.
      // Page zoom (Ctrl +/-/0) is not: those accelerators lived on the
      // View menu, so the shell owns them through webContents.setZoomFactor.
      Menu.setApplicationMenu(null);
      const startupWindow = createMainWindow();
      const logo = nativeImage.createFromPath(desktopIconPath()).toDataURL();
      splashLoad = startupWindow.loadURL(startupPageUrl(logo)).catch((error) => {
        if (!startupWindow.isDestroyed()) console.error("Could not show desktop startup screen", error);
      });
      // Real tray surface from the first launch: restore + explicit quit are
      // always reachable, and close-to-tray has somewhere to hide to the
      // moment the user enables it.
      desktopLifecycle.ensureTray();
      // Device-level lifecycle IPC: the renderer reads real state (settings
      // document + OS login items) and controls only booleans — no paths,
      // commands, or credentials cross this bridge.
      desktopLifecycle.registerIpc(ipcMain, () =>
        backendPort ? `http://127.0.0.1:${backendPort}` : null,
      );
      // Keybinding IPC + the global show/hide hotkey. Registering at ready
      // — before the window finishes loading — means the hotkey also works
      // while the window is hidden to the tray; sender checks pin every
      // write to the main window's own frame.
      registerShortcutsIpc(ipcMain, {
        store: keybindingsStore,
        hotkey: globalToggleHotkey,
        getWindow: () => mainWindow,
        getOrigin: () => (backendPort ? `http://127.0.0.1:${backendPort}` : null),
      });
      globalToggleHotkey.apply();
      registerZoomIpc(ipcMain, {
        controller: zoomController,
        getWindow: () => mainWindow,
        getOrigin: () => (backendPort ? `http://127.0.0.1:${backendPort}` : null),
      });
      registerInputPreferencesIpc({
        ipcMain,
        filePath: path.join(foundationLayout ? foundationLayout.configDir : path.join(stateRoot(), "config"), "input-preferences.json"),
        getWindow: () => mainWindow,
        getOrigin: () => backendPort ? `http://127.0.0.1:${backendPort}` : null,
      });
      registerResumePreviewPreferencesIpc({
        ipcMain,
        filePath: path.join(foundationLayout ? foundationLayout.configDir : path.join(stateRoot(), "config"), "resume-preview-preferences.json"),
        getWindow: () => mainWindow,
        getOrigin: () => backendPort ? `http://127.0.0.1:${backendPort}` : null,
      });
      registerAgentRoleSlotsIpc({
        ipcMain,
        filePath: path.join(foundationLayout ? foundationLayout.configDir : path.join(stateRoot(), "config"), AGENT_ROLE_SLOTS_FILE_NAME),
        getWindow: () => mainWindow,
        getOrigin: () => backendPort ? `http://127.0.0.1:${backendPort}` : null,
      });
      hostedSessionBroker = await startHostedSessionBroker({ token: internalToken,
        store: createHostedSessionStore({ directory: resolveHostedSessionDirectory({ isPackaged: app.isPackaged, foundationLayout, stateRoot: stateRoot() }), safeStorage, logger: console }),
        logger: console,
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
          logger: console,
          dictationTransport: createDictationTransport((url, init) => require("electron").net.fetch(url, init)),
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
      if (desktopLifecycle.isQuitting()) return;
      const windowOpened = await startBackend();
      if (!windowOpened) {
        await openMainWindow();
      }
    } catch (error) {
      if (!shuttingDown) {
        showStartupFailure(error);
      }
      await terminateChildTree(backend);
      setTimeout(() => app.quit(), 100);
    }
  });

  const quitCoordinator = createQuitCoordinator({
    // A real quit latches FIRST: while Electron closes windows during
    // teardown, each fires "close" and must not be re-intercepted into a
    // tray hide. A hidden window is never a successful quit.
    beginQuit: () => desktopLifecycle.beginQuit(),
    markShuttingDown: () => {
      shuttingDown = true;
      backendExpectedExit = true;
    },
    runReleaseHooks: () => runRegisteredReleaseHooks(),
    releaseResources: async () => {
      const ownedMigrationChild = migrationChild && migrationChild.exitCode === null ? migrationChild : null;
      // Only owned startup children are terminated here; unrelated
      // Node/Prisma processes are never touched. Process exit releases the
      // backend's SQLite connection. A hidden window does not reach here.
      try {
        await connectionOps?.dispose?.();
      } catch {
        // Persistent Codex children are best-effort on shutdown.
      }
      console.log("[desktop-quit] connection service released");
      try {
        execServer?.close();
        hostedSessionBroker?.server.close();
        credentialBroker?.server.close();
      } catch {
        // Closing the loopback listener must never block shutdown.
      }
      console.log("[desktop-quit] loopback listeners closed");
      desktopLifecycle.dispose();
      try {
        globalToggleHotkey.dispose();
      } catch {
        // unregisterAll must never block an in-progress quit.
      }
      console.log("[desktop-quit] lifecycle and hotkeys disposed");
      const [migrationResult, backendResult] = await Promise.all([
        terminateChildTree(ownedMigrationChild),
        terminateChildTree(backend),
      ]);
      // A resolved termination is not proof of cleanup — report what was
      // actually confirmed so best-effort failures stay visible.
      for (const [label, result] of [["migration", migrationResult], ["backend", backendResult]]) {
        if (result && (!result.exited || !result.ok)) console.warn(`[desktop-quit] ${label} cleanup inconclusive (exited=${result.exited} ${result.detail})`);
      }
      console.log("[desktop-quit] owned processes terminated");
    },
    flushSession: () => flushDefaultSession(session.defaultSession),
    requestQuit: () => app.quit(),
  });

  app.on("before-quit", (event) => {
    quitCoordinator.onBeforeQuit(event);
  });

  app.on("window-all-closed", () => {
    const state = desktopLifecycle.getState();
    if (!shouldQuitWhenAllWindowsClosed({
      platform: process.platform,
      closeToTrayActive: state.closeToTrayActive,
      isQuitting: desktopLifecycle.isQuitting(),
    })) return;
    app.quit();
  });
}
