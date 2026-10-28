import { CareerRuntimeError } from "./errors";

export const CANDIDATE_GENDER = ["男", "女", "保密", "其他"] as const;
export type CandidateGender = (typeof CANDIDATE_GENDER)[number];

export const CANDIDATE_POLITICAL_STATUS = [
  "中共党员",
  "中共预备党员",
  "共青团员",
  "群众",
  "其他",
] as const;
export type CandidatePoliticalStatus =
  (typeof CANDIDATE_POLITICAL_STATUS)[number];

const GENDER_SET = new Set<string>(CANDIDATE_GENDER);
const POLITICAL_STATUS_SET = new Set<string>(CANDIDATE_POLITICAL_STATUS);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function optionalText(value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  return value.trim() || null;
}

export function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function assertGender(value: string | null | undefined): string | null | undefined {
  const text = optionalText(value);
  if (text === undefined || text === null) return text;
  if (!GENDER_SET.has(text)) {
    throw new CareerRuntimeError("INVALID_GENDER", "Invalid gender.");
  }
  return text;
}

export function assertPoliticalStatus(
  value: string | null | undefined,
): string | null | undefined {
  const text = optionalText(value);
  if (text === undefined || text === null) return text;
  if (!POLITICAL_STATUS_SET.has(text)) {
    throw new CareerRuntimeError(
      "INVALID_POLITICAL_STATUS",
      "Invalid political status.",
    );
  }
  return text;
}

export function assertBirthDate(
  value: string | null | undefined,
): string | null | undefined {
  const text = optionalText(value);
  if (text === undefined || text === null) return text;
  if (!isValidIsoDate(text)) {
    throw new CareerRuntimeError(
      "INVALID_BIRTH_DATE",
      "Birth date must be a valid YYYY-MM-DD calendar date.",
    );
  }
  return text;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[+()\-.\s\d]{5,30}$/;
const PHONE_COUNTRY_CODE_PATTERN = /^\+?\d{1,4}$/;

export function assertPhoneCountryCode(
  value: string | null | undefined,
): string | null | undefined {
  const text = optionalText(value);
  if (text === undefined || text === null) return text;
  if (!PHONE_COUNTRY_CODE_PATTERN.test(text)) {
    throw new CareerRuntimeError(
      "INVALID_PHONE_COUNTRY_CODE",
      "Invalid phone country code.",
    );
  }
  return text;
}

export function assertEmail(
  value: string | null | undefined,
): string | null | undefined {
  const text = optionalText(value);
  if (text === undefined || text === null) return text;
  if (!EMAIL_PATTERN.test(text) || text.length > 254) {
    throw new CareerRuntimeError("INVALID_EMAIL", "Invalid email address.");
  }
  return text;
}

export function assertPhone(
  value: string | null | undefined,
): string | null | undefined {
  const text = optionalText(value);
  if (text === undefined || text === null) return text;
  const digits = text.replace(/\D/g, "");
  if (!PHONE_PATTERN.test(text) || digits.length < 5 || digits.length > 15) {
    throw new CareerRuntimeError("INVALID_PHONE", "Invalid phone number.");
  }
  return text;
}
