import { NextRequest, NextResponse } from "next/server";
import {
  AUTO_APPLY_CONNECT_CLIENT_HEADER,
  AUTO_APPLY_CONNECT_CLIENT_VALUE,
  AUTO_APPLY_CONNECT_ERROR,
  AutoApplyConnectError,
} from "@/lib/extensions/autoApply/connect";
import { CareerRuntimeError } from "@/lib/career/errors";
import { log } from "@/lib/telemetry";

/**
 * Shared guards for the extension-facing connect endpoints.
 *
 * There is deliberately no CORS surface here: the plugin reaches these
 * routes through an optional host permission it explicitly requests at pair
 * time, so no Access-Control-* headers are emitted and credentialed web
 * pages cannot ride along. The custom client header additionally makes
 * every endpoint a non-simple request for real web origins, which their
 * preflight (always denied) blocks outright.
 */

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export function requireExtensionClient(
  req: NextRequest,
): NextResponse | null {
  const value = req.headers.get(AUTO_APPLY_CONNECT_CLIENT_HEADER);
  if (value !== AUTO_APPLY_CONNECT_CLIENT_VALUE) {
    return NextResponse.json(
      { ok: false, error: "Missing extension client header" },
      { status: 400, headers: NO_STORE },
    );
  }
  return null;
}

export function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match ? match[1] : null;
}

export function unauthorized(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "Missing access token", code: AUTO_APPLY_CONNECT_ERROR.CONNECTION_INVALID },
    { status: 401, headers: NO_STORE },
  );
}

export function connectErrorResponse(error: unknown): NextResponse {
  if (error instanceof AutoApplyConnectError) {
    const status =
      error.code === AUTO_APPLY_CONNECT_ERROR.INVALID_REQUEST
        ? 400
        : error.code === AUTO_APPLY_CONNECT_ERROR.PAIRING_INVALID ||
            error.code === AUTO_APPLY_CONNECT_ERROR.CONNECTION_INVALID ||
            error.code === AUTO_APPLY_CONNECT_ERROR.CONNECTION_REVOKED
          ? 401
          : error.code === AUTO_APPLY_CONNECT_ERROR.PAIRING_EXPIRED
            ? 410
            : 409;
    return NextResponse.json(
      { ok: false, error: error.message, code: error.code },
      { status, headers: NO_STORE },
    );
  }
  if (error instanceof CareerRuntimeError) {
    return NextResponse.json(
      { ok: false, error: error.message, code: error.code },
      { status: 403, headers: NO_STORE },
    );
  }
  log.error("[auto-apply] connect endpoint failed", {
    error: String(error),
  });
  return NextResponse.json(
    { ok: false, error: "Request failed" },
    { status: 500, headers: NO_STORE },
  );
}
