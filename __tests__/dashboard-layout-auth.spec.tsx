// The dashboard layout owns the unauthenticated sign-in redirect. Emitting
// it here (Node runtime) produces a relative Location that resolves against
// the request origin — the only redirect path that survives NextURL's
// loopback normalization inside the middleware edge sandbox.

vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("@/actions/agentChat.actions", () => ({
  loadActiveChatConversation: async () => ({ data: null }),
}));

vi.mock("@/actions/career.runtime", () => ({
  getCareerRuntimeSnapshot: async () => ({}),
}));

vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn(async () => null),
}));

import { auth } from "@/auth";
import { redirect } from "next/navigation";
import StaleSessionSignOut from "@/components/StaleSessionSignOut";
import RootLayout from "@/app/dashboard/layout";

describe("dashboard layout auth gate", () => {
  it("redirects unauthenticated requests to /signin from the Node runtime", async () => {
    (auth as any).mockResolvedValue(null);
    await expect(RootLayout({ children: null })).rejects.toThrow("NEXT_REDIRECT:/signin");
    expect(redirect).toHaveBeenCalledWith("/signin");
  });

  it("keeps the stale-session UI when the JWT outlives the user row", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1", email: "u@example.test" } });
    const element = await RootLayout({ children: null });
    expect(redirect).not.toHaveBeenCalled();
    expect(element.type).toBe(StaleSessionSignOut);
  });
});
