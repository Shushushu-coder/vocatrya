/**
 * Phase C/D desktop bridges exposed by desktop/main/preload.js via
 * contextBridge. Present only inside the packaged/dev Electron shell.
 */

interface VocatryaRuntimeBridge {
  list(): Promise<
    {
      backendKind: string;
      runtimeVendor: string;
      supportedAccountProviders: string[];
      displayName: string;
      profileStrategy: string;
      /** Consolidated capability descriptor — see AccountRuntimeCapabilities. */
      capabilities: import("../lib/ai/runtime/capabilities").AccountRuntimeCapabilities;
    }[]
  >;
  detect(backendKind: string): Promise<{
    backendKind: string;
    runtimeVendor: string;
    state: string;
    installed: boolean;
    executablePath?: string;
    version?: string;
    /** Codex only: every discovered binary and the verified list. */
    installs?: {
      path: string;
      source: string;
      version: string | null;
      verified: boolean;
      stale: boolean;
      selected: boolean;
      selectedFor?: string[];
    }[];
    verifiedVersions?: string[];
  }>;
  getVersion(backendKind: string): Promise<{
    backendKind: string;
    installed: boolean;
    version: string | null;
    state: string;
  }>;
  getStatus(
    backendKind: string,
    runtimeProfileRef?: string,
  ): Promise<{
    backendKind: string;
    runtimeVendor: string;
    state: string;
    installed: boolean;
    executablePath?: string;
    version?: string;
    authState: string | null;
  }>;
  getInstallInfo(backendKind: string): Promise<{
    backendKind: string;
    executionEnabled: boolean;
    methods: {
      kind: string;
      summary: string;
      executable: string;
      args: string[];
      documentationUrl?: string;
    }[];
  }>;
  getUpdateInfo(backendKind: string): Promise<{
    backendKind: string;
    executionEnabled: boolean;
    methods: { kind: string; summary: string; executable: string; args: string[] }[];
  }>;
  /**
   * Read-only upstream update check — shared by the automatic mount-time
   * check and the manual recheck. `force: true` bypasses the shared
   * upstream cache; it never installs or updates anything.
   */
  checkUpdate(
    backendKind: string,
    options?: { force?: boolean },
  ): Promise<import("../lib/ai/runtime/update-check").RuntimeUpdateCheckResult>;
  /**
   * Audited update execution. `target` is a fixed enum — "latest" tracks
   * the vendor's newest build, "required" pins the strict capability
   * version (e.g. Codex native-session CLI). No path/args/version string
   * crosses the bridge.
   */
  applyUpdate(
    backendKind: string,
    options?: { target?: "latest" | "required" },
  ): Promise<import("../lib/ai/runtime/update-check").RuntimeApplyUpdateResult>;
}

interface AiConnectionOpConnection {
  id: string;
  provider: string;
  authType: string;
  backendKind: string;
  displayName: string;
  accountIdentity: string | null;
  status: string;
  runtimeProfileRef: string | null;
  lastVerifiedAt: string | null;
  createdAt: string;
}

interface AiConnectionOpFailure {
  ok: false;
  code: string;
  connection?: AiConnectionOpConnection;
}

interface AiConnectionOpSuccess {
  ok: true;
  connection: AiConnectionOpConnection;
  authState?: string;
}

type AiConnectionOpResult = AiConnectionOpSuccess | AiConnectionOpFailure;

interface AiConnectionModelsResult {
  ok: boolean;
  code?: string;
  dynamicDiscoverySupported?: boolean;
  models?: {
    id: string;
    displayName: string;
    source: "RUNTIME" | "CURATED" | "CUSTOM";
    availability: string;
  }[];
}

interface AiConnectionSmokeResult {
  ok: boolean;
  code?: string;
  text?: string;
  expected?: string;
  matched?: boolean;
}

interface VocatryaAiBridge {
  startLogin(input: {
    backendKind: string;
    ticket: string;
  }): Promise<AiConnectionOpResult>;
  cancelOperation(input: {
    ticket?: string;
    connectionId?: string;
  }): Promise<{ ok: boolean; cancelled: boolean }>;
  reconnect(input: {
    connectionId: string;
    ticket: string;
  }): Promise<AiConnectionOpResult>;
  disconnect(input: {
    connectionId: string;
    ticket: string;
  }): Promise<AiConnectionOpResult>;
  verify(input: {
    connectionId: string;
    ticket: string;
  }): Promise<AiConnectionOpResult>;
  listModels(input: {
    connectionId: string;
    ticket: string;
  }): Promise<AiConnectionModelsResult>;
  runSmoke(input: {
    connectionId: string;
    ticket: string;
    model?: string;
  }): Promise<AiConnectionSmokeResult>;
  /**
   * Fires while a login op runs when the runtime cannot open a browser
   * itself (e.g. OpenCode). The URL is the vendor's official authorize
   * entry point. Returns an unsubscribe function.
   */
  onOAuthUrl(callback: (url: string) => void): () => void;
}

