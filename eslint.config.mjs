import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  {
    // ESLint 9 only skips node_modules/.git by default; sibling worktrees,
    // local scratch dirs and separately linted projects must be listed.
    ignores: [
      "**/.next/",
      "coverage/",
      "__mocks__/",
      ".codex-tmp/",
      ".worktrees/",
      ".claude/",
      ".tmp/",
      ".wave1-runtime/",
      ".playwright-cli/",
      "services/managed-ai/dist/",
      "video/",
    ],
  },
  ...compat.extends("next/core-web-vitals"),
  {
    // Playwright's fixture `use` callback is not a React hook.
    files: ["e2e/**"],
    rules: { "react-hooks/rules-of-hooks": "off" },
  },
];

export default eslintConfig;
