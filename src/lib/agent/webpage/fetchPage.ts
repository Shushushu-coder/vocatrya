import http from "node:http";
import https from "node:https";
import type { Readable } from "node:stream";
import { extractReadable, normalizePlainText } from "./extract";
import {
  defaultResolver,
  isBlockedAddress,
  isBlockedHostname,
  type HostResolver,
  type ResolvedAddress,
} from "./netGuard";

export const WEBPAGE_FETCH = {
  TIMEOUT_MS: 15_000,
  MAX_BYTES: 2 * 1024 * 1024,
  MAX_REDIRECTS: 3,
  USER_AGENT:
    "VocatryaAgent/1.0 (user-requested page read; not a crawler)",
} as const;

export const WEBPAGE_ERROR = {
  NOT_USER_SUPPLIED: "URL_NOT_USER_SUPPLIED",
  INVALID_URL: "INVALID_URL",
  BLOCKED_ADDRESS: "BLOCKED_ADDRESS",
  TIMEOUT: "TIMEOUT",
  TOO_LARGE: "TOO_LARGE",
  UNSUPPORTED_TYPE: "UNSUPPORTED_TYPE",
  HTTP_ERROR: "HTTP_ERROR",
  EXTRACTION_EMPTY: "EXTRACTION_EMPTY",
  TOO_MANY_REDIRECTS: "TOO_MANY_REDIRECTS",
  FETCH_FAILED: "FETCH_FAILED",
} as const;
export type WebpageErrorCode =
  (typeof WEBPAGE_ERROR)[keyof typeof WEBPAGE_ERROR];

export type WebpageFetchResult =
  | {
      ok: true;
      finalUrl: string;
      title?: string;
      text: string;
      truncated: boolean;
      fetchedAt: string;
    }
  | { ok: false; code: WebpageErrorCode; status?: number };

export type TransportResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
};
export type Transport = (req: {
  url: URL;
  address: ResolvedAddress;
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Promise<TransportResponse>;

export type FetchDeps = {
  resolve?: HostResolver;
  transport?: Transport;
  now?: () => Date;
  timeoutMs?: number;
  maxBytes?: number;
};

// Connects to the address that was just validated (not a second DNS lookup),
// so a rebinding resolver cannot swap in a private address between the check
// and the connection. Host header and TLS servername still use the hostname.
export const nodeTransport: Transport = ({ url, address, headers, signal }) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        agent: false,
        servername: /^[\d.]+$|:/.test(host) ? undefined : host,
        lookup: (_name, options, callback) => {
          const cb = callback as (...args: unknown[]) => void;
          if ((options as { all?: boolean })?.all) {
            cb(null, [{ address: address.address, family: address.family }]);
          } else {
            cb(null, address.address, address.family);
          }
        },
      },
      (res) => {
        const flat: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          flat[k] = Array.isArray(v) ? v.join(", ") : v;
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: flat,
          body: res as Readable,
          destroy: () => res.destroy(),
        });
      },
    );
    const onAbort = () => req.destroy(new Error("aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    req.on("error", reject);
    req.end();
  });

class PageError extends Error {
  constructor(
    readonly code: WebpageErrorCode,
    readonly status?: number,
  ) {
    super(code);
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

function parseHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PageError(WEBPAGE_ERROR.INVALID_URL);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PageError(WEBPAGE_ERROR.INVALID_URL);
  }
  if (url.username || url.password) throw new PageError(WEBPAGE_ERROR.INVALID_URL);
  return url;
}

async function validatedAddress(
  url: URL,
  resolve: HostResolver,
): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(host)) throw new PageError(WEBPAGE_ERROR.BLOCKED_ADDRESS);
  let records: ResolvedAddress[];
  try {
    records = await resolve(host);
  } catch {
    throw new PageError(WEBPAGE_ERROR.FETCH_FAILED);
  }
  if (records.length === 0) throw new PageError(WEBPAGE_ERROR.FETCH_FAILED);
  // Every record must pass: a host mixing public and private answers is
  // refused rather than trusting the resolver's ordering.
  if (records.some((r) => isBlockedAddress(r.address))) {
    throw new PageError(WEBPAGE_ERROR.BLOCKED_ADDRESS);
  }
  return records[0];
}

