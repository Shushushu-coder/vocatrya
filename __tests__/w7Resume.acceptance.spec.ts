// @vitest-environment node
// W7 RM-RESUME service-level acceptance on an isolated migrated SQLite DB in
// fresh-native mode (activateFreshAbNative, no AB env overrides). Ordered
// checkpoints mirror the required user path; each expect remains a real gate.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { makeResumeExportTestContext } from "./helpers/resumeExportTestDb";
import { seedAccount } from "./helpers/backupTestDb";
import {
  activateFreshAbNative,
  CAREER_RUNTIME_MODE,
  resolveCareerRuntimeMode,
} from "@/lib/career";
import { CandidateProfileService } from "@/lib/career/candidateProfileService";
import { CareerMaterialService } from "@/lib/career/careerMaterialService";
import { ResumeVariantService } from "@/lib/career/resumeVariantService";
import { ResumeProvenanceService } from "@/lib/career/resumeProvenanceService";
import {
  ResumeArtifactService,
  resolveResumeArtifactStorageKey,
} from "@/lib/career/resumeArtifactService";
import {
  buildResumeHeaderSnapshot,
  parseResumeHeaderSnapshot,
} from "@/lib/career/resumeHeaderSnapshot";

const ctx = makeResumeExportTestContext();
const dbFile = ctx.url.slice("file:".length);
const checkpoints: { step: string; ok: boolean; detail: string }[] = [];
// Empty env exercises the fresh-default capability path, not an env override.
const env: NodeJS.ProcessEnv = {};
const PDF_BYTES = Buffer.from(
  "%PDF-1.7\n1 0 obj\n<< /W7-Check (resume-acceptance-验收字节) >>\nendobj\n%%EOF",
);

let db = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let userId = "";

const profileFor = () => new CandidateProfileService(db, userId, env);
const materialsFor = () => new CareerMaterialService(db, userId, env);
const variantsFor = () => new ResumeVariantService(db, userId, env);
const provenanceFor = () => new ResumeProvenanceService(db, userId, env);
const artifactsFor = () =>
  new ResumeArtifactService(db, userId, env, ctx.uploadsRoot);

function record(step: string, ok: boolean, detail: string) {
  checkpoints.push({ step, ok, detail });
}

async function reconnect() {
  await db.$disconnect();
  db = new PrismaClient({ datasources: { db: { url: ctx.url } } });
}

type GraphSection = {
  title: string;
  items: {
    materialTitleSnapshot: string | null;
    itemKind: string;
    careerMaterialItemId: string | null;
    expressions: { content: string; kind: string; evidenceStatus: string }[];
  }[];
};

function graphFingerprint(version: {
  headerSnapshot: string | null;
  sections: GraphSection[];
}) {
  return {
    header: parseResumeHeaderSnapshot(version.headerSnapshot),
    sections: version.sections.map((section) => ({
      title: section.title,
      items: section.items.map((item) => ({
        materialTitleSnapshot: item.materialTitleSnapshot,
        itemKind: item.itemKind,
        material: item.careerMaterialItemId,
        expressions: item.expressions.map((e) => e.content),
      })),
    })),
  };
}

afterAll(async () => {
  await db.$disconnect();
  const dir = path.resolve(".tmp", "mvp-w7-resume");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "service-checkpoints.json"),
    JSON.stringify(
      {
        dbFile,
        userId,
        checkpoints,
        allPassed: checkpoints.every((c) => c.ok),
      },
      null,
      2,
    ),
  );
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

