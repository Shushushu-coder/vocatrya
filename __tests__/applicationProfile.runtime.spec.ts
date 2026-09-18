// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { AB_RUNTIME_FEATURE_ENV } from "@/lib/career/identities";
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
  archiveApplicationMaterial,
  createApplicationMaterial,
  getApplicationCandidateProfile,
  getApplicationMaterial,
  getApplicationProjection,
  getEmergencyContactOverview,
  getJobSearchPreference,
  listApplicationMaterials,
  updateApplicationCandidateProfile,
  updateApplicationMaterial,
  upsertJobSearchPreference,
} from "@/actions/applicationProfile.actions";

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let userId: string;
const mockedUser = vi.mocked(getCurrentUser);

function setFeature(on: boolean) {
  if (on) process.env[AB_RUNTIME_FEATURE_ENV] = "true";
  else delete process.env[AB_RUNTIME_FEATURE_ENV];
}

beforeAll(() => {
  // schema already pushed in hoisted ctx.
});

afterAll(async () => {
  await prisma.$disconnect();
  delete process.env[AB_RUNTIME_FEATURE_ENV];
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM flake.
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, `app-profile-${Date.now()}-${Math.random()}@example.com`);
  mockedUser.mockResolvedValue({ id: userId, name: "Test", email: "t@example.com" } as never);
  setFeature(false);
});

describe("application profile runtime matrix (actions)", () => {
  it("AB_ENABLED: read succeeds", async () => {
    await activateFreshAbNative(prisma);
    setFeature(true);
    const res = await getApplicationCandidateProfile();
    expect(res.success).toBe(true);
    const pref = await getJobSearchPreference();
    expect(pref.success).toBe(true);
    const mats = await listApplicationMaterials();
    expect(mats.success).toBe(true);
  });

  it("AB_ENABLED: write succeeds", async () => {
    await activateFreshAbNative(prisma);
    setFeature(true);
    const res = await updateApplicationCandidateProfile({ fullName: "Matrix Write", email: "m@example.com" });
    expect(res.success).toBe(true);
    const pref = await upsertJobSearchPreference({ targetRoles: "Frontend" });
    expect(pref.success).toBe(true);
    const mat = await createApplicationMaterial({ type: "EDUCATION", title: "Uni", detail: { institution: "Uni" } });
    expect(mat.success).toBe(true);
  });

  it("AB_READY_DISABLED: read/write/copy denied and no B data returned", async () => {
    await activateFreshAbNative(prisma);
    setFeature(true);
    await updateApplicationCandidateProfile({ fullName: "Hidden Fixture" });
    await upsertJobSearchPreference({ targetRoles: "Backend" });
    setFeature(false);

    const read = await getApplicationCandidateProfile();
    expect(read.success).toBe(false);
    expect(read).not.toHaveProperty("data");

    const pref = await getJobSearchPreference();
    expect(pref.success).toBe(false);
    expect(pref).not.toHaveProperty("data");

    const mats = await listApplicationMaterials();
    expect(mats.success).toBe(false);
    expect(mats).not.toHaveProperty("data");

    const proj = await getApplicationProjection();
    expect(proj.success).toBe(false);
    expect(proj).not.toHaveProperty("data");

    const sensitive = await getEmergencyContactOverview();
    expect(sensitive.success).toBe(false);
    expect(sensitive).not.toHaveProperty("data");

    const write = await updateApplicationCandidateProfile({ fullName: "Blocked" });
    expect(write.success).toBe(false);

    const writePref = await upsertJobSearchPreference({ targetRoles: "Blocked" });
    expect(writePref.success).toBe(false);

    const writeMat = await createApplicationMaterial({ type: "EDUCATION", title: "Blocked" });
    expect(writeMat.success).toBe(false);

    // DB rows remain.
    expect(await prisma.candidateProfile.count({ where: { userId } })).toBe(1);
  });

  it("LEGACY_ONLY: read/write denied and no B data returned", async () => {
    // No migration state -> LEGACY_ONLY.
    const read = await getApplicationCandidateProfile();
    expect(read.success).toBe(false);
    expect(read).not.toHaveProperty("data");
    const write = await updateApplicationCandidateProfile({ fullName: "Blocked" });
    expect(write.success).toBe(false);
    const mats = await listApplicationMaterials();
    expect(mats.success).toBe(false);
    expect(mats).not.toHaveProperty("data");
  });

  it("downgrade preserves rows and re-enable restores same values (actions)", async () => {
    await activateFreshAbNative(prisma);
    setFeature(true);
    await updateApplicationCandidateProfile({ fullName: "Downgrade Action", email: "d@example.com" });
    const created = await createApplicationMaterial({ type: "PROJECT", title: "Downgrade Project" });
    expect(created.success).toBe(true);
    const matId = created.success ? (created.data as { id: string }).id : "";

    setFeature(false);
    const hidden = await getApplicationCandidateProfile();
    expect(hidden.success).toBe(false);
    expect(await prisma.candidateProfile.count({ where: { userId } })).toBe(1);
    expect(await prisma.careerMaterialItem.findUnique({ where: { id: matId } })).not.toBeNull();

    setFeature(true);
    const restored = await getApplicationCandidateProfile();
    expect(restored.success).toBe(true);
    if (restored.success) {
      expect((restored.data as { fullName: string }).fullName).toBe("Downgrade Action");
    }
    const restoredMat = await getApplicationMaterial(matId);
    expect(restoredMat.success).toBe(true);
  }, 60_000);

  it("archived materials are excluded from list/get", async () => {
    await activateFreshAbNative(prisma);
    setFeature(true);
    const created = await createApplicationMaterial({ type: "SKILL", title: "TS" });
    const id = created.success ? (created.data as { id: string }).id : "";
    const archived = await archiveApplicationMaterial(id);
    expect(archived.success).toBe(true);
    const listed = await listApplicationMaterials();
    expect(listed.success).toBe(true);
    if (listed.success) {
      expect((listed.data as unknown[]).length).toBe(0);
    }
    const direct = await getApplicationMaterial(id);
    expect(direct.success).toBe(false);
  });
});

