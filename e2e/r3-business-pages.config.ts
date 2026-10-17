import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { configureE2EDatabase } from "./support/database";

// Explicit isolated database and evidence directory required; no .env fallback.
if (!process.env.R3_EVIDENCE_DIR || !process.env.DATABASE_URL) {
  throw new Error("Set R3_EVIDENCE_DIR and DATABASE_URL to isolated synthetic paths.");
}
const database = configureE2EDatabase();
const evidence = path.resolve(process.env.R3_EVIDENCE_DIR);
export default defineConfig({
  testDir: ".",
  testMatch: ["r3-business-pages.spec.ts"],
  globalSetup: "./global-setup.ts",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: path.join(evidence, "playwright-results"),
  reporter: [["list"], ["html", { outputFolder: path.join(evidence, "playwright-report"), open: "never" }]],
  use: { baseURL: "http://localhost:3752", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    cwd: path.resolve(__dirname, ".."),
    command: "node node_modules/next/dist/bin/next start -p 3752",
    url: "http://localhost:3752",
    reuseExistingServer: false,
    env: {
      DATABASE_URL: database.url,
      AUTH_SECRET: process.env.AUTH_SECRET ?? "r3-business-pages-synthetic-secret",
      // next start rejects Auth.js requests on localhost unless the host is trusted.
      AUTH_TRUST_HOST: "true",
    },
    timeout: 60_000,
  },
});
