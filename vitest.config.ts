import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      {
        find: "@prisma/client",
        replacement: path.resolve(__dirname, "./node_modules/@prisma/client"),
      },
      {
        find: "next-auth/providers/credentials",
        replacement: path.resolve(
          __dirname,
          "./__mocks__/next-auth-providers.ts"
        ),
      },
      {
        find: /^next-auth$/,
        replacement: path.resolve(__dirname, "./__mocks__/next-auth.ts"),
      },
      {
        find: "server-only",
        replacement: path.resolve(__dirname, "./__mocks__/server-only.ts"),
      },
    ],
  },
  test: {
    globals: true,
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "http://localhost:3737",
      },
    },
    setupFiles: ["./vitest.polyfills.ts", "./vitest.setup.ts"],
    clearMocks: true,
    // Many suites launch SQLite/Prisma subprocesses. Bound CPU and disk load
    // so the default Windows run does not starve async UI tests of their
    // existing assertion deadlines.
    maxWorkers: 4,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
    },
    // /docs is gitignored local phase residue; default suite must not
    // treat those environment-sensitive smokes as isolated coverage.
    exclude: [
      "e2e/**",
      "desktop/**",
      "services/**",
      "**/node_modules/**",
      "docs/**",
      ".worktrees/**",
      ".codex-tmp/**",
      ".tmp/**",
      ".devin/**",
      ".next/**",
    ],
    server: {
      deps: {
        inline: [/@prisma/, /next-auth/, /@auth/, /@next/, /jose/],
      },
    },
  },
});
