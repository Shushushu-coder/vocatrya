// @vitest-environment node
import { dictationFetch } from "@/lib/dictation/transport.server";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("serializes multipart audio through the authenticated desktop channel", async () => {
  vi.stubEnv("VOCATRYA_CREDENTIAL_URL", "http://127.0.0.1:12345");
  vi.stubEnv("VOCATRYA_DESKTOP_INTERNAL_TOKEN", "synthetic-internal-token");
  const doFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"text":"ok"}'));
  vi.stubGlobal("fetch", doFetch);
  const form = new FormData();
  form.append("model", "gemini-3.5-flash-lite");
  form.append("file", new Blob(["clip"], { type: "audio/webm" }), "clip.webm");
  await dictationFetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent", {
    method: "POST", headers: { "x-goog-api-key": "synthetic-provider-key" }, body: form,
  });
  expect(doFetch).toHaveBeenCalledWith("http://127.0.0.1:12345/dictation/request", expect.objectContaining({
    headers: expect.objectContaining({ authorization: "Bearer synthetic-internal-token",
      "x-dictation-api-key": "synthetic-provider-key", "content-type": expect.stringContaining("multipart/form-data; boundary=") }),
  }));
  const init = doFetch.mock.calls[0]![1] as RequestInit;
  const parts = await new Response(init.body, { headers: { "content-type": new Headers(init.headers).get("content-type")! } }).formData();
  expect(parts.get("model")).toBe("gemini-3.5-flash-lite");
  expect(await (parts.get("file") as File).text()).toBe("clip");
});

it("fails closed for a malformed desktop channel instead of sending the key elsewhere", async () => {
  vi.stubEnv("VOCATRYA_CREDENTIAL_URL", "https://untrusted.example");
  const doFetch = vi.fn();
  vi.stubGlobal("fetch", doFetch);
  await expect(dictationFetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent")).rejects.toThrow("unavailable");
  expect(doFetch).not.toHaveBeenCalled();
});

it("keeps direct transport for web development", async () => {
  vi.stubEnv("VOCATRYA_CREDENTIAL_URL", "");
  const doFetch = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", doFetch);
  await dictationFetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent", { method: "POST" });
  expect(doFetch).toHaveBeenCalledWith("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent", { method: "POST" });
});
