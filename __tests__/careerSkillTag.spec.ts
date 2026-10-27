// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
} from "@/lib/career/identities";
import { activateFreshAbNative, CareerRuntimeError } from "@/lib/career";
import { buildMaterialItemText } from "@/lib/career/applicationCopy";
import { CareerMaterialService } from "@/lib/career/careerMaterialService";
import { sanitizeApplicationMaterialDetail } from "@/lib/career/careerMaterialInput";
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
  createApplicationMaterial,
  setApplicationSkillTag,
  updateApplicationMaterial,
} from "@/actions/applicationProfile.actions";
import { deleteTagById, getTagList } from "@/actions/tag.actions";

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const FEATURE_ON = {
  ...process.env,
  [AB_RUNTIME_FEATURE_ENV]: "true",
  [AB_ROLLOUT_SCOPE_ENV]: "full",
};
const mockedUser = vi.mocked(getCurrentUser);

let userId: string;
let otherUserId: string;

function materials(uid = userId) {
  return new CareerMaterialService(prisma, uid, FEATURE_ON);
}

async function createTag(label: string, createdBy: string) {
  return prisma.tag.create({
    data: {
      label,
      value: label.trim().toLowerCase(),
      createdBy,
    },
  });
}

async function createSkill(title = "TypeScript") {
  const created = await createApplicationMaterial({
    type: "SKILL",
    title,
    detail: { skillName: title, proficiency: "advanced" },
  });
  if (!created.success) throw new Error(created.message);
  return (created.data as { id: string }).id;
}

