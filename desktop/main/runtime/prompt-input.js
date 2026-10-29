// One-shot business-prompt transport helpers for ACCOUNT_LOGIN adapters.
//
// Business prompts can exceed the Windows CreateProcess command-line
// limit (resume imports routinely carry tens of KB); they must never
// ride as argv elements. Each supported runtime transports the prompt
// one of two verified ways:
//   - stdin: the CLI reads the full prompt from piped stdin
//     (codex exec `-`, claude -p, opencode run, cursor agent -p);
//   - file:  the CLI loads the prompt from a file inside the fresh
//     Vocatrya-owned workDir (grok --prompt-file, devin --prompt-file).
const fs = require("node:fs");
const path = require("node:path");

// Prompt file name inside the per-execution workDir. Constant — one
// invocation gets one prompt, and the workDir is removed wholesale
// by the caller on success, failure, timeout, and abort.
const PROMPT_FILE_NAME = "prompt.txt";

// Returns an onStdinReady hook that streams the full prompt through the
// child's piped stdin and ends it (EOF), so CLIs that read stdin to EOF
// start immediately instead of waiting on the descriptor. The runner
// owns stdin lifetime — this hook must not wait on the stream, and an
// EPIPE/destroyed stream is ignored because an early-exiting child is
// already reported through the normal exit path.
function promptStdinWriter(prompt) {
  const payload = String(prompt);
  return (stdin) => {
    if (!stdin || typeof stdin.end !== "function") return;
    try {
      stdin.on("error", () => {});
      stdin.end(payload, "utf8");
    } catch {
      // Stdin already closed (e.g. the child exited before spawn
      // returned); the exit result carries the real failure.
    }
  };
}

// Writes the prompt into the fresh per-execution working directory and
// returns the file path. The caller never deletes the file itself —
// the workDir is owned by the service and removed in its finally
// cleanup, which also runs on failure, timeout, and abort.
function writePromptFile(workingDirectory, prompt) {
  const promptPath = path.join(workingDirectory, PROMPT_FILE_NAME);
  fs.writeFileSync(promptPath, String(prompt), { encoding: "utf8" });
  return promptPath;
}

module.exports = {
  PROMPT_FILE_NAME,
  promptStdinWriter,
  writePromptFile,
};
