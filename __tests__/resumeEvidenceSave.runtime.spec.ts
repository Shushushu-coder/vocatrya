// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { AB_RUNTIME_FEATURE_ENV, AB_ROLLOUT_SCOPE_ENV } from "@/lib/career/identities";
import { activateFreshAbNative } from "@/lib/career";
import {
  ResumeEvidenceSaveError,
  buildResumeEvidenceSavePlan,
  previewResumeEvidenceSavePlan,
  saveResumeEvidencePlan,
} from "@/lib/career/resumeEvidenceSave";
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";
import { savableDraft } from "./helpers/resumeEvidenceSaveDraft";

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
vi.mock("@/utils/user.utils", () => ({ getCurrentUser: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getCurrentUser } from "@/utils/user.utils";
import {
  confirmResumeEvidenceSave,
  previewResumeEvidenceSave,
} from "@/actions/resumeEvidenceSave.actions";

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let userId: string;

beforeAll(() => {
  process.env[AB_RUNTIME_FEATURE_ENV] = "true";
  process.env[AB_ROLLOUT_SCOPE_ENV] = "full";
});
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
  userId = await seedAccount(prisma, `re-save-${Date.now()}-${Math.random()}@example.com`);
  await activateFreshAbNative(prisma);
  vi.mocked(getCurrentUser).mockResolvedValue({
    id: userId,
    name: "T",
    email: "t@example.com",
  } as never);
});

const counts = async () => ({
  materials: await prisma.careerMaterialItem.count(),
  evidence: await prisma.careerEvidence.count(),
});

/** Proxy db whose transaction client fails the Nth careerEvidence.create. */
function failingDb(failOn: number): PrismaClient {
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === "$transaction") {
        return (fn: (tx: unknown) => Promise<unknown>) =>
          target.$transaction(async (tx) => {
            let n = 0;
            const wrapped = new Proxy(tx, {
              get(t, p) {
                if (p === "careerEvidence") {
                  return {
                    ...t.careerEvidence,
                    create: (args: never) => {
                      n += 1;
                      if (n === failOn) throw new Error("injected failure");
                      return t.careerEvidence.create(args);
                    },
                  };
                }
                return (t as never)[p];
              },
            });
            return fn(wrapped);
          });
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as PrismaClient;
}