// BD-LINKS: the dedicated setSkillTag channel owns CareerSkillDetail.tagId.
// These checks run the real action + service + SQLite path on an isolated
// database — ownership, SKILL typing, snapshot semantics, single name source,
// and the Tag delete guard including archived records.
describe("skill↔Tag link channel (isolated db)", () => {
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
      `skill-tag-${Date.now()}-${Math.random()}@example.com`,
    );
    otherUserId = await seedAccount(
      prisma,
      `skill-tag-other-${Date.now()}-${Math.random()}@example.com`,
    );
    mockedUser.mockResolvedValue({
      id: userId,
      name: "Test",
      email: "t@example.com",
    } as never);
    await activateFreshAbNative(prisma);
    process.env[AB_RUNTIME_FEATURE_ENV] = "true";
    process.env[AB_ROLLOUT_SCOPE_ENV] = "full";
  });

  it("rejects missing or malformed runtime identifiers without selecting a default row", async () => {
    const tag = await createTag("Runtime", userId);
    const id = await createSkill();
    for (const input of [
      { id, tagId: undefined }, { id, tagId: "" }, { id: undefined, tagId: tag.id },
      { id: "", tagId: tag.id }, { id, tagId: 123 },
    ]) {
      await expect(materials().setSkillTag(input as never)).rejects.toBeInstanceOf(CareerRuntimeError);
    }
    const detail = await prisma.careerSkillDetail.findUniqueOrThrow({ where: { materialItemId: id } });
    expect(detail.tagId).toBeNull();
    expect(detail.skillName).toBe("TypeScript");
  });

  it("concurrent link and free-text save cannot overwrite a linked name", async () => {
    const tag = await createTag("Concurrent", userId);
    const id = await createSkill();
    const results = await Promise.allSettled([
      materials().setSkillTag({ id, tagId: tag.id }),
      materials().update({ id, detail: { skillName: "Free Draft" } }),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const detail = await prisma.careerSkillDetail.findUniqueOrThrow({ where: { materialItemId: id } });
    if (detail.tagId) expect(detail.skillName).toBe(tag.label);
    else expect(detail.skillName).toBe("Free Draft");
  });

  it("concurrent link and tag deletion cannot leave a dangling reference", async () => {
    const tag = await createTag("Delete Race", userId);
    const id = await createSkill();
    const results = await Promise.all([
      materials().setSkillTag({ id, tagId: tag.id }).then(() => true, () => false),
      deleteTagById(tag.id).then((result) => result.success),
    ]);
    expect(results.some(Boolean)).toBe(true);
    const remaining = await prisma.tag.findUnique({ where: { id: tag.id } });
    const detail = await prisma.careerSkillDetail.findUniqueOrThrow({ where: { materialItemId: id } });
    if (!remaining) expect(detail.tagId).toBeNull();
    if (detail.tagId) {
      expect(remaining?.id).toBe(detail.tagId);
      expect(detail.skillName).toBe(tag.label);
    }
    expect(await prisma.$queryRawUnsafe("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("links a same-user tag, snapshots its label, and returns the relation", async () => {
    const tag = await createTag("React", userId);
    const id = await createSkill();

    const res = await setApplicationSkillTag({ id, tagId: tag.id });
    expect(res.success).toBe(true);

    const detail = await prisma.careerSkillDetail.findUniqueOrThrow({
      where: { materialItemId: id },
      include: { tag: true },
    });
    expect(detail.tagId).toBe(tag.id);
    expect(detail.skillName).toBe("React");
    expect(detail.tag?.label).toBe("React");

    // item.title stays independent.
    const item = await prisma.careerMaterialItem.findUniqueOrThrow({
      where: { id },
    });
    expect(item.title).toBe("TypeScript");
  });

  it("unlink keeps the last visible label as the text snapshot", async () => {
    const tag = await createTag("GraphQL", userId);
    const id = await createSkill();

    await setApplicationSkillTag({ id, tagId: tag.id });
    const res = await setApplicationSkillTag({ id, tagId: null });
    expect(res.success).toBe(true);

    const detail = await prisma.careerSkillDetail.findUniqueOrThrow({
      where: { materialItemId: id },
      include: { tag: true },
    });
    expect(detail.tagId).toBeNull();
    expect(detail.tag).toBeNull();
    expect(detail.skillName).toBe("GraphQL");
  });

  it("live tag renames surface through the relation without rewriting skillName", async () => {
    const tag = await createTag("Docker", userId);
    const id = await createSkill();
    await setApplicationSkillTag({ id, tagId: tag.id });

    await prisma.tag.update({
      where: { id: tag.id },
      data: { label: "Docker Compose" },
    });

    const item = await materials().get(id);
    const detail = item.skillDetail as unknown as {
      tagId: string | null;
      skillName: string | null;
      tag: { label: string } | null;
    };
    expect(detail.tag?.label).toBe("Docker Compose");
    // skillName is only the fallback snapshot — the rename does not cascade.
    expect(detail.skillName).toBe("Docker");
    const copied = buildMaterialItemText({
      title: item.title,
      skillDetail: { skillName: detail.skillName, proficiency: "advanced", tag: detail.tag },
    });
    expect(copied).toContain("Docker Compose (advanced)");
    expect(copied).not.toContain("Docker (advanced)");
  });

  it("rejects a tag owned by another user", async () => {
    const foreign = await createTag("Foreign", otherUserId);
    const id = await createSkill();

    const res = await setApplicationSkillTag({ id, tagId: foreign.id });
    expect(res.success).toBe(false);

    const detail = await prisma.careerSkillDetail.findUniqueOrThrow({
      where: { materialItemId: id },
    });
    expect(detail.tagId).toBeNull();
    expect(detail.skillName).toBe("TypeScript");
  });

  it("rejects non-SKILL materials and other users' records", async () => {
    const tag = await createTag("React", userId);
    const edu = await createApplicationMaterial({
      type: "EDUCATION",
      title: "Fudan",
      detail: { institution: "Fudan" },
    });
    if (!edu.success) throw new Error(edu.message);
    const wrong = await setApplicationSkillTag({
      id: (edu.data as { id: string }).id,
      tagId: tag.id,
    });
    expect(wrong.success).toBe(false);

    const foreignSkill = await prisma.careerMaterialItem.create({
      data: {
        userId: otherUserId,
        type: "SKILL",
        title: "Theirs",
        skillDetail: { create: { skillName: "Theirs" } },
      },
    });
    const stolen = await setApplicationSkillTag({
      id: foreignSkill.id,
      tagId: tag.id,
    });
    expect(stolen.success).toBe(false);
  });

  it("blocks tagId/tag through the generic detail patch path", () => {
    for (const key of ["tagId", "tag"]) {
      expect(() =>
        sanitizeApplicationMaterialDetail("SKILL", { [key]: "whatever" }),
      ).toThrow(CareerRuntimeError);
    }
  });

  it("refuses a skillName patch while the row is linked, allows it when free", async () => {
    const tag = await createTag("Rust", userId);
    const id = await createSkill();
    await setApplicationSkillTag({ id, tagId: tag.id });

    const blocked = await updateApplicationMaterial({
      id,
      detail: { skillName: "Competing Name" },
    });
    expect(blocked.success).toBe(false);
    const linked = await prisma.careerSkillDetail.findUniqueOrThrow({
      where: { materialItemId: id },
    });
    expect(linked.skillName).toBe("Rust");

    await setApplicationSkillTag({ id, tagId: null });
    const allowed = await updateApplicationMaterial({
      id,
      detail: { skillName: "Free Text" },
    });
    expect(allowed.success).toBe(true);
    const freed = await prisma.careerSkillDetail.findUniqueOrThrow({
      where: { materialItemId: id },
    });
    expect(freed.skillName).toBe("Free Text");
  });

  it("tag delete guard counts career skill references, including archived rows", async () => {
    const tag = await createTag("Kubernetes", userId);
    const active = await createSkill("Active");
    const archived = await createSkill("Archived");
    await setApplicationSkillTag({ id: active, tagId: tag.id });
    await setApplicationSkillTag({ id: archived, tagId: tag.id });
    await materials().archive(archived);

    const res = await deleteTagById(tag.id);
    expect(res.success).toBe(false);
    expect(res.message).toContain("cannot be deleted");
    expect(res.message).toContain("career skill record(s)");
    // The row must survive: SetNull is the safety net, not the guard.
    expect(await prisma.tag.findUnique({ where: { id: tag.id } })).not.toBeNull();

    await setApplicationSkillTag({ id: active, tagId: null });
    await setApplicationSkillTag({ id: archived, tagId: null });
    const freed = await deleteTagById(tag.id);
    expect(freed.success).toBe(true);
    expect(await prisma.tag.findUnique({ where: { id: tag.id } })).toBeNull();
  });

  it("tag list _count.careerSkillDetails includes archived material rows", async () => {
    const tag = await createTag("Terraform", userId);
    const active = await createSkill("Active");
    const archived = await createSkill("Archived");
    await setApplicationSkillTag({ id: active, tagId: tag.id });
    await setApplicationSkillTag({ id: archived, tagId: tag.id });
    await materials().archive(archived);

    const res = await getTagList(1, 50);
    const row = (res.data as Array<{ id: string; _count?: Record<string, number> }>).find(
      (item) => item.id === tag.id,
    );
    expect(row?._count?.careerSkillDetails).toBe(2);
  });
});
