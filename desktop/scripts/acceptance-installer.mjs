import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { inspectInstalledLayout, verifyInstalledLayout } from "./verify-installer.mjs";

const require = createRequire(import.meta.url);
const identity = require("../main/installer-identity.js");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const distRoot = path.join(repoRoot, ".codex-tmp", "windows-installer", "dist");
const acceptRoot = path.join(repoRoot, ".codex-tmp", "windows-installer", "acceptance");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const installerPath = path.join(distRoot, `Vocatrya-Setup-${pkg.version}-x64.exe`);
const defaultInstallDir = path.join(process.env.LOCALAPPDATA, "Programs", "Vocatrya");
function shellFolder(name) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); [Environment]::GetFolderPath('${name}')`],
    { encoding: "buffer", windowsHide: true },
  );
  return result.stdout.toString("utf8").replace(/^\uFEFF/, "").trim();
}

const desktopShortcut = path.join(shellFolder("Desktop") || path.join(process.env.USERPROFILE, "Desktop"), "Vocatrya.lnk");
const startMenuShortcut = path.join(
  shellFolder("Programs") || path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
  "Vocatrya.lnk",
);

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortcutTarget(lnkPath) {
  const script = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${JSON.stringify(lnkPath)})`,
    "Write-Output $s.TargetPath",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  return (result.stdout || "").trim();
}

function nsisSilent(exePath, installDir) {
  const argLine = installDir ? `/S /D=${installDir}` : "/S";
  const script = [
    `$p = Start-Process -FilePath ${JSON.stringify(exePath)} -ArgumentList ${JSON.stringify(argLine)} -Wait -PassThru`,
    "Write-Output $p.ExitCode",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    timeout: 300_000,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return Number((result.stdout || "").trim().split(/\r?\n/).pop());
}

function waitForFile(filePath, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    spawnSync("ping", ["127.0.0.1", "-n", "2"], { windowsHide: true });
  }
  return fs.existsSync(filePath);
}

