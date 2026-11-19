import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["desktop/main/**/*.test.mjs"],
    exclude: [
      "**/node_modules/**",
      ".worktrees/**",
      ".claude/**",
      ".codex-tmp/**",
      ".tmp/**",
      ".devin/**",
      ".next/**",
    ],
  },
});
