export type ResumeHeaderLink = {
  label: string;
  url: string;
};

export type ResumeHeaderSnapshot = {
  fullName: string | null;
  headline: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  links: ResumeHeaderLink[];
};

export type ResumeHeaderProfileSource = {
  fullName?: string | null;
  headline?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  linksData?: string | null;
};

const EMPTY: ResumeHeaderSnapshot = {
  fullName: null,
  headline: null,
  email: null,
  phone: null,
  address: null,
  links: [],
};

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parseLink(value: unknown): ResumeHeaderLink | null {
  if (typeof value === "string") {
    const url = optionalText(value);
    return url ? { label: url, url } : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const url = optionalText(record.url) ?? optionalText(record.href);
  if (!url) return null;
  return { label: optionalText(record.label) ?? url, url };
}

export function parseResumeHeaderLinks(raw: unknown): ResumeHeaderLink[] {
  if (raw == null) return [];
  let value: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      value = JSON.parse(trimmed);
    } catch {
      return trimmed
        .split(/\r?\n/)
        .map((line) => parseLink(line))
        .filter((link): link is ResumeHeaderLink => link != null);
    }
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => parseLink(entry))
      .filter((link): link is ResumeHeaderLink => link != null);
  }
  const single = parseLink(value);
  return single ? [single] : [];
}

export function emptyResumeHeaderSnapshot(): ResumeHeaderSnapshot {
  return { ...EMPTY, links: [] };
}

export function parseResumeHeaderSnapshot(
  raw: string | null | undefined,
): ResumeHeaderSnapshot {
  if (raw == null || raw.trim() === "") {
    return emptyResumeHeaderSnapshot();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyResumeHeaderSnapshot();
    }
    const record = parsed as Record<string, unknown>;
    return {
      fullName: optionalText(record.fullName),
      headline: optionalText(record.headline),
      email: optionalText(record.email),
      phone: optionalText(record.phone),
      address: optionalText(record.address),
      links: parseResumeHeaderLinks(record.links ?? record.linksData),
    };
  } catch {
    return emptyResumeHeaderSnapshot();
  }
}

export function serializeResumeHeaderSnapshot(
  header: ResumeHeaderSnapshot,
): string {
  return JSON.stringify({
    fullName: optionalText(header.fullName),
    headline: optionalText(header.headline),
    email: optionalText(header.email),
    phone: optionalText(header.phone),
    address: optionalText(header.address),
    links: parseResumeHeaderLinks(header.links),
  });
}

export function sanitizeResumeHeaderSnapshot(
  raw: string | null | undefined,
): string | null {
  if (raw == null || raw.trim() === "") return null;
  return serializeResumeHeaderSnapshot(parseResumeHeaderSnapshot(raw));
}

export function buildResumeHeaderSnapshot(
  profile: ResumeHeaderProfileSource | null | undefined,
): string | null {
  if (!profile) return null;
  return serializeResumeHeaderSnapshot({
    fullName: optionalText(profile.fullName),
    headline: optionalText(profile.headline),
    email: optionalText(profile.email),
    phone: optionalText(profile.phone),
    address: optionalText(profile.address),
    links: parseResumeHeaderLinks(profile.linksData),
  });
}