describe("Resume Evidence save: transaction", () => {
  it("writes material + all evidence as USER_CONFIRMED", async () => {
    const plan = buildResumeEvidenceSavePlan(savableDraft());
    const res = await saveResumeEvidencePlan(prisma, userId, plan);
    expect(res.alreadySaved).toBe(false);
    expect(res.evidenceIds).toHaveLength(2);
    const item = await prisma.careerMaterialItem.findUniqueOrThrow({
      where: { id: res.materialId },
      include: { evidence: { orderBy: { sortOrder: "asc" } }, internshipDetail: true },
    });
    expect(item.verificationStatus).toBe("USER_CONFIRMED");
    expect(item.origin).toBe("USER");
    expect(item.title).toBe("Acme backend intern");
    expect(item.internshipDetail?.organizationName).toBe("Acme");
    expect(item.evidence.map((e) => e.verificationStatus)).toEqual([
      "USER_CONFIRMED",
      "USER_CONFIRMED",
    ]);
    expect(item.evidence.map((e) => e.kind)).toEqual(["FACT", "FACT"]);
    expect(item.evidence[1].metricText).toBe("30%");
    expect(item.evidence.map((e) => e.sortOrder)).toEqual([0, 1]);
  });

  it("writes nothing when the 2nd evidence fails (all or nothing)", async () => {
    const plan = buildResumeEvidenceSavePlan(savableDraft());
    await expect(
      saveResumeEvidencePlan(failingDb(2), userId, plan),
    ).rejects.toThrow("injected failure");
    expect(await counts()).toEqual({ materials: 0, evidence: 0 });
    // Retry with the same draft succeeds after the failure.
    const res = await saveResumeEvidencePlan(prisma, userId, plan);
    expect(res.alreadySaved).toBe(false);
    expect(await counts()).toEqual({ materials: 1, evidence: 2 });
  });

  it("is idempotent for sequential and concurrent double submits", async () => {
    const plan = buildResumeEvidenceSavePlan(savableDraft());
    const [a, b] = await Promise.all([
      saveResumeEvidencePlan(prisma, userId, plan),
      saveResumeEvidencePlan(prisma, userId, plan),
    ]);
    expect(a.materialId).toBe(b.materialId);
    expect(await counts()).toEqual({ materials: 1, evidence: 2 });
    const again = await saveResumeEvidencePlan(prisma, userId, plan);
    expect(again.alreadySaved).toBe(true);
    expect(again.materialId).toBe(a.materialId);
    expect(await counts()).toEqual({ materials: 1, evidence: 2 });
  });

  it("update_existing appends evidence only and leaves the material untouched", async () => {
    const first = await saveResumeEvidencePlan(
      prisma,
      userId,
      buildResumeEvidenceSavePlan(savableDraft()),
    );
    const plan = buildResumeEvidenceSavePlan(
      savableDraft((d) => {
        d.materialMapping.futureOperation = "update_existing";
        d.materialMapping.careerMaterialItemId = first.materialId;
        d.materialMapping.evidenceToAdd = [
          {
            content: "Wrote the runbook",
            metricText: null,
            kindOnWrite: "FACT",
            semanticRole: "output",
            basisFactIds: ["f1"],
            userAcceptedAsEvidence: true,
          },
        ];
      }),
    );
    const res = await saveResumeEvidencePlan(prisma, userId, plan);
    expect(res.materialId).toBe(first.materialId);
    const item = await prisma.careerMaterialItem.findUniqueOrThrow({
      where: { id: first.materialId },
      include: { evidence: { orderBy: { sortOrder: "asc" } } },
    });
    expect(item.title).toBe("Acme backend intern");
    expect(item.evidence).toHaveLength(3);
    expect(item.evidence[2].sortOrder).toBe(2);
    expect(item.evidence[2].verificationStatus).toBe("USER_CONFIRMED");
    expect((await saveResumeEvidencePlan(prisma, userId, plan)).alreadySaved).toBe(true);
    expect(await counts()).toEqual({ materials: 1, evidence: 3 });
  });

  it("rejects an update target owned by someone else", async () => {
    const other = await seedAccount(prisma, `re-other-${Date.now()}@example.com`);
    const mat = await prisma.careerMaterialItem.create({
      data: { userId: other, type: "INTERNSHIP", title: "x", internshipDetail: { create: {} } },
    });
    const plan = buildResumeEvidenceSavePlan(
      savableDraft((d) => {
        d.materialMapping.futureOperation = "update_existing";
        d.materialMapping.careerMaterialItemId = mat.id;
      }),
    );
    await expect(saveResumeEvidencePlan(prisma, userId, plan)).rejects.toMatchObject({
      code: "target_not_found",
    });
    expect((await counts()).evidence).toBe(0);
  });
});

