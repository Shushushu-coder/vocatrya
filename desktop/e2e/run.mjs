import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { assembleDesktopBackend } from "../scripts/assemble.mjs";
import { desktopEnvironment, startDesktop, connectDesktop, stopDesktop } from "./harness.mjs";
import { register, checkNavigation, checkReopen } from "./scenario.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: npm run test:e2e:desktop [-- --direct]\nWindows Electron fresh-native registration/navigation/restart. Rebuilds current source; uses only a unique .tmp/desktop-e2e directory. --direct is a separately labelled proxy diagnostic. See desktop/E2E.md.");
  process.exit(0);
}
if (process.platform !== "win32") throw new Error("Desktop UI E2E requires Windows and an interactive desktop session");
if (args.some((arg) => arg !== "--direct")) throw new Error("Unknown option; see --help");
const direct = args.includes("--direct");
const runRoot = path.join(root, ".tmp", "desktop-e2e", randomUUID());
const appRoot = path.join(runRoot, "app");
const dataRoot = path.join(runRoot, "data-root");
fs.mkdirSync(appRoot, { recursive: true });

function sourceFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "src", "public", "prisma/schema.prisma", "prisma/migrations", "desktop/main", "desktop/assets", "scripts/build-fresh-native-bootstrap.mjs", "next.config.mjs", "next-env.d.ts", "eslint.config.mjs", "package.json", "package-lock.json", "tsconfig.json", "postcss.config.mjs"], { cwd: root }).toString().split("\0").filter(Boolean);
}

function sourceDigest() {
  const files = sourceFiles();
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    hash.update(file);
    hash.update(fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file)) : "<deleted>");
  }
  return hash.digest("hex");
}

async function build() {
  const env = desktopEnvironment(process.env, dataRoot);
  // Build-time instrumentation never sees a real development database.
  env.DATABASE_URL = `file:${path.join(runRoot, "build.db").replaceAll("\\", "/")}`;
  env.AUTH_SECRET = "desktop-e2e-synthetic-build-secret";
  const child = spawn(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "build"], { cwd: appRoot, env, windowsHide: true, stdio: "inherit" });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`Current-source Next build failed (exit ${code})`);
}

let instance;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
    void stopDesktop(instance).finally(() => process.exit(130));
  });
}

try {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const digest = sourceDigest();
  console.log(`Desktop E2E: commit=${commit} source=${digest} host=Electron mode=fresh-native proxy=${direct ? "DIRECT DIAGNOSTIC" : "SYSTEM (unchanged)"}`);
  console.log(`Isolated run: ${runRoot}`);
  // Build from explicit source inputs only. Next otherwise loads the user's
  // checkout .env files even when the child environment is allowlisted.
  // The snapshot also prevents contention with a developer's .next server.
  for (const file of [...new Set(sourceFiles())]) {
    const source = path.join(root, file);
    if (!fs.existsSync(source)) continue;
    const destination = path.join(appRoot, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  fs.symlinkSync(path.join(root, "node_modules"), path.join(appRoot, "node_modules"), "junction");
  if (sourceDigest() !== digest) throw new Error("Source changed while snapshotting; rerun against a stable checkout");
  await build();
  if (sourceDigest() !== digest) throw new Error("Source changed during build; rerun against a stable checkout");

  // The unmodified desktop main resolves its backend relative to this copy.
  assembleDesktopBackend({ repoRoot: appRoot, outputRoot: path.join(appRoot, ".codex-tmp", "desktop-poc") });
  if (sourceDigest() !== digest) throw new Error("Source changed during assembly; rerun against a stable checkout");
  console.log("PASS current-source build/assembly identity");

  const launchOptions = { appRoot, dataRoot, logDirectory: path.join(runRoot, "logs"), electronExe: require("electron"), direct };
  const identity = { name: "桌面导航测试", email: `desktop-${randomUUID()}@example.test`, password: `Desktop-${randomUUID()}!` };
  instance = startDesktop(launchOptions);
  await connectDesktop(instance);
  await instance.page.context().tracing.start({ screenshots: true, snapshots: true });
  await register(instance.page, instance.origin, identity);
  await checkNavigation(instance.page, instance.origin);
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: `file:${path.join(dataRoot, "data", "vocatrya.db").replaceAll("\\", "/")}` });
  try {
    const marker = await prisma.abMigrationState.findFirst();
    if (marker?.status !== "FRESH_READY" || marker.migrationKey !== "vocatrya-ab-fresh-native-v1" || !marker.verifiedAt) throw new Error("Isolated database is not verified fresh-native");
    await prisma.user.findUniqueOrThrow({ where: { email: identity.email } });
  } finally { await prisma.$disconnect(); }
  console.log("PASS isolated database marker and persisted signup");
  await instance.page.context().tracing.stop();
  await stopDesktop(instance, { requireGraceful: true });
  instance = null;
  console.log("PASS application quit and backend shutdown");
  instance = startDesktop({ ...launchOptions, launchNumber: 2 });
  await connectDesktop(instance);
  await checkReopen(instance.page, instance.origin, identity);
  await stopDesktop(instance, { requireGraceful: true });
  instance = null;
  if (!interrupted) console.log(`PASS Windows Electron fresh-native E2E${direct ? " (DIRECT DIAGNOSTIC ONLY)" : " (system proxy unchanged)"}`);
} catch (error) {
  console.error(`FAIL Windows Electron fresh-native E2E: ${error.message}`);
  console.error(`Evidence retained in ${runRoot}`);
  await instance?.page?.screenshot({ path: path.join(runRoot, "failure.png"), fullPage: true }).catch(() => {});
  await instance?.page?.context().tracing.stop({ path: path.join(runRoot, "failure-trace.zip") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await stopDesktop(instance);
}
