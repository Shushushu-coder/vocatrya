// Semver compare with prerelease ordering: the numeric core decides first;
// when cores tie, a stable release outranks every prerelease (v1.2.0 >
// v1.2.0-rc) and prereleases follow semver identifier rules (beta.2 < rc).
// Build metadata (+...) is ignored per spec.
interface ParsedVersion {
  core: number[];
  pre: string[] | null;
}

function parseVersion(value: string): ParsedVersion | null {
  const trimmed = value.trim().replace(/^v/i, "").split("+")[0];
  const dash = trimmed.indexOf("-");
  const main = dash === -1 ? trimmed : trimmed.slice(0, dash);
  const pre = dash === -1 ? null : trimmed.slice(dash + 1) || null;
  if (!/^\d+(\.\d+)*$/.test(main)) return null;
  return { core: main.split(".").map(Number), pre: pre?.split(".") ?? null };
}

// Semver §11: numeric identifiers compare numerically and always rank below
// alphanumeric ones; a longer identifier list wins when all shared fields
// are equal. Returns true when `a` outranks `b`.
function isNewerPrerelease(a: string[], b: string[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return false;
    if (b[i] === undefined) return true;
    const aNumeric = /^\d+$/.test(a[i]);
    const bNumeric = /^\d+$/.test(b[i]);
    if (aNumeric !== bNumeric) return !aNumeric;
    if (aNumeric && Number(a[i]) !== Number(b[i])) {
      return Number(a[i]) > Number(b[i]);
    }
    if (!aNumeric && a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;

  for (let i = 0; i < Math.max(a.core.length, b.core.length); i++) {
    const diff = (a.core[i] ?? 0) - (b.core[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  if (a.pre === null && b.pre === null) return false;
  if (a.pre === null) return true;
  if (b.pre === null) return false;
  return isNewerPrerelease(a.pre, b.pre);
}
