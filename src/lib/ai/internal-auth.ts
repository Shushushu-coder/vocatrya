/**
 * Phase D internal loopback auth — guards the /api/internal/ai-connections
 * endpoints so only the Electron main process (holder of the per-launch
 * VOCATRYA_DESKTOP_INTERNAL_TOKEN injected into the backend env) may call
 * them. In web/dev mode without the token the routes fail closed.
 */
import { timingSafeEqual } from "node:crypto";

const INTERNAL_TOKEN_ENV = "VOCATRYA_DESKTOP_INTERNAL_TOKEN";

export class InternalApiError extends Error {
  readonly code: "NOT_CONFIGURED" | "UNAUTHORIZED";

  constructor(code: "NOT_CONFIGURED" | "UNAUTHORIZED") {
    super(code === "NOT_CONFIGURED" ? "Internal API not configured" : "Unauthorized");
    this.name = "InternalApiError";
    this.code = code;
  }
}

export function assertInternalRequest(request: Request): void {
  const token = process.env[INTERNAL_TOKEN_ENV];
  if (!token) {
    throw new InternalApiError("NOT_CONFIGURED");
  }
  const header = request.headers.get("authorization") ?? "";
  const presented = /^Bearer (.+)$/.exec(header)?.[1] ?? "";
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InternalApiError("UNAUTHORIZED");
  }
}
