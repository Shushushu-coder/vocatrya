/**
 * Conflict-free ContactInfo → CandidateProfile resolution.
 *
 * Missing/empty values are ignored. Conflicting non-empty values leave that
 * field unset. No frequency / newest / first-row heuristic is used to pick a
 * winner among disagreements.
 */

export type LegacyContactRow = {
  resumeId: string;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  url1: string | null;
  url1Label: string | null;
  url2: string | null;
  url2Label: string | null;
};

export type ContactFieldName =
  | "email"
  | "phone"
  | "address"
  | "fullName"
  | "headline"
  | "links";

export type ContactFieldConflict = {
  field: ContactFieldName;
  distinctNormalizedCount: number;
};

export type ContactResolution = {
  profile: {
    fullName: string | null;
    headline: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    linksData: string | null;
  };
  conflicts: ContactFieldConflict[];
  createProfile: boolean;
};

export function normalizeContactText(value: unknown): string | null {
  const text = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return text ? text : null;
}

export function normalizeEmail(value: unknown): string | null {
  const text = normalizeContactText(value);
  return text ? text.toLowerCase() : null;
}

export function normalizePhone(value: unknown): string | null {
  const text = normalizeContactText(value);
  if (!text) return null;
  return text.replace(/[()\s.\-]/g, "");
}

function fullNameOf(row: LegacyContactRow): string | null {
  const first = normalizeContactText(row.firstName);
  const last = normalizeContactText(row.lastName);
  if (!first && !last) return null;
  return [first, last].filter(Boolean).join(" ");
}

function linksOf(row: LegacyContactRow): string | null {
  const links: Array<{ url: string; label: string | null }> = [];
  const url1 = normalizeContactText(row.url1);
  if (url1) {
    links.push({ url: url1, label: normalizeContactText(row.url1Label) });
  }
  const url2 = normalizeContactText(row.url2);
  if (url2) {
    links.push({ url: url2, label: normalizeContactText(row.url2Label) });
  }
  return links.length ? JSON.stringify(links) : null;
}

function agreeOrConflict(
  values: Array<{ normalized: string; original: string }>,
): { agreed: string | null; distinct: number } {
  if (values.length === 0) return { agreed: null, distinct: 0 };
  const distinct = new Set(values.map((v) => v.normalized));
  if (distinct.size !== 1) return { agreed: null, distinct: distinct.size };
  return { agreed: values[0].original, distinct: 1 };
}

export function resolveContactProfile(
  rows: LegacyContactRow[],
): ContactResolution {
  const conflicts: ContactFieldConflict[] = [];

  const pick = (
    field: ContactFieldName,
    pairs: Array<{ normalized: string | null; original: string | null }>,
  ): string | null => {
    const present = pairs.filter(
      (p): p is { normalized: string; original: string } =>
        Boolean(p.normalized && p.original),
    );
    const result = agreeOrConflict(present);
    if (result.distinct > 1) {
      conflicts.push({ field, distinctNormalizedCount: result.distinct });
      return null;
    }
    return result.agreed;
  };

  const email = pick(
    "email",
    rows.map((row) => ({
      normalized: normalizeEmail(row.email),
      original: normalizeContactText(row.email),
    })),
  );
  const phone = pick(
    "phone",
    rows.map((row) => ({
      normalized: normalizePhone(row.phone),
      original: normalizeContactText(row.phone),
    })),
  );
  const address = pick(
    "address",
    rows.map((row) => ({
      normalized: normalizeContactText(row.address)?.toLowerCase() ?? null,
      original: normalizeContactText(row.address),
    })),
  );
  const fullName = pick(
    "fullName",
    rows.map((row) => {
      const name = fullNameOf(row);
      return {
        normalized: name ? name.toLowerCase() : null,
        original: name,
      };
    }),
  );
  const headline = pick(
    "headline",
    rows.map((row) => {
      const value = normalizeContactText(row.headline);
      return {
        normalized: value ? value.toLowerCase() : null,
        original: value,
      };
    }),
  );
  const linksData = pick(
    "links",
    rows.map((row) => {
      const value = linksOf(row);
      return { normalized: value, original: value };
    }),
  );

  const profile = {
    fullName,
    headline,
    email,
    phone,
    address,
    linksData,
  };
  const coreConflict = conflicts.some(
    (conflict) =>
      conflict.field === "email" ||
      conflict.field === "phone" ||
      conflict.field === "address",
  );
  const createProfile =
    !coreConflict && Object.values(profile).some((value) => value != null);
  return { profile, conflicts, createProfile };
}

export function contactHeaderSnapshot(row: LegacyContactRow | null): string | null {
  if (!row) return null;
  return JSON.stringify({
    firstName: row.firstName,
    lastName: row.lastName,
    headline: row.headline,
    email: row.email,
    phone: row.phone,
    address: row.address,
    url1: row.url1,
    url1Label: row.url1Label,
    url2: row.url2,
    url2Label: row.url2Label,
  });
}
