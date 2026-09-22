const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const DEFAULT_READINESS_TIMEOUT_MS = 25_000;
const DEFAULT_PORT_ATTEMPTS = 3;
const SENSITIVE_ENV_KEYS = new Set([
  "AUTH_SECRET",
  "ENCRYPTION_KEY",
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
]);

function assertLoopbackHost(hostname) {
  if (hostname !== "127.0.0.1") {
    throw new Error(`Desktop backend must bind to 127.0.0.1, received ${hostname}`);
  }
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = probe.address();
      probe.close((closeError) => {
        if (closeError) {
          reject(closeError);
        } else if (!address || typeof address === "string") {
          reject(new Error("Unable to determine an ephemeral loopback port"));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

function createPocSecret() {
  return require("node:crypto").randomBytes(32).toString("base64url");
}

function toPrismaFileUrl(filePath) {
  return `file:${path.resolve(filePath).replaceAll("\\", "/")}`;
}

function buildBackendEnvironment({ port, dataDir, baseEnv = process.env, secret = createPocSecret(), encryptionKey, uploadsDir, databaseUrl, appVersion }) {
  assertLoopbackHost("127.0.0.1");
  const env = {
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NEXTAUTH_URL: `http://127.0.0.1:${port}`,
    AUTH_TRUST_HOST: "true",
    AUTH_SECRET: secret,
    DATABASE_URL: databaseUrl || toPrismaFileUrl(path.join(dataDir, "desktop-poc.db")),
    TZ: baseEnv.TZ || "UTC",
    NEXT_TELEMETRY_DISABLED: "1",
    VOCATRYA_AB_ROLLOUT_SCOPE: "none",
    MCP_ENABLED: "false",
  };

  // Preserve non-secret configuration knobs without copying credentials into the child environment.
  for (const key of ["OLLAMA_BASE_URL", "OTEL_SERVICE_NAME", "VOCATRYA_AB_RUNTIME_ENABLED"]) {
    if (baseEnv[key]) env[key] = baseEnv[key];
  }
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA"]) {
    if (baseEnv[key]) env[key] = baseEnv[key];
  }
  // Desktop foundation injection: stable uploads root + persistent encryption
  // key. Both are explicit parameters only; inherited host values are never
  // trusted here so Docker/web defaults stay untouched.
  for (const key of ["UPLOADS_DIR", "VOCATRYA_UPLOADS_DIR"]) delete env[key];
  if (uploadsDir) env.UPLOADS_DIR = uploadsDir;
  for (const key of SENSITIVE_ENV_KEYS) {
    if (key !== "AUTH_SECRET" && key !== "DATABASE_URL" && key !== "ENCRYPTION_KEY") delete env[key];
  }
  if (encryptionKey) {
    env.ENCRYPTION_KEY = encryptionKey;
  } else {
    delete env.ENCRYPTION_KEY;
  }
  // Installed-app version the About/Support dialog reports. The packaged app
  // supplies its Electron app.getVersion() so a stale web bundle cannot show
  // an older inlined package.json version; unset means "use package.json".
  if (typeof appVersion === "string" && appVersion.trim()) {
    env.VOCATRYA_APP_VERSION = appVersion.trim();
  } else {
    delete env.VOCATRYA_APP_VERSION;
  }
  return env;
}

function resolveNodeExecutable({ isPackaged, appPath, env = process.env, platform = process.platform }) {
  if (isPackaged) {
    const packaged = path.join(appPath, "runtime", "win32-x64", "node.exe");
    if (platform === "win32") {
      if (!fs.existsSync(packaged)) throw new Error(`Bundled Node runtime is missing: ${packaged}`);
      return packaged;
    }
    throw new Error("Packaged desktop runtime is only prepared for Windows x64");
  }
  const explicit = env.DESKTOP_NODE_RUNTIME || env.NODE_EXECUTABLE;
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved)) throw new Error(`Configured Node runtime does not exist: ${resolved}`);
    return resolved;
  }
  const prepared = path.join(appPath, ".codex-tmp", "desktop-poc", "runtime", "win32-x64", "node.exe");
  if (platform === "win32" && fs.existsSync(prepared)) return prepared;
  if (env.npm_node_execpath && fs.existsSync(env.npm_node_execpath)) return env.npm_node_execpath;
  const command = platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(command, ["node"], { encoding: "utf8", windowsHide: true });
  const candidate = result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : "";
  if (candidate) return candidate;
  throw new Error("No development Node executable found; set DESKTOP_NODE_RUNTIME explicitly");
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", done);
    timer = setTimeout(done, timeoutMs);
  });
}

