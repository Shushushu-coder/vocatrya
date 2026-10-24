import { describe, expect, it } from "vitest";
import { COLD_START_PATH, resolveColdStartEntry } from "./cold-start.js";

describe("desktop cold start entry", () => {
  it("opens the auth-gated dashboard route on the loopback origin", () => {
    expect(COLD_START_PATH).toBe("/dashboard");
    expect(resolveColdStartEntry("http://127.0.0.1:43123")).toBe(
      "http://127.0.0.1:43123/dashboard",
    );
  });

  it("drops credentials, query, and hash so the shell cannot smuggle a session", () => {
    expect(
      resolveColdStartEntry("http://user:secret@127.0.0.1:9/signin?token=forged#session"),
    ).toBe("http://127.0.0.1:9/dashboard");
  });

  it("rejects a missing origin and any non-loopback target", () => {
    expect(() => resolveColdStartEntry("")).toThrow(/origin is required/);
    expect(() => resolveColdStartEntry("not a url")).toThrow(/invalid/);
    expect(() => resolveColdStartEntry("https://example.com")).toThrow(/loopback/);
    expect(() => resolveColdStartEntry("file:///C:/Vocatrya/app")).toThrow(/loopback/);
  });

  it("takes one argument: there is no user, token, or cookie parameter", () => {
    expect(resolveColdStartEntry.length).toBe(1);
  });
});
