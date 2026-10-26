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
}

interface Window {
  vocatryaResume?: {
    printToPDF(versionId: string): Promise<
      { ok: true; bytes: Uint8Array } |
      { ok: false; code: "timeout" | "load_failed" | "print_failed" | "invalid_version_id" | "untrusted_sender" }
    >;
  };
  vocatryaWindow?: { setTheme(theme: "light" | "dark", preference: "light" | "dark" | "system"): Promise<void> };
  vocatryaRuntime?: VocatryaRuntimeBridge;
  vocatryaAi?: VocatryaAiBridge;
  vocatryaDesktop?: VocatryaDesktopBridge;
}
