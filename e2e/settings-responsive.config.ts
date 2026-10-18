import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { configureE2EDatabase } from "./support/database";
import { requireR3HarnessEnv, r3WebServer } from "./support/r3Harness";

// Production server against an explicit synthetic database. No .env fallback.
const { evidenceDir } = requireR3HarnessEnv();
const database = configureE2EDatabase();
const evidence = path.resolve(evidenceDir);

export default defineConfig({
  testDir: ".",
  testMatch: ["settings-responsive.spec.ts"],
  globalSetup: "./global-setup.ts",
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: path.join(evidence, "playwright-results"),
  reporter: [["list"], ["html", { outputFolder: path.join(evidence, "playwright-report"), open: "never" }]],
  use: { baseURL: "http://localhost:3754", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: r3WebServer(3754, database.url, path.resolve(__dirname, "..")),
});
