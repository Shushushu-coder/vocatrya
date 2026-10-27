// Origin contract for the middleware `authorized` callback. The desktop
// backend serves Electron on http://127.0.0.1:<dynamic-port>, but the edge
// sandbox's NextURL canonicalizes every loopback host to `localhost` and the
// middleware adapter rewrites each same-host redirect Location through it —
// so middleware can never emit a `127.0.0.1` redirect without breaking the
// Electron navigation policy. Dashboard requests therefore pass through and
// let the dashboard layout redirect from the Node runtime; API routes keep
// the default sign-in redirect (fetch-level, non-navigation).

import { authConfig } from "@/auth.config";

const authorized = authConfig.callbacks.authorized as (args: {
  auth: unknown;
  request: { nextUrl: { pathname: string; href: string; toString(): string } };
}) => boolean | Response;

const nextUrl = (pathname: string) => {
  const href = `http://127.0.0.1:45678${pathname}`;
  return { pathname, href, toString: () => href };
};

describe("middleware authorized() origin contract", () => {
  it("passes unauthenticated /dashboard requests through to the layout", () => {
    const result = authorized({ auth: null, request: { nextUrl: nextUrl("/dashboard") } });
    // `false` would make next-auth emit a NextResponse.redirect from the edge
    // sandbox — the very Location normalization this fix avoids.
    expect(result).toBe(true);
    expect(result).not.toBeInstanceOf(Response);
  });

  it("passes unauthenticated /dashboard sub-paths through to the layout", () => {
    expect(authorized({ auth: null, request: { nextUrl: nextUrl("/dashboard/settings") } })).toBe(true);
  });

  it("allows authenticated /dashboard requests", () => {
    const session = { user: { id: "u1", email: "u@example.test" } };
    expect(authorized({ auth: session, request: { nextUrl: nextUrl("/dashboard") } })).toBe(true);
  });

  it("keeps the default sign-in redirect for unauthenticated API routes", () => {
    expect(authorized({ auth: null, request: { nextUrl: nextUrl("/api/jobs") } })).toBe(false);
  });

  it("allows authenticated API routes", () => {
    const session = { user: { id: "u1" } };
    expect(authorized({ auth: session, request: { nextUrl: nextUrl("/api/jobs") } })).toBe(true);
  });

  it("lets unauthenticated requests to non-guarded paths through", () => {
    expect(authorized({ auth: null, request: { nextUrl: nextUrl("/signin") } })).toBe(true);
  });

  it("still redirects authenticated users on non-guarded paths to /dashboard", () => {
    const session = { user: { id: "u1" } };
    const result = authorized({ auth: session, request: { nextUrl: nextUrl("/") } });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("location")).toBe("http://127.0.0.1:45678/dashboard");
  });
});