it("W7: 素材→创建/复用→编辑重开→冻结→预览数据源→导出文件→重开", async () => {
  // A. fresh-native activation on a migrated empty database.
  const activation = await activateFreshAbNative(db);
  record("fresh-activation", activation.status === "FRESH_READY" && activation.verifiedAt != null, `status=${activation.status}`);
  const resolved = await resolveCareerRuntimeMode(db, { env });
  expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
  expect(resolved.origin).toBe("fresh");
  expect(resolved.rolloutScope).toBe("full");
  record("runtime-fresh-native", resolved.mode === "AB_ENABLED", `mode=${resolved.mode} origin=${resolved.origin} scope=${resolved.rolloutScope}`);

  userId = await seedAccount(db, `w7-${Date.now()}@example.com`);

  // B. Career profile + materials (the synthetic source data).
  await profileFor().upsertCandidateProfile(userId, {
    fullName: "王验收",
    headline: "后端开发应届生",
    email: "w7@example.com",
    phone: "13800001111",
    address: "上海市杨浦区",
    linksData: "https://github.com/w7-check\nhttps://w7.example.com",
  });
  const edu = await materialsFor().create({
    type: "EDUCATION",
    title: "南京大学 计算机科学与技术 本科",
    startDate: new Date("2021-09-01T00:00:00Z"),
    endDate: new Date("2025-06-30T00:00:00Z"),
    notes: "GPA 3.8/4.0，专业前 5%",
    detail: { institution: "南京大学", degree: "学士", fieldOfStudy: "计算机科学与技术", gpaValue: 3.8, gpaScale: 4, rankText: "前5%" },
  });
  const intern = await materialsFor().create({
    type: "INTERNSHIP",
    title: "示例科技 后端实习生",
    startDate: new Date("2024-07-01T00:00:00Z"),
    endDate: new Date("2024-09-30T00:00:00Z"),
    notes: "负责订单服务接口开发与单测补齐",
    detail: { organizationName: "示例科技", roleTitle: "后端实习生", department: "交易平台部" },
  });
  const skill = await materialsFor().create({
    type: "SKILL",
    title: "TypeScript 后端开发",
    detail: { skillName: "TypeScript", proficiency: "熟练" },
  });
  const evidence = await materialsFor().addEvidence({
    materialItemId: intern.id,
    kind: "METRIC",
    content: "订单接口 P99 延迟降低 32%",
  });
  const materialList = await materialsFor().list();
  expect(materialList.map((m) => m.id)).toEqual(
    expect.arrayContaining([edu.id, intern.id, skill.id]),
  );
  record("materials-seeded", materialList.length === 3, `materials=${materialList.length}`);

  // C. Create variant: header snapshot comes from the candidate profile,
  // sections reuse career materials via createSectionItem.
  const profile = await profileFor().getCandidateProfile(userId);
  const created = await variantsFor().createVariant({
    name: "W7 验收简历",
    headerSnapshot: buildResumeHeaderSnapshot(profile),
  });
  const v1 = created.currentVersionId!;
  const header = parseResumeHeaderSnapshot(
    (await variantsFor().getVersion(v1)).headerSnapshot,
  );
  expect(header).toMatchObject({
    fullName: "王验收",
    headline: "后端开发应届生",
    email: "w7@example.com",
    phone: "13800001111",
  });
  record("variant-created-profile-header", true, `variant=${created.id} v1=${v1}`);

  const sEdu = await variantsFor().createSection({ versionId: v1, title: "教育经历", systemKind: "EDUCATION" });
  const sExp = await variantsFor().createSection({ versionId: v1, title: "实习经历", systemKind: "EXPERIENCE" });
  const sSkill = await variantsFor().createSection({ versionId: v1, title: "技能", systemKind: "SKILLS" });

  const eduItem = await variantsFor().createSectionItem({ sectionId: sEdu.id, careerMaterialItemId: edu.id });
  expect(eduItem.materialTitleSnapshot).toBe(edu.title);
  expect(eduItem.itemKind).toBe("EDUCATION");
  const internItem = await variantsFor().createSectionItem({ sectionId: sExp.id, careerMaterialItemId: intern.id });
  expect(internItem.itemKind).toBe("INTERNSHIP");
  const skillItem = await variantsFor().createSectionItem({ sectionId: sSkill.id, careerMaterialItemId: skill.id });
  expect(skillItem.itemKind).toBe("SKILL");
  record("materials-into-resume", true, `items linked: edu/intern/skill`);

  const e1 = await variantsFor().createExpression({ itemId: eduItem.id, content: "南京大学 计算机科学与技术，GPA 3.8/4.0（前5%）", kind: "BODY" });
  const e2 = await variantsFor().createExpression({ itemId: internItem.id, content: "负责订单服务接口开发，补齐集成测试", kind: "BULLET" });
  const e3 = await variantsFor().createExpression({ itemId: internItem.id, content: "推动慢查询治理，P99 延迟降低 32%", kind: "BULLET" });
  await variantsFor().createExpression({ itemId: skillItem.id, content: "TypeScript / Node.js / Prisma / SQLite", kind: "BODY" });
  await provenanceFor().replaceExpressionEvidence({ expressionId: e3.id, evidenceIds: [evidence.id] });
  const linked = await provenanceFor().getExpressionEvidence(e3.id);
  expect(linked.map((row: { careerEvidenceId: string }) => row.careerEvidenceId)).toEqual([evidence.id]);
  record("expressions-evidence", true, `expressions=4 evidence=${evidence.id}`);

  // D. Edit draft, then reopen via a fresh client (simulated app restart).
  await variantsFor().updateHeaderSnapshot(v1, { fullName: "王验收", headline: "后端开发应届生 · 2025届", email: "w7@example.com", phone: "13800001111", address: "上海市杨浦区", links: ["https://github.com/w7-check", "https://w7.example.com"] });
  await variantsFor().updateExpression({ expressionId: e2.id, content: "负责订单服务接口开发与性能压测" });
  await reconnect();
  const reopened = await variantsFor().getVersion(v1);
  const fp1 = graphFingerprint(reopened);
  expect(fp1.header.headline).toBe("后端开发应届生 · 2025届");
  expect(reopened.sections).toHaveLength(3);
  expect(fp1.sections[1].items[0].expressions).toEqual([
    "负责订单服务接口开发与性能压测",
    "推动慢查询治理，P99 延迟降低 32%",
  ]);
  expect(reopened.status).toBe("DRAFT");
  record("edit-persist-reopen", true, `sections=${reopened.sections.length}`);

  // E. Freeze: v1 becomes immutable; every mutation path must reject.
  const frozen = await variantsFor().freeze(v1);
  expect(frozen.status).toBe("FROZEN");
  expect(frozen.frozenAt).not.toBeNull();
  record("freeze", true, `status=${frozen.status}`);

  const frozenFp = graphFingerprint(await variantsFor().getVersion(v1));
  await expect(variantsFor().createSection({ versionId: v1, title: "不应写入" })).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
  await expect(variantsFor().updateHeaderSnapshot(v1, { fullName: "篡改" })).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
  await expect(variantsFor().updateExpression({ expressionId: e1.id, content: "篡改" })).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
  await expect(variantsFor().deleteSectionItem(eduItem.id)).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
  await expect(variantsFor().freeze(v1)).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
  expect(graphFingerprint(await variantsFor().getVersion(v1))).toEqual(frozenFp);
  record("frozen-mutations-rejected", true, "section/header/expression/delete/refreeze all rejected");

  // F. Continue editing: the draft edit clones v1 into a new DRAFT v2 and the
  // frozen v1 stays byte-identical.
  const v2 = await variantsFor().editVersion(v1, { locale: "zh-CN" });
  expect(v2.id).not.toBe(v1);
  expect(v2.versionNumber).toBe(2);
  expect(v2.status).toBe("DRAFT");
  expect(v2.parentVersionId).toBe(v1);
  const v2graph = await variantsFor().getVersion(v2.id);
  expect(graphFingerprint(v2graph).sections).toEqual(frozenFp.sections);
  const sExtra = await variantsFor().createSection({ versionId: v2.id, title: "项目经历", systemKind: "PROJECTS" });
  const manualItem = await variantsFor().createSectionItem({ sectionId: sExtra.id });
  await variantsFor().createExpression({ itemId: manualItem.id, content: "校园二手交易平台后端（个人项目）", kind: "BODY" });
  const v1After = graphFingerprint(await variantsFor().getVersion(v1));
  expect(v1After).toEqual(frozenFp);
  const versions = await variantsFor().listVariantVersions(created.id);
  expect(versions.map((row) => [row.versionNumber, row.status])).toEqual([
    [1, "FROZEN"],
    [2, "DRAFT"],
  ]);
  record("edit-after-freeze-isolated", true, `v2=${v2.id} v1 unchanged`);

  // G. Preview data source + real export file round-trip.
  const previewSource = await variantsFor().getVersion(v1);
  expect(previewSource.sections.map((s) => s.title)).toEqual(["教育经历", "实习经历", "技能"]);
  expect(previewSource.sections[1].items[0].materialTitleSnapshot).toBe(intern.title);
  record("preview-datasource", true, "getVersion feeds ResumePreview/print page");

  const artifact = await artifactsFor().createExport(v1, PDF_BYTES);
  const storedPath = resolveResumeArtifactStorageKey(artifact.storageKey, ctx.uploadsRoot);
  const onDisk = await fs.promises.readFile(storedPath);
  expect(onDisk.equals(PDF_BYTES)).toBe(true);
  expect(artifact.sha256).toBe(createHash("sha256").update(PDF_BYTES).digest("hex"));
  expect(artifact.fileName).toBe("王验收_W7 验收简历.pdf");
  const downloaded = await artifactsFor().openForDownload(artifact.id);
  expect(downloaded.bytes.equals(PDF_BYTES)).toBe(true);
  const reused = await artifactsFor().findReusableExport(v1);
  expect(reused?.id).toBe(artifact.id);
  const again = await artifactsFor().createExport(v1, Buffer.from("%PDF-other"));
  expect(again.id).toBe(artifact.id);
  await expect(artifactsFor().createExport(v2.id, PDF_BYTES)).rejects.toMatchObject({ code: "VERSION_NOT_IMMUTABLE" });
  record("export-artifact-file", true, `file=${storedPath} bytes=${onDisk.length}`);

  // H. Second restart: everything survives a new connection.
  await reconnect();
  const resolvedAgain = await resolveCareerRuntimeMode(db, { env });
  expect(resolvedAgain.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
  const variants = await variantsFor().listVariants();
  expect(variants).toHaveLength(1);
  expect(variants[0].name).toBe("W7 验收简历");
  expect(variants[0].currentVersion?.versionNumber).toBe(2);
  const v1Reopened = await variantsFor().getVersion(v1);
  expect(v1Reopened.status).toBe("FROZEN");
  expect(graphFingerprint(v1Reopened)).toEqual(frozenFp);
  const v2Reopened = await variantsFor().getVersion(v2.id);
  expect(v2Reopened.sections.map((s) => s.title)).toEqual(["教育经历", "实习经历", "技能", "项目经历"]);
  const artifactAgain = await artifactsFor().findReusableExport(v1);
  expect(artifactAgain?.id).toBe(artifact.id);
  expect((await artifactsFor().openForDownload(artifact.id)).bytes.equals(PDF_BYTES)).toBe(true);
  record("restart-consistency", true, "variant/v1-frozen/v2-draft/artifact all consistent");
});