describe("Resume Evidence save: update_existing field changes", () => {
  const evidenceOnly = [
    {
      content: "Wrote the runbook",
      metricText: null,
      kindOnWrite: "FACT" as const,
      semanticRole: "output" as const,
      basisFactIds: ["f1"],
      userAcceptedAsEvidence: true,
    },
  ];
  const seed = async () =>
    (
      await saveResumeEvidencePlan(prisma, userId, buildResumeEvidenceSavePlan(savableDraft()))
    ).materialId;

  it("previews old -> new for changed fields only and writes them with the evidence", async () => {
    const id = await seed();
    const plan = buildResumeEvidenceSavePlan(
      savableDraft((d) => {
        d.materialMapping.futureOperation = "update_existing";
        d.materialMapping.careerMaterialItemId = id;
        d.materialMapping.parent.title = "Acme platform intern";
        d.materialMapping.parent.endDate = null; // unknown: must not clear
        d.materialMapping.parent.isCurrent = null; // unknown: omitted
        d.materialMapping.detail = { organizationName: "Acme", roleTitle: "Platform Intern" };
        d.materialMapping.evidenceToAdd = evidenceOnly;
      }),
    );
    const pv = await previewResumeEvidenceSavePlan(prisma, userId, plan);
    expect(pv.targetTitle).toBe("Acme backend intern");
    expect(pv.changes).toEqual([
      { scope: "parent", field: "title", old: "Acme backend intern", new: "Acme platform intern" },
      { scope: "detail", field: "roleTitle", old: "Intern", new: "Platform Intern" },
    ]);
    // Preview alone writes nothing.
    expect((await counts()).evidence).toBe(2);

    // A different preview digest is refused and nothing changes.
    await expect(
      saveResumeEvidencePlan(prisma, userId, plan, { expectedDigest: "stale" }),
    ).rejects.toMatchObject({ code: "preview_mismatch" });

    const res = await saveResumeEvidencePlan(prisma, userId, plan, { expectedDigest: pv.digest });
    expect(res.alreadySaved).toBe(false);
    const item = await prisma.careerMaterialItem.findUniqueOrThrow({
      where: { id },
      include: { internshipDetail: true },
    });
    expect(item.title).toBe("Acme platform intern");
    expect(item.endDate?.toISOString().slice(0, 10)).toBe("2024-09-01");
    expect(item.internshipDetail?.roleTitle).toBe("Platform Intern");
    expect(item.internshipDetail?.organizationName).toBe("Acme");
    expect(item.verificationStatus).toBe("USER_CONFIRMED");
    expect(await counts()).toEqual({ materials: 1, evidence: 3 });

    // Repeating the confirmed save is a no-op.
    const again = await saveResumeEvidencePlan(prisma, userId, plan, { expectedDigest: pv.digest });
    expect(again.alreadySaved).toBe(true);
    expect(await counts()).toEqual({ materials: 1, evidence: 3 });
  });

  it("rolls the field changes back when the evidence append fails", async () => {
    const id = await seed();
    const plan = buildResumeEvidenceSavePlan(
      savableDraft((d) => {
        d.materialMapping.futureOperation = "update_existing";
        d.materialMapping.careerMaterialItemId = id;
        d.materialMapping.parent.title = "Changed title";
        d.materialMapping.detail = { roleTitle: "Changed role" };
        d.materialMapping.evidenceToAdd = [
          ...evidenceOnly,
          { ...evidenceOnly[0], content: "Second new fact" },
        ];
      }),
    );
    await expect(saveResumeEvidencePlan(failingDb(2), userId, plan)).rejects.toThrow("injected");
    const item = await prisma.careerMaterialItem.findUniqueOrThrow({
      where: { id },
      include: { internshipDetail: true },
    });
    expect(item.title).toBe("Acme backend intern");
    expect(item.internshipDetail?.roleTitle).toBe("Intern");
    expect((await counts()).evidence).toBe(2);
  });

  it("rejects a type mismatch", async () => {
    const id = await seed();
    const plan = buildResumeEvidenceSavePlan(
      savableDraft((d) => {
        d.materialMapping.futureOperation = "update_existing";
        d.materialMapping.careerMaterialItemId = id;
        d.materialMapping.type = "PROJECT";
        d.materialMapping.detail = {};
      }),
    );
    await expect(saveResumeEvidencePlan(prisma, userId, plan)).rejects.toMatchObject({
      code: "type_mismatch",
    });
  });
});

describe("Resume Evidence save: blockedWrites and detail coercion", () => {
  const errOf = (draft: unknown) => {
    try {
      buildResumeEvidenceSavePlan(draft);
    } catch (e) {
      return e as ResumeEvidenceSaveError;
    }
    return null;
  };
  const edu = (detail: Record<string, string>) =>
    savableDraft((d) => {
      d.materialMapping.type = "EDUCATION";
      d.materialMapping.parent.title = "Uni";
      d.materialMapping.detail = detail;
    });

  it("non-empty blockedWrites blocks the save (server)", async () => {
    const draft = savableDraft((d) => {
      d.materialMapping.blockedWrites = [
        { code: "DETAIL_COLUMN_NOT_ALLOWED", message: "x is not writable" },
      ];
    });
    expect(errOf(draft)?.code).toBe("blocked_writes");
    expect(await previewResumeEvidenceSave(draft)).toMatchObject({
      success: false,
      code: "blocked_writes",
    });
    expect(await confirmResumeEvidenceSave(draft, "x")).toMatchObject({
      success: false,
      code: "blocked_writes",
    });
    expect(await counts()).toEqual({ materials: 0, evidence: 0 });
  });

  it("coerces float and boolean detail strictly and stores typed values", async () => {
    const plan = buildResumeEvidenceSavePlan(
      edu({
        institution: "Uni",
        gpaValue: " 3.8 ",
        gpaScale: "4",
        graduationExpected: "是",
        isExchange: "No",
        hasNationalScholarship: "YES",
      }),
    );
    const res = await saveResumeEvidencePlan(prisma, userId, plan);
    const d = await prisma.careerEducationDetail.findUniqueOrThrow({
      where: { materialItemId: res.materialId },
    });
    expect(d.gpaValue).toBe(3.8);
    expect(d.gpaScale).toBe(4);
    expect(d.graduationExpected).toBe(true);
    expect(d.isExchange).toBe(false);
    expect(d.hasNationalScholarship).toBe(true);
  });

  it.each([
    ["gpaValue", "3.8/4"],
    ["gpaValue", "3.8分"],
    ["gpaValue", "abc"],
    ["gpaScale", "1e3"],
    ["graduationExpected", "maybe"],
    ["isExchange", "1"],
  ])("rejects %s=%s and names the field", async (field, value) => {
    const draft = edu({ institution: "Uni", [field]: value });
    const err = errOf(draft);
    expect(err?.code).toBe("invalid_detail");
    expect(err?.field).toBe(field);
    expect(await previewResumeEvidenceSave(draft)).toMatchObject({
      success: false,
      code: "invalid_detail",
      field,
    });
    expect(await counts()).toEqual({ materials: 0, evidence: 0 });
  });

  it("names a non-whitelisted detail field", () => {
    expect(errOf(edu({ institution: "Uni", favouriteColour: "red" }))).toMatchObject({
      code: "invalid_detail",
      field: "favouriteColour",
    });
  });
});

