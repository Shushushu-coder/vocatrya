import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { chromium } from "@playwright/test";

export function desktopEnvironment(source, dataRoot) {
  const env = {};
  // Deliberately exclude credentials, Node options, proxy overrides and
  // ELECTRON_RUN_AS_NODE. Chromium still uses the machine's system proxy.
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "Path", "PATHEXT", "USERPROFILE", "LOCALAPPDATA", "APPDATA"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return {
    ...env,
    VOCATRYA_DESKTOP_DATA_ROOT: dataRoot,
    DESKTOP_NODE_RUNTIME: process.execPath,
    VOCATRYA_AB_RUNTIME_ENABLED: "true",
    VOCATRYA_AB_ROLLOUT_SCOPE: "full",
    TZ: "Asia/Shanghai",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

export async function waitForValue(label, probe, { timeout = 180_000, child } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null || child.spawnError)) {
      throw new Error(`${label}: Electron exited (code=${child.exitCode}, signal=${child.signalCode})${child.spawnError ? `: ${child.spawnError.message}` : ""}`);
    }
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label}: timed out after ${timeout}ms`);
}

export function devToolsEndpoint(contents) {
  const [port, wsPath] = contents.trim().split(/\r?\n/);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(wsPath ?? "")) return null;
  return `http://127.0.0.1:${port}`;
}

export async function requestQuit(page, timeout = 5000) {
  // evaluate has no Playwright default timeout. Bound the IPC itself so a
  // stuck renderer cannot prevent owned-process cleanup from running.
  let timer;
  await Promise.race([
    page.evaluate(() => window.vocatryaDesktop.quit()).catch(() => {}),
    new Promise((resolve) => { timer = setTimeout(resolve, timeout); }),
  ]).finally(() => clearTimeout(timer));
}

function readIfPresent(file) {
  try { return fs.readFileSync(file); }
  catch (error) { if (error.code === "ENOENT") return Buffer.alloc(0); throw error; }
}

async function responds(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    await response.body?.cancel();
    return response.status === 200;
  } catch { return false; }
}

export function startDesktop({ appRoot, dataRoot, logDirectory, electronExe, direct = false, launchNumber = 1 }) {
  fs.mkdirSync(logDirectory, { recursive: true });
  const activePortFile = path.join(dataRoot, "electron", "DevToolsActivePort");
  // This profile belongs exclusively to this runner. Remove its previous
  // launch's discovery file before spawning; never accept a stale endpoint.
  fs.rmSync(activePortFile, { force: true });
  const backendLog = path.join(dataRoot, "logs", "backend-stdout.log");
  const offset = readIfPresent(backendLog).length;
  const output = fs.createWriteStream(path.join(logDirectory, `electron-${launchNumber}.log`));
  const child = spawn(electronExe, [
    "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    ...(direct ? ["--no-proxy-server"] : []), appRoot,
  ], { cwd: appRoot, env: desktopEnvironment(process.env, dataRoot), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", (error) => { child.spawnError = error; });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  child.once("close", () => output.end());
  return { child, activePortFile, backendLog, offset, browser: null, page: null };
}

export async function connectDesktop(instance) {
  const { child, backendLog, offset, activePortFile } = instance;
  instance.origin = await waitForValue("backend HTTP readiness", async () => {
    const log = readIfPresent(backendLog).subarray(offset).toString("utf8");
    const match = [...log.matchAll(/Local:\s+(http:\/\/127\.0\.0\.1:\d+)/g)].at(-1);
    if (!match || !log.includes("Ready")) return null;
    return await responds(`${match[1]}/signin`) ? match[1] : null;
  }, { child });
  console.log("PASS backend HTTP ready");
  const endpoint = await waitForValue("CDP readiness", async () => {
    const url = devToolsEndpoint(readIfPresent(activePortFile).toString("utf8"));
    return url && await responds(`${url}/json/version`) ? url : null;
  }, { child });
  instance.browser = await chromium.connectOverCDP(endpoint, { timeout: 30_000 });
  console.log("PASS CDP connected (dynamic loopback port)");
  const entry = await fetch(`${instance.origin}/dashboard`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
  const location = entry.headers.get("location");
  await entry.body?.cancel();
  if (location && new URL(location, instance.origin).origin !== instance.origin) {
    const target = new URL(location, instance.origin);
    throw new Error(`Desktop cold-start redirect leaves the allowed origin: ${instance.origin}/dashboard -> ${target.origin}${target.pathname}`);
  }
  instance.page = await waitForValue("application window readiness", () => {
    for (const context of instance.browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().startsWith(`${instance.origin}/`)) return page;
        if (page.url().startsWith("data:") && /startup%20failed|backend%20stopped/i.test(page.url())) {
          instance.page = page;
          throw new Error("Electron showed a startup failure page; inspect this run's logs");
        }
      }
    }
    return null;
  }, { child, timeout: 60_000 });
  instance.page.setDefaultTimeout(30_000);
  console.log("PASS application window found");
  const log = readIfPresent(backendLog).subarray(offset).toString("utf8");
  if (!/state=FRESH_READY mode=AB_ENABLED .*scope=full/.test(log)) {
    throw new Error("Desktop runtime is not FRESH_READY / AB_ENABLED / full");
  }
}

export async function stopDesktop(instance, { requireGraceful = false } = {}) {
  if (!instance) return;
  const { child, page, browser } = instance;
  if (child.spawnError) return;
  let graceful = child.exitCode === 0;
  try {
    if (child.exitCode === null && child.signalCode === null) {
      if (page && !page.isClosed()) {
        await requestQuit(page);
        await waitForValue("application quit", () => child.exitCode !== null || child.signalCode !== null, { timeout: 20_000 }).catch(() => {});
      }
      graceful = child.exitCode === 0;
      if (child.exitCode === null && child.signalCode === null) {
        // The PID comes directly from our spawn, never a process-name scan.
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        await once(killer, "exit");
        await waitForValue("owned Electron process cleanup", () => child.exitCode !== null || child.signalCode !== null, { timeout: 15_000 });
      }
    }
  } finally {
    await browser?.close().catch(() => {});
  }
  if (requireGraceful && !graceful) throw new Error("Application did not exit cleanly through its quit IPC");
  if (requireGraceful && instance.origin) {
    await waitForValue("backend stopped after quit", () => new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: Number(new URL(instance.origin).port) });
      socket.setTimeout(1000);
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("error", (error) => { socket.destroy(); resolve(error.code === "ECONNREFUSED"); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    }), { timeout: 15_000 });
  }
}
