const { app, BrowserWindow, dialog, shell, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
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
      return;
    }
    fs.mkdirSync(dataRoot(), { recursive: true });
    logDirectory = path.join(stateRoot(), "logs");
    const started = await startBackendWithRetry({
      attempts: DEFAULT_PORT_ATTEMPTS,
      allocatePort: allocateLoopbackPort,
      spawnChild: async (port) => {
        const env = buildBackendEnvironment({ port, dataDir: dataRoot(), baseEnv: process.env });
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

  app.whenReady().then(async () => {
    try {
      await startBackend();
      await createMainWindow();
    } catch (error) {
      showStartupFailure(error);
      await terminateChildTree(backend);
      setTimeout(() => app.quit(), 100);
    }
  });

  app.on("before-quit", (event) => {
    if (!backend || shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    backendExpectedExit = true;
    terminateChildTree(backend).finally(() => app.quit());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
