// Phase C runtime definition registry — the single source of truth for the
// ACCOUNT_LOGIN runtimes. Definitions are structured data
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
      // env keys whose redirect constitutes the credential boundary —
      // auth material can only persist where these point. Primary first.
      credentialBoundary: ["CODEX_HOME"],
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
      // Upstream latest-version source: the official npm package's
      // `latest` dist-tag (registry.npmjs.org/@openai%2Fcodex/latest).
      check: { kind: "npm-latest", package: "@openai/codex" },
      // Real downgrade path for npm-global installs: pin the certified
      // version back. Standalone-installer users re-run the installer
      // once a certified build is promoted — the command is honest
      // metadata, never executed here.
      recovery: { kind: "npm-pin", package: "@openai/codex" },
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
      credentialBoundary: ["CLAUDE_CONFIG_DIR"],
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
      // Upstream latest-version source: the official npm package's
      // `latest` dist-tag (registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest).
      check: { kind: "npm-latest", package: "@anthropic-ai/claude-code" },
      recovery: { kind: "npm-pin", package: "@anthropic-ai/claude-code" },
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
        // Verified on grok 1.0.34/1.0.41: trusted_folders.toml, the
        // Claude/Cursor compatibility scanners (skills, hooks, MCP config —
        // e.g. ~/.claude.json), and the project-discovery home boundary all
        // resolve through ~ (HOME/USERPROFILE), NOT GROK_HOME. Redirecting
        // home — including the %APPDATA%/%LOCALAPPDATA% data roots — into
        // the managed profile is what actually stops foreign MCP servers/
        // hooks and host project trust from leaking into managed sessions.
        // HOMEDRIVE/HOMEPATH are stripped (not settable per-drive) so ~
        // resolution can only fall back to USERPROFILE.
        HOME: "$PROFILE_DIR\\home",
        USERPROFILE: "$PROFILE_DIR\\home",
        APPDATA: "$PROFILE_DIR\\home\\AppData\\Roaming",
        LOCALAPPDATA: "$PROFILE_DIR\\home\\AppData\\Local",
      },
      // auth.json lives under GROK_HOME; the compat scanners and folder
      // trust resolve through the redirected home roots, so both halves of
      // the boundary are listed.
      credentialBoundary: [
        "GROK_HOME",
        "USERPROFILE",
        "HOME",
        "APPDATA",
        "LOCALAPPDATA",
      ],
      // Every documented env route that could override authentication,
      // redirect endpoints, inject config, or widen the tool surface inside
      // a managed profile (grok 1.0.34 config-reference). The base env is
      // already allowlist-built so most of these never arrive; the list
      // documents intent and guards future allowlist growth.
      stripEnv: [
        // Credential / auth-method overrides.
        "XAI_API_KEY",
        "GROK_API_KEY",
        "GROK_DEPLOYMENT_KEY",
        "GROK_AUTH_PROVIDER_COMMAND",
        "GROK_AUTH_PROVIDER_LABEL",
        "GROK_AUTH_TOKEN_TTL",
        "GROK_AUTH_EXPIRED",
        "GROK_AUTH_EARLY_INVALIDATION_SECS",
        "GROK_OIDC_ISSUER",
        "GROK_OIDC_CLIENT_ID",
        "GROK_OIDC_AUDIENCE",
        "GROK_OIDC_SCOPES",
        "GROK_OAUTH2_CLIENT_ID",
        "GROK_OAUTH2_ISSUER",
        "GROK_OAUTH2_PRINCIPAL_ID",
        "GROK_OAUTH2_PRINCIPAL_TYPE",
        "GROK_OAUTH2_REFERRER",
        "GROK_OAUTH2_SCOPES",
        "GROK_DISABLE_API_KEY_AUTH",
        "GROK_FORCE_LOGIN_TEAM_ID",
        // Endpoint / relay / managed-config redirects.
        "GROK_CLI_CHAT_PROXY_BASE_URL",
        "GROK_MODELS_BASE_URL",
        "GROK_MODELS_LIST_URL",
        "GROK_XAI_API_BASE_URL",
        "GROK_WS_ORIGIN",
        "GROK_WS_URL",
        "GROK_MANAGED_CONFIG_URL",
        "GROK_FEEDBACK_BASE_URL",
        "GROK_WEB_FETCH_PROXY",
        "GROK_TRACE_UPLOAD_URL",
        "GROK_TRACE_UPLOAD_BUCKET",
        "GROK_TRACE_UPLOAD_CREDENTIALS_FILE",
        "GROK_TRACE_UPLOAD_ENDPOINT_URL",
        "GROK_TRACE_UPLOAD_REGION",
        "GROK_EXTERNAL_OTEL",
        // Config injection (JSON inline or file path — can carry
        // auth_provider_command, custom endpoints, per-model keys).
        "GROK_CONFIG",
        "GROK_CONFIG_PATH",
        // Home-resolution fallbacks — stripped so ~ can only resolve through
        // the redirected USERPROFILE/HOME inside the managed profile.
        "HOMEDRIVE",
        "HOMEPATH",
        // Compatibility scanners — an env toggle would beat the managed
        // config.toml compat cells (env layer wins over user config).
        "GROK_CLAUDE_AGENTS_ENABLED",
        "GROK_CLAUDE_HOOKS_ENABLED",
        "GROK_CLAUDE_MCPS_ENABLED",
        "GROK_CLAUDE_RULES_ENABLED",
        "GROK_CLAUDE_SKILLS_ENABLED",
        "GROK_CURSOR_AGENTS_ENABLED",
        "GROK_CURSOR_HOOKS_ENABLED",
        "GROK_CURSOR_MCPS_ENABLED",
        "GROK_CURSOR_RULES_ENABLED",
        "GROK_CURSOR_SKILLS_ENABLED",
        // Tool/agent surface and behaviour overrides.
        "GROK_AGENT",
        "GROK_SANDBOX",
        "GROK_SANDBOX_AUTO_ALLOW_BASH",
        "GROK_DEFAULT_MODEL",
        "GROK_DEFAULT_SELECTED_PERMISSION",
        "GROK_REMEMBER_TOOL_APPROVALS",
        "GROK_SUBAGENTS",
        "GROK_SUBAGENT_MODEL_INHERITANCE",
        "GROK_SUBAGENT_WORKTREE_SNAPSHOT",
        "GROK_ASK_USER_QUESTION",
        "GROK_WRITE_FILE",
        "GROK_WEB_FETCH",
        "GROK_BACKEND_SEARCH",
        "GROK_LSP_TOOLS",
        "GROK_ZDR_ACCESS_ENABLED",
        "GROK_DISABLE_ZDR_INCOMPATIBLE_TOOLS",
        "GROK_MANAGED_MCPS_ENABLED",
        "GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED",
        "GROK_MCP_AUTO_RESTART",
        "GROK_MCP_PUSH_SERVER_STATUS",
        "GROK_MEMORY",
        "GROK_AUTO_WAKE",
        "GROK_ACTIVE_AGENT_MESSAGES",
        "GROK_RESPECT_GITIGNORE",
        // Runtime management channels.
        "GROK_DISABLE_AUTOUPDATER",
        "GROK_MAXIMUM_VERSION",
        "GROK_MINIMUM_VERSION",
        "GROK_REQUIRED_MAXIMUM_VERSION",
        "GROK_REQUIRED_MINIMUM_VERSION",
        "GROK_GROVE",
        "GROK_CLONE",
        "GROVE_CLONE",
        "GROVE_AUTH_TOKEN",
        "GROK_WORKTREE_TYPE",
        "GROK_CAMPAIGNS",
        "GROK_MARKETPLACE_REQUIRE_SHA",
        "GROK_DEBUG_LOG",
        "GROK_LOG_FILE",
        "GROK_HOOKS_LOG",
        "GROK_LEADER_LOG",
        "GROK_LOG_SAMPLING",
        "GROK_INSTRUMENTATION",
        "GROK_CRASH_HANDLER",
      ],
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
      // Upstream latest-version source: the vendor channel pointer —
      // a plain-text document naming the promoted build (verified
      // 2026-10-28 → "1.0.70"). x.ai fronts a GCS bucket; the direct
      // bucket URL is the documented fallback from install.ps1.
      check: {
        kind: "channel-file",
        channel: "stable",
        urls: [
          "https://x.ai/cli/stable",
          "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable",
        ],
      },
      // install.ps1 accepts -Version, so a pinned reinstall is a real
      // downgrade path (usage line verified in the published script).
      recovery: {
        kind: "script-version-arg",
        command:
          "& ([scriptblock]::Create((irm https://x.ai/cli/install.ps1))) -Version {version}",
      },
    },
    versionProbe: { args: ["version"] },
    // Verified against grok 1.0.34/1.0.41, re-verified on 1.0.92: there is
    // NO `login status` / `auth status` / `whoami` command. Auth state is
    // probed over ACP — `grok agent --no-leader stdio` advertises a
    // `cached_token` auth method only when a session exists in the
    // profile's auth.json, and authenticate(cached_token) returns account
    // metadata (email, auth_mode "Oidc", subscription_tier). Handled by
    // the grok adapter's ACP probe, not by a one-shot command.
    authProbe: {
      kind: "ACP_STDIO",
      args: ["agent", "--no-leader", "stdio"],
      mode: "READ_ONLY",
      notes:
        "ACP initialize + authenticate(cached_token) handshake. initialize " +
        "never authenticates; cached_token is advertised only when the " +
        "managed profile already holds a session.",
    },
    // Verified against grok 1.0.34/1.0.41, re-verified on 1.0.92 (grok
    // <cmd> --help). All commands run with GROK_HOME pointed at the
    // managed profile directory.
    commands: {
      // Browser OAuth via auth.x.ai. Long-running: binds a 127.0.0.1
      // callback listener, prints the authorize URL on stderr ("Open this
      // URL to sign in:"), and exits when the flow completes. Cancelled
      // via AbortSignal. On 1.0.92 --oauth still forces this loopback
      // flow (plain `grok login` now defaults to device-code).
      login: ["login", "--oauth"],
      logout: ["logout"],
      // `grok models` prints the account-visible catalog ("Available
      // models:" + "* id (default)" / "- id" lines). When unauthenticated
      // it prints "You are not authenticated." and only the bundled list —
      // the adapter treats that as discovery-unavailable, not a catalog.
      models: ["models"],
      // One-shot headless inference; the adapter appends the safety flags.
      print: ["-p"],
    },
    capabilities: {
      accountLogin: true,
      modelDiscovery: true,
      streaming: true,
      acp: true,
    },
  },
  {
    backendKind: "OPENCODE_RUNTIME",
    runtimeVendor: "OPENCODE",
    // OpenCode is its own account ecosystem: OpenCode Zen (pay-as-you-go
    // gateway, auth.json "opencode" entry) and OpenCode Go (flat-rate
    // subscription, auth.json "opencode-go" entry). Both authenticate via
    // the vendor's own `auth login` API-key credential — never via
    // ChatGPT/OAuth hosting semantics. GITHUB_COPILOT stays a declared-
    // but-unimplemented entry (the adapter refuses it this phase).
    supportedAccountProviders: ["OPENCODE_ZEN", "OPENCODE_GO", "GITHUB_COPILOT"],
    displayName: "OpenCode",
    binaries: [
      {
        commands: ["opencode.exe", "opencode.cmd", "opencode"],
        knownLocations: [
          // npm global install: the PATH shims (opencode / opencode.cmd)
          // are not spawnable with shell:false — prefer the real vendored
          // binary inside the platform package.
          "{APPDATA}\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
          "{APPDATA}\\npm\\opencode.cmd",
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
      // auth.json lives at $XDG_DATA_HOME\opencode — the four XDG roots
      // are the credential boundary; the home redirects guard fallback
      // resolution paths.
      credentialBoundary: [
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "HOME",
        "USERPROFILE",
      ],
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
      // Upstream latest-version source: the official npm package's
      // `latest` dist-tag (registry.npmjs.org/opencode-ai/latest).
      check: { kind: "npm-latest", package: "opencode-ai" },
      recovery: { kind: "npm-pin", package: "opencode-ai" },
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
    // account-provider (-p) selector.
    commands: {
      // `auth login -p <opencode|opencode-go>` opens the vendor's
      // interactive credential TUI (API-key entry for Zen/Go). It reads
      // console input — the adapter launches it inside a real console
      // window like the Devin login. Long-running; cancelled via
      // AbortSignal.
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
          "cursor-agent.cmd",
          "cursor-agent.exe",
          "cursor-agent",
          "agent.cmd",
          "agent.exe",
          "agent",
        ],
        knownLocations: [
          "{LOCALAPPDATA}\\cursor-agent\\agent.cmd",
          "{LOCALAPPDATA}\\cursor-agent\\cursor-agent.cmd",
          "{USERPROFILE}\\.local\\bin\\agent.exe",
        ],
      },
    ],
    // cursor-agent installs as a versioned Node bundle: the PATH shims
    // (agent.cmd / cursor-agent.cmd / agent.ps1) all dispatch into
    // %LOCALAPPDATA%\cursor-agent\versions\<YYYY.MM.DD-sha>\node.exe
    // index.js. `shell:false` cannot spawn .cmd shims, so the spawned
    // executable is the bundle's node.exe with index.js prepended to
    // argv. The version dir also anchors identity — a PATH `agent` that
    // resolves elsewhere (e.g. Grok's agent.exe) is not this runtime.
    bundle: {
      kind: "node-versions",
      versionsDir: "{LOCALAPPDATA}\\cursor-agent\\versions",
      interpreter: "node.exe",
      entrypoint: "index.js",
      versionDirPattern: "^\\d{4}\\.\\d{2}\\.\\d{2}-",
    },
    profile: {
      // Auth isolation boundary (probed against cursor-agent
      // 2026.09.18-9a7762b on win32): credentials persist in
      // %APPDATA%\Cursor\auth.json — NOT under CURSOR_CONFIG_DIR, which
      // only covers cli-config.json / statsig-cache / mcp-auth.json.
      // User-level MCP (~/.cursor/mcp.json) and homedir fallbacks resolve
      // via USERPROFILE/HOME. XDG roots redirect defensively for
      // cross-platform code paths.
      strategy: PROFILE_STRATEGIES.ISOLATED_ROOTS,
      env: {
        CURSOR_CONFIG_DIR: "$PROFILE_DIR\\config",
        APPDATA: "$PROFILE_DIR\\appdata",
        LOCALAPPDATA: "$PROFILE_DIR\\localappdata",
        HOME: "$PROFILE_DIR\\home",
        USERPROFILE: "$PROFILE_DIR\\home",
        XDG_CONFIG_HOME: "$PROFILE_DIR\\xdg-config",
        XDG_DATA_HOME: "$PROFILE_DIR\\xdg-data",
        XDG_CACHE_HOME: "$PROFILE_DIR\\xdg-cache",
        XDG_STATE_HOME: "$PROFILE_DIR\\xdg-state",
      },
      // auth.json persists under the redirected APPDATA — that is the
      // credential boundary. CURSOR_CONFIG_DIR covers config only; the
      // home/XDG roots are defensive redirects that keep ~/.cursor and
      // cross-platform fallbacks out of the real profile.
      credentialBoundary: [
        "APPDATA",
        "CURSOR_CONFIG_DIR",
        "USERPROFILE",
        "HOME",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
      ],
      stripEnv: [
        // Credential overrides — these bypass the browser session and
        // would let a managed child authenticate with the host's key.
        "CURSOR_API_KEY",
        "CURSOR_AUTH_TOKEN",
        "CURSOR_LOCAL_AGENT_API_KEY",
        "CURSOR_LOCAL_AGENT_API_KEY_HELPER",
        "CURSOR_LOCAL_AGENT_API_KEY_HELPER_TTL_MS",
        // Endpoint/website overrides — ACCOUNT_LOGIN pins official
        // production routing; a host override must not redirect auth.
        "CURSOR_API_ENDPOINT",
        "CURSOR_API_BASE_URL",
        "CURSOR_API_URL",
        "CURSOR_WEBSITE_URL",
        "CURSOR_LOCAL_AGENT_BASE_URL",
        "CURSOR_AGENT_ENDPOINT",
        // Bedrock / authless paths replace Cursor account auth.
        "CURSOR_ENABLE_BEDROCK",
        "CURSOR_ENABLE_LOCAL_BEDROCK",
        "CURSOR_BEDROCK_AWS_AUTH_REFRESH",
        "CURSOR_BEDROCK_BASE_URL",
        "CURSOR_BEDROCK_DEFAULT_MODEL",
        "CURSOR_BEDROCK_REGION",
        "CURSOR_ENABLE_AUTHLESS",
        "CURSOR_AGENT_CLI_AUTHLESS_MODE",
        "CURSOR_AGENT_CLI_LOCAL_MODE",
        // Managed-policy / credential-store / update overrides.
        "CURSOR_MDM_SIGN_IN_POLICY_JSON",
        "AGENT_CLI_CREDENTIAL_STORE",
        "AGENT_CLI_UPDATE_CHECK_URL",
        // Behavioral/session overrides that could leak host state or
        // change execution routing inside a managed profile.
        "CURSOR_SANDBOX",
        "CURSOR_MODEL",
        "CURSOR_STATSIG_OVERRIDES",
        "CURSOR_AGENT_STORE",
        "CURSOR_AGENT_STORE_FILES_DIR",
        "CURSOR_AGENT_STORE_SHARED_PATHS",
        "CURSOR_AGENT_SOCKET",
        "CURSOR_AGENT_PERSIST_SESSION",
        "CURSOR_AGENT_TMUX_PATH",
        "CURSOR_AGENT_TMUX_SERVER_NAME",
        "CURSOR_AGENT_DEBUG_PORT",
        "CURSOR_AGENT_OOM_HEAPDUMP",
        "CURSOR_AGENT_WORKER_ID",
        "CURSOR_ASKPASS",
        "CURSOR_ASKPASS_SECRET",
        "CURSOR_ASKPASS_SOCKET",
        "CURSOR_LOCAL_AGENT_ALLOW_CURSOR_HOST",
        "CURSOR_LOCAL_AGENT_MAX_RETRIES",
        "CURSOR_PRIVACY_MODE",
        "CURSOR_REQUEST_ID",
        "CURSOR_BC_ID",
        "CURSOR_GROUP",
        "CURSOR_PERSONAL",
        "CURSOR_PROJECT",
        "CURSOR_POOL",
        "CURSOR_REPO_READ_ONLY_TOKEN",
        "CURSOR_WORKER_ID",
        "CURSOR_WAKE",
        "CURSOR_WAKE_TIMEOUT_MS",
        "CURSOR_RIPGREP_PATH",
        "CURSOR_PLUGIN_ROOT",
        "CURSOR_DATA_DIR",
        "CURSOR_WORKTREES_ROOT",
        "CURSOR_STATE_INPUT_FILE",
        "CURSOR_STATE_OUTPUT_FILE",
        "CURSOR_CONVERSATION_ID",
        "CURSOR_USER_EMAIL",
        "CURSOR_IDENTITY_UNAVAILABLE",
        "CURSOR_INVOKED_AS",
        // ~ fallbacks that could point a managed child at the real
        // profile roots.
        "HOMEDRIVE",
        "HOMEPATH",
      ],
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
      // Upstream latest-version source: the official Windows install
      // script is generated per release and pins the published build
      // (`$version = '2026.10.22-27dcf5f'`) — the same document the
      // install method pipes into iex.
      check: {
        kind: "install-script",
        url: "https://cursor.com/install?win32=true",
      },
      // No documented pinned-version Windows installer — honest absence
      // of a scripted downgrade path.
      recovery: { kind: "none" },
    },
    versionProbe: {
      args: ["--version"],
      notes:
        "`agent --version` prints e.g. `2026.09.18-9a7762b` (the bundle " +
        "node.exe gets index.js prepended before this flag).",
    },
    authProbe: {
      args: ["status", "--format", "json"],
      mode: "READ_ONLY",
      notes:
        "`agent status --format json` emits {status, isAuthenticated, " +
        "hasAccessToken, hasRefreshToken, message, userInfo?}; it reads " +
        "only the persisted credential store — ambient CURSOR_API_KEY/" +
        "CURSOR_AUTH_TOKEN do not move it, but they are still stripped " +
        "so inference cannot bypass the account session.",
    },
    capabilities: {
      accountLogin: true,
      modelDiscovery: true,
      streaming: true,
      acp: true,
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
      credentialBoundary: ["COPILOT_HOME"],
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
      // Upstream latest-version source: the official npm package's
      // `latest` dist-tag (registry.npmjs.org/@github%2Fcopilot/latest).
      check: { kind: "npm-latest", package: "@github/copilot" },
      recovery: { kind: "npm-pin", package: "@github/copilot" },
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
          // Verified on devin 3000.10.31: the official Windows install is a
          // versioned bundle under %LOCALAPPDATA%\devin\cli — bin\devin.exe
          // is a real PE executable, directly spawnable with shell:false.
          "{LOCALAPPDATA}\\devin\\cli\\bin\\devin.exe",
        ],
      },
    ],
    profile: {
      // Verified against devin 3000.10.31 on win32: credentials persist at
      // %USERPROFILE%\AppData\Roaming\devin\credentials.toml — resolved via
      // USERPROFILE, NOT the APPDATA/XDG_* env vars (redirecting APPDATA
      // alone leaves the CLI on the real profile). The CLI canonicalizes
      // <USERPROFILE>\AppData\Roaming and <USERPROFILE>\AppData\Local at
      // startup and fails closed if they do not exist, so the adapter
      // materializes that skeleton before every spawn. HOME and the XDG
      // roots are redirected too so no other home resolution can fall back
      // to the real profile. The --config flag only relocates config.json —
      // it does NOT move credentials, so it is not part of the boundary.
      strategy: PROFILE_STRATEGIES.ISOLATED_ROOTS,
      env: {
        USERPROFILE: "$PROFILE_DIR\\home",
        HOME: "$PROFILE_DIR\\home",
        APPDATA: "$PROFILE_DIR\\home\\AppData\\Roaming",
        LOCALAPPDATA: "$PROFILE_DIR\\home\\AppData\\Local",
        XDG_CONFIG_HOME: "$PROFILE_DIR\\xdg-config",
        XDG_DATA_HOME: "$PROFILE_DIR\\xdg-data",
        XDG_CACHE_HOME: "$PROFILE_DIR\\xdg-cache",
        XDG_STATE_HOME: "$PROFILE_DIR\\xdg-state",
      },
      // credentials.toml resolves through USERPROFILE — the credential
      // boundary. HOME/APPDATA/LOCALAPPDATA/XDG_* are defensive isolation
      // roots (still redirected via profile.env) but are not
      // credential-bearing, which is what makes the browser-login
      // passthrough below safe.
      credentialBoundary: ["USERPROFILE"],
      // Browser-facing login only: the CLI opens the default browser via
      // ShellExecute, and the spawned browser resolves its user-data dir
      // from %APPDATA%/%LOCALAPPDATA%. These host roots are restored for
      // the login process so the browser keeps the user's existing session;
      // USERPROFILE — the credentials.toml boundary — stays managed.
      browserLoginEnvPassthrough: ["APPDATA", "LOCALAPPDATA"],
      // Every env route that could override authentication, redirect the
      // backend, or change the auth method inside a managed profile. The
      // base env is allowlist-built so most never arrive; the list
      // documents intent and guards future allowlist growth.
      stripEnv: [
        // Credential / auth-method overrides — WINDSURF_API_KEY is a real
        // credential input for `devin acp` (verified in the bundled
        // commands reference) and would bypass the account session.
        "DEVIN_API_KEY",
        "DEVIN_TOKEN",
        "DEVIN_ACCESS_TOKEN",
        "DEVIN_PAT",
        "WINDSURF_API_KEY",
        "WINDSURF_TOKEN",
        "COGNITION_API_KEY",
        "COGNITION_TOKEN",
        // Endpoint / backend / credential-policy redirects.
        "DEVIN_API_URL",
        "DEVIN_API_BASE_URL",
        "DEVIN_WEBAPP_HOST",
        "DEVIN_BACKEND",
        "DEVIN_ACP_BACKEND",
        "ACP_BACKEND",
        // Session/behavior overrides — a managed profile pins its own
        // permission mode and never inherits an ambient model/sandbox.
        "DEVIN_MODEL",
        "DEVIN_PERMISSION_MODE",
        "DEVIN_SANDBOX",
        "DEVIN_PLUGIN_DISCOVERY",
        "DEVIN_HAH",
        "DEVIN_SAH",
        // ~ fallbacks that could point a managed child at the real
        // profile roots (USERPROFILE is the credential boundary).
        "HOMEDRIVE",
        "HOMEPATH",
      ],
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
      // Upstream latest-version source: the promoted-build manifest the
      // official setup.ps1 itself reads (verified 2026-10-28 →
      // {"version":"3000.11.228", platforms:{…}}).
      check: {
        kind: "json-manifest",
        url: "https://static.devin.ai/cli/current/manifest.json",
        field: "version",
      },
      // The build system publishes per-version setup scripts
      // (cli/<version>/setup.ps1 per the published setup template), so a
      // pinned reinstall is a real downgrade path.
      recovery: {
        kind: "pinned-setup",
        command: "irm https://static.devin.ai/cli/{version}/setup.ps1 | iex",
      },
    },
    versionProbe: { args: ["--version"] },
    authProbe: {
      args: ["auth", "status"],
      mode: "READ_ONLY",
      // Verified on devin 3000.10.31: prints "Logged in (via Devin)." plus
      // User/Account blocks (email, user id, tier, team) when an account
      // session exists, or "Not logged in." with the credentials path when
      // not. Token/API-key logins print a different "(via ...)" method.
      notes:
        "Reads Devin CLI auth state for the redirected USERPROFILE. The " +
        "(via <method>) suffix is the auth-method classification surface; " +
        "only 'via Devin' (account login) may complete ACCOUNT_LOGIN.",
    },
    // Verified against devin 3000.10.31 (devin <cmd> --help). All commands
    // run with USERPROFILE pointed at the managed profile home.
    commands: {
      // `devin auth login` opens an interactive TUI menu (browser / manual
      // token / enterprise). It cannot be driven over pipes — the adapter
      // launches it inside a real console window and the CLI owns the
      // browser flow entirely. Long-running; cancelled via AbortSignal.
      login: ["auth", "login"],
      logout: ["auth", "logout"],
      status: ["auth", "status"],
      // `models list --format json` prints the account-visible catalog as
      // {families:[{slug,label,variants:[{model_uid,label,...}]}]}.
      models: ["models", "list", "--format", "json"],
      // One-shot headless inference; the adapter appends the safety flags.
      print: ["-p"],
      // Read-only account/org metadata used to pin devin.org_id so -p does
      // not hit the interactive organization picker.
      orgInfo: ["cloud", "drs", "whoami"],
    },
    capabilities: {
      accountLogin: true,
      modelDiscovery: true,
      streaming: true,
      acp: true,
    },
  },
  {
    backendKind: "ANTIGRAVITY_RUNTIME",
    runtimeVendor: "ANTIGRAVITY",
    supportedAccountProviders: ["ANTIGRAVITY"],
    displayName: "Antigravity CLI",
    binaries: [
      {
        commands: ["agy.exe", "agy.cmd", "agy"],
        knownLocations: ["{LOCALAPPDATA}\\agy\\bin\\agy.exe"],
      },
    ],
    profile: {
      // Verified on agy 1.5.14: USERPROFILE redirection moves ~\\.gemini
      // (state, logs, cache) into the managed home, but the OAuth token is
      // a Windows Credential Manager entry (`gemini:antigravity`) — the
      // keyring is per Windows user and no env redirect can cover it, so
      // multiAccountIsolation stays false.
      strategy: PROFILE_STRATEGIES.ISOLATED_ROOTS,
      env: {
        USERPROFILE: "$PROFILE_DIR\\home",
        HOME: "$PROFILE_DIR\\home",
        APPDATA: "$PROFILE_DIR\\home\\AppData\\Roaming",
        LOCALAPPDATA: "$PROFILE_DIR\\home\\AppData\\Local",
        XDG_CONFIG_HOME: "$PROFILE_DIR\\xdg-config",
        XDG_DATA_HOME: "$PROFILE_DIR\\xdg-data",
        XDG_CACHE_HOME: "$PROFILE_DIR\\xdg-cache",
        XDG_STATE_HOME: "$PROFILE_DIR\\xdg-state",
      },
      credentialBoundary: ["USERPROFILE", "HOME"],
      // Browser-facing login only: `acp --login` may hand its OAuth URL to
      // the system browser, and Chrome/Edge resolve the user-data dir from
      // %LOCALAPPDATA%/%APPDATA% — redirected roots would launch a fresh
      // unsigned browser profile. Restoring those roots for the login
      // process keeps the browser on the user's signed-in profile. The
      // credential lands in the OS keyring regardless of env, so nothing
      // credential-bearing is exposed; USERPROFILE/HOME stay managed.
      browserLoginEnvPassthrough: ["APPDATA", "LOCALAPPDATA"],
      stripEnv: [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENAI_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "AGY_ADC_AUTH",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_GENAI_USE_ENTERPRISE",
        "HOMEDRIVE",
        "HOMEPATH",
      ],
    },
    install: {
      executionEnabled: false,
      methods: [
        {
          kind: "powershell-script",
          summary: "Official Antigravity CLI install script",
          executable: "powershell.exe",
          args: [
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://antigravity.google/cli/install.ps1 | iex",
          ],
          documentationUrl: "https://antigravity.google/docs/cli/install/",
        },
      ],
    },
    update: {
      executionEnabled: false,
      methods: [
        {
          kind: "self-update",
          summary: "Antigravity CLI updater",
          executable: "agy",
          args: ["update"],
        },
      ],
    },
    versionProbe: { args: ["--version"] },
    // Verified on agy 1.5.14: `agy acp` is an ACP stdio server. initialize
    // advertises fixed authMethods (oauth-personal/oauth-business/
    // gemini-api-key/agent-platform); authenticate(oauth-personal) returns
    // the account tier immediately when the keyring holds a personal
    // Google credential, and launches an interactive OAuth loopback
    // browser that blocks when it does not — handled by the adapter's ACP
    // probe, which bounds the exchange and fails closed.
    authProbe: {
      kind: "ACP_STDIO",
      args: ["acp"],
      mode: "READ_ONLY",
      notes:
        "ACP initialize + authenticate(oauth-personal). Method-pinned: " +
        "only a personal Google OAuth session satisfies the method.",
    },
    commands: {
      // Prints the accounts.google.com OAuth URL on stdout and reads the
      // pasted authorization code (or full landing URL) from stdin; exits
      // 1 on EOF ("login cancelled"). Long-running interactive console.
      login: ["acp", "--login"],
      // No headless logout exists. See antigravity.js.
      logout: ["--version"],
      // `agy models` prints the model table regardless of sign-in — the
      // adapter never treats it as a catalog or an auth signal.
      models: ["models"],
      // --print is a VALUE flag on 1.5.14; the stdin prompt channel is
      // `--print=` + stream-json in/out (see antigravity.js).
      print: ["--print="],
    },
    capabilities: {
      accountLogin: true,
      modelDiscovery: false,
      // File-home redirect is not keyring isolation.
      multiAccountIsolation: false,
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
