import { describe, expect, it } from "vitest";
import { buildAutoApplyExport } from "@/lib/extensions/autoApply/convert";
import { loadAutoApplySource } from "@/lib/extensions/autoApply/source";
import { parseSectionSelection } from "@/lib/extensions/autoApply/sections";
import {
  PROFILE_BACKUP_FORMAT,
  PROFILE_BACKUP_VERSION,
  PROFILE_SCHEMA_VERSION,
  UPSTREAM_COMMIT,
  UPSTREAM_SECTION_KEYS,
} from "@/lib/extensions/autoApply/upstreamContract";
import type {
  AutoApplySource,
  AutoApplySourceMaterial,
  UpstreamRepeatItem,
  UpstreamRepeatSection,
  UpstreamSimpleSection,
} from "@/lib/extensions/autoApply/types";

// --- synthetic source ------------------------------------------------------

function sourceProfile(overrides: Record<string, unknown> = {}) {
  return {
    fullName: "张三",
    headline: "后端工程师",
    email: "zhangsan@example.com",
    phone: "13800000000",
    phoneCountryCode: "+86",
    address: "杭州市西湖区示例路 1 号",
    linksData: JSON.stringify([
      { label: "GitHub", url: "https://github.com/zhangsan" },
      { label: "个人主页", url: "https://zhangsan.dev" },
    ]),
    gender: "男",
    birthDate: "2001-03-05",
    ethnicity: "汉族",
    politicalStatus: "共青团员",
    nativePlace: "浙江省杭州市",
    householdRegistration: "浙江省杭州市",
    graduationCohort: "2026届",
    countryOrRegion: "中国",
    wechatId: "zs_wechat",
    qqNumber: "100000001",
    currentCity: "杭州市",
    homeCity: "宁波市",
    homeAddress: "宁波市海曙区示例街 2 号",
    updatedAt: "2026-11-10T08:00:00.000Z",
    hasExtraData: false,
    ...overrides,
  };
}

function material(overrides: Partial<AutoApplySourceMaterial> = {}): AutoApplySourceMaterial {
  return {
    id: "mat-1",
    type: "EDUCATION",
    title: "示例大学",
    startDate: "2024-09-01",
    endDate: "2027-06-30",
    isCurrent: false,
    notes: null,
    updatedAt: "2026-11-10T09:00:00.000Z",
    detail: {},
    hasStructuredData: false,
    evidence: [],
    ...overrides,
  };
}

function makeSource(overrides: Partial<AutoApplySource> = {}): AutoApplySource {
  return {
    profile: sourceProfile(),
    preference: {
      targetRoles: "后端开发工程师",
      preferredCities: "杭州、上海",
      preferredIndustries: "互联网",
      recruitmentTypes: "校园招聘",
      availability: "随时到岗",
      updatedAt: "2026-11-09T00:00:00.000Z",
      hasConstraints: false,
      hasSoftPreferences: false,
    },
    materials: [
      material({
        detail: {
          institution: "示例大学",
          degree: "硕士",
          fieldOfStudy: "软件工程",
          studyMode: "全日制",
          locationText: "杭州市",
          department: "计算机学院",
          gpaValue: 3.8,
          gpaScale: 4,
          rankMajorText: "前10%",
          researchDirection: "分布式系统",
        },
      }),
      material({
        id: "mat-2",
        type: "INTERNSHIP",
        title: "示例科技-后端实习",
        startDate: "2025-07-01",
        endDate: null,
        isCurrent: true,
        notes: "参与网申系统开发，负责表单配置模块。",
        detail: {
          organizationName: "示例科技有限公司",
          roleTitle: "后端开发实习生",
          department: "平台研发部",
          locationText: "杭州市",
        },
        evidence: [
          { content: "完成 3 个核心模块", metricText: "覆盖 20+ 页面" },
          { content: "接口响应优化", metricText: null },
        ],
      }),
    ],
    ...overrides,
  };
}

