import "server-only";

import { FEISHU_API_BASE, FEISHU_REQUEST_TIMEOUT_MS } from "./constants";
import { FEISHU_ERROR, FeishuError, isFeishuError } from "./errors";
import { parseRetryAfterMs } from "../notion/mcpClient";

/**
 * Thin fetch wrapper for the Feishu OpenAPI. Returns the raw response for
 * every HTTP status so callers (capability probes especially) can read
 * 403-vs-404 honestly; it throws FeishuError only for transport failures —
 * network, timeout, abort, or an unparseable body. `expectFeishuOk` converts
 * a response into a typed error at the point a call means to succeed.
 */

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init);

/** Test seam — swap the transport, never the error mapping. */
export function setFeishuApiFetch(impl: FetchLike | null): void {
  fetchImpl = impl ?? ((url, init) => fetch(url, init));
}

export type FeishuResponse = {
  status: number;
  /** Feishu business code inside the envelope (0 = success). */
  code: number | null;
  msg?: string;
  data?: unknown;
  retryAfterMs?: number;
};

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  return AbortSignal.any([a, b]);
}

// Feishu business codes worth mapping beyond the HTTP status. Server-side
// codes arrive in the JSON envelope; only stable, documented families are
// special-cased — everything else falls through to the status mapping.
const REAUTH_CODES = new Set([
  99991661, 99991662, 99991663, 99991664, 99991668, // invalid/expired tenant or app token
]);
const RATE_LIMIT_CODES = new Set([99991400, 99991401]);
const PERMISSION_CODES = new Set([
  99991672, 99991679, // app lacks the required API scope
  1770031, 1770032, // document permission denied
]);

export async function feishuRequest(input: {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  token?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<FeishuResponse> {
  const url = new URL(`${FEISHU_API_BASE}${input.path}`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const timeout = AbortSignal.timeout(FEISHU_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url.toString(), {
      method: input.method,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: combineSignals(input.signal, timeout),
    });
    const retryAfterMs = parseRetryAfterMs(
      response.headers.get("retry-after"),
    );
    let parsed: { code?: number; msg?: string; data?: unknown; tenant_access_token?: string; expire?: number } | null = null;
    try {
      parsed = (await response.json()) as {
        code?: number;
        msg?: string;
        data?: unknown;
        tenant_access_token?: string;
        expire?: number;
      } | null;
    } catch {
      // A non-JSON body still carries an honest status.
    }
    return {
      status: response.status,
      code: typeof parsed?.code === "number" ? parsed.code : null,
      msg: typeof parsed?.msg === "string" ? parsed.msg : undefined,
      data: input.path === "/open-apis/auth/v3/tenant_access_token/internal"
        ? { tenant_access_token: parsed?.tenant_access_token, expire: parsed?.expire }
        : parsed?.data,
      retryAfterMs,
    };
  } catch (error) {
    if (isFeishuError(error)) throw error;
    const aborted =
      input.signal?.aborted === true || timeout.aborted ||
      (error instanceof Error && error.name === "AbortError");
    throw new FeishuError(
      aborted ? FEISHU_ERROR.OUTCOME_UNKNOWN : FEISHU_ERROR.NETWORK,
      { retryable: !aborted },
    );
  }
}

/** Map a finished response into a typed error. Assumes it was not ok. */
export function feishuApiError(res: FeishuResponse): FeishuError {
  if (res.code !== null) {
    if (REAUTH_CODES.has(res.code)) {
      return new FeishuError(FEISHU_ERROR.REAUTH_REQUIRED);
    }
    if (RATE_LIMIT_CODES.has(res.code) || res.status === 429) {
      return new FeishuError(FEISHU_ERROR.RATE_LIMITED, {
        retryable: true,
        retryAfterMs: res.retryAfterMs,
      });
    }
    if (res.code === 1770002) return new FeishuError(FEISHU_ERROR.OBJECT_NOT_FOUND);
    if (PERMISSION_CODES.has(res.code)) {
      return new FeishuError(FEISHU_ERROR.PERMISSION_DENIED);
    }
  }
  if (res.status === 401) return new FeishuError(FEISHU_ERROR.REAUTH_REQUIRED);
  if (res.status === 403) return new FeishuError(FEISHU_ERROR.PERMISSION_DENIED);
  if (res.status === 404) return new FeishuError(FEISHU_ERROR.OBJECT_NOT_FOUND);
  if (res.status === 429) {
    return new FeishuError(FEISHU_ERROR.RATE_LIMITED, {
      retryable: true,
      retryAfterMs: res.retryAfterMs,
    });
  }
  if (res.status >= 500) return new FeishuError(FEISHU_ERROR.OUTCOME_UNKNOWN, { retryable: true });
  // 4xx business failures are definite request problems, not unknowns.
  return new FeishuError(FEISHU_ERROR.VALIDATION_FAILED);
}

export function expectFeishuOk<T = unknown>(res: FeishuResponse): T {
  if (res.status >= 200 && res.status < 300 && res.code === 0) {
    return res.data as T;
  }
  throw feishuApiError(res);
}

/** Catch-all mapper for call sites that wrap arbitrary thrown values. */
export function mapFeishuRemoteError(error: unknown): FeishuError {
  if (isFeishuError(error)) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new FeishuError(FEISHU_ERROR.OUTCOME_UNKNOWN);
  }
  return new FeishuError(FEISHU_ERROR.NETWORK, { retryable: true });
}

/** Tool-facing classification — the code the agent sees in the result. */
export function classifyFeishuToolError(error: unknown): string {
  return mapFeishuRemoteError(error).code;
}
