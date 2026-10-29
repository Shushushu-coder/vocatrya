import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

export default mergeConfig(base, defineConfig({ test: { include: ["__tests__/resumeBuilder.pagination.browser.tsx"], environment: "node", maxWorkers: 1 } }));
