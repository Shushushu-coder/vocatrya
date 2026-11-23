import { vi } from "vitest";

type CredentialsConfig = {
  credentials?: Record<string, unknown>;
  authorize?: (...args: unknown[]) => unknown;
};

const Credentials = vi.fn((config?: CredentialsConfig) => ({
  id: "credentials",
  name: "Credentials",
  type: "credentials",
  credentials: config?.credentials || {},
  authorize: config?.authorize || vi.fn(),
}));

export default Credentials;
