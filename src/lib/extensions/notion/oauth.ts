import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { NOTION_MCP_ORIGIN, NOTION_MCP_URL } from "./constants";
import { NOTION_ERROR, NotionError } from "./errors";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 15_000;

// The OAuth resource parameter binds the issued token to the MCP endpoint.
export const NOTION_OAUTH_RESOURCE = NOTION_MCP_URL;

function timedFetch(fetchFn: FetchLike): FetchLike {
  return (input, init) =>
    fetchFn(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
}

let oauthFetch: FetchLike = timedFetch(fetch);

/** Test seam — production never replaces the fetch. */
export function setNotionOAuthFetch(fetchFn: FetchLike) {
  oauthFetch = timedFetch(fetchFn);
}

async function tryJson(
  fetchFn: FetchLike,
  candidates: string[],
): Promise<Record<string, unknown> | null> {
  for (const url of candidates) {
    try {
      const res = await fetchFn(url, { headers: { accept: "application/json" } });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
    } catch {
      // Fall through to the next candidate — discovery failures aggregate.
    }
  }
  return null;
}

export type NotionAuthorizationServer = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
};

/**
 * RFC 9728 protected-resource metadata → RFC 8414 authorization-server
 * metadata. Falls back to the documented origin when the PRM document is not
 * reachable so a partially-degraded discovery does not block connecting.
 */