function terminateChildTree(child, timeoutMs = 3_000) {
  if (!child) return Promise.resolve();
  const pid = child.pid;
  if (child.exitCode === null) {
    try {
      child.kill();
    } catch {
      // The process may have exited between the state check and kill().
    }
  }
  return waitForChildExit(child, timeoutMs).then(() => {
    if (process.platform === "win32" && pid) {
      spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
    }
  });
}

function requestHttp(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode || 0));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("readiness request timed out")));
    request.once("error", reject);
  });
}

async function waitForReadiness(url, { child, timeoutMs = DEFAULT_READINESS_TIMEOUT_MS, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child && child.spawnError) {
      throw new Error(`Backend process could not start: ${child.spawnError.message}`);
    }
    if (child && child.exitCode !== null) {
      throw new Error(`Backend exited before readiness (code ${child.exitCode})`);
    }
    try {
      const status = await requestHttp(url, Math.min(intervalMs * 2, 1_000));
      if (status >= 200 && status < 500) return status;
      lastError = new Error(`Backend readiness returned HTTP ${status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Backend readiness timed out after ${timeoutMs}ms: ${lastError?.message || "no response"}`);
}

function buildBackendCommand({ nodeExecutable, serverPath }) {
  if (!nodeExecutable || !serverPath) throw new Error("nodeExecutable and serverPath are required");
  return { executable: nodeExecutable, args: [serverPath] };
}

async function startBackendWithRetry({
  attempts = DEFAULT_PORT_ATTEMPTS,
  allocatePort = allocateLoopbackPort,
  spawnChild,
  waitReady,
  terminate = terminateChildTree,
} = {}) {
  if (typeof spawnChild !== "function") throw new Error("spawnChild is required");
  if (typeof waitReady !== "function") throw new Error("waitReady is required");
  const attemptedPorts = [];
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = await allocatePort();
    attemptedPorts.push(port);
    const child = await spawnChild(port);
    try {
      await waitReady(port, child);
      return { port, child, attemptedPorts };
    } catch (error) {
      lastError = error;
      await terminate(child);
    }
  }
  const failure = lastError || new Error("Backend failed to start");
  failure.attemptedPorts = attemptedPorts;
  throw failure;
}

function spawnBackend({ nodeExecutable, serverPath, cwd, env, logDirectory }) {
  fs.mkdirSync(logDirectory, { recursive: true });
  const stdout = fs.createWriteStream(path.join(logDirectory, "backend-stdout.log"), { flags: "a" });
  const stderr = fs.createWriteStream(path.join(logDirectory, "backend-stderr.log"), { flags: "a" });
  const command = buildBackendCommand({ nodeExecutable, serverPath });
  const child = spawn(command.executable, command.args, {
    cwd,
    env,
    windowsHide: true,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.once("error", (error) => {
    child.spawnError = error;
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  child.once("close", () => {
    stdout.end();
    stderr.end();
  });
  return child;
}

function isAllowedNavigation(url, origin) {
  try {
    const candidate = new URL(url);
    const allowed = new URL(origin);
    return candidate.protocol === "http:" && candidate.hostname === "127.0.0.1" && candidate.port === allowed.port;
  } catch {
    return false;
  }
}

function isExternalHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_PORT_ATTEMPTS,
  DEFAULT_READINESS_TIMEOUT_MS,
  allocateLoopbackPort,
  assertLoopbackHost,
  buildBackendCommand,
  buildBackendEnvironment,
  createPocSecret,
  toPrismaFileUrl,
  isAllowedNavigation,
  isExternalHttpUrl,
  resolveNodeExecutable,
  spawnBackend,
  startBackendWithRetry,
  terminateChildTree,
  waitForReadiness,
};


