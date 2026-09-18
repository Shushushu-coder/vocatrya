/**
 * Sensitive masking helpers for Application Profile V1.
 * V1 scope: emergencyContactName / emergencyContactRelation / emergencyContactPhone.
 * idNumber and family members stay deferred even if schema/service exist.
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

export function isSensitiveFieldKey(key: string): boolean {
  return (
    key === "emergencyContactName" ||
    key === "emergencyContactRelation" ||
    key === "emergencyContactPhone"
  );
}
