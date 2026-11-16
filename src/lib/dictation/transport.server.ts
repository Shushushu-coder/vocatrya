import "server-only";

/** Desktop requests use Chromium's system proxy support through an authenticated,
 * fixed-destination channel. Web development keeps the normal Node transport. */
export const dictationFetch: typeof fetch = async (input, init) => {
  const raw = process.env.VOCATRYA_CREDENTIAL_URL;
  if (!raw) return fetch(input, init);
  const base = new URL(raw);
  const token = process.env.VOCATRYA_DESKTOP_INTERNAL_TOKEN;
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" ||
      base.username || base.password || base.search || base.hash || base.pathname !== "/" || !token) {
    throw new Error("Desktop dictation transport is unavailable");
  }
  const request = new Request(input, init);
  const apiKey = request.headers.get("x-goog-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!apiKey) throw new Error("Dictation credential is missing");
  return fetch(`${base.origin}/dictation/request`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": request.headers.get("content-type") ?? "application/json",
      "x-dictation-target": request.url,
      "x-dictation-api-key": apiKey,
    },
    body: await request.arrayBuffer(),
    signal: request.signal,
    redirect: "error",
    cache: "no-store",
  });
};