const ALL_KEYS = [
  "basic", "intention", "education", "internship", "work", "project",
  "student", "awards", "language", "computer", "certificates", "papers", "other",
] as const;

function simple(backup: ReturnType<typeof buildAutoApplyExport>["backup"], key: string) {
  return backup.profileV2.sections[key] as UpstreamSimpleSection;
}
function repeat(backup: ReturnType<typeof buildAutoApplyExport>["backup"], key: string) {
  return backup.profileV2.sections[key] as UpstreamRepeatSection;
}

// --- upstream import replica (mirrors options.js at the pinned commit) -----

const UPSTREAM_KNOWN = [
  "basic", "intention", "education", "internship", "work", "performance",
  "project", "student", "awards", "language", "computer", "certificates",
  "family", "training", "papers", "patent", "self", "declarations", "other",
];

function upstreamNormalizeValues(values: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!values || typeof values !== "object" || Array.isArray(values)) return result;
  for (const [label, value] of Object.entries(values)) {
    const cleanLabel = String(label).trim();
    const cleanValue = String(value == null ? "" : value).trim();
    if (cleanLabel && cleanValue) result[cleanLabel] = cleanValue;
  }
  return result;
}

function upstreamNormalizeCustom(rows: unknown) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      label: String((row as { label?: unknown })?.label ?? "").trim(),
      value: String((row as { value?: unknown })?.value ?? "").trim(),
    }))
    .filter((row) => row.label && row.value);
}

function upstreamImport(jsonText: string) {
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.format !== "OpenJobAutofillProfileBackup" ||
    !parsed.profileV2
  ) {
    throw new Error("当前只支持导入 OpenJobAutofill 导出的资料备份文件。");
  }
  const pv2 = parsed.profileV2 as Record<string, unknown>;
  const sourceSections =
    pv2.sections && typeof pv2.sections === "object"
      ? (pv2.sections as Record<string, Record<string, unknown>>)
      : {};
  const sections: Record<string, unknown> = {};
  for (const key of UPSTREAM_KNOWN) {
    const input = sourceSections[key];
    const meta = { kind: key === "basic" || key === "self" || key === "declarations" || key === "other" ? "simple" : "repeat" };
    if (meta.kind === "repeat") {
      const items = Array.isArray(input?.items)
        ? (input!.items as UpstreamRepeatItem[])
            .map((item) => ({
              title: String(item?.title ?? "").slice(0, 120),
              values: upstreamNormalizeValues(item?.values),
              custom: upstreamNormalizeCustom(item?.custom),
            }))
            .filter((item) => Object.keys(item.values).length > 0 || item.custom.length > 0)
        : [];
      sections[key] = { kind: "repeat", items };
    } else {
      sections[key] = {
        kind: "simple",
        values: upstreamNormalizeValues(input?.values),
        custom: upstreamNormalizeCustom(input?.custom),
      };
    }
  }
  return { sections };
}

// --- tests -----------------------------------------------------------------