function charsetOf(contentType: string, head: Buffer): string {
  const fromHeader = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  const fromMeta = head
    .subarray(0, 4096)
    .toString("latin1")
    .match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  return (fromHeader ?? fromMeta ?? "utf-8").toLowerCase();
}

function decodeBody(body: Buffer, contentType: string): string {
  const charset = charsetOf(contentType, body);
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

async function readCapped(
  res: TransportResponse,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const declared = Number(res.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.destroy();
    throw new PageError(WEBPAGE_ERROR.TOO_LARGE);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    if (signal.aborted) throw new PageError(WEBPAGE_ERROR.TIMEOUT);
    total += chunk.byteLength;
    if (total > maxBytes) {
      res.destroy();
      throw new PageError(WEBPAGE_ERROR.TOO_LARGE);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch one page and return its readable text. The caller has already decided
 * the URL may be read (scope rule); this enforces transport safety: http(s)
 * only, every hop's resolved address checked, bounded redirects/time/size,
 * text content types only, no cookies or credentials, links never followed.
 */
export async function fetchReadablePage(
  rawUrl: string,
  deps: FetchDeps = {},
): Promise<WebpageFetchResult> {
  const resolve = deps.resolve ?? defaultResolver;
  const transport = deps.transport ?? nodeTransport;
  const maxBytes = deps.maxBytes ?? WEBPAGE_FETCH.MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? WEBPAGE_FETCH.TIMEOUT_MS,
  );
  try {
    let url = parseHttpUrl(rawUrl);
    for (let hop = 0; ; hop++) {
      const address = await validatedAddress(url, resolve);
      if (controller.signal.aborted) throw new PageError(WEBPAGE_ERROR.TIMEOUT);
      const res = await transport({
        url,
        address,
        signal: controller.signal,
        headers: {
          "User-Agent": WEBPAGE_FETCH.USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
          "Accept-Encoding": "identity",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      });
      if (REDIRECT_STATUSES.has(res.status)) {
        res.destroy();
        const location = res.headers.location;
        if (!location) throw new PageError(WEBPAGE_ERROR.HTTP_ERROR, res.status);
        if (hop >= WEBPAGE_FETCH.MAX_REDIRECTS) {
          throw new PageError(WEBPAGE_ERROR.TOO_MANY_REDIRECTS);
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new PageError(WEBPAGE_ERROR.INVALID_URL);
        }
        url = parseHttpUrl(next.href);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        res.destroy();
        throw new PageError(WEBPAGE_ERROR.HTTP_ERROR, res.status);
      }
      const contentType = res.headers["content-type"] ?? "";
      const mime = contentType.split(";")[0].trim().toLowerCase();
      if (!HTML_TYPES.has(mime) && mime !== "text/plain") {
        res.destroy();
        throw new PageError(WEBPAGE_ERROR.UNSUPPORTED_TYPE);
      }
      const body = await readCapped(res, maxBytes, controller.signal);
      const decoded = decodeBody(body, contentType);
      const extracted =
        mime === "text/plain"
          ? { title: undefined, ...normalizePlainText(decoded) }
          : extractReadable(decoded);
      if (!extracted.text.trim()) {
        throw new PageError(WEBPAGE_ERROR.EXTRACTION_EMPTY);
      }
      return {
        ok: true,
        finalUrl: url.href.replace(/#.*$/, ""),
        title: extracted.title,
        text: extracted.text,
        truncated: extracted.truncated,
        fetchedAt: (deps.now?.() ?? new Date()).toISOString(),
      };
    }
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, code: WEBPAGE_ERROR.TIMEOUT };
    }
    if (error instanceof PageError) {
      return { ok: false, code: error.code, status: error.status };
    }
    return { ok: false, code: WEBPAGE_ERROR.FETCH_FAILED };
  } finally {
    clearTimeout(timer);
  }
}
