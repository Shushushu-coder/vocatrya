import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

export default NextAuth(authConfig).auth;

export const config = {
  // https://nextjs.org/docs/app/building-your-application/routing/middleware#matcher
  matcher: [
    "/dashboard",
    "/dashboard/:path*",
    // "internal" routes carry their own loopback bearer auth (desktop main
    // → backend); they must bypass the session middleware. The auto-apply
    // connect endpoints likewise authenticate with their own bearer token
    // (paired extension, no browser session) plus a client header check.
    "/api/((?!auth|mcp|internal|extensions/auto-apply/connect).*)",
  ],
};