export async function discoverNotionAuthorizationServer(
  fetchFn: FetchLike = oauthFetch,
): Promise<NotionAuthorizationServer> {
  const prm = await tryJson(fetchFn, [
    `${NOTION_MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`,
    `${NOTION_MCP_ORIGIN}/.well-known/oauth-protected-resource`,
  ]);
  const servers = prm?.authorization_servers;
  const issuer =
    Array.isArray(servers) && typeof servers[0] === "string"
      ? servers[0].replace(/\/$/, "")
      : NOTION_MCP_ORIGIN;
  if (issuer !== NOTION_MCP_ORIGIN) {
    throw new NotionError(NOTION_ERROR.OAUTH_FAILED);
  }

  const meta = await tryJson(fetchFn, [
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuer}/.well-known/openid-configuration`,
    `${NOTION_MCP_ORIGIN}/.well-known/oauth-authorization-server`,
  ]);
  if (
    typeof meta?.authorization_endpoint !== "string" ||
    typeof meta?.token_endpoint !== "string"
  ) {
    throw new NotionError(NOTION_ERROR.OAUTH_FAILED, {
      message: "authorization server metadata unavailable",
      retryable: true,
    });
  }
  // This is a fixed Notion adapter: discovery cannot redirect credentials
  // to a different issuer, insecure endpoint or credential-bearing URL.
  const endpoints = [meta.authorization_endpoint, meta.token_endpoint,
    meta.registration_endpoint, meta.revocation_endpoint].filter((value): value is string => typeof value === "string");
  const valid = endpoints.every(endpoint => {
    try {
      const url = new URL(endpoint);
      return url.origin === NOTION_MCP_ORIGIN && !url.username && !url.password;
    } catch { return false; }
  });
  if (!valid || (typeof meta.issuer === "string" && meta.issuer !== issuer) ||
      (Array.isArray(meta.code_challenge_methods_supported) && !meta.code_challenge_methods_supported.includes("S256"))) {
    throw new NotionError(NOTION_ERROR.OAUTH_FAILED);
  }
  return {
    issuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint:
      typeof meta.registration_endpoint === "string"
        ? meta.registration_endpoint
        : undefined,
    revocationEndpoint:
      typeof meta.revocation_endpoint === "string"
        ? meta.revocation_endpoint
        : undefined,
  };
}

export type NotionClientRegistration = {
  clientId: string;
  clientSecret?: string;
};

/**
 * RFC 7591 dynamic client registration. The whole loopback port pool is
 * registered once so a reconnect can pick any free port without another
 * registration.
 */
export async function registerNotionClient(
  server: NotionAuthorizationServer,
  redirectUris: string[],
  clientName: string,
  fetchFn: FetchLike = oauthFetch,
): Promise<NotionClientRegistration> {
  if (!server.registrationEndpoint) {
    throw new NotionError(NOTION_ERROR.OAUTH_FAILED, {
      message: "dynamic client registration is not advertised",
    });
  }
  const res = await fetchFn(server.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) throw oauthHttpError(res, "client registration failed");
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body.client_id !== "string") {
    throw new NotionError(NOTION_ERROR.OAUTH_FAILED, {
      message: "client registration returned no client_id",
    });
  }
  return {
    clientId: body.client_id,
    clientSecret:
      typeof body.client_secret === "string" ? body.client_secret : undefined,
  };
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

export function hashPendingState(state: string): string {
  return createHash("sha256").update(`notion-oauth-state:${state}`).digest("hex");
}

export function buildAuthorizationUrl(input: {
  endpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", NOTION_OAUTH_RESOURCE);
  return url.toString();
}

export type NotionTokenResponse = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceIcon?: string;
  botId?: string;
  ownerUserId?: string;
};

async function readOAuthBody(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function oauthHttpError(res: Response, fallback: string): NotionError {
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    return new NotionError(NOTION_ERROR.RATE_LIMITED, {
      retryable: true,
      retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
    });
  }
  return new NotionError(NOTION_ERROR.OAUTH_FAILED, {
    message: `${fallback} (${res.status})`,
    retryable: res.status >= 500,
  });
}

function parseTokenResponse(body: Record<string, unknown>): NotionTokenResponse {
  if (typeof body.error === "string") {
    if (body.error === "invalid_grant") {
      throw new NotionError(NOTION_ERROR.REAUTH_REQUIRED, {
        message: "the stored grant is no longer valid",
      });
    }
    if (body.error === "access_denied") {
      throw new NotionError(NOTION_ERROR.OAUTH_DENIED);
    }
    throw new NotionError(NOTION_ERROR.OAUTH_FAILED, {
      message: `token endpoint returned ${body.error}`,
      retryable: body.error === "temporarily_unavailable",
    });
  }
  if (typeof body.access_token !== "string") {
    throw new NotionError(NOTION_ERROR.OAUTH_FAILED, {
      message: "token response missing access_token",
    });
  }
  const owner = body.owner as Record<string, unknown> | undefined;
  const ownerUser = owner?.user as Record<string, unknown> | undefined;
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expiresAt:
      typeof body.expires_in === "number"
        ? Date.now() + body.expires_in * 1000
        : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    workspaceId:
      typeof body.workspace_id === "string" ? body.workspace_id : undefined,
    workspaceName:
      typeof body.workspace_name === "string"
        ? body.workspace_name
        : undefined,
    workspaceIcon:
      typeof body.workspace_icon === "string"
        ? body.workspace_icon
        : undefined,
    botId: typeof body.bot_id === "string" ? body.bot_id : undefined,
    ownerUserId:
      typeof ownerUser?.id === "string" ? ownerUser.id : undefined,
  };
}

export async function exchangeAuthorizationCode(
  server: NotionAuthorizationServer,
  input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    clientId: string;
    clientSecret?: string;
  },
  fetchFn: FetchLike = oauthFetch,
): Promise<NotionTokenResponse> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    client_id: input.clientId,
    resource: NOTION_OAUTH_RESOURCE,
  });
  if (input.clientSecret) params.set("client_secret", input.clientSecret);
  const res = await fetchFn(server.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: params.toString(),
  });
  const body = await readOAuthBody(res);
  if (!res.ok) {
    if (body.error === "invalid_grant") {
      throw new NotionError(NOTION_ERROR.OAUTH_FAILED, {
        message: "authorization code was rejected",
      });
    }
    throw oauthHttpError(res, "token exchange failed");
  }
  return parseTokenResponse(body);
}

export async function refreshNotionTokens(
  server: NotionAuthorizationServer,
  input: { refreshToken: string; clientId: string; clientSecret?: string },
  fetchFn: FetchLike = oauthFetch,
): Promise<NotionTokenResponse> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    resource: NOTION_OAUTH_RESOURCE,
  });
  if (input.clientSecret) params.set("client_secret", input.clientSecret);
  const res = await fetchFn(server.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: params.toString(),
  });
  const body = await readOAuthBody(res);
  if (!res.ok) {
    // invalid_grant inside a 400 body is the documented expired/revoked
    // signal; readOAuthBody already parsed it for parseTokenResponse, but a
    // non-OK status never reaches the parser — handle it here.
    if (body.error === "invalid_grant") {
      throw new NotionError(NOTION_ERROR.REAUTH_REQUIRED, {
        message: "the stored grant is no longer valid",
      });
    }
    throw oauthHttpError(res, "token refresh failed");
  }
  return parseTokenResponse(body);
}

/** RFC 7009 revocation. Best-effort: callers swallow failures. */
export async function revokeNotionToken(
  server: NotionAuthorizationServer,
  input: { token: string; clientId: string; clientSecret?: string },
  fetchFn: FetchLike = oauthFetch,
): Promise<void> {
  if (!server.revocationEndpoint) return;
  const params = new URLSearchParams({
    token: input.token,
    client_id: input.clientId,
  });
  if (input.clientSecret) params.set("client_secret", input.clientSecret);
  try {
    await fetchFn(server.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch {
    // Revocation is advisory — disconnect proceeds regardless.
  }
}