describe("application profile material detail whitelist (actions)", () => {
  async function enableAb() {
    await activateFreshAbNative(prisma);
    setFeature(true);
  }

  it("rejects structuredData injection and does not write", async () => {
    await enableAb();
    const before = await prisma.careerMaterialItem.count({ where: { userId } });
    const res = await createApplicationMaterial({
      type: "EDUCATION",
      title: "Test",
      detail: {
        institution: "Test University",
        structuredData: "{\"evil\":true}",
      },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.message).toBe("Invalid material detail field.");
      expect(res.message).not.toContain("evil");
    }
    expect(await prisma.careerMaterialItem.count({ where: { userId } })).toBe(before);
  });

  it("rejects companyId injection", async () => {
    await enableAb();
    const before = await prisma.careerMaterialItem.count({ where: { userId } });
    const res = await createApplicationMaterial({
      type: "INTERNSHIP",
      title: "Intern",
      detail: { organizationName: "Test", companyId: "some-id" },
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.message).toBe("Invalid material detail field.");
    expect(await prisma.careerMaterialItem.count({ where: { userId } })).toBe(before);
  });

  it("rejects cross-type fields", async () => {
    await enableAb();
    const before = await prisma.careerMaterialItem.count({ where: { userId } });
    const res = await createApplicationMaterial({
      type: "SKILL",
      title: "Python",
      detail: { skillName: "Python", gpaValue: 4 },
    });
    expect(res.success).toBe(false);
    expect(await prisma.careerMaterialItem.count({ where: { userId } })).toBe(before);
  });

  it("rejects unknown fields", async () => {
    await enableAb();
    const before = await prisma.careerMaterialItem.count({ where: { userId } });
    const res = await createApplicationMaterial({
      type: "EDUCATION",
      title: "Uni",
      detail: { institution: "X", arbitraryKey: "x" },
    });
    expect(res.success).toBe(false);
    expect(await prisma.careerMaterialItem.count({ where: { userId } })).toBe(before);
  });

  it("saves valid EDUCATION / INTERNSHIP / SKILL details without extra fields", async () => {
    await enableAb();
    const education = await createApplicationMaterial({
      type: "EDUCATION",
      title: "BSc",
      detail: { institution: "Test University", degree: "BSc", gpaValue: 3.7 },
    });
    expect(education.success).toBe(true);
    const educationId = education.success ? (education.data as { id: string }).id : "";
    const educationDetail = await prisma.careerEducationDetail.findUniqueOrThrow({
      where: { materialItemId: educationId },
    });
    expect(educationDetail.institution).toBe("Test University");
    expect(educationDetail.degree).toBe("BSc");
    expect(educationDetail.gpaValue).toBe(3.7);
    expect(educationDetail.structuredData).toBe("{}");

    const internship = await createApplicationMaterial({
      type: "INTERNSHIP",
      title: "Intern",
      detail: { organizationName: "Test", roleTitle: "Intern" },
    });
    expect(internship.success).toBe(true);
    const internshipId = internship.success ? (internship.data as { id: string }).id : "";
    const internshipDetail = await prisma.careerInternshipDetail.findUniqueOrThrow({
      where: { materialItemId: internshipId },
    });
    expect(internshipDetail.organizationName).toBe("Test");
    expect(internshipDetail.roleTitle).toBe("Intern");
    expect(internshipDetail.companyId).toBeNull();
    expect(internshipDetail.structuredData).toBe("{}");

    const skill = await createApplicationMaterial({
      type: "SKILL",
      title: "Python",
      detail: { skillName: "Python", proficiency: "advanced" },
    });
    expect(skill.success).toBe(true);
    const skillId = skill.success ? (skill.data as { id: string }).id : "";
    const skillDetail = await prisma.careerSkillDetail.findUniqueOrThrow({
      where: { materialItemId: skillId },
    });
    expect(skillDetail.skillName).toBe("Python");
    expect(skillDetail.proficiency).toBe("advanced");
    expect(skillDetail.structuredData).toBe("{}");
  });

  it("rejects empty create titles after trim", async () => {
    await enableAb();
    const before = await prisma.careerMaterialItem.count({ where: { userId } });
    const res = await createApplicationMaterial({ type: "EDUCATION", title: "   " });
    expect(res.success).toBe(false);
    expect(await prisma.careerMaterialItem.count({ where: { userId } })).toBe(before);
  });

  it("rejects structuredData on update and leaves the row unchanged", async () => {
    await enableAb();
    const created = await createApplicationMaterial({
      type: "EDUCATION",
      title: "Keep",
      detail: { institution: "Keep U" },
    });
    expect(created.success).toBe(true);
    const id = created.success ? (created.data as { id: string }).id : "";
    const before = await prisma.careerEducationDetail.findUniqueOrThrow({
      where: { materialItemId: id },
    });
    const res = await updateApplicationMaterial({
      id,
      detail: { institution: "Keep U", structuredData: "{\"evil\":true}" },
    });
    expect(res.success).toBe(false);
    const after = await prisma.careerEducationDetail.findUniqueOrThrow({
      where: { materialItemId: id },
    });
    expect(after.institution).toBe("Keep U");
    expect(after.structuredData).toBe(before.structuredData);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});
