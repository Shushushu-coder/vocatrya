import { auth } from "@/auth";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { deleteResumeById } from "@/actions/profile.actions";

// Test-only endpoint used by e2e fixtures to tear down what a test created:
// job and resume rows, plus the Library items (job titles / companies /
// locations) their comboboxes persist independently. Disabled in production
// so it can never delete real data.
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const userId = session.user.id;

  const {
    jobIds = [],
    resumes = [],
    tasks = [],
    questions = [],
    titles = [],
    companies = [],
    locations = [],
    activityTypes = [],
    activities = [],
    tags = [],
    mcpTokens = [],
    automations = [],
    contacts = [],
    contactRoles = [],
  }: {
    jobIds?: string[];
    resumes?: string[];
    tasks?: string[];
    questions?: string[];
    titles?: string[];
    companies?: string[];
    locations?: string[];
    activityTypes?: string[];
    activities?: string[];
    tags?: string[];
    mcpTokens?: string[];
    automations?: string[];
    contacts?: string[];
    contactRoles?: string[];
  } = await req.json();

  // Delete automations before resumes: Automation.resumeId is a required FK, so
  // a resume can't be removed while an automation references it. Deleting the
  // automation cascades its runs and nulls discovered jobs' automationId.
  if (automations.length > 0) {
    await prisma.automation.deleteMany({
      where: { name: { in: automations }, userId },
    });
  }

  // Delete jobs, resumes and tasks first (they/their sections reference the
  // Library items), so those items become unused and eligible for deletion.
  for (const title of resumes) {
    const rows = await prisma.resume.findMany({
      where: { title, profile: { userId } },
      select: { id: true },
    });
    // deleteResumeById cascades contact info / summary / experience /
    // education / sections within a transaction.
    for (const { id } of rows) {
      await deleteResumeById(id);
    }
  }
  for (const title of tasks) {
    const rows = await prisma.task.findMany({
      where: { title, userId },
      select: { id: true },
    });
    for (const { id } of rows) {
      // A task can't be deleted while an activity references it.
      await prisma.activity.deleteMany({ where: { taskId: id, userId } });
      await prisma.task.deleteMany({ where: { id, userId } });
    }
  }

  // Delete standalone activities (created directly on the activities page, not
  // through a task) by name before the Library teardown, so their activityType
  // reference count drops to zero and the type becomes eligible for deletion.
  // Starting an activity spawns a second running row with the same
  // activityName, so matching on name removes both.
  if (activities.length > 0) {
    await prisma.activity.deleteMany({
      where: { activityName: { in: activities }, userId },
    });
  }

  // Delete questions before tags below — deleteTagsByName only removes a tag
  // once its question/job/skill reference count is zero.
  if (questions.length > 0) {
    await prisma.question.deleteMany({
      where: { question: { in: questions }, createdBy: userId },
    });
  }

  // Delete contacts before the Library teardown: they reference companies,
  // locations and roles. Their job links cascade with them.
  if (contacts.length > 0) {
    await prisma.contact.deleteMany({
      where: { name: { in: contacts }, createdBy: userId },
    });
  }

  // Sources are never created by the tests (they select the seeded "Indeed"),
  // so they are intentionally not cleaned up here.
  // jobIds from A+B tests are JobOpportunity ids. Remove that owned graph
  // before Library rows. One transaction rolls the job and Library deletes
  // back together when a later restrict constraint still applies.
  try {
    await prisma.$transaction(async (tx) => {
      for (const id of jobIds) {
        await tx.job.deleteMany({ where: { id, userId } });
        await deleteOwnedOpportunity(tx, id, userId);
      }
      await deleteLibraryByName(tx, "jobTitle", titles, userId);
      await deleteLibraryByName(tx, "company", companies, userId);
      await deleteLibraryByName(tx, "location", locations, userId);
      await deleteLibraryByName(tx, "activityType", activityTypes, userId);
      await deleteLibraryByName(tx, "contactRole", contactRoles, userId);
      await deleteTagsByName(tx, tags, userId);
      if (mcpTokens.length > 0) {
        await tx.mcpAccessToken.deleteMany({
          where: { name: { in: mcpTokens }, userId },
        });
      }
    });
  } catch (error) {
    const code =
      error instanceof Prisma.PrismaClientKnownRequestError
        ? error.code
        : error instanceof CleanupBlockedError
          ? "CLEANUP_BLOCKED"
          : "CLEANUP_FAILED";
    return NextResponse.json(
      { error: "Cleanup failed", code },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}

// Tags are shared across jobs/questions/skills (not a single ref model like
// the Library types above), so they get their own reference count + delete.
async function deleteTagsByName(
  db: Prisma.TransactionClient,
  names: string[],
  userId: string,
) {
  for (const name of names) {
    const value = name.trim().toLowerCase();
    if (!value) continue;
    const tag = await db.tag.findFirst({
      where: { value, createdBy: userId },
      select: {
        id: true,
        _count: { select: { jobs: true, questions: true, skills: true } },
      },
    });
    if (!tag) continue;
    const { jobs, questions, skills } = tag._count;
    if (jobs + questions + skills > 0) continue;
    await db.tag.delete({ where: { id: tag.id } });
  }
}

type RefModel =
  | "jobTitle"
  | "company"
  | "location"
  | "activityType"
  | "contactRole";

// Count every place a Library row can still be referenced from, so we never
// delete one that another job or resume section still uses.
async function referenceCount(
  db: Prisma.TransactionClient,
  model: RefModel,
  refId: string,
): Promise<number> {
  if (model === "jobTitle") {
    return (
      (await db.job.count({ where: { jobTitleId: refId } })) +
      (await db.workExperience.count({ where: { jobTitleId: refId } }))
    );
  }
  if (model === "company") {
    // JobOpportunity and RecruitmentCampaign restrict Company. Count them
    // so a shared Library row is left in place instead of raising P2003.
    // Career detail rows set the company null on delete; counting them
    // avoids changing records this request does not own.
    return (
      (await db.job.count({ where: { companyId: refId } })) +
      (await db.workExperience.count({ where: { companyId: refId } })) +
      (await db.contact.count({
        where: { OR: [{ companyId: refId }, { workedAtCompanyId: refId }] },
      })) +
      (await db.jobOpportunity.count({ where: { companyId: refId } })) +
      (await db.recruitmentCampaign.count({ where: { companyId: refId } })) +
      (await db.careerInternshipDetail.count({ where: { companyId: refId } })) +
      (await db.careerEmploymentDetail.count({ where: { companyId: refId } }))
    );
  }
  if (model === "activityType") {
    return (
      (await db.activity.count({ where: { activityTypeId: refId } })) +
      (await db.task.count({ where: { activityTypeId: refId } }))
    );
  }
  if (model === "contactRole") {
    return (
      (await db.jobContact.count({ where: { roleId: refId } })) +
      (await db.contact.count({ where: { roleId: refId } }))
    );
  }
  return (
    (await db.job.count({ where: { locationId: refId } })) +
    (await db.workExperience.count({ where: { locationId: refId } })) +
    (await db.education.count({ where: { locationId: refId } })) +
    (await db.contact.count({ where: { locationId: refId } }))
  );
}

// Delete each named Library row (matched the same way the create actions store
// it: value = label.trim().toLowerCase()), scoped to the user and only when
// nothing references it anymore.
async function deleteLibraryByName(
  db: Prisma.TransactionClient,
  model: RefModel,
  names: string[],
  userId: string,
) {
  for (const name of names) {
    const value = name.trim().toLowerCase();
    if (!value) continue;
    const row = await (db[model] as any).findFirst({
      where: { value, createdBy: userId },
      select: { id: true },
    });
    if (!row) continue;
    if ((await referenceCount(db, model, row.id)) > 0) continue;
    await (db[model] as any).delete({ where: { id: row.id } });
  }
}

class CleanupBlockedError extends Error {
  constructor() {
    super("CLEANUP_BLOCKED");
    this.name = "CleanupBlockedError";
  }
}

// Deletes one JobOpportunity the caller named and owns, plus the attempt,
// process-step, and job-description rows that exist only for that id.
// Restrict links from another owner fail the surrounding transaction.
// SetNull links to resumes or other attempts are refused before any write.
async function deleteOwnedOpportunity(
  db: Prisma.TransactionClient,
  id: string,
  userId: string,
) {
  const owned = await db.jobOpportunity.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!owned) return;

  const resumeTargets = await db.resumeVariant.count({
    where: { targetJobOpportunityId: owned.id },
  });
  if (resumeTargets > 0) throw new CleanupBlockedError();

  const ownedAttempts = await db.applicationAttempt.findMany({
    where: { jobOpportunityId: owned.id, userId },
    select: { id: true },
  });
  const ownedAttemptIds = ownedAttempts.map((attempt) => attempt.id);
  if (ownedAttemptIds.length > 0) {
    const externalTransfers = await db.applicationAttempt.count({
      where: {
        transferredFromAttemptId: { in: ownedAttemptIds },
        NOT: { id: { in: ownedAttemptIds } },
      },
    });
    if (externalTransfers > 0) throw new CleanupBlockedError();
  }

  await db.jobOpportunity.update({
    where: { id: owned.id },
    data: { currentJdVersionId: null },
  });
  await db.jobDescriptionVersion.updateMany({
    where: { jobOpportunityId: owned.id },
    data: { currentParseId: null },
  });
  await db.applicationAttempt.deleteMany({
    where: { jobOpportunityId: owned.id, userId },
  });
  await db.jobDescriptionParse.deleteMany({
    where: { jobDescriptionVersion: { jobOpportunityId: owned.id } },
  });
  await db.jobDescriptionVersion.deleteMany({
    where: { jobOpportunityId: owned.id },
  });
  await db.jobOpportunity.delete({ where: { id: owned.id } });
}
