// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { AB_RUNTIME_FEATURE_ENV, AB_ROLLOUT_SCOPE_ENV } from "@/lib/career/identities";
import { activateFreshAbNative } from "@/lib/career";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: ctx.url } } }),
  };
});

vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { getCurrentUser } from "@/utils/user.utils";
import {
  archiveResumeVariant,
  createResumeSection,
  createResumeVariant,
  getResumeVariant,
  listResumeVariants,
  renameResumeVariant,
} from "@/actions/resumeVariant.actions";
import {
  createApplicationProcessStep,
  saveInterviewReflection,
  attachAttemptResumeVersion,
} from "@/actions/application.actions";

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let userId: string;
const mockedUser = vi.mocked(getCurrentUser);

function setFeature(on: boolean, scope = "full") {
  if (on) {
    process.env[AB_RUNTIME_FEATURE_ENV] = "true";
    process.env[AB_ROLLOUT_SCOPE_ENV] = scope;
  } else {
    process.env[AB_RUNTIME_FEATURE_ENV] = "false";
    delete process.env[AB_ROLLOUT_SCOPE_ENV];
  }
}

afterAll(async () => {
  await prisma.$disconnect();
  delete process.env[AB_RUNTIME_FEATURE_ENV];
  delete process.env[AB_ROLLOUT_SCOPE_ENV];
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM flake.
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(
    prisma,
    `rv1-runtime-${Date.now()}-${Math.random()}@example.com`,
  );
  mockedUser.mockResolvedValue({
    id: userId,
    name: "Test",
    email: "t@example.com",
  } as never);
  setFeature(false);
});

describe("Resume Variant V1 runtime matrix", () => {
  it("AB_ENABLED: list/read/write succeed", async () => {
    await activateFreshAbNative(prisma);
    setFeature(true);
    const created = await createResumeVariant({ name: "Campus" });
    expect(created.success).toBe(true);
    const listed = await listResumeVariants();
    expect(listed.success).toBe(true);
    expect(
      (listed.success ? (listed.data as { name: string }[]) : []).map((row) => row.name),
    ).toEqual(["Campus"]);
    const id = created.success ? (created.data as { id: string }).id : "";
    const loaded = await getResumeVariant(id);
    expect(loaded.success).toBe(true);
    const renamed = await renameResumeVariant({ variantId: id, name: "Campus v2" });
    expect(renamed.success).toBe(true);
  });

  it("AB_READY_DISABLED: no variant fetch and actions denied", async () => {
    await activateFreshAbNative(prisma);
    setFeature(true);
    const created = await createResumeVariant({ name: "Hidden" });
    expect(created.success).toBe(true);
    setFeature(false);

    const listed = await listResumeVariants();
    expect(listed.success).toBe(false);
    expect(listed).not.toHaveProperty("data");
    const write = await createResumeSection({ versionId: "x", title: "Nope" });
    expect(write.success).toBe(false);
    const submit = await attachAttemptResumeVersion({
      attemptId: "attempt",
      submittedResumeVersionId: "version",
    });
    expect(submit.success).toBe(false);
  });

  it("LEGACY_ONLY: no variant fetch and actions denied", async () => {
    const listed = await listResumeVariants();
    expect(listed.success).toBe(false);
    expect(listed).not.toHaveProperty("data");
    const created = await createResumeVariant({ name: "Nope" });
    expect(created.success).toBe(false);
  });

  it("downgrade keeps rows and re-enable returns the same variant", async () => {
    await activateFreshAbNative(prisma);
    setFeature(true);
    const created = await createResumeVariant({ name: "Keep me" });
    expect(created.success).toBe(true);
    const id = created.success ? (created.data as { id: string }).id : "";

    setFeature(false);
    expect((await listResumeVariants()).success).toBe(false);
    expect(await prisma.resumeVariant.count({ where: { id } })).toBe(1);

    setFeature(true);
    const listed = await listResumeVariants();
    expect(listed.success).toBe(true);
    expect(
      (listed.success ? (listed.data as { id: string }[]) : []).map((row) => row.id),
    ).toEqual([id]);
    const loaded = await getResumeVariant(id);
    expect(loaded.success).toBe(true);
  });

  it("AB_ENABLED + none denies resume actions", async () => {
    await activateFreshAbNative(prisma);
    setFeature(true, "none");
    const listed = await listResumeVariants();
    expect(listed.success).toBe(false);
    const created = await createResumeVariant({ name: "Nope" });
    expect(created.success).toBe(false);
  });

  it("AB_ENABLED + resume_v1 allows resume and denies full A-side actions", async () => {
    await activateFreshAbNative(prisma);
    setFeature(true, "resume_v1");
    const created = await createResumeVariant({ name: "Scoped" });
    expect(created.success).toBe(true);
    const listed = await listResumeVariants();
    expect(listed.success).toBe(true);
    const step = await createApplicationProcessStep({
      jobOpportunityId: "opp",
      category: "INTERVIEW",
      label: "Nope",
    });
    expect(step.success).toBe(false);
    const reflection = await saveInterviewReflection({
      applicationProcessStepId: "step",
      items: [{ questionText: "Nope" }],
    });
    expect(reflection.success).toBe(false);
  });

  it("archive action hides the variant from the default list without deleting", async () => {
    await activateFreshAbNative(prisma);
    setFeature(true);
    const created = await createResumeVariant({ name: "Soon archived" });
    const id = created.success ? (created.data as { id: string }).id : "";
    const archived = await archiveResumeVariant(id);
    expect(archived.success).toBe(true);
    const listed = await listResumeVariants();
    expect(listed.success ? ((listed.data as { id: string }[]) ?? []) : []).toEqual([]);
    expect(
      (await prisma.resumeVariant.findUniqueOrThrow({ where: { id } })).archivedAt,
    ).not.toBeNull();
  });
});
