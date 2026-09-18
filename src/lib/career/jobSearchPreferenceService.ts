import type { PrismaClient } from "@prisma/client";
import { assertAbWritesAllowed } from "./writeGuard";
import { normalizeOptionalText } from "./opportunityService";

export type JobSearchPreferenceInput = {
  targetRoles?: string | null;
  preferredCities?: string | null;
  preferredIndustries?: string | null;
  recruitmentTypes?: string | null;
  availability?: string | null;
  hardConstraints?: string | null;
  softPreferences?: string | null;
};

function optionalText(value: string | null | undefined) {
  return normalizeOptionalText(value);
}

export class JobSearchPreferenceService {
  constructor(
    private readonly db: PrismaClient,
    private readonly userId: string,
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  private async gate(): Promise<void> {
    await assertAbWritesAllowed(this.db, this.env);
  }

  async getJobSearchPreference(userId: string = this.userId) {
    return this.db.jobSearchPreference.findUnique({ where: { userId } });
  }

  async upsertJobSearchPreference(userId: string, input: JobSearchPreferenceInput) {
    await this.gate();
    const data = {
      targetRoles: optionalText(input.targetRoles),
      preferredCities: optionalText(input.preferredCities),
      preferredIndustries: optionalText(input.preferredIndustries),
      recruitmentTypes: optionalText(input.recruitmentTypes),
      availability: optionalText(input.availability),
      hardConstraints: optionalText(input.hardConstraints),
      softPreferences: optionalText(input.softPreferences),
    };
    return this.db.jobSearchPreference.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });
  }
}
