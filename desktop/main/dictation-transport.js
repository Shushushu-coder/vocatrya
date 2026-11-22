// Invoked only AFTER the credential broker authenticates the backend bearer.
// No arbitrary destination, redirects, renderer IPC, disk writes or body logging.
const MAX_BODY_BYTES = 17 * 1024 * 1024; // 12 MB clip plus base64/JSON overhead.
const MAX_RESPONSE_BYTES = 1024 * 1024;

function allowedTarget(value) {
  if (value === "https://generativelanguage.googleapis.com/v1beta/interactions" ||
      /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[A-Za-z0-9._-]+:generateContent$/.test(value)) return "gemini";
  return null;
}

function createDictationTransport(fetchImpl) {
  return async (req, res) => {
    const provider = allowedTarget(req.headers["x-dictation-target"]);
    const key = req.headers["x-dictation-api-key"];
    const contentType = req.headers["content-type"];
    const reply = (status, code) => {
      if (!res.destroyed) {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ success: false, code }));
      }
    };
    if (!provider || typeof key !== "string" || !key.trim() || key.length > 4096 ||
        typeof contentType !== "string" || !/^(application\/json|multipart\/form-data)(;|$)/i.test(contentType)) {
      reply(400, "DICTATION_INVALID_AUDIO");
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    const cancel = () => controller.abort();
    res.once("close", cancel);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { reply(413, "DICTATION_AUDIO_TOO_LARGE"); return; }
        chunks.push(chunk);
      }
      const upstream = await fetchImpl(req.headers["x-dictation-target"], {
        method: "POST",
        headers: {
          "content-type": contentType,
          "x-goog-api-key": key,
        },
        body: Buffer.concat(chunks),
        redirect: "error",
        signal: controller.signal,
      });
      const responseChunks = [];
      let responseSize = 0;
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          responseSize += chunk.length;
          if (responseSize > MAX_RESPONSE_BYTES) throw new Error("Response too large");
          responseChunks.push(Buffer.from(chunk));
        }
      }
      if (!res.destroyed) {
        res.writeHead(upstream.status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(Buffer.concat(responseChunks));
      }
    } catch {
      reply(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? "DICTATION_TIMEOUT" : "DICTATION_NETWORK");
    } finally {
      clearTimeout(timer);
      res.removeListener("close", cancel);
    }
  };
}

module.exports = { createDictationTransport, allowedTarget };
