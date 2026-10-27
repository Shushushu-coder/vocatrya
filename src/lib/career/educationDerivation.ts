import type { PrismaClient } from "@prisma/client";

// Contract §4 / D5: derived values are assembled at read time only and never
// written back to any column. Only explicit "obtained" facts participate:
// graduationOn present AND graduationExpected=false. isCurrent=false alone is
// NOT proof of graduation, postdoctoral work is experience (excluded from
// degree levels), and MBA-style names never imply a different level than the
// explicit vocabulary value. Unknown stays unknown.

export const OBTAINED_DEGREE_WEIGHT: Readonly<Record<string, number>> = {
  博士: 5,
  硕士: 4,
  本科: 3,
  大专: 2,
};

const NON_LEVEL_DEGREES = new Set(["博士后"]);

// Date fields may arrive as ISO strings when the caller passes rows through a
// server action boundary; tolerate both.
type EducationLike = {
  id: string;
  isCurrent: boolean;
  endDate: Date | string | null;
  updatedAt: Date | string;
  educationDetail: {
    degree: string | null;
    locationText: string | null;
    graduationOn: string | null;
    graduationExpected: boolean;
  } | null;
};

export type DerivedEducationSummary = {
  /** Raw degree text of the selected explicitly-obtained record. */
  highestEducation: string | null;
  /** locationText of the selected record, passed through verbatim. */
  schoolCity: string | null;
  /** Graduation year ("YYYY") of the selected record, else manual fallback. */
  graduationCohort: string | null;
  /** Where graduationCohort came from. */
  cohortSource: "derived" | "manual" | "none";
  /** Degree of the strongest in-progress record, for separate annotation. */
  inProgressDegree: string | null;
};

function isObtained(item: EducationLike): boolean {
  const detail = item.educationDetail;
  if (!detail) return false;
  if (!detail.graduationOn) return false;
  if (detail.graduationExpected) return false;
  if (item.isCurrent) return false;
  return true;
}

function isInProgress(item: EducationLike): boolean {
  const detail = item.educationDetail;
  if (!detail) return false;
  return item.isCurrent || detail.graduationExpected === true;
}

function degreeWeight(item: EducationLike): number {
  const degree = item.educationDetail?.degree;
  if (!degree) return 0;
  if (NON_LEVEL_DEGREES.has(degree)) return -1;
  return OBTAINED_DEGREE_WEIGHT[degree] ?? 0;
}

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function graduationDate(item: EducationLike): Date | null {
  const detail = item.educationDetail;
  if (detail?.graduationOn) {
    const [year, month, day] = detail.graduationOn.split("-").map(Number);
    if (year && month && day) return new Date(Date.UTC(year, month - 1, day));
  }
  return toDate(item.endDate);
}

function compareCandidates(a: EducationLike, b: EducationLike): number {
  const weight = degreeWeight(b) - degreeWeight(a);
  if (weight !== 0) return weight;
  const aTime = graduationDate(a)?.getTime() ?? 0;
  const bTime = graduationDate(b)?.getTime() ?? 0;
  if (aTime !== bTime) return bTime - aTime;
  const aUpdated = toDate(a.updatedAt)?.getTime() ?? 0;
  const bUpdated = toDate(b.updatedAt)?.getTime() ?? 0;
  if (aUpdated !== bUpdated) return bUpdated - aUpdated;
  return a.id.localeCompare(b.id);
}

function graduationYear(item: EducationLike): string | null {
  const detail = item.educationDetail;
  if (detail?.graduationOn && /^\d{4}-\d{2}-\d{2}$/.test(detail.graduationOn)) {
    return detail.graduationOn.slice(0, 4);
  }
  const end = toDate(item.endDate);
  return end ? String(end.getUTCFullYear()) : null;
}

export function deriveEducationSummary(
  materials: EducationLike[],
  manualGraduationCohort: string | null | undefined,
): DerivedEducationSummary {
  // 博士后 is work experience, not a degree level — exclude those records from
  // every derived level rather than ranking them at the bottom.
  const levelRecords = materials.filter(
    (item) => degreeWeight(item) > 0,
  );
  const obtained = levelRecords.filter(isObtained);
  const inProgress = levelRecords.filter(isInProgress);

  const selected = obtained.length ? [...obtained].sort(compareCandidates)[0] : null;
  const current =
    inProgress.length > 0 ? [...inProgress].sort(compareCandidates)[0] : null;

  const derivedYear = selected ? graduationYear(selected) : null;
  return {
    highestEducation: selected?.educationDetail?.degree ?? null,
    schoolCity: selected?.educationDetail?.locationText ?? null,
    graduationCohort: derivedYear ?? manualGraduationCohort ?? null,
    cohortSource: derivedYear ? "derived" : manualGraduationCohort ? "manual" : "none",
    inProgressDegree: current?.educationDetail?.degree ?? null,
  };
}

export class EducationDerivationService {
  constructor(
    private readonly db: PrismaClient,
    private readonly userId: string,
  ) {}

  async getDerivedEducationSummary(): Promise<DerivedEducationSummary> {
    const [materials, profile] = await Promise.all([
      this.db.careerMaterialItem.findMany({
        where: { userId: this.userId, type: "EDUCATION", archivedAt: null },
        include: { educationDetail: true },
      }),
      this.db.candidateProfile.findUnique({
        where: { userId: this.userId },
        select: { graduationCohort: true },
      }),
    ]);
    return deriveEducationSummary(materials, profile?.graduationCohort);
  }
}
