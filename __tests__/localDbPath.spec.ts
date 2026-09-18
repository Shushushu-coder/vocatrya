import { resolveLocalDbDisplayPath } from "@/lib/career/localDbPath";

function env(url: string | undefined): NodeJS.ProcessEnv {
  const next = { ...process.env };
  if (url === undefined) delete next.DATABASE_URL;
  else next.DATABASE_URL = url;
  return next;
}

describe("resolveLocalDbDisplayPath fail-closed", () => {
  it("resolves a relative file: URL to a real path", () => {
    const result = resolveLocalDbDisplayPath(env("file:./dev.db"), "/repo");
    expect(result.kind).toBe("local-file");
    if (result.kind !== "local-file") return;
    expect(result.path.replace(/\\/g, "/")).toMatch(/prisma\/dev\.db$/);
    expect(result.path).toContain("repo");
    expect(JSON.stringify(result)).not.toContain("file:");
    expect(JSON.stringify(result)).not.toContain("DATABASE_URL");
  });

  it("resolves file:../data/app.db relative to prisma/", () => {
    const result = resolveLocalDbDisplayPath(env("file:../data/app.db"), "/repo");
    expect(result.kind).toBe("local-file");
    if (result.kind !== "local-file") return;
    expect(result.path.replace(/\\/g, "/")).toMatch(/data\/app\.db$/);
    expect(result.path).not.toMatch(/prisma[/\\]dev\.db$/);
  });

  it("resolves an absolute file: URL when the parser supports it", () => {
    const result = resolveLocalDbDisplayPath(env("file:/tmp/custom-app.db"), "/repo");
    expect(result.kind).toBe("local-file");
    if (result.kind !== "local-file") return;
    expect(result.path.replace(/\\/g, "/")).toMatch(/custom-app\.db$/);
    expect(result.path).not.toContain("prisma");
    expect(JSON.stringify(result)).not.toContain("file:/tmp");
  });

  it("returns unavailable for postgresql URLs without leaking credentials or a fake path", () => {
    const result = resolveLocalDbDisplayPath(
      env("postgresql://user:password@example/db"),
      "/repo",
    );
    expect(result).toEqual({ kind: "unavailable" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("user");
    expect(serialized).not.toContain("postgresql");
    expect(serialized).not.toContain("prisma/dev.db");
    expect(serialized).not.toContain("dev.db");
  });

  it("returns unavailable for an empty file: URL", () => {
    const result = resolveLocalDbDisplayPath(env("file:"), "/repo");
    expect(result).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("prisma/dev.db");
    expect(JSON.stringify(result)).not.toContain("dev.db");
  });

  it("returns unavailable when DATABASE_URL is missing", () => {
    const result = resolveLocalDbDisplayPath(env(undefined), "/repo");
    expect(result).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("prisma/dev.db");
  });

  it("strips query params from a file: URL without returning the raw URL", () => {
    const result = resolveLocalDbDisplayPath(env("file:./dev.db?connection_limit=1"), "/repo");
    expect(result.kind).toBe("local-file");
    if (result.kind !== "local-file") return;
    expect(result.path.replace(/\\/g, "/")).toMatch(/prisma\/dev\.db$/);
    expect(JSON.stringify(result)).not.toContain("connection_limit");
    expect(JSON.stringify(result)).not.toContain("file:");
  });
});
