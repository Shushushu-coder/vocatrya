import type { PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import { assertResumeV1Writable } from "./capabilities";
import { normalizeOptionalText } from "./opportunityService";

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

export type CandidateProfileInput = {
  fullName?: string | null;
  headline?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  linksData?: string | null;
  extraData?: string | null;
  gender?: string | null;
  birthDate?: string | null;
  ethnicity?: string | null;
  politicalStatus?: string | null;
  nativePlace?: string | null;
  householdRegistration?: string | null;
  graduationCohort?: string | null;
  countryOrRegion?: string | null;
  wechatId?: string | null;
  qqNumber?: string | null;
  currentCity?: string | null;
  homeCity?: string | null;
  homeAddress?: string | null;
  phoneCountryCode?: string | null;
};

export type CandidateSensitiveInfoInput = {
  idType?: string | null;
  idNumber?: string | null;
  emergencyContactName?: string | null;
  emergencyContactRelation?: string | null;
  emergencyContactPhone?: string | null;
};

export type CandidateFamilyMemberInput = {
  name?: string | null;
  relation?: string | null;
  employer?: string | null;
  position?: string | null;
  phone?: string | null;
};

function optionalText(
  value: string | null | undefined,
): string | null | undefined {
  return normalizeOptionalText(value);
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

function assertGender(value: string | null | undefined): string | null | undefined {
  const text = optionalText(value);
  if (text === undefined || text === null) return text;
  if (!GENDER_SET.has(text)) {
    throw new CareerRuntimeError("INVALID_GENDER", "Invalid gender.");
  }
  return text;
}

function assertPoliticalStatus(
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

function assertBirthDate(
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

function assertPhoneCountryCode(
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

export class CandidateProfileService {
  constructor(
    private readonly db: PrismaClient,
    private readonly userId: string,
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  private async gate(): Promise<void> {
    await assertResumeV1Writable(this.db, this.env);
  }

  async getCandidateProfile(userId: string = this.userId) {
    return this.db.candidateProfile.findUnique({ where: { userId } });
  }

  async upsertCandidateProfile(
    userId: string,
    input: CandidateProfileInput,
  ) {
    await this.gate();
    const data = {
      fullName: optionalText(input.fullName),
      headline: optionalText(input.headline),
      email: assertEmail(input.email),
      phone: assertPhone(input.phone),
      address: optionalText(input.address),
      linksData: optionalText(input.linksData),
      extraData: optionalText(input.extraData),
      gender: assertGender(input.gender),
      birthDate: assertBirthDate(input.birthDate),
      ethnicity: optionalText(input.ethnicity),
      politicalStatus: assertPoliticalStatus(input.politicalStatus),
      nativePlace: optionalText(input.nativePlace),
      householdRegistration: optionalText(input.householdRegistration),
      graduationCohort: optionalText(input.graduationCohort),
      countryOrRegion: optionalText(input.countryOrRegion),
      wechatId: optionalText(input.wechatId),
      qqNumber: optionalText(input.qqNumber),
      currentCity: optionalText(input.currentCity),
      homeCity: optionalText(input.homeCity),
      homeAddress: optionalText(input.homeAddress),
      phoneCountryCode: assertPhoneCountryCode(input.phoneCountryCode),
    };
    return this.db.candidateProfile.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });
  }

  async getCandidateSensitiveInfo(userId: string = this.userId) {
    return this.db.candidateSensitiveInfo.findUnique({
      where: { userId },
      include: {
        familyMembers: { orderBy: { sortOrder: "asc" } },
        referees: {
          where: { archivedAt: null },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        },
      },
    });
  }

  async upsertCandidateSensitiveInfo(
    userId: string,
    input: CandidateSensitiveInfoInput,
  ) {
    await this.gate();
    const data = {
      idType: optionalText(input.idType),
      idNumber: optionalText(input.idNumber),
      emergencyContactName: optionalText(input.emergencyContactName),
      emergencyContactRelation: optionalText(input.emergencyContactRelation),
      emergencyContactPhone: assertPhone(input.emergencyContactPhone),
    };
    try {
      return await this.db.candidateSensitiveInfo.upsert({
        where: { userId },
        update: data,
        create: {
          userId,
          ...data,
        },
      });
    } catch {
      throw new CareerRuntimeError(
        "SENSITIVE_INFO_WRITE_FAILED",
        "Could not save candidate sensitive information.",
      );
    }
  }

  async replaceCandidateFamilyMembers(
    userId: string,
    members: CandidateFamilyMemberInput[],
  ) {
    await this.gate();
    const sensitive = await this.db.candidateSensitiveInfo.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!sensitive) {
      throw new CareerRuntimeError(
        "SENSITIVE_INFO_MISSING",
        "Candidate sensitive information does not exist.",
      );
    }
    const rows = members.map((member, index) => ({
      sensitiveInfoId: sensitive.id,
      name: optionalText(member.name) ?? null,
      relation: optionalText(member.relation) ?? null,
      employer: optionalText(member.employer) ?? null,
      position: optionalText(member.position) ?? null,
      phone: optionalText(member.phone) ?? null,
      sortOrder: (index + 1) * 10,
    }));
    try {
      await this.db.$transaction(async (tx) => {
        await tx.candidateFamilyMember.deleteMany({
          where: { sensitiveInfoId: sensitive.id },
        });
        if (rows.length > 0) {
          await tx.candidateFamilyMember.createMany({ data: rows });
        }
      });
    } catch {
      throw new CareerRuntimeError(
        "FAMILY_MEMBER_WRITE_FAILED",
        "Could not save candidate family members.",
      );
    }
    return this.getCandidateSensitiveInfo(userId);
  }
}
