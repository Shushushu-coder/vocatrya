import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { configureE2EDatabase } from "./support/database";

// Production server against an explicit synthetic database. No .env fallback.
if (!process.env.R3_EVIDENCE_DIR || !process.env.DATABASE_URL) {
  throw new Error("Set R3_EVIDENCE_DIR and DATABASE_URL to isolated synthetic paths.");
}
const database = configureE2EDatabase();
const evidence = path.resolve(process.env.R3_EVIDENCE_DIR);

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
  webServer: {
    cwd: path.resolve(__dirname, ".."),
    command: "node node_modules/next/dist/bin/next start -p 3754",
    url: "http://localhost:3754",
    reuseExistingServer: false,
    env: {
      ...process.env,
      DATABASE_URL: database.url,
      NEXTAUTH_URL: "http://localhost:3754",
      AUTH_TRUST_HOST: "true",
    },
    timeout: 60_000,
  },
});
