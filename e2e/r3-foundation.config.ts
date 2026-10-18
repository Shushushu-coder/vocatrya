import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { configureE2EDatabase } from "./support/database";
import {
  provisionR3FreshNativeSchema,
  requireR3HarnessEnv,
  resolveR3FreshNativeDatabase,
  r3WebServer,
  R3_FRESH_NATIVE_PORT,
} from "./support/r3Harness";

// Explicit isolated database and evidence directory required; no .env fallback.
const { evidenceDir } = requireR3HarnessEnv();
const database = configureE2EDatabase();
const evidence = path.resolve(evidenceDir);
const root = path.resolve(__dirname, "..");
const freshDatabase = resolveR3FreshNativeDatabase(evidenceDir);
// The server opens the database during instrumentation, so the disposable
// fresh-native file must already be migrated before the web server boots.
provisionR3FreshNativeSchema(freshDatabase, root);

export default defineConfig({
  testDir: ".",
  globalSetup: "./global-setup.ts",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: path.join(evidence, "playwright-results"),
  reporter: [["list"], ["html", { outputFolder: path.join(evidence, "playwright-report"), open: "never" }]],
  use: { baseURL: "http://localhost:3749", trace: "retain-on-failure" },
  projects: [
    {
      // Legacy family: the shared DATABASE_URL keeps an unmarked migration
      // state, asserted in global setup.
      name: "chromium",
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3749" },
      testMatch: ["r3-foundation.spec.ts", "dialog-overlay.spec.ts"],
    },
    {
      // Fresh-native family: a disposable database the FRESH_READY marker can
      // never leak out of, on its own server.
      name: "chromium-fresh-native",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://localhost:${R3_FRESH_NATIVE_PORT}`,
      },
      testMatch: ["dialog-reflection.spec.ts"],
    },
  ],
  webServer: [
    r3WebServer(3749, database.url, root),
    // Pin the fresh-native runtime: an ambient VOCATRYA_AB_* value (shell or
    // .env) must not degrade this server to a disabled scope.
    r3WebServer(R3_FRESH_NATIVE_PORT, freshDatabase.url, root, {
      VOCATRYA_AB_RUNTIME_ENABLED: "true",
      VOCATRYA_AB_ROLLOUT_SCOPE: "full",
    }),
  ],
});
