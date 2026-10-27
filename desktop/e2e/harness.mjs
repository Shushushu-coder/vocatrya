import fs from "node:fs";
import http from "node:http";
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

export async function waitForInitialNavigation(page, origin, authenticated) {
  // Finding a same-origin page does not mean Electron's initial loadURL has
  // finished. A test navigation before load can abort startup and its backend.
  await page.waitForURL((url) => url.origin === origin && url.pathname === (authenticated ? "/dashboard" : "/signin"), { waitUntil: "load", timeout: 60_000 });
}

export async function connectDesktop(instance, { authenticated = false } = {}) {
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
  // This independent HTTP probe has no renderer cookies, including on reopen.
  const entry = await fetch(`${instance.origin}/dashboard`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
  const location = entry.headers.get("location");
  await entry.body?.cancel();
  if (!location) throw new Error("Cold-start /dashboard did not redirect unauthenticated requests to signin");
  const target = new URL(location, instance.origin);
  if (target.origin !== instance.origin || target.pathname !== "/signin" || target.hostname !== "127.0.0.1") {
    throw new Error(`Desktop cold-start redirect leaves the allowed origin: ${instance.origin}/dashboard -> ${target}`);
  }
  console.log(`PASS cold-start /dashboard redirects to same-origin /signin (${target})`);
  // Forged Host/Forwarded headers must never steer the auth redirect; the
  // redirect is emitted as a same-origin relative path, so there is no
  // attacker-controlled host to rewrite at all. Raw http.request is used
  // because fetch implementations may silently drop a forged Host header.
  const forgedLocation = await new Promise((resolve, reject) => {
    const probe = http.get(`${instance.origin}/dashboard/settings`, {
      headers: { Host: "forged.example", "X-Forwarded-Host": "attacker.test", "X-Forwarded-Proto": "https" },
      timeout: 5000,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.headers.location));
    });
    probe.once("timeout", () => probe.destroy(new Error("forged-header probe timed out")));
    probe.once("error", reject);
  });
  if (!forgedLocation) throw new Error("Cold-start /dashboard/settings did not redirect unauthenticated requests");
  const forgedTarget = new URL(forgedLocation, instance.origin);
  if (forgedTarget.origin !== instance.origin || forgedTarget.pathname !== "/signin" || forgedTarget.hostname !== "127.0.0.1") {
    throw new Error(`Forged Host/Forwarded headers steered the auth redirect: ${instance.origin}/dashboard/settings -> ${forgedTarget}`);
  }
  console.log("PASS forged Host/Forwarded headers cannot steer the auth redirect");
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
  await waitForInitialNavigation(instance.page, instance.origin, authenticated);
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
        try {
          await withDeadline(once(killer, "exit"), "owned taskkill", 10_000);
        } catch (error) {
          killer.kill();
          throw error;
        }
        await waitForValue("owned Electron process cleanup", () => child.exitCode !== null || child.signalCode !== null, { timeout: 15_000 });
      }
    }
  } finally {
    if (browser) await withDeadline(browser.close().catch(() => {}), "CDP disconnect", 10_000);
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

export async function withDeadline(operation, label, timeout = 10_000) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timed out after ${timeout}ms`)), timeout); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
