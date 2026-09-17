/**
 * Writable-target classification. Production / audit / in-repo smoke paths
 * cannot be opened for mutation in Phase 3, even with confirm flags.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAuditDbCandidates, type DbRole } from "./phase2Auditor";

export type WritableGate = {
  allowed: boolean;
  reason: string;
  role: "disposable_copy" | "forbidden" | "unclassified";
  normalizedPath: string;
};

function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

function sameFile(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (na.toLowerCase() === nb.toLowerCase()) return true;
  try {
    if (fs.existsSync(na) && fs.existsSync(nb)) {
      return fs.realpathSync(na) === fs.realpathSync(nb);
    }
  } catch {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return false;
}

export function isUnderTempDir(filePath: string): boolean {
  const abs = normalizePath(filePath);
  const tmp = normalizePath(os.tmpdir());
  const absCmp = process.platform === "win32" ? abs.toLowerCase() : abs;
  const tmpCmp = process.platform === "win32" ? tmp.toLowerCase() : tmp;
  return absCmp.startsWith(tmpCmp + path.sep) || absCmp.startsWith(tmpCmp + "/");
}

export function forbiddenWritableCandidates(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ role: DbRole; path: string }> {
  return resolveAuditDbCandidates(repoRoot, env).filter(
    (candidate) => candidate.role !== "disposable_test",
  );
}

export function classifyWritableTarget(
  dbPath: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): WritableGate {
  const normalizedPath = normalizePath(dbPath);
  const forbidden = forbiddenWritableCandidates(repoRoot, env);
  const hit = forbidden.find((candidate) => sameFile(candidate.path, normalizedPath));
  if (hit) {
    return {
      allowed: false,
      role: "forbidden",
      normalizedPath,
      reason: `Refusing writable migration against ${hit.role} path: ${hit.path}`,
    };
  }
  if (!isUnderTempDir(normalizedPath)) {
    return {
      allowed: false,
      role: "unclassified",
      normalizedPath,
      reason:
        "Writable Phase 3 backfill is limited to disposable copies under the OS temp directory",
    };
  }
  return {
    allowed: true,
    role: "disposable_copy",
    normalizedPath,
    reason: "Disposable temp SQLite copy",
  };
}

export function assertWritableTargetAllowed(options: {
  dbPath: string;
  repoRoot: string;
  confirmWritable: boolean;
  allowDisposableCopy: boolean;
  forceRequested?: boolean;
  env?: NodeJS.ProcessEnv;
}): WritableGate {
  if (options.forceRequested) {
    return {
      allowed: false,
      role: "forbidden",
      normalizedPath: normalizePath(options.dbPath),
      reason:
        "--force is not supported. Semantic preflight blockers cannot be bypassed in Phase 3.",
    };
  }
  if (!options.confirmWritable || !options.allowDisposableCopy) {
    return {
      allowed: false,
      role: "forbidden",
      normalizedPath: normalizePath(options.dbPath),
      reason:
        "Writable migrate requires both --confirm-writable and --allow-disposable-copy",
    };
  }
  const gate = classifyWritableTarget(
    options.dbPath,
    options.repoRoot,
    options.env,
  );
  if (!gate.allowed) return gate;
  return gate;
}
