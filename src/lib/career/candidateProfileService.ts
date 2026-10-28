import {
  assertGender,
  assertPoliticalStatus,
  assertBirthDate,
  assertPhoneCountryCode,
  assertEmail,
  assertPhone,
} from "./candidateProfileValidation";
export {
  CANDIDATE_GENDER,
  CANDIDATE_POLITICAL_STATUS,
  isValidIsoDate,
  assertGender,
  assertPoliticalStatus,
  assertBirthDate,
  assertPhoneCountryCode,
  assertEmail,
  assertPhone,
} from "./candidateProfileValidation";
export type { CandidateGender, CandidatePoliticalStatus } from "./candidateProfileValidation";
import type { PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import { assertResumeV1Writable } from "./capabilities";
import { normalizeOptionalText } from "./opportunityService";

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
