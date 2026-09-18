import path from "node:path";

/**
 * Safe local DB path display for the sensitive-data notice.
 * Never returns env values, connection strings, or secrets.
 * Never logs. Never invents prisma/dev.db when the datasource is not a
 * resolvable SQLite file: URL.
 */
export type LocalDbPathDisplay =
  | {
      kind: "local-file";
      path: string;
    }
  | {
      kind: "unavailable";
    };

const UNAVAILABLE: LocalDbPathDisplay = { kind: "unavailable" };

export function resolveLocalDbDisplayPath(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot: string = process.cwd(),
): LocalDbPathDisplay {
  const raw = (env.DATABASE_URL ?? "").trim();
  if (!raw.toLowerCase().startsWith("file:")) {
    return UNAVAILABLE;
  }

  let filePart = raw.slice("file:".length).trim();
  const cut = filePart.search(/[?#]/);
  if (cut >= 0) filePart = filePart.slice(0, cut).trim();
  if (!filePart) return UNAVAILABLE;

  const normalized = filePart.replace(/\\/g, "/");
  if (
    path.isAbsolute(filePart) ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.startsWith("/")
  ) {
    return { kind: "local-file", path: path.resolve(filePart) };
  }
  // Prisma resolves relative file: URLs against the prisma/ directory
  // when DATABASE_URL=file:./dev.db. Mirror that without touching the
  // filesystem or logging anything.
  if (
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    !normalized.includes("/")
  ) {
    return {
      kind: "local-file",
      path: path.resolve(repoRoot, "prisma", normalized),
    };
  }
  return { kind: "local-file", path: path.resolve(repoRoot, normalized) };
}