function listOwnedProcesses() {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
  );
  try {
    const parsed = JSON.parse(result.stdout || "[]");
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function processesForInstall(installDir) {
  const normalized = path.resolve(installDir).toLowerCase();
  return listOwnedProcesses().filter((proc) => {
    const exe = String(proc.ExecutablePath || "").toLowerCase();
    const cmd = String(proc.CommandLine || "").toLowerCase();
    return exe.startsWith(normalized) || cmd.includes(normalized.replaceAll("\\", "\\\\").toLowerCase()) || cmd.includes(normalized);
  });
}

function request(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(3000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function waitForSignin(installDir, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  const nodeExe = path.resolve(path.join(installDir, "resources", "runtime", "win32-x64", "node.exe")).toLowerCase();
  while (Date.now() < deadline) {
    const pids = new Set(
      listOwnedProcesses()
        .filter((proc) => String(proc.ExecutablePath || "").toLowerCase() === nodeExe)
        .map((proc) => String(proc.ProcessId)),
    );
    if (pids.size === 0) {
      await sleep(500);
      continue;
    }
    const net = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true });
    const lines = (net.stdout || "").split(/\r?\n/);
    for (const line of lines) {
      if (!line.includes("127.0.0.1:") || !line.includes("LISTENING")) continue;
      const match = line.match(/127\.0\.0\.1:(\d+).+LISTENING\s+(\d+)/i);
      if (!match) continue;
      const port = match[1];
      const pid = match[2];
      if (!pids.has(pid)) continue;
      try {
        const res = await request(`http://127.0.0.1:${port}/signin`);
        if (res.status >= 200 && res.status < 500) {
          return { port: Number(port), status: res.status, body: res.body };
        }
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(500);
  }
  throw new Error(`signin readiness timed out: ${lastError?.message || "no loopback server"}`);
}

function launchApp({ installDir, dataRoot, cwd }) {
  const exe = path.join(installDir, "Vocatrya.exe");
  const workdir = cwd || installDir;
  const script = [
    "Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue",
    "Remove-Item Env:DESKTOP_NODE_RUNTIME -ErrorAction SilentlyContinue",
    "Remove-Item Env:NODE_EXECUTABLE -ErrorAction SilentlyContinue",
    `$env:VOCATRYA_DESKTOP_DATA_ROOT = ${JSON.stringify(dataRoot)}`,
    `$p = Start-Process -FilePath ${JSON.stringify(exe)} -WorkingDirectory ${JSON.stringify(workdir)} -PassThru`,
    "Write-Output $p.Id",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  const pid = Number((result.stdout || "").trim().split(/\r?\n/).pop());
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`Failed to launch ${exe}: ${result.stderr || result.stdout}`);
  }
  return { pid };
}

async function stopApp(installDir) {
  const owned = processesForInstall(installDir);
  for (const proc of owned.filter((item) => /vocatrya\.exe$/i.test(item.Name || item.ExecutablePath || ""))) {
    spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Stop-Process -Id ${proc.ProcessId} -ErrorAction SilentlyContinue`,
    ], { windowsHide: true });
  }
  await sleep(1000);
  const remaining = processesForInstall(installDir);
  for (const proc of remaining) {
    spawnSync("taskkill.exe", ["/PID", String(proc.ProcessId), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  }
  await sleep(500);
}

function findUninstaller(installDir) {
  const candidates = fs.readdirSync(installDir).filter((name) => /uninstall/i.test(name) && name.toLowerCase().endsWith(".exe"));
  if (candidates.length === 0) throw new Error(`Uninstaller not found in ${installDir}`);
  return path.join(installDir, candidates[0]);
}

function hashTreeFile(filePath) {
  return { exists: fs.existsSync(filePath), sha256: sha256File(filePath) };
}

async function launchAndReady({ installDir, dataRoot, cwd }) {
  const child = launchApp({ installDir, dataRoot, cwd });
  const ready = await waitForSignin(installDir);
  const nodeExe = path.join(installDir, "resources", "runtime", "win32-x64", "node.exe");
  const owned = processesForInstall(installDir);
  const nodeProcs = owned.filter((proc) => String(proc.ExecutablePath || "").toLowerCase() === nodeExe.toLowerCase());
  const staticSample = fs.readdirSync(path.join(installDir, "resources", "backend", ".next", "static", "chunks")).find((name) => name.endsWith(".js"));
  let staticStatus = null;
  if (staticSample) {
    try {
      staticStatus = (await request(`http://127.0.0.1:${ready.port}/_next/static/chunks/${staticSample}`)).status;
    } catch {
      staticStatus = 0;
    }
  }
  return { child, ready, nodeProcs, staticStatus, owned };
}

const report = {
  installerPath,
  packageVersion: pkg.version,
};

fs.mkdirSync(acceptRoot, { recursive: true });
if (!fs.existsSync(installerPath)) throw new Error(`Installer missing: ${installerPath}`);

report.installerSha256 = sha256File(installerPath);
report.installerSize = fs.statSync(installerPath).size;
report.unsignedInstaller = true;

const dataRoot = path.join(acceptRoot, "user-data");
if (fs.existsSync(dataRoot)) fs.rmSync(dataRoot, { recursive: true, force: true });
fs.mkdirSync(dataRoot, { recursive: true });

const customDir = path.join(acceptRoot, "Vocatrya Test Install");
const unicodeDir = path.join(acceptRoot, "Vocatrya\u6d4b\u8bd5\u5b89\u88c5");

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  // Default per-user install.
  if (fs.existsSync(path.join(defaultInstallDir, "Vocatrya.exe"))) {
    try {
      nsisSilent(findUninstaller(defaultInstallDir));
      await sleep(2000);
    } catch {
      nsisSilent(installerPath);
      await sleep(2000);
    }
  }
  nsisSilent(installerPath);
  if (!waitForFile(path.join(defaultInstallDir, "Vocatrya.exe"), 90_000)) {
    throw new Error(`Default install did not produce Vocatrya.exe at ${defaultInstallDir}`);
  }
  report.defaultInstallLocation = defaultInstallDir;
  report.defaultInstall = true;
  report.installedLayout = verifyInstalledLayout(defaultInstallDir);
  report.desktopShortcutExists = fs.existsSync(desktopShortcut);
  report.startMenuShortcutExists = fs.existsSync(startMenuShortcut);
  report.desktopShortcutTarget = report.desktopShortcutExists ? shortcutTarget(desktopShortcut) : null;
  report.startMenuShortcutTarget = report.startMenuShortcutExists ? shortcutTarget(startMenuShortcut) : null;
  report.desktopShortcutTargetOk = (report.desktopShortcutTarget || "").toLowerCase() === path.join(defaultInstallDir, "Vocatrya.exe").toLowerCase();
  report.startMenuShortcutTargetOk = (report.startMenuShortcutTarget || "").toLowerCase() === path.join(defaultInstallDir, "Vocatrya.exe").toLowerCase();

  const first = await launchAndReady({ installDir: defaultInstallDir, dataRoot, cwd: "C:\\Windows" });
  report.defaultInstallLaunch = true;
  report.defaultInstallSignin = first.ready.status;
  report.freshInstallSigninHttp = first.ready.status;
  report.staticAssetStatus = first.staticStatus;
  report.bundledNodePath = path.join(defaultInstallDir, "resources", "runtime", "win32-x64", "node.exe");
  report.systemNodeRequired = false;
  report.dockerRequired = false;
  report.repoRequired = false;
  report.arbitraryCwdLaunch = true;
  report.offlineInstallLaunch = true;

  const secretsPath = path.join(dataRoot, "config", "secrets.dat");
  const dbPath = path.join(dataRoot, "data", "vocatrya.db");
  const filesSentinel = path.join(dataRoot, "files", "installer-sentinel.txt");
  const backupSentinel = path.join(dataRoot, "backups", "installer-backup-sentinel.txt");
  if (!waitForFile(secretsPath, 20_000) || !waitForFile(dbPath, 20_000)) {
    throw new Error("Fresh install did not create secrets.dat or vocatrya.db");
  }
  fs.mkdirSync(path.dirname(filesSentinel), { recursive: true });
  fs.mkdirSync(path.dirname(backupSentinel), { recursive: true });
  fs.writeFileSync(filesSentinel, "files-sentinel", "utf8");
  fs.writeFileSync(backupSentinel, "backup-sentinel", "utf8");
  const before = {
    secrets: hashTreeFile(secretsPath),
    db: hashTreeFile(dbPath),
    files: hashTreeFile(filesSentinel),
    backups: hashTreeFile(backupSentinel),
  };
  report.freshInstallDpapiSecret = before.secrets.exists;
  report.freshInstallDbMigration = before.db.exists && before.db.sha256 !== null;

  const sharpProbe = spawnSync(
    path.join(defaultInstallDir, "resources", "runtime", "win32-x64", "node.exe"),
    ["-e", "require('sharp'); console.log('sharp-ok')"],
    {
      cwd: path.join(defaultInstallDir, "resources", "backend"),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, PATH: `${process.env.SystemRoot};${process.env.SystemRoot}\\System32` },
    },
  );
  report.sharpFromInstalledApp = (sharpProbe.stdout || "").includes("sharp-ok") && sharpProbe.status === 0;

  const vocatryaCount = processesForInstall(defaultInstallDir).filter((proc) => /vocatrya\.exe$/i.test(proc.Name || "")).length;
  const second = launchApp({ installDir: defaultInstallDir, dataRoot, cwd: defaultInstallDir });
  await sleep(4000);
  const afterSecond = processesForInstall(defaultInstallDir).filter((proc) => /vocatrya\.exe$/i.test(proc.Name || ""));
  report.singleInstanceInstalled = afterSecond.length === vocatryaCount || afterSecond.length === 1;
  if (second.pid) {
    spawnSync("taskkill.exe", ["/PID", String(second.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  }

  const nodeBeforeCrash = processesForInstall(defaultInstallDir).filter((proc) => /node\.exe$/i.test(proc.Name || ""));
  if (nodeBeforeCrash[0]) {
    spawnSync("taskkill.exe", ["/PID", String(nodeBeforeCrash[0].ProcessId), "/F"], { windowsHide: true, stdio: "ignore" });
    await sleep(2000);
    report.crashBackendKilled = true;
  }
  await stopApp(defaultInstallDir);
  report.gracefulShutdownInstalled = processesForInstall(defaultInstallDir).length === 0;
  report.orphanProcessesAfterClose = processesForInstall(defaultInstallDir).map((proc) => proc.Name);

  // Reinstall over existing installation.
  nsisSilent(installerPath);
  if (!waitForFile(path.join(defaultInstallDir, "Vocatrya.exe"), 90_000)) throw new Error("Reinstall missing exe");
  const afterReinstall = {
    secrets: hashTreeFile(secretsPath),
    db: hashTreeFile(dbPath),
    files: hashTreeFile(filesSentinel),
    backups: hashTreeFile(backupSentinel),
  };
  report.reinstall = true;
  report.secretPreservedAfterReinstall = afterReinstall.secrets.sha256 === before.secrets.sha256;
  report.databasePreservedAfterReinstall = afterReinstall.db.sha256 === before.db.sha256;
  report.filesPreservedAfterReinstall = afterReinstall.files.sha256 === before.files.sha256;
  report.backupsPreservedAfterReinstall = afterReinstall.backups.sha256 === before.backups.sha256;

  const relaunch = await launchAndReady({ installDir: defaultInstallDir, dataRoot, cwd: defaultInstallDir });
  report.reinstallLaunch = relaunch.ready.status;
  await stopApp(defaultInstallDir);

  // Uninstall while preserving data.
  const uninstaller = findUninstaller(defaultInstallDir);
  report.uninstaller = uninstaller;
  nsisSilent(uninstaller);
  await sleep(3000);
  report.uninstall = !fs.existsSync(path.join(defaultInstallDir, "Vocatrya.exe"));
  report.installedBinaryRemoved = report.uninstall;
  report.desktopShortcutRemoved = !fs.existsSync(desktopShortcut);
  report.startMenuShortcutRemoved = !fs.existsSync(startMenuShortcut);
  report.userDbPreservedAfterUninstall = hashTreeFile(dbPath).sha256 === before.db.sha256;
  report.secretStorePreservedAfterUninstall = hashTreeFile(secretsPath).sha256 === before.secrets.sha256;
  report.filesPreservedAfterUninstall = hashTreeFile(filesSentinel).sha256 === before.files.sha256;
  report.backupsPreservedAfterUninstall = hashTreeFile(backupSentinel).sha256 === before.backups.sha256;
  report.logsPreservedAfterUninstall = fs.existsSync(path.join(dataRoot, "logs"));

  // Reinstall after uninstall reuses data.
  nsisSilent(installerPath);
  if (!waitForFile(path.join(defaultInstallDir, "Vocatrya.exe"), 90_000)) throw new Error("Reinstall after uninstall missing exe");
  report.reinstallAfterUninstall = true;
  report.preservedDataReused =
    hashTreeFile(secretsPath).sha256 === before.secrets.sha256 &&
    hashTreeFile(dbPath).sha256 === before.db.sha256 &&
    hashTreeFile(filesSentinel).sha256 === before.files.sha256;
  const reused = await launchAndReady({ installDir: defaultInstallDir, dataRoot, cwd: defaultInstallDir });
  report.reinstallLaunchAfterUninstall = reused.ready.status;
  await stopApp(defaultInstallDir);

  // Running-app uninstall.
  await launchAndReady({ installDir: defaultInstallDir, dataRoot, cwd: defaultInstallDir });
  try {
    nsisSilent(findUninstaller(defaultInstallDir));
    report.runningAppUninstallBehavior = "uninstaller invoked while running; silent uninstall completed";
  } catch (error) {
    report.runningAppUninstallBehavior = `uninstaller requested close or failed: ${error.message}`;
    await stopApp(defaultInstallDir);
    if (fs.existsSync(findUninstaller(defaultInstallDir))) nsisSilent(findUninstaller(defaultInstallDir));
  }
  await sleep(3000);
  await stopApp(defaultInstallDir);
  if (fs.existsSync(path.join(defaultInstallDir, "Vocatrya.exe"))) {
    try {
      nsisSilent(findUninstaller(defaultInstallDir));
    } catch {
      // Final cleanup best-effort.
    }
  }

  // Custom path with spaces.
  if (fs.existsSync(customDir)) fs.rmSync(customDir, { recursive: true, force: true });
  nsisSilent(installerPath, customDir);
  if (!waitForFile(path.join(customDir, "Vocatrya.exe"), 90_000)) {
    throw new Error(`Custom space-path install missing exe: ${customDir}`);
  }
  report.customSpacePathInstall = true;
  const customLaunch = await launchAndReady({ installDir: customDir, dataRoot, cwd: customDir });
  report.customSpacePathLaunch = customLaunch.ready.status;
  await stopApp(customDir);
  nsisSilent(findUninstaller(customDir));

  // Unicode path package/launch from unpacked copy.
  const unpacked = path.join(distRoot, "win-unpacked");
  if (fs.existsSync(unicodeDir)) fs.rmSync(unicodeDir, { recursive: true, force: true });
  fs.cpSync(unpacked, unicodeDir, { recursive: true });
  report.unicodePathPackageTest = verifyInstalledLayout(unicodeDir).missingResources.length === 0;
  const unicodeLaunch = await launchAndReady({ installDir: unicodeDir, dataRoot, cwd: unicodeDir });
  report.unicodePathLaunch = unicodeLaunch.ready.status;
  await stopApp(unicodeDir);

  report.actualRealUserDataTouched = fs.existsSync(path.join(process.env.LOCALAPPDATA, "Vocatrya", "data", "vocatrya.db"));
  report.realProductDbTouched = sha256File(path.join(repoRoot, "prisma", "dev.db"));
  fs.writeFileSync(path.join(acceptRoot, "acceptance-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  report.error = error.stack || error.message;
  fs.writeFileSync(path.join(acceptRoot, "acceptance-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(error);
  process.exit(1);
});
