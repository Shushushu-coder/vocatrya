// Phase C runtime definition registry — the single source of truth for the
// seven first-wave ACCOUNT_LOGIN runtimes. Definitions are structured data
// only: install/update commands are never assembled from renderer input and
// are not executed by this phase (executionEnabled: false).
//
// Each definition maps one AIConnection.backendKind to its runtime vendor,
// the account providers that runtime can authenticate
// (supportedAccountProviders — a runtime may host several account
// providers; vendor and account provider are separate axes), binary
// candidates, managed-profile isolation strategy, official install/update
// metadata, and read-only probe contracts. The backend-side typed mirror
// for pure contracts lives in src/lib/ai/runtime/contract.ts — provider
// definitions exist ONLY here so the two layers cannot drift on behaviour.

const PROFILE_STRATEGIES = Object.freeze({
  // One managed directory injected through a single provider-specific env var
  // (CODEX_HOME, CLAUDE_CONFIG_DIR, ...).
  PROFILE_DIR_ENV: "PROFILE_DIR_ENV",
  // The runtime has no native profile primitive; isolation is achieved by
  // redirecting the well-known roots (APPDATA / XDG_* / HOME) plus an
  // explicit --config path. WORKABLE_WITH_PROCESS_ENV_ISOLATION.
  ISOLATED_ROOTS: "ISOLATED_ROOTS",
});

const RUNTIME_INSTALL_STATES = Object.freeze([
  "NOT_INSTALLED",
  "READY",
  "UPDATE_AVAILABLE",
  "BROKEN",
]);

const RUNTIME_AUTH_STATES = Object.freeze([
  "AUTHENTICATED",
  "NOT_AUTHENTICATED",
  "REAUTH_REQUIRED",
  "UNKNOWN",
]);

