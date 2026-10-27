import type { NextAuthConfig } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
    };
  }
}

export const authConfig = {
  pages: {
    signIn: "/signin",
    error: "/signin",
  },
  secret: process.env.AUTH_SECRET,
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isOnDashboard = nextUrl.pathname.startsWith("/dashboard");
      const isApiRoute = nextUrl.pathname.startsWith("/api");

      if (isOnDashboard) {
        // Middleware can never emit a same-origin redirect for the desktop
        // backend: the edge sandbox's NextURL canonicalizes every loopback
        // host to `localhost`, and the middleware adapter rewrites each
        // same-host redirect Location through it. Electron's navigation
        // policy only allows `http://127.0.0.1:<port>`, so such a redirect
        // fails the window load. Pass the request through — the dashboard
        // layout issues the sign-in redirect from the Node runtime, where
        // `redirect()` produces a relative Location resolved against the
        // request origin.
        return true;
      }
      if (isApiRoute) {
        return isLoggedIn;
      }
      if (isLoggedIn) {
        return Response.redirect(new URL("/dashboard", nextUrl));
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user?.id) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      const userId = (token.id as string) || token.sub;
      if (userId) {
        session.user.id = userId;
      }
      return session;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
