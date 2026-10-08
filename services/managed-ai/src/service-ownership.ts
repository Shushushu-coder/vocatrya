import { existsSync, realpathSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** An OS-released SQLite file lock enforces one active service per authority DB.
 * This separate lock database contains no accounting data. Operators and short
 * admission/settlement transactions continue using the authority DB normally.
 * Process death releases ownership, permitting safe startup recovery.
 */
export function acquireServiceOwnership(filename: string): () => void {
  const absolute = resolve(filename);
  const canonical = existsSync(absolute) ? realpathSync(absolute) : join(realpathSync(dirname(absolute)), basename(absolute));
  const lock = new DatabaseSync(`${canonical}.service-lock`);
  try { lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
  catch { lock.close(); throw new Error("Managed service already owns this database"); }
  return () => { lock.exec("ROLLBACK"); lock.close(); };
}
