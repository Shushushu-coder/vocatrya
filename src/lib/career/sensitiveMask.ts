/**
 * Sensitive masking helpers for Application Profile V1.
 * Scope: emergency contact fields, ID number, and CandidateReferee contact
 * fields. These values only travel through their own masked overview /
 * reveal / field-level copy paths — never through projection or bulk copy.
 */

export function maskName(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  // Partial mask: keep first char, mask the rest. CJK single-char names keep 1 char + *.
  if ([...trimmed].length <= 1) return `${trimmed}*`;
  const chars = [...trimmed];
  return `${chars[0]}${"*".repeat(Math.max(chars.length - 1, 1))}`;
}

export function maskPhone(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length <= 4) return "****";
  return `****${digits.slice(-4)}`;
}

// keep local-part first char, mask the rest; domain stays readable.
export function maskEmail(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const at = trimmed.indexOf("@");
  if (at <= 0) return maskName(trimmed);
  const local = [...trimmed.slice(0, at)];
  const maskedLocal =
    local.length <= 1 ? `${local[0]}*` : `${local[0]}${"*".repeat(local.length - 1)}`;
  return `${maskedLocal}${trimmed.slice(at)}`;
}

// ID numbers keep their last 4 digits, matching the phone convention.
export function maskIdNumber(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 4) return "****";
  return `${"*".repeat(Math.max(trimmed.length - 4, 4))}${trimmed.slice(-4)}`;
}

export function isSensitiveFieldKey(key: string): boolean {
  return (
    key === "idType" ||
    key === "idNumber" ||
    key === "emergencyContactName" ||
    key === "emergencyContactRelation" ||
    key === "emergencyContactPhone" ||
    key === "refereeName" ||
    key === "refereeOrganization" ||
    key === "refereePosition" ||
    key === "refereeRelationship" ||
    key === "refereePhone" ||
    key === "refereeEmail" ||
    key === "refereeNote" ||
    key === "storageKey"
  );
}
