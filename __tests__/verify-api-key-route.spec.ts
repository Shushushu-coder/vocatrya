// Tests for POST /api/settings/api-keys/verify: validation, provider lookup,
// verifier success, and connection-error message shaping.

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

const mockVerifier = vi.fn();
vi.mock("@/lib/ai/provider-registry.server", () => ({
  PROVIDER_VERIFIERS: {
    get openai() {
      return mockVerifier;
    },
  },
}));

import { POST } from "@/app/api/settings/api-keys/verify/route";
import { auth } from "@/auth";

const authed = () =>
  (auth as any).mockResolvedValue({ user: { id: "user-1" } });
const req = (body: unknown) => ({ json: async () => body }) as any;

describe("POST /api/settings/api-keys/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authed();
  });

  it("returns 400 when provider or key is missing", async () => {
    const res = await POST(req({ provider: "openai" }));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });

  it("returns 400 for an unknown provider", async () => {
    const res = await POST(req({ provider: "nope", key: "k" }));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBe("Unknown provider");
  });

  it("returns the verifier result on success", async () => {
    mockVerifier.mockResolvedValue({ success: true, models: ["gpt-4o"] });

    const res = await POST(req({ provider: "openai", key: "sk-live" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ success: true, models: ["gpt-4o"] });
    expect(mockVerifier).toHaveBeenCalledWith("sk-live");
  });

  it("maps connection failures to a friendly message", async () => {
    mockVerifier.mockRejectedValue(new Error("fetch failed"));

    const res = await POST(req({ provider: "openai", key: "sk-live" }));
    const data = await res.json();

    expect(data.success).toBe(false);
    expect(data.error).toBe("Cannot connect to openai service");
  });

  it("does not expose unexpected verifier error details", async () => {
    mockVerifier.mockRejectedValue(
      new Error("request failed for https://provider.invalid?key=secret-value"),
    );

    const res = await POST(req({ provider: "openai", key: "sk-bad" }));
    const data = await res.json();

    expect(data.success).toBe(false);
    expect(data.error).toBe("Verification failed. Check the key and try again");
    expect(JSON.stringify(data)).not.toContain("secret-value");
  });

  it("returns 400 on a malformed JSON body", async () => {
    const res = await POST({
      json: async () => {
        throw new Error("unexpected token");
      },
    } as any);

    expect(res.status).toBe(400);
  });

  it("returns 400 when the key is blank, oversized, or not a string", async () => {
    for (const body of [
      { provider: "openai", key: "   " },
      { provider: "openai", key: 42 },
      { provider: "openai", key: "k".repeat(4097) },
    ]) {
      const res = await POST(req(body));
      expect(res.status).toBe(400);
    }
    expect(mockVerifier).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace before calling the verifier", async () => {
    mockVerifier.mockResolvedValue({ success: true });

    const res = await POST(req({ provider: "openai", key: "  sk-live\n" }));
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(mockVerifier).toHaveBeenCalledWith("sk-live");
  });

  it("maps a verifier-side timeout to the same friendly message", async () => {
    mockVerifier.mockRejectedValue(
      Object.assign(new Error("The operation timed out"), {
        name: "TimeoutError",
      }),
    );

    const res = await POST(req({ provider: "openai", key: "sk-live" }));
    const data = await res.json();

    expect(data.success).toBe(false);
    expect(data.error).toContain("did not respond in time");
  });

  it("bounds a hanging verifier instead of pending forever", async () => {
    vi.useFakeTimers();
    try {
      mockVerifier.mockReturnValue(new Promise(() => {}));

      const pending = POST(req({ provider: "openai", key: "sk-live" }));
      await vi.advanceTimersByTimeAsync(21_000);
      const res = await pending;
      const data = await res.json();

      expect(data.success).toBe(false);
      expect(data.error).toContain("did not respond in time");
    } finally {
      vi.useRealTimers();
    }
  });
});