/**
 * Device-level lifecycle surface exposed by desktop/main/preload.js as
 * window.vocatryaDesktop. Every read and every write resolves to the main
 * process's authoritative snapshot: closeToTray/startMinimized come from the
 * app-owned device settings document, openAtLogin is verified against the
 * OS login item, and the *Active/*Available flags report what is actually
 * in effect right now.
 */
interface VocatryaDesktopLifecycleState {
  closeToTray: boolean;
  /** closeToTray only intercepts the close button while a tray exists. */
  closeToTrayActive: boolean;
  startMinimized: boolean;
  openAtLogin: boolean;
  /** False on platforms with no login-item support — the toggle is inert. */
  openAtLoginSupported: boolean;
  /** Non-null when the OS login-item state could not be read. */
  openAtLoginError: string | null;
  trayAvailable: boolean;
}

/**
 * Device keybinding surface carried on the same vocatryaDesktop bridge.
 * Combos are canonical "Mod/Alt/Shift+Key" strings shared with
 * src/lib/shortcuts/combos.ts; null clears a window binding.
 */
type WindowShortcutActionId =
  | "toggleSidebar"
  | "historyBack"
  | "historyForward"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset";

interface VocatryaShortcutState {
  window: Record<WindowShortcutActionId, string | null>;
  global: {
    enabled: boolean;
    combo: string;
    /** Live OS registration status — never optimistic. */
    registered: boolean;
    /** Last registration failure code ("occupied") or null. */
    error: string | null;
  };
}

type VocatryaShortcutWriteResult =
  | { ok: true; state: VocatryaShortcutState }
  | {
      ok: false;
      code: "conflict" | "invalid" | "occupied" | "unsupported";
      conflictingAction?: string;
      /** Present when the refusal still carries authoritative state (rollback). */
      state?: VocatryaShortcutState;
    };

interface VocatryaDesktopBridge {
  getState(): Promise<VocatryaDesktopLifecycleState>;
  /** Resolve to the post-write authoritative state. */
  setCloseToTray(enabled: boolean): Promise<VocatryaDesktopLifecycleState>;
  setStartMinimized(enabled: boolean): Promise<VocatryaDesktopLifecycleState>;
  /**
   * Resolves to the verified post-write state; rejects when the OS write
   * does not take effect or login items are unsupported on this platform.
   */
  setOpenAtLogin(enabled: boolean): Promise<VocatryaDesktopLifecycleState>;
  showWindow(): Promise<void>;
  quit(): Promise<void>;
  getShortcutState(): Promise<VocatryaShortcutState>;
  setWindowShortcut(input: {
    action: WindowShortcutActionId;
    combo: string | null;
  }): Promise<VocatryaShortcutWriteResult>;
  setGlobalShortcut(input: {
    enabled?: boolean;
    combo?: string;
  }): Promise<VocatryaShortcutWriteResult>;
  /** Drop the OS hotkey registration without changing the saved enabled flag. */
  suspendGlobalShortcut(): Promise<void>;
  resumeGlobalShortcut(): Promise<void>;
  getZoomFactor(): Promise<number>;
  adjustZoom(direction: "in" | "out" | "reset"): Promise<number>;
  onZoomFactor(callback: (factor: number) => void): () => void;
}

interface Window {
  vocatryaInputPreferences?: {
    read(): string | null;
    write(raw: string): string;
  };
  vocatryaAgentSlots?: {
    /**
     * Account-scoped role slots in the desktop config directory. `read`
     * returns that user's JSON snapshot, or null when none is stored.
     * `write` rejects a stale generation without replacing the snapshot.
     */
    read(userId: string): string | null;
    write(
      userId: string,
      raw: string,
    ): { ok: true } | { ok: false; code: "stale" | "invalid" | "unavailable" };
  };
  vocatryaResume?: {
    printToPDF(versionId: string): Promise<
      { ok: true; bytes: Uint8Array } |
      { ok: false; code: "timeout" | "load_failed" | "print_failed" | "invalid_version_id" | "untrusted_sender" }
    >;
    /**
     * Resume preview pane preference snapshot ({hidden, width}) held in the
     * app-owned device config file — survives the backend's ephemeral port.
     * `read` returns the stored snapshot string or null; `write` persists a
     * validated snapshot and returns it. Both throw when storage fails.
     */
    readPreviewPreferences(): string | null;
    writePreviewPreferences(raw: string): string;
  };
  vocatryaWindow?: { setTheme(theme: "light" | "dark", preference: "light" | "dark" | "system"): Promise<void> };
  vocatryaRuntime?: VocatryaRuntimeBridge;
  vocatryaAi?: VocatryaAiBridge;
  vocatryaDesktop?: VocatryaDesktopBridge;
}
