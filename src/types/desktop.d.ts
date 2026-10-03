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
  getCapabilities(backendKind: string): Promise<
    import("../lib/ai/runtime/capabilities").AccountRuntimeCapabilities
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

interface Window {
  vocatryaWindow?: { setTheme(theme: "light" | "dark", preference: "light" | "dark" | "system"): Promise<void> };
  vocatryaRuntime?: VocatryaRuntimeBridge;
  vocatryaAi?: VocatryaAiBridge;
}