describe("Resume Evidence save: server-side validation", () => {
  it.each(["EMPLOYMENT", "CUSTOM"] as const)("rejects %s (draft-only)", (type) => {
    const draft = savableDraft((d) => {
      d.materialMapping.type = type;
      d.materialMapping.futureOperation = "draft_only";
    });
    try {
      buildResumeEvidenceSavePlan(draft);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ResumeEvidenceSaveError);
      expect((e as ResumeEvidenceSaveError).code).toBe("unsupported_type");
    }
  });

  it("rejects a tampered draft: invalid shape, unaccepted evidence, open conflict, early stage, bad detail", () => {
    const code = (draft: unknown) => {
      try {
        buildResumeEvidenceSavePlan(draft);
      } catch (e) {
        return (e as ResumeEvidenceSaveError).code;
      }
      return "none";
    };
    expect(code({ foo: 1 })).toBe("invalid_draft");
    expect(
      code(savableDraft((d) => (d.materialMapping.evidenceToAdd[0].userAcceptedAsEvidence = false))),
    ).toBe("evidence_not_accepted");
    expect(
      code(
        savableDraft((d) => {
          d.conflicts = [
            {
              id: "c1",
              topic: "t",
              left: { text: "a", sourceRefs: ["src-paste"] },
              right: { text: "b", sourceRefs: ["src-paste"] },
              resolution: "open",
            },
          ];
          d.session.sufficiency = { met: false, missingSlots: ["result"] };
          d.session.stage = "clarifying";
          d.next.questionBudget = 1;
        }),
      ),
    ).not.toBe("none");
    expect(code(savableDraft((d) => (d.session.stage = "summarizing")))).toBe("stage_not_ready");
    expect(code(savableDraft((d) => (d.materialMapping.detail = { structuredData: "x" })))).toBe(
      "invalid_detail",
    );
    expect(code(savableDraft((d) => (d.materialMapping.evidenceToAdd = [])))).toBe("no_evidence");
  });

  it("actions: preview then confirm writes; stale digest and unsupported type write nothing", async () => {
    const draft = savableDraft();
    const pv = await previewResumeEvidenceSave(draft);
    expect(pv.success).toBe(true);
    if (!pv.success || !pv.data) throw new Error("preview");
    expect(pv.data.verificationStatus).toBe("USER_CONFIRMED");
    expect(pv.data.evidence).toHaveLength(2);
    expect(await counts()).toEqual({ materials: 0, evidence: 0 });

    const stale = await confirmResumeEvidenceSave(draft, "deadbeef");
    expect(stale).toMatchObject({ success: false, code: "preview_mismatch" });
    expect(await counts()).toEqual({ materials: 0, evidence: 0 });

    const bad = savableDraft((d) => {
      d.materialMapping.type = "EMPLOYMENT";
      d.materialMapping.futureOperation = "draft_only";
    });
    expect(await previewResumeEvidenceSave(bad)).toMatchObject({
      success: false,
      code: "unsupported_type",
    });
    expect(await confirmResumeEvidenceSave(bad, pv.data.digest)).toMatchObject({
      success: false,
      code: "unsupported_type",
    });

    const ok = await confirmResumeEvidenceSave(draft, pv.data.digest);
    expect(ok).toMatchObject({ success: true, data: { evidenceCount: 2, alreadySaved: false } });
    const again = await confirmResumeEvidenceSave(draft, pv.data.digest);
    expect(again).toMatchObject({ success: true, data: { alreadySaved: true } });
    expect(await counts()).toEqual({ materials: 1, evidence: 2 });
  });
});

