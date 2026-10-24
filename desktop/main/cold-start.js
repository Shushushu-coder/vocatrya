// Cold-start entry for the desktop shell.
//
// The shell always opens the auth-gated route. NextAuth middleware matches
// /dashboard and is the validity check: a still-valid session renders the
// app, and a missing, invalid, or expired session is redirected to /signin.
// This module accepts an origin only. It does not accept a user, a token,
// or a cookie, and cookie presence is never treated as a login.
"use strict";

const COLD_START_PATH = "/dashboard";

function resolveColdStartEntry(origin) {
  if (typeof origin !== "string" || !origin.trim()) {
    throw new Error("Cold start origin is required");
  }
  let base;
  try {
    base = new URL(origin);
  } catch {
    throw new Error("Cold start origin is invalid");
  }
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1") {
    throw new Error("Cold start origin must be the loopback backend");
  }
  const entry = new URL(COLD_START_PATH, base);
  if (entry.origin !== base.origin) {
    throw new Error("Cold start entry left the backend origin");
  }
  entry.username = "";
  entry.password = "";
  entry.search = "";
  entry.hash = "";
  return entry.toString();
}

module.exports = {
  COLD_START_PATH,
  resolveColdStartEntry,
};