// {ENV_VAR} placeholders inside knownLocations are expanded against the
// spawned/base environment at detection time. Paths stay read-only probes:
// existence checks only, never disk-wide scans.
const RUNTIME_DEFINITIONS = Object.freeze([
  {
    backendKind: "CODEX_RUNTIME",
    runtimeVendor: "OPENAI",
    supportedAccountProviders: ["OPENAI"],
    displayName: "OpenAI Codex CLI",
    binaries: [
      {
        commands: ["codex.exe", "codex.cmd", "codex"],
        knownLocations: [
          "{LOCALAPPDATA}\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
          // npm global install: the PATH shims (codex / codex.cmd) are not
          // spawnable with shell:false; the real binary is vendored inside
          // the platform package.
          "{APPDATA}\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe",
          "{APPDATA}\\npm\\codex.cmd",
        ],
      },
    ],
    profile: {
      strategy: PROFILE_STRATEGIES.PROFILE_DIR_ENV,
      env: { CODEX_HOME: "$PROFILE_DIR" },
      // An inherited API key or access token silently overrides
      // account-login routing inside the managed profile.
      stripEnv: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"],
    },
    install: {
      executionEnabled: false,
      methods: [
        {
          kind: "powershell-script",
          summary: "Official Codex standalone installer",
          executable: "powershell.exe",
          args: [
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://chatgpt.com/codex/install.ps1 | iex",
          ],
          documentationUrl: "https://developers.openai.com/codex/cli",
        },
        {
          kind: "npm-global",
          summary: "npm fallback",
          executable: "npm",
          args: ["install", "-g", "@openai/codex"],
        },
      ],
    },
    update: {
      executionEnabled: false,
      methods: [
        {
          kind: "self-update",
          summary: "Codex built-in updater",
          executable: "codex",
          args: ["update"],
        },
      ],
    },
    versionProbe: { args: ["--version"] },
    authProbe: {
      args: ["login", "status"],
      mode: "READ_ONLY",
      notes: "Reads local Codex auth state for the injected CODEX_HOME.",
    },
    // Verified against codex-cli 0.154.0 (codex <cmd> --help). All commands
    // run with CODEX_HOME pointed at the managed profile directory.
    commands: {
      // Interactive ChatGPT login: starts a local callback server and opens
      // the system browser. Long-running; cancelled via AbortSignal.
      login: ["login"],
      logout: ["logout"],
      // `codex debug models` prints the raw model catalog as JSON
      // ({models:[{slug,display_name,visibility,...}]}). --bundled skips the
      // remote refresh and dumps the catalog shipped inside the binary.
      models: ["debug", "models"],
      modelsBundled: ["debug", "models", "--bundled"],
    },
    capabilities: {
      accountLogin: true,
      modelDiscovery: true,
      streaming: true,
      appServer: true,
    },
  },
  {
    backendKind: "CLAUDE_RUNTIME",
    runtimeVendor: "ANTHROPIC",
    supportedAccountProviders: ["ANTHROPIC"],
    displayName: "Claude Code",
    binaries: [
      {
        commands: ["claude.exe", "claude.cmd", "claude"],
        knownLocations: [
          "{USERPROFILE}\\.local\\bin\\claude.exe",
          // WinGet installs a real .exe link (verified 2.1.203).
          "{LOCALAPPDATA}\\Microsoft\\WinGet\\Links\\claude.exe",
          // npm global: the declared bin inside @anthropic-ai/claude-code.
          "{APPDATA}\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
          "{APPDATA}\\npm\\claude.cmd",
        ],
      },
    ],
    profile: {
      strategy: PROFILE_STRATEGIES.PROFILE_DIR_ENV,
      // Absolute managed path required — never the host ~/.claude.
      // Claude Code writes credentials into CLAUDE_CONFIG_DIR, giving true
      // per-connection isolation.
      env: { CLAUDE_CONFIG_DIR: "$PROFILE_DIR" },
      // Every env route that would outrank a Claude.ai subscription login
      // or redirect the provider backend (spec §8): API keys, OAuth/env
      // tokens, federation/profile routing, cloud providers, base URL.
      stripEnv: [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_PROFILE",
        "ANTHROPIC_FEDERATION_RULE_ID",
        "ANTHROPIC_ORGANIZATION_ID",
        "ANTHROPIC_IDENTITY_TOKEN_FILE",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_API_KEY",
      ],
    },
    install: {
      executionEnabled: false,
      methods: [
        {
          kind: "powershell-script",
          summary: "Official Claude Code installer",
          executable: "powershell.exe",
          args: [
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://claude.ai/install.ps1 | iex",
          ],
          documentationUrl: "https://code.claude.com/docs/en/setup",
        },
        {
          kind: "winget",
          summary: "Optional WinGet path",
          executable: "winget",
          args: ["install", "Anthropic.ClaudeCode"],
        },
      ],
    },
    update: {
      executionEnabled: false,
      methods: [
        {
          kind: "self-update",
          summary: "Claude built-in updater",
          executable: "claude",
          args: ["update"],
        },
      ],
    },
    versionProbe: { args: ["--version"] },
    authProbe: {
      args: ["auth", "status", "--json"],
      mode: "READ_ONLY",
      notes:
        "Structured auth status for the injected CLAUDE_CONFIG_DIR. " +
        "Verified 2.1.203: exit 0 + authMethod/apiProvider JSON when " +
        "logged in; exit 1 + loggedIn:false when not.",
    },
    // Verified against claude 2.1.203 (claude <cmd> --help). All commands
    // run with CLAUDE_CONFIG_DIR pointed at the managed profile directory.
    commands: {
      // Claude.ai subscription login: starts the OAuth browser flow and
      // waits on the local callback. Long-running; cancelled via
      // AbortSignal. --claudeai pins the subscription path explicitly.
      login: ["auth", "login", "--claudeai"],
      logout: ["auth", "logout"],
    },
    capabilities: {
      accountLogin: true,
      // claude 2.1.203 has no machine-readable model enumeration — the
      // curated `--model` alias catalog is used instead.
      modelDiscovery: false,
      streaming: true,
      acp: true,
    },
  },
  {
    backendKind: "GROK_RUNTIME",
    runtimeVendor: "XAI",
    supportedAccountProviders: ["XAI"],
    displayName: "Grok CLI",
    binaries: [
      {
        commands: ["grok.exe", "grok.cmd", "grok"],
        knownLocations: [
          "{USERPROFILE}\\.grok\\bin\\grok.exe",
          "{LOCALAPPDATA}\\Grok\\bin\\grok.exe",
        ],
      },
    ],
    profile: {
      strategy: PROFILE_STRATEGIES.PROFILE_DIR_ENV,
      env: {
        GROK_HOME: "$PROFILE_DIR",
        // The leader socket must be per-profile or two managed accounts can
        // attach to the same leader process.
        GROK_LEADER_SOCKET: "$PROFILE_DIR\\grok-leader.sock",
      },
      // GROK_DEPLOYMENT_KEY takes precedence over the profile auth store and
      // would silently bypass ACCOUNT_LOGIN isolation.
      stripEnv: ["GROK_API_KEY", "XAI_API_KEY", "GROK_DEPLOYMENT_KEY"],
    },
    install: {
      executionEnabled: false,
      methods: [
        {
          kind: "powershell-script",
          summary: "Official x.ai Grok CLI installer",
          executable: "powershell.exe",
          args: [
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://x.ai/cli/install.ps1 | iex",
          ],
          documentationUrl: "https://docs.x.ai/build/cli",
        },
      ],
    },
    update: {
      executionEnabled: false,
      methods: [
        {
          kind: "self-update",
          summary: "Grok built-in updater",
          executable: "grok",
          args: ["update"],
        },
      ],
    },
    versionProbe: { args: ["version"] },
    authProbe: {
      args: ["auth", "status"],
      mode: "READ_ONLY",
      notes:
        "Provisional: vendor auth-status surface is not fully confirmed; the " +
        "parser treats unrecognized output as UNKNOWN.",
    },
    capabilities: {
      accountLogin: true,
      modelDiscovery: true,
      acp: true,
    },
  },
  {
    backendKind: "OPENCODE_RUNTIME",
    runtimeVendor: "OPENCODE",
    // OpenCode is a multi-provider runtime: it hosts account logins for
    // OpenAI (ChatGPT OAuth) and GitHub Copilot. OpenCode itself (Zen/Go)
    // is API-key only and is never an ACCOUNT_LOGIN provider.
    supportedAccountProviders: ["OPENAI", "GITHUB_COPILOT"],
    displayName: "OpenCode",
    binaries: [
      {
        commands: ["opencode.exe", "opencode.cmd", "opencode"],
        knownLocations: [
          "{APPDATA}\\npm\\opencode.cmd",
          "{APPDATA}\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
        ],
      },
    ],
    profile: {
      // Verified against opencode 1.18.31 (`opencode debug paths`):
      // auth.json lives under XDG_DATA_HOME\opencode — OPENCODE_CONFIG_DIR
      // alone does NOT isolate credentials. The credential boundary is the
      // four XDG roots, each redirected into the managed profile.
      strategy: PROFILE_STRATEGIES.ISOLATED_ROOTS,
      env: {
        XDG_DATA_HOME: "$PROFILE_DIR\\data",
        XDG_CONFIG_HOME: "$PROFILE_DIR\\config",
        XDG_CACHE_HOME: "$PROFILE_DIR\\cache",
        XDG_STATE_HOME: "$PROFILE_DIR\\state",
        // Config/plugin override only — never the credential boundary.
        OPENCODE_CONFIG_DIR: "$PROFILE_DIR\\config\\opencode",
        // Belt-and-suspenders home redirect so nothing falls back to the
        // real user profile if a future version stops honoring XDG.
        HOME: "$PROFILE_DIR\\home",
        USERPROFILE: "$PROFILE_DIR\\home",
      },
      // Any ambient provider key/token would silently bypass the managed
      // OAuth session — OpenCode reads credential env for every provider.
      stripEnv: [
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "XAI_API_KEY",
        "GROK_API_KEY",
        "OPENROUTER_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GEMINI_API_KEY",
        "GROQ_API_KEY",
        "MISTRAL_API_KEY",
        "DEEPSEEK_API_KEY",
        "AZURE_OPENAI_API_KEY",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "COPILOT_GITHUB_TOKEN",
        "OPENCODE_API_KEY",
      ],
    },
    install: {
      executionEnabled: false,
      methods: [
        {
          kind: "npm-global",
          summary: "Official npm package",
          executable: "npm",
          args: ["install", "-g", "opencode-ai"],
          documentationUrl: "https://opencode.ai/docs/",
        },
      ],
    },
    update: {
      executionEnabled: false,
      methods: [
        {
          kind: "self-update",
          summary: "OpenCode built-in upgrade",
          executable: "opencode",
          args: ["upgrade"],
        },
      ],
    },
    versionProbe: { args: ["--version"] },
    authProbe: {
      args: ["auth", "list"],
      mode: "READ_ONLY",
      notes:
        "Lists credential entries (provider name + auth type label) for " +
        "the injected XDG roots. ANSI-decorated text only — no JSON — so " +
        "the adapter parses it strictly.",
    },
    // Verified against opencode 1.18.31 (`opencode <cmd> --help`). The
    // registry holds vendor-neutral command heads; the adapter appends the
    // account-provider (-p) and method (-m) selectors.
    commands: {
      // `auth login -p <provider> -m "<method label>"` selects the OAuth
      // method non-interactively; it starts a localhost callback and
      // prints the authorize URL. Long-running; cancelled via AbortSignal.
      login: ["auth", "login"],
      logout: ["auth", "logout"],
      models: ["models"],
      run: ["run"],
    },
    capabilities: {
      accountLogin: true,
      modelDiscovery: true,
      streaming: true,
    },
  },
  {
    backendKind: "CURSOR_RUNTIME",
    runtimeVendor: "CURSOR",
    supportedAccountProviders: ["CURSOR"],
    displayName: "Cursor Agent CLI",
    binaries: [
      {
        commands: [
          "agent.exe",
          "agent.cmd",
          "agent",
          "cursor-agent.exe",
          "cursor-agent",
        ],
        knownLocations: [
          "{USERPROFILE}\\.local\\bin\\agent.exe",
          "{LOCALAPPDATA}\\cursor-agent\\bin\\agent.exe",
        ],
      },
    ],
    profile: {
      strategy: PROFILE_STRATEGIES.PROFILE_DIR_ENV,
      env: { CURSOR_CONFIG_DIR: "$PROFILE_DIR" },
      // CURSOR_API_KEY wins over the stored session — strip it so a shell
      // key cannot masquerade as the managed account.
      stripEnv: ["CURSOR_API_KEY"],
    },
    install: {
      executionEnabled: false,
      methods: [
        {
          kind: "powershell-script",
          summary: "Official Cursor CLI installer",
          executable: "powershell.exe",
          args: [
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm 'https://cursor.com/install?win32=true' | iex",
          ],
          documentationUrl: "https://cursor.com/docs/cli/installation",
        },
      ],
    },
    update: {
      executionEnabled: false,
      methods: [
        {
          kind: "self-update",
          summary: "Cursor agent built-in updater",
          executable: "agent",
          args: ["update"],
        },
      ],
    },
    versionProbe: { args: ["--version"] },
    authProbe: {
      args: ["status"],
      mode: "READ_ONLY",
      notes: "Reports agent auth/connection state for the injected config.",
    },
    capabilities: {
      accountLogin: true,
      modelDiscovery: true,
    },
  },
  {
    backendKind: "COPILOT_RUNTIME",
    runtimeVendor: "GITHUB_COPILOT",
    supportedAccountProviders: ["GITHUB_COPILOT"],
    displayName: "GitHub Copilot CLI",
    binaries: [
      {
        commands: ["copilot.exe", "copilot.cmd", "copilot"],
        knownLocations: ["{APPDATA}\\npm\\copilot.cmd"],
      },
    ],
    profile: {
      strategy: PROFILE_STRATEGIES.PROFILE_DIR_ENV,
      env: { COPILOT_HOME: "$PROFILE_DIR" },
      // Any ambient GitHub token overrides the managed account session.
      stripEnv: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    },
    install: {
      executionEnabled: false,
      methods: [
        {
          kind: "winget",
          summary: "Official WinGet package",
          executable: "winget",
          args: ["install", "GitHub.Copilot"],
          documentationUrl:
            "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
        },
        {
          kind: "npm-global",
          summary: "Official npm package",
          executable: "npm",
          args: ["install", "-g", "@github/copilot"],
        },
      ],
    },
    update: {
      executionEnabled: false,
      methods: [
        {
          kind: "self-update",
          summary: "Copilot built-in updater",
          executable: "copilot",
          args: ["update"],
        },
        {
          kind: "winget",
          summary: "WinGet upgrade path",
          executable: "winget",
          args: ["upgrade", "GitHub.Copilot"],
        },
      ],
    },
    versionProbe: { args: ["--version"] },
    authProbe: {
      args: ["auth", "status"],
      mode: "READ_ONLY",
      notes:
        "Provisional: auth-status surface pending vendor confirmation; " +
        "unrecognized output maps to UNKNOWN.",
    },
    capabilities: {
      accountLogin: true,
      modelDiscovery: true,
    },
  },
  {
    backendKind: "DEVIN_RUNTIME",
    runtimeVendor: "DEVIN",
    supportedAccountProviders: ["DEVIN"],
    displayName: "Devin CLI",
    binaries: [
      {
        commands: ["devin.exe", "devin.cmd", "devin"],
        knownLocations: [
          "{LOCALAPPDATA}\\Programs\\Devin\\devin.exe",
          "{USERPROFILE}\\.devin\\bin\\devin.exe",
        ],
      },
    ],
    profile: {
      // WORKABLE_WITH_PROCESS_ENV_ISOLATION: Devin has no official profile
      // primitive, so each connection gets its own APPDATA / XDG roots and
      // HOME plus an explicit --config path. If Devin ships a native profile
      // flag later, this strategy is replaced, not extended.
      strategy: PROFILE_STRATEGIES.ISOLATED_ROOTS,
      env: {
        APPDATA: "$PROFILE_DIR\\appdata",
        XDG_CONFIG_HOME: "$PROFILE_DIR\\xdg-config",
        XDG_DATA_HOME: "$PROFILE_DIR\\xdg-data",
        HOME: "$PROFILE_DIR\\home",
        USERPROFILE: "$PROFILE_DIR\\home",
      },
      stripEnv: ["DEVIN_API_KEY", "DEVIN_TOKEN"],
      invocation: {
        configArgs: ["--config", "$PROFILE_DIR\\config\\devin.toml"],
      },
    },
    install: {
      executionEnabled: false,
      methods: [
        {
          kind: "powershell-script",
          summary: "Official Devin CLI setup script",
          executable: "powershell.exe",
          args: [
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://static.devin.ai/cli/setup.ps1 | iex",
          ],
          documentationUrl: "https://docs.devin.ai/cli",
        },
        {
          kind: "vendor-binary",
          summary: "Standalone updater binary (x86_64)",
          executable: "devin-updater-x86_64-pc-windows.exe",
          args: [],
          downloadUrl:
            "https://static.devin.ai/cli/devin-updater-x86_64-pc-windows.exe",
        },
      ],
    },
    update: {
      executionEnabled: false,
      methods: [
        {
          kind: "self-update",
          summary: "Devin built-in updater",
          executable: "devin",
          args: ["update"],
        },
      ],
    },
    versionProbe: { args: ["--version"] },
    authProbe: {
      args: ["auth", "status"],
      mode: "READ_ONLY",
      notes: "Reports Devin auth state for the isolated config roots.",
    },
    capabilities: {
      accountLogin: true,
      modelDiscovery: true,
    },
  },
]);

const definitionsByBackend = new Map(
  RUNTIME_DEFINITIONS.map((definition) => [definition.backendKind, definition]),
);

function listRuntimeDefinitions() {
  return RUNTIME_DEFINITIONS.slice();
}

function getRuntimeDefinition(backendKind) {
  return definitionsByBackend.get(backendKind) || null;
}

function isRegisteredBackendKind(backendKind) {
  return definitionsByBackend.has(backendKind);
}

// Union of every provider's strip list: a spawned runtime must never see
// another provider's credential overrides either.
function collectSensitiveEnvKeys() {
  const keys = new Set();
  for (const definition of RUNTIME_DEFINITIONS) {
    for (const key of definition.profile.stripEnv || []) keys.add(key);
  }
  return keys;
}

module.exports = {
  PROFILE_STRATEGIES,
  RUNTIME_AUTH_STATES,
  RUNTIME_DEFINITIONS,
  RUNTIME_INSTALL_STATES,
  collectSensitiveEnvKeys,
  getRuntimeDefinition,
  isRegisteredBackendKind,
  listRuntimeDefinitions,
};