describe("Resume Evidence save: model-shaped draft", () => {
  /**
   * A raw JSON draft in the shape the field spec describes — what a real model
   * emits once it knows the contract (acceptance scenario: pasted experience +
   * user_turn confirmations, savable PROJECT type).
   */
  const modelShapedDraft = () => ({
    contractVersion: "resume-evidence-result/v0.1",
    skillId: "vocatrya.skill.resume-evidence-deep-dive",
    skillVersion: "0.1.0-proposal",
    artifactKind: "skill_result_draft",
    exampleKind: "model_output",
    session: {
      stage: "ready_to_stop",
      stopReason: null,
      roundIndex: 2,
      focus: null,
      sufficiency: { met: true, missingSlots: [] },
    },
    authorization: {
      scope: "single_experience",
      fullLibraryScanned: false,
      purpose: "unspecified",
      targetJdRef: null,
    },
    sourceRefs: [
      { ref: "src-paste", kind: "pasted_text", label: "经历原文", stableId: null, excerpt: "负责订单履约系统重构" },
      { ref: "src-turn-1", kind: "user_turn", label: "用户确认数字", stableId: null, excerpt: "P99 从 1.8s 降到 420ms 是我负责的" },
    ],
    confirmedFacts: [
      { id: "f-act", text: "定位超时热点并改写拆单协议。", slot: "action", epistemic: "source_material", sourceRefs: ["src-paste"], attribution: "personal" },
      { id: "f-met", text: "拆单接口 P99 从 1.8s 降到 420ms。", slot: "metric", epistemic: "user_stated", sourceRefs: ["src-turn-1"], attribution: "personal" },
    ],
    pending: [],
    conflicts: [],
    contributions: [
      { id: "c1", statement: "用户个人完成热点定位与协议改写。", attribution: "personal", actionIds: ["a1"], outcomeIds: ["o1"], sourceRefs: ["src-turn-1"], epistemic: "user_stated" },
    ],
    actions: [
      { id: "a1", statement: "定位超时热点，改写拆单协议。", actor: "personal", sourceRefs: ["src-paste"], epistemic: "source_material" },
    ],
    outcomes: [
      { id: "o1", statement: "拆单接口 P99 从 1.8s 降到 420ms。", quantified: true, metricText: "P99：1.8s → 420ms", attribution: "personal", sourceRefs: ["src-turn-1"], epistemic: "user_stated" },
    ],
    suggestedExpressions: [
      { id: "e1", text: "负责订单履约系统重构，拆单接口 P99 从 1.8s 降至 420ms。", basisFactIds: ["f-act", "f-met"], epistemic: "suggested_wording", userAcceptedWording: true, saveAuthorized: false },
    ],
    assumptions: [],
    skipped: [
      { id: "s1", slot: "evidence_pointer", reason: "user_unknown", note: "没有提供证据名称。" },
    ],
    materialMapping: {
      operation: "draft_only",
      careerMaterialItemId: null,
      type: "PROJECT",
      parent: { title: "订单履约系统重构", startDate: null, endDate: null, isCurrent: null, notes: null },
      detail: { roleTitle: "后端工程师", projectType: "履约系统" },
      evidenceToAdd: [
        { content: "定位超时热点并改写拆单协议。", metricText: null, kindOnWrite: "FACT", semanticRole: "action", basisFactIds: ["f-act"], userAcceptedAsEvidence: true },
        { content: "拆单接口 P99 从 1.8s 降到 420ms。", metricText: "P99：1.8s → 420ms", kindOnWrite: "FACT", semanticRole: "metric", basisFactIds: ["f-met"], userAcceptedAsEvidence: true },
      ],
      blockedWrites: [] as { code: string; message: string }[],
      verificationStatusOnWrite: "USER_AUTHORED",
      originOnWrite: "USER",
      callsExistingEntrypoints: [],
      futureOperation: "create_new",
      futureEntrypoints: ["createApplicationMaterial", "addApplicationMaterialEvidence"],
    },
    saveGate: {
      wordingAccepted: true,
      saveAuthorized: false,
      persisted: false,
      mustConfirmBeforeSave: ["素材标题与两条事实点措辞"],
    },
    next: {
      recommendation: "wait_for_save_confirmation",
      questionBudget: 0,
      userControls: ["纠正", "结束"],
    },
  });

  it("a spec-shaped draft validates, previews, confirms and reads back", async () => {
    const draft = modelShapedDraft();
    const pv = await previewResumeEvidenceSave(draft);
    expect(pv.success).toBe(true);
    if (!pv.success || !pv.data) throw new Error("preview failed");
    expect(pv.data).toMatchObject({
      operation: "create_new",
      type: "PROJECT",
      verificationStatus: "USER_CONFIRMED",
    });
    expect(await counts()).toEqual({ materials: 0, evidence: 0 });

    const ok = await confirmResumeEvidenceSave(draft, pv.data.digest);
    expect(ok).toMatchObject({ success: true, data: { evidenceCount: 2, alreadySaved: false } });
    if (!ok.success || !ok.data) throw new Error("confirm failed");

    // Re-read the stored rows.
    const item = await prisma.careerMaterialItem.findUniqueOrThrow({
      where: { id: ok.data.materialId },
      include: { evidence: { orderBy: { sortOrder: "asc" } }, projectDetail: true },
    });
    expect(item.verificationStatus).toBe("USER_CONFIRMED");
    expect(item.origin).toBe("USER");
    expect(item.title).toBe("订单履约系统重构");
    expect(item.projectDetail).toMatchObject({ roleTitle: "后端工程师", projectType: "履约系统" });
    expect(item.evidence.map((e) => [e.kind, e.verificationStatus, e.content])).toEqual([
      ["FACT", "USER_CONFIRMED", "定位超时热点并改写拆单协议。"],
      ["FACT", "USER_CONFIRMED", "拆单接口 P99 从 1.8s 降到 420ms。"],
    ]);
    expect(item.evidence[1].metricText).toBe("P99：1.8s → 420ms");

    // A repeat confirm is detected from stored rows, writing nothing new.
    const again = await confirmResumeEvidenceSave(draft, pv.data.digest);
    expect(again).toMatchObject({ success: true, data: { alreadySaved: true } });
    expect(await counts()).toEqual({ materials: 1, evidence: 2 });
  });

  it("the same draft with unaccepted evidence and a real blocked write saves nothing", async () => {
    const draft = modelShapedDraft();
    (draft.materialMapping.evidenceToAdd[0] as { userAcceptedAsEvidence: boolean }).userAcceptedAsEvidence = false;
    draft.materialMapping.blockedWrites = [
      { code: "DETAIL_COLUMN_NOT_ALLOWED", message: "salary 不在白名单" },
    ];
    await expect(previewResumeEvidenceSave(draft)).resolves.toMatchObject({
      success: false,
      code: "blocked_writes",
    });
    expect(await counts()).toEqual({ materials: 0, evidence: 0 });
    // Without the blocked write the unaccepted evidence is named instead.
    draft.materialMapping.blockedWrites = [];
    await expect(confirmResumeEvidenceSave(draft, "x")).resolves.toMatchObject({
      success: false,
      code: "evidence_not_accepted",
    });
    expect(await counts()).toEqual({ materials: 0, evidence: 0 });
  });

  it("actions refuse to write when career writes are disabled", async () => {
    process.env[AB_RUNTIME_FEATURE_ENV] = "false";
    delete process.env[AB_ROLLOUT_SCOPE_ENV];
    try {
      const draft = savableDraft();
      const res = await confirmResumeEvidenceSave(draft, "x");
      expect(res.success).toBe(false);
      expect(await counts()).toEqual({ materials: 0, evidence: 0 });
    } finally {
      process.env[AB_RUNTIME_FEATURE_ENV] = "true";
      process.env[AB_ROLLOUT_SCOPE_ENV] = "full";
    }
  });
});