describe("buildAutoApplyExport envelope", () => {
  it("produces a backup envelope accepted by the upstream importer", () => {
    const { backup } = buildAutoApplyExport(makeSource(), [...ALL_KEYS], {
      now: new Date("2026-11-13T10:00:00.000Z"),
      appVersion: "1.2.0-beta.2",
    });
    expect(backup.format).toBe(PROFILE_BACKUP_FORMAT);
    expect(backup.version).toBe(PROFILE_BACKUP_VERSION);
    expect(backup.exportedAt).toBe("2026-11-13T10:00:00.000Z");
    expect(backup.profileV2.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    // Source metadata identifies origin/version/time without breaking import.
    expect(backup.source.app).toBe("Vocatrya");
    expect(backup.source.upstreamCommit).toBe(UPSTREAM_COMMIT);
    expect(backup.source.channel).toBe("manual-export");
    // updatedAt = latest source timestamp (material updatedAt wins here).
    expect(backup.profileV2.updatedAt).toBe("2026-11-10T09:00:00.000Z");
    // Only known upstream section keys are ever emitted.
    for (const key of Object.keys(backup.profileV2.sections)) {
      expect(UPSTREAM_SECTION_KEYS.has(key)).toBe(true);
    }
  });

  it("round-trips through the upstream import/normalize path", () => {
    const { backup } = buildAutoApplyExport(makeSource(), [...ALL_KEYS]);
    const fileText = JSON.stringify(backup, null, 2);
    const imported = upstreamImport(fileText) as {
      sections: Record<string, { kind: string; items?: { values: Record<string, string>; custom: { label: string; value: string }[] }[]; values?: Record<string, string>; custom?: { label: string; value: string }[] }>;
    };
    const basic = imported.sections.basic;
    expect(basic.values?.["姓名"]).toBe("张三");
    expect(basic.values?.["电话"]).toBe("13800000000");
    expect(basic.values?.["邮箱"]).toBe("zhangsan@example.com");
    const education = imported.sections.education;
    expect(education.items).toHaveLength(1);
    expect(education.items?.[0].values["学校"]).toBe("示例大学");
    expect(education.items?.[0].values["开始时间"]).toBe("2024-09");
    expect(education.items?.[0].values["结束时间"]).toBe("2027-06");
    const internship = imported.sections.internship;
    expect(internship.items?.[0].values["公司"]).toBe("示例科技有限公司");
    expect(internship.items?.[0].values["结束时间"]).toBe("至今");
    // The Vocatrya metadata block is ignored by upstream, not an error.
    expect((imported.sections.other.values as Record<string, string>)["GitHub"]).toBe(
      "https://github.com/zhangsan",
    );
    expect((imported.sections.other.values as Record<string, string>)["个人主页"]).toBe(
      "https://zhangsan.dev",
    );
  });
});

describe("field mapping", () => {
  it("maps basic profile fields to upstream labels", () => {
    const { backup } = buildAutoApplyExport(makeSource(), [...ALL_KEYS]);
    const values = simple(backup, "basic").values;
    expect(values["姓名"]).toBe("张三");
    expect(values["性别"]).toBe("男");
    expect(values["出生日期"]).toBe("2001-03-05");
    expect(values["民族"]).toBe("汉族");
    expect(values["政治面貌"]).toBe("共青团员");
    expect(values["籍贯"]).toBe("浙江省杭州市");
    expect(values["户籍"]).toBe("浙江省杭州市");
    expect(values["现居住城市"]).toBe("杭州市");
    expect(values["微信号"]).toBe("zs_wechat");
    expect(values["QQ"]).toBe("100000001");
    const custom = simple(backup, "basic").custom;
    const customMap = Object.fromEntries(custom.map((row) => [row.label, row.value]));
    expect(customMap["职业标签"]).toBe("后端工程师");
    expect(customMap["电话国家区号"]).toBe("+86");
    expect(customMap["家庭所在城市"]).toBe("宁波市");
  });

  it("maps education detail fields including gpa and ranks", () => {
    const { backup } = buildAutoApplyExport(makeSource(), [...ALL_KEYS]);
    const item = repeat(backup, "education").items[0];
    expect(item.values["学校"]).toBe("示例大学");
    expect(item.values["专业"]).toBe("软件工程");
    expect(item.values["学位"]).toBe("硕士");
    expect(item.values["学习形式"]).toBe("全日制");
    expect(item.values["学院（院系）"]).toBe("计算机学院");
    expect(item.values["成绩"]).toBe("3.8/4");
    expect(item.values["专业排名"]).toBe("前10%");
    expect(item.values["研究方向"]).toBe("分布式系统");
  });

  it("maps internship with notes as 工作内容 and evidence as 工作成果", () => {
    const { backup } = buildAutoApplyExport(makeSource(), [...ALL_KEYS]);
    const item = repeat(backup, "internship").items[0];
    expect(item.values["公司"]).toBe("示例科技有限公司");
    expect(item.values["部门"]).toBe("平台研发部");
    expect(item.values["职位"]).toBe("后端开发实习生");
    expect(item.values["工作内容"]).toBe("参与网申系统开发，负责表单配置模块。");
    expect(item.values["工作成果"]).toContain("完成 3 个核心模块");
    expect(item.values["工作成果"]).toContain("覆盖 20+ 页面");
    expect(item.values["结束时间"]).toBe("至今");
  });

  it("maps job preference into a single intention item", () => {
    const { backup } = buildAutoApplyExport(makeSource(), [...ALL_KEYS]);
    const items = repeat(backup, "intention").items;
    expect(items).toHaveLength(1);
    expect(items[0].values["意向岗位"]).toBe("后端开发工程师");
    expect(items[0].values["期望工作城市"]).toBe("杭州、上海");
    const customMap = Object.fromEntries(items[0].custom.map((row) => [row.label, row.value]));
    expect(customMap["期望行业"]).toBe("互联网");
    expect(customMap["可到岗时间"]).toBe("随时到岗");
  });
});

describe("section selection", () => {
  it("exports only selected sections and leaves others empty", () => {
    const { backup } = buildAutoApplyExport(makeSource(), ["basic"]);
    expect(simple(backup, "basic").values["姓名"]).toBe("张三");
    expect(repeat(backup, "education").items).toHaveLength(0);
    expect(repeat(backup, "internship").items).toHaveLength(0);
    expect(simple(backup, "other").values["GitHub"]).toBeUndefined();
  });

  it("never fills sensitive sections even when asked via selection", () => {
    // family / declarations are not selectable: parse drops them.
    const selection = parseSectionSelection("basic,family,declarations,xyz");
    expect(selection.sections).toEqual(["basic"]);
    expect(selection.ignored).toEqual(["family", "declarations", "xyz"]);
    const { backup } = buildAutoApplyExport(makeSource(), selection.sections);
    expect(repeat(backup, "family").items).toHaveLength(0);
    expect((simple(backup, "declarations").values)).toEqual({});
  });

  it("parses a missing sections param as all exportable sections", () => {
    expect(parseSectionSelection(null).sections).toHaveLength(ALL_KEYS.length);
    expect(parseSectionSelection("").sections).toHaveLength(ALL_KEYS.length);
    expect(parseSectionSelection("garbage").sections).toHaveLength(0);
  });
});

describe("sensitive data exclusion", () => {
  it("never reads or emits sensitive records; whitelist drops extras", async () => {
    const sentinel = "SENTINEL-SHOULD-NOT-EXPORT";
    const fakeDb = {
      candidateProfile: {
        findUnique: async () => ({
          ...sourceProfile(),
          // Fields outside the whitelist — must never reach the export.
          extraData: sentinel,
          id: sentinel,
          userId: sentinel,
          createdAt: sentinel,
        }),
      },
      candidateSensitiveInfo: {
        findUnique: async () => {
          throw new Error("sensitive table must not be queried");
        },
      },
      candidateFamilyMember: {
        findMany: async () => {
          throw new Error("family table must not be queried");
        },
      },
      jobSearchPreference: {
        findUnique: async () => ({
          targetRoles: "后端开发工程师",
          preferredCities: null,
          preferredIndustries: null,
          recruitmentTypes: null,
          availability: null,
          hardConstraints: sentinel,
          softPreferences: sentinel,
          updatedAt: "2026-11-09T00:00:00.000Z",
        }),
      },
      careerMaterialItem: {
        findMany: async () => [
          {
            id: "mat-edu",
            userId: sentinel,
            type: "EDUCATION",
            title: "示例大学",
            startDate: new Date("2024-09-01T00:00:00.000Z"),
            endDate: null,
            isCurrent: false,
            notes: null,
            origin: "USER",
            verificationStatus: "USER_AUTHORED",
            archivedAt: null,
            createdAt: sentinel,
            updatedAt: "2026-11-10T09:00:00.000Z",
            educationDetail: {
              id: sentinel,
              materialItemId: sentinel,
              companyId: sentinel,
              institution: "示例大学",
              degree: "硕士",
              structuredData: `{"leak":"${sentinel}"}`,
              createdAt: sentinel,
              updatedAt: sentinel,
            },
            attachments: [{ storageKey: sentinel }],
            evidence: [
              { id: sentinel, content: "成绩事实", metricText: "GPA 3.9", kind: "FACT", materialItemId: sentinel },
            ],
          },
        ],
      },
    };

    const source = await loadAutoApplySource(fakeDb as never, "user-1");
    expect(source.profile?.hasExtraData).toBe(true);
    const { backup, report } = buildAutoApplyExport(source, [...ALL_KEYS]);
    const serialized = JSON.stringify(backup);
    expect(serialized).not.toContain(sentinel);
    expect(report.unsupported.some((note) => note.includes("extraData"))).toBe(true);
    expect(report.unsupported.some((note) => note.includes("扩展结构数据"))).toBe(true);
    expect(report.unsupported.some((note) => note.includes("硬性约束"))).toBe(true);
    // Evidence content is user-authored non-sensitive data and flows through.
    const edu = repeat(backup, "education").items[0];
    expect(edu.custom.some((row) => row.label === "补充事实" && row.value.includes("成绩事实"))).toBe(true);
    // Sensitive categories are reported as excluded.
    expect(report.sensitiveExcluded.join()).toContain("证件");
    expect(report.sensitiveExcluded.join()).toContain("紧急联系人");
    expect(report.sensitiveExcluded.join()).toContain("家庭成员");
    expect(report.sensitiveExcluded.join()).toContain("附件");
    expect(report.sensitiveExcluded.join()).toContain("凭据");
  });
});

describe("report: missing / ambiguous / unsupported", () => {
  it("reports missing core basic fields", () => {
    const source = makeSource({
      profile: sourceProfile({ email: null, phone: null, fullName: null }),
    });
    const { report } = buildAutoApplyExport(source, ["basic"]);
    const basic = report.sections.find((s) => s.key === "basic");
    expect(basic?.missing).toEqual(expect.arrayContaining(["姓名", "电话", "邮箱"]));
  });

  it("flags degree→学位 ambiguity and unmapped material types", () => {
    const source = makeSource({
      materials: [
        material({ detail: { institution: "示例大学", degree: "硕士" } }),
        material({ id: "r1", type: "RESEARCH", title: "科研组" }),
        material({ id: "c1", type: "CUSTOM", title: "自由材料" }),
      ],
    });
    const { report } = buildAutoApplyExport(source, [...ALL_KEYS]);
    expect(report.ambiguous.some((n) => n.includes("学历"))).toBe(true);
    expect(report.unsupported.some((n) => n.includes("科研经历"))).toBe(true);
    expect(report.unsupported.some((n) => n.includes("自定义材料"))).toBe(true);
  });
});

describe("re-import after profile update", () => {
  it("a later export carries the new data and a newer updatedAt", () => {
    const first = buildAutoApplyExport(makeSource(), [...ALL_KEYS], {
      now: new Date("2026-11-13T10:00:00.000Z"),
    });
    const updatedSource = makeSource({
      materials: [
        ...makeSource().materials,
        material({
          id: "mat-3",
          title: "第二学位",
          updatedAt: "2026-11-13T12:00:00.000Z",
          detail: { institution: "第二大学", degree: "学士" },
        }),
      ],
    });
    const second = buildAutoApplyExport(updatedSource, [...ALL_KEYS], {
      now: new Date("2026-11-13T13:00:00.000Z"),
    });
    expect(second.backup.profileV2.updatedAt > first.backup.profileV2.updatedAt).toBe(true);
    const imported = upstreamImport(JSON.stringify(second.backup));
    const edu = imported.sections.education as {
      items: { values: Record<string, string> }[];
    };
    expect(edu.items).toHaveLength(2);
    expect(edu.items[1].values["学校"]).toBe("第二大学");
  });
});
