import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { assembleDesktopBackend } from "../scripts/assemble.mjs";
import { desktopEnvironment, startDesktop, connectDesktop, stopDesktop, withDeadline } from "./harness.mjs";
import { register, checkNavigation, checkReopen } from "./scenario.mjs";
import { enforceRunDirLimit, requireFreeSpace } from "./guards.mjs";
import { runDesktopE2E } from "./launcher.mjs";

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
const runId = randomUUID();

const result = await runDesktopE2E({
  runId,
  root,
  direct,
  deps: {
    fs,
    execFileSync,
    spawnImpl: spawn,
    enforceRunDirLimit,
    requireFreeSpace,
    buildEnv: ({ dataRoot, runRoot }) => {
      const env = desktopEnvironment(process.env, dataRoot);
      // Build-time instrumentation never sees a real development database.
      env.DATABASE_URL = `file:${path.join(runRoot, "build.db").replaceAll("\\", "/")}`;
      env.AUTH_SECRET = "desktop-e2e-synthetic-build-secret";
      return env;
    },
    assemble: assembleDesktopBackend,
    runScenario: async ({ appRoot, dataRoot, runRoot, direct, state }) => {
      const launchOptions = { appRoot, dataRoot, logDirectory: path.join(runRoot, "logs"), electronExe: require("electron"), direct };
      const identity = { name: "桌面导航测试", email: `desktop-${randomUUID()}@example.test`, password: `Desktop-${randomUUID()}!` };
      state.instance = startDesktop(launchOptions);
      await connectDesktop(state.instance);
      await withDeadline(state.instance.page.context().tracing.start({ screenshots: true, snapshots: true }), "start trace");
      await register(state.instance.page, state.instance.origin, identity);
      await checkNavigation(state.instance.page, state.instance.origin);
      const { PrismaClient } = require("@prisma/client");
      const prisma = new PrismaClient({ datasourceUrl: `file:${path.join(dataRoot, "data", "vocatrya.db").replaceAll("\\", "/")}` });
      try {
        const marker = await prisma.abMigrationState.findFirst();
        if (marker?.status !== "FRESH_READY" || marker.migrationKey !== "vocatrya-ab-fresh-native-v1" || !marker.verifiedAt) throw new Error("Isolated database is not verified fresh-native");
        await prisma.user.findUniqueOrThrow({ where: { email: identity.email } });
      } finally { await prisma.$disconnect(); }
      console.log("PASS isolated database marker and persisted signup");
      await withDeadline(state.instance.page.context().tracing.stop(), "finish trace");
      await stopDesktop(state.instance, { requireGraceful: true });
      state.instance = null;
      console.log("PASS application quit and backend shutdown");
      state.instance = startDesktop({ ...launchOptions, launchNumber: 2 });
      await connectDesktop(state.instance, { authenticated: true });
      await checkReopen(state.instance.page, state.instance.origin, identity);
      await stopDesktop(state.instance, { requireGraceful: true });
      state.instance = null;
    },
    stopDesktop,
    captureFailureArtifacts: async (instance, runRoot) => {
      if (!instance?.page) return;
      await Promise.all([
        withDeadline(instance.page.screenshot({ path: path.join(runRoot, "failure.png"), fullPage: true, timeout: 5000 }), "failure screenshot"),
        withDeadline(instance.page.context().tracing.stop({ path: path.join(runRoot, "failure-trace.zip") }), "failure trace"),
      ].map((capture) => capture.catch((error) => console.error(`Evidence capture: ${error.message}`))));
    },
  },
});
if (!result.ok) process.exitCode = 1;
