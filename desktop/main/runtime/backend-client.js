// Phase D loopback client for the Vocatrya backend's internal AI-connection
// endpoints. Electron main calls these with a per-launch bearer token the
// renderer can never see; they are the only path that mutates AIConnection
// rows for runtime operations. No command output, profile path, or
// credential material is ever sent — only opaque refs and parsed metadata.
const RESOLVE_PATH = "/api/internal/ai-connections/resolve";
const COMPLETE_PATH = "/api/internal/ai-connections/complete";

function createBackendClient({ getBaseUrl, token, fetchImpl } = {}) {
  if (typeof getBaseUrl !== "function") {
    throw new Error("getBaseUrl is required");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("An internal API token is required");
  }
  const fetchFn = fetchImpl || fetch;

  async function post(pathname, body) {
    let response;
    try {
      response = await fetchFn(`${getBaseUrl()}${pathname}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, code: "BACKEND_UNAVAILABLE" };
    }
    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      // Non-JSON response — fall through to the generic failure below.
    }
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, code: "BACKEND_UNAVAILABLE" };
    }
    return parsed;
  }

  return {
    // {ticket} → {ok, operationId, operation, backendKind, connection?}
    resolveTicket: (ticket) => post(RESOLVE_PATH, { ticket }),
    // {operationId, result} → {ok, connection?, code?}
    completeOperation: (operationId, result) =>
      post(COMPLETE_PATH, { operationId, result }),
  };
}

module.exports = { createBackendClient };
