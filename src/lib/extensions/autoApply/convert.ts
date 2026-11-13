import { parseResumeHeaderLinks } from "@/lib/career/resumeHeaderSnapshot";
import type { AutoApplySectionKey } from "./sections";
import {
  PROFILE_BACKUP_FORMAT,
  PROFILE_BACKUP_VERSION,
  PROFILE_SCHEMA_VERSION,
  UPSTREAM_COMMIT,
  UPSTREAM_EXTENSION_VERSION,
  UPSTREAM_REPO_URL,
  UPSTREAM_SECTIONS,
  type UpstreamSectionMeta,
} from "./upstreamContract";
import type {
  AutoApplyBackup,
  AutoApplyExportReport,
  AutoApplyExportResult,
  AutoApplySource,
  AutoApplySourceMaterial,
  UpstreamCustomRow,
  UpstreamProfileV2,
  UpstreamRepeatItem,
  UpstreamSection,
} from "./types";

/**
 * Vocatrya → OpenJobAutofill profileV2 converter.
 *
 * Every output field goes through an explicit label map below — nothing is
 * copied from raw profile rows or freeform structures. Sensitive records
 * (CandidateSensitiveInfo, CandidateFamilyMember, CandidateReferee,
 * CandidateAttachment, credentials) are never read by the source loader at
 * all, so there is nothing here that could leak them.
 */

const SENSITIVE_EXCLUDED_CATEGORIES = [
  "证件类型与证件号码",
  "紧急联系人及其联系方式",
  "家庭成员",
  "证明人/推荐人联系方式",
  "附件与上传文件",
  "账号凭据与 AI 配置",
];

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function yearMonth(value: Date | string | null | undefined): string | undefined {
  if (value == null || value === "") return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 7);
}

/** Repeat-section period fields, matching upstream "YYYY-MM" / "至今". */
function periodValues(item: AutoApplySourceMaterial): Record<string, string> {
  const values: Record<string, string> = {};
  const start = yearMonth(item.startDate);
  if (start) values["开始时间"] = start;
  if (item.isCurrent) {
    values["结束时间"] = "至今";
  } else {
    const end = yearMonth(item.endDate);
    if (end) values["结束时间"] = end;
  }
  return values;
}

function evidenceText(evidence: AutoApplySourceMaterial["evidence"]): string | undefined {
  const parts = evidence
    .map((entry) => {
      const content = text(entry.content);
      const metric = text(entry.metricText);
      if (!content) return undefined;
      return metric ? `${content}（${metric}）` : content;
    })
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("；") : undefined;
}

type FieldBag = {
  values: Record<string, string>;
  custom: UpstreamCustomRow[];
  missing: string[];
};

function bag(): FieldBag {
  return { values: {}, custom: [], missing: [] };
}

function put(bagRef: FieldBag, label: string, value: unknown): void {
  const clean = text(value);
  if (clean) bagRef.values[label] = clean;
}

function putCustom(bagRef: FieldBag, label: string, value: unknown): void {
  const clean = text(value);
  if (clean) bagRef.custom.push({ label, value: clean });
}

function need(bagRef: FieldBag, label: string, value: unknown, missingLabel: string): void {
  const clean = text(value);
  if (clean) bagRef.values[label] = clean;
  else bagRef.missing.push(missingLabel);
}

function detailText(detail: Record<string, unknown>, key: string): string | undefined {
  return text(detail[key]);
}

function detailBool(detail: Record<string, unknown>, key: string): boolean {
  return detail[key] === true;
}

// --- per-section mappers -------------------------------------------------

function mapBasic(source: AutoApplySource): FieldBag {
  const out = bag();
  const profile = source.profile;
  if (!profile) {
    out.missing.push("姓名", "电话", "邮箱");
    return out;
  }
  need(out, "姓名", profile.fullName, "姓名");
  need(out, "电话", profile.phone, "电话");
  need(out, "邮箱", profile.email, "邮箱");
  put(out, "性别", profile.gender);
  put(out, "出生日期", profile.birthDate);
  put(out, "民族", profile.ethnicity);
  put(out, "国籍（国家或地区）", profile.countryOrRegion);
  put(out, "政治面貌", profile.politicalStatus);
  put(out, "籍贯", profile.nativePlace);
  put(out, "户籍", profile.householdRegistration);
  put(out, "现居住城市", profile.currentCity);
  put(out, "现居住详细地址", profile.address);
  put(out, "通讯地址", profile.address);
  put(out, "微信号", profile.wechatId);
  put(out, "QQ", profile.qqNumber);
  putCustom(out, "职业标签", profile.headline);
  putCustom(out, "毕业届别", profile.graduationCohort);
  putCustom(out, "家庭所在城市", profile.homeCity);
  putCustom(out, "家庭住址", profile.homeAddress);
  putCustom(out, "电话国家区号", profile.phoneCountryCode);
  return out;
}

function mapIntention(source: AutoApplySource): { item: UpstreamRepeatItem; missing: string[] }[] {
  const preference = source.preference;
  if (!preference) {
    return [{ item: { title: "", values: {}, custom: [] }, missing: ["意向岗位"] }];
  }
  const out = bag();
  need(out, "意向岗位", preference.targetRoles, "意向岗位");
  put(out, "期望工作城市", preference.preferredCities);
  put(out, "面试城市", preference.preferredCities);
  putCustom(out, "期望行业", preference.preferredIndustries);
  putCustom(out, "招聘类型", preference.recruitmentTypes);
  putCustom(out, "可到岗时间", preference.availability);
  return [{ item: { title: "求职意向 1", values: out.values, custom: out.custom }, missing: out.missing }];
}

function mapEducationItem(item: AutoApplySourceMaterial, index: number): { item: UpstreamRepeatItem; missing: string[] } {
  const detail = item.detail;
  const out = bag();
  Object.assign(out.values, periodValues(item));
  need(out, "学校", detailText(detail, "institution"), "学校");
  put(out, "专业", detailText(detail, "fieldOfStudy"));
  put(out, "学位", detailText(detail, "degree"));
  put(out, "学习形式", detailText(detail, "studyMode"));
  put(out, "城市", detailText(detail, "locationText") ?? detailText(detail, "currentStudyLocation"));
  put(out, "学院（院系）", detailText(detail, "department"));
  put(out, "研究方向", detailText(detail, "researchDirection"));
  const gpaValue = detail["gpaValue"];
  const gpaScale = detail["gpaScale"];
  const gpaText =
    typeof gpaValue === "number" && Number.isFinite(gpaValue)
      ? typeof gpaScale === "number" && Number.isFinite(gpaScale)
        ? `${gpaValue}/${gpaScale}`
        : String(gpaValue)
      : undefined;
  put(out, "成绩", gpaText);
  put(out, "班级排名", detailText(detail, "rankClassText"));
  put(out, "专业排名", detailText(detail, "rankMajorText") ?? detailText(detail, "rankText"));
  if (detailBool(detail, "isExchange")) putCustom(out, "交换经历", "是");
  if (detailBool(detail, "graduationExpected")) {
    const expectedOn = yearMonth(detailText(detail, "graduationOn"));
    putCustom(out, "预计毕业时间", expectedOn ?? "预计");
  }
  putCustom(out, "专业门类", detailText(detail, "majorCategory"));
  putCustom(out, "导师姓名", detailText(detail, "advisorName"));
  putCustom(out, "实验室", detailText(detail, "labName"));
  if (detailBool(detail, "hasNationalScholarship")) putCustom(out, "国家奖学金", "是");
  putCustom(out, "备注", item.notes);
  putCustom(out, "补充事实", evidenceText(item.evidence));
  return {
    item: { title: item.title || `教育经历 ${index + 1}`, values: out.values, custom: out.custom },
    missing: out.missing,
  };
}

function mapWorkLikeItem(
  item: AutoApplySourceMaterial,
  index: number,
  itemLabel: string,
): { item: UpstreamRepeatItem; missing: string[] } {
  const detail = item.detail;
  const out = bag();
  Object.assign(out.values, periodValues(item));
  need(out, "公司", detailText(detail, "organizationName"), "公司");
  put(out, "部门", detailText(detail, "department"));
  put(out, "地点", detailText(detail, "locationText"));
  put(out, "职位", detailText(detail, "roleTitle"));
  put(out, "工作内容", item.notes);
  put(out, "工作成果", evidenceText(item.evidence));
  putCustom(out, "用工性质", detailText(detail, "employmentType"));
  return {
    item: { title: item.title || `${itemLabel} ${index + 1}`, values: out.values, custom: out.custom },
    missing: out.missing,
  };
}

function mapProjectItem(item: AutoApplySourceMaterial, index: number): { item: UpstreamRepeatItem; missing: string[] } {
  const detail = item.detail;
  const out = bag();
  Object.assign(out.values, periodValues(item));
  need(out, "项目名称", item.title, "项目名称");
  put(out, "职位", detailText(detail, "roleTitle"));
  put(out, "项目内容", item.notes);
  put(out, "项目成果", evidenceText(item.evidence));
  put(out, "项目链接", detailText(detail, "projectUrl"));
  putCustom(out, "项目类型", detailText(detail, "projectType"));
  putCustom(out, "技术栈", detailText(detail, "techStack"));
  putCustom(out, "所属机构", detailText(detail, "organizationName"));
  return {
    item: { title: item.title || `项目经历 ${index + 1}`, values: out.values, custom: out.custom },
    missing: out.missing,
  };
}

function mapStudentItem(item: AutoApplySourceMaterial, index: number): { item: UpstreamRepeatItem; missing: string[] } {
  const detail = item.detail;
  const out = bag();
  Object.assign(out.values, periodValues(item));
  need(out, "组织名称", detailText(detail, "organizationName"), "组织名称");
  put(out, "职位", detailText(detail, "roleTitle"));
  put(out, "工作内容", item.notes);
  putCustom(out, "补充事实", evidenceText(item.evidence));
  return {
    item: { title: item.title || `干部任职经历 ${index + 1}`, values: out.values, custom: out.custom },
    missing: out.missing,
  };
}

function mapAwardItem(item: AutoApplySourceMaterial, index: number): { item: UpstreamRepeatItem; missing: string[] } {
  const detail = item.detail;
  const out = bag();
  if (item.type === "COMPETITION") {
    const when = yearMonth(item.startDate);
    if (when) out.values["奖惩时间"] = when;
    put(out, "颁奖单位", detailText(detail, "organizer"));
    put(out, "奖惩描述", detailText(detail, "result") ?? item.notes);
  } else {
    const when = yearMonth(detailText(detail, "awardedAt"));
    if (when) out.values["奖惩时间"] = when;
    put(out, "颁奖单位", detailText(detail, "issuer"));
    put(out, "奖惩描述", item.notes);
    putCustom(out, "奖项类型", detailText(detail, "awardType"));
    putCustom(out, "奖项范围", detailText(detail, "awardScope"));
  }
  need(out, "奖惩名称", item.title, "奖惩名称");
  put(out, "奖励等级", detailText(detail, "awardLevel"));
  putCustom(out, "补充事实", evidenceText(item.evidence));
  return {
    item: { title: item.title || `奖惩 ${index + 1}`, values: out.values, custom: out.custom },
    missing: out.missing,
  };
}

function mapLanguageItem(item: AutoApplySourceMaterial, index: number): { item: UpstreamRepeatItem; missing: string[] } {
  const detail = item.detail;
  const out = bag();
  const obtained = yearMonth(detailText(detail, "obtainedOn"));
  if (obtained) out.values["获得时间"] = obtained;
  need(out, "外语种类", detailText(detail, "language"), "外语种类");
  put(out, "证书名称（技能名称）", detailText(detail, "examOrLevel"));
  put(out, "成绩", detailText(detail, "score"));
  putCustom(out, "备注", item.notes);
  return {
    item: { title: item.title || `外语能力 ${index + 1}`, values: out.values, custom: out.custom },
    missing: out.missing,
  };
}

function mapComputerItem(item: AutoApplySourceMaterial, index: number): { item: UpstreamRepeatItem; missing: string[] } {
  const detail = item.detail;
  const out = bag();
  need(out, "证书名称（技能名称）", detailText(detail, "skillName"), "技能名称");
  put(out, "掌握程度", detailText(detail, "proficiency"));
  putCustom(out, "备注", item.notes);
  return {
    item: { title: item.title || `计算机技能 ${index + 1}`, values: out.values, custom: out.custom },
    missing: out.missing,
  };
}

function mapCertificateItem(item: AutoApplySourceMaterial, index: number): { item: UpstreamRepeatItem; missing: string[] } {
  const detail = item.detail;
  const out = bag();
  const issued = yearMonth(detailText(detail, "issueDate"));
  if (issued) out.values["证书获得时间"] = issued;
  need(out, "证书名称（技能名称）", item.title, "证书名称");
  put(out, "证书编号", detailText(detail, "credentialId"));
  put(out, "授予单位", detailText(detail, "organization"));
  put(out, "证书说明", item.notes);
  const expires = yearMonth(detailText(detail, "expirationDate"));
  if (expires) putCustom(out, "有效期至", expires);
  putCustom(out, "证书链接", detailText(detail, "credentialUrl"));
  return {
    item: { title: item.title || `证书 ${index + 1}`, values: out.values, custom: out.custom },
    missing: out.missing,
  };
}

function mapPaperItem(item: AutoApplySourceMaterial, index: number): { item: UpstreamRepeatItem; missing: string[] } {
  const detail = item.detail;
  const out = bag();
  const published = yearMonth(detailText(detail, "publishedAt"));
  if (published) out.values["发表时间"] = published;
  need(out, "论文名称", item.title, "论文名称");
  put(out, "刊物名称", detailText(detail, "venue"));
  put(out, "刊物层级", detailText(detail, "venueLevel"));
  put(out, "论文描述", item.notes);
  putCustom(out, "作者", detailText(detail, "authors"));
  putCustom(out, "作者排序", detailText(detail, "authorRole"));
  putCustom(out, "链接", detailText(detail, "url"));
  putCustom(out, "补充事实", evidenceText(item.evidence));
  return {
    item: { title: item.title || `论文和著作 ${index + 1}`, values: out.values, custom: out.custom },
    missing: out.missing,
  };
}

function mapOther(source: AutoApplySource): FieldBag {
  const out = bag();
  const links = parseResumeHeaderLinks(source.profile?.linksData ?? null);
  let homepageAssigned = false;
  for (const link of links) {
    const label = text(link.label);
    const url = text(link.url);
    if (!url) continue;
    if (/github\.com/i.test(url)) {
      if (!out.values["GitHub"]) out.values["GitHub"] = url;
      else out.custom.push({ label: label ?? "GitHub", value: url });
      continue;
    }
    if (!homepageAssigned) {
      out.values["个人主页"] = url;
      homepageAssigned = true;
      continue;
    }
    out.custom.push({ label: label ?? "链接", value: url });
  }
  return out;
}

// --- assembly ------------------------------------------------------------

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function sourceUpdatedAt(source: AutoApplySource, exportedAt: string): string {
  const stamps = [
    toIso(source.profile?.updatedAt),
    toIso(source.preference?.updatedAt),
    ...source.materials.map((item) => toIso(item.updatedAt)),
  ].filter((stamp): stamp is string => Boolean(stamp));
  if (stamps.length === 0) return exportedAt;
  return stamps.reduce((max, stamp) => (stamp > max ? stamp : max));
}

export function buildAutoApplyExport(
  source: AutoApplySource,
  selected: readonly AutoApplySectionKey[],
  options: { now?: Date; appVersion?: string } = {},
): AutoApplyExportResult {
  const now = options.now ?? new Date();
  const exportedAt = now.toISOString();
  const selectedSet = new Set(selected);
  const report: AutoApplyExportReport = {
    sections: [],
    ambiguous: [],
    unsupported: [],
    sensitiveExcluded: [...SENSITIVE_EXCLUDED_CATEGORIES],
  };
  const sections: Record<string, UpstreamSection> = {};

  const materialsOf = (type: string) => source.materials.filter((item) => item.type === type);

  const meta = (key: string) =>
    UPSTREAM_SECTIONS.find((section) => section.key === key)!;

  const emptySection = (metaEntry: UpstreamSectionMeta): UpstreamSection =>
    metaEntry.kind === "repeat"
      ? { key: metaEntry.key, title: metaEntry.title, kind: "repeat", items: [] }
      : { key: metaEntry.key, title: metaEntry.title, kind: "simple", values: {}, custom: [] };

  const pushSimple = (
    key: AutoApplySectionKey,
    build: () => FieldBag,
  ) => {
    const metaEntry = meta(key);
    if (!selectedSet.has(key)) {
      sections[metaEntry.key] = emptySection(metaEntry);
      return;
    }
    const bagRef = build();
    sections[metaEntry.key] = {
      key: metaEntry.key,
      title: metaEntry.title,
      kind: "simple",
      values: bagRef.values,
      custom: bagRef.custom,
    };
    report.sections.push({
      key,
      title: metaEntry.title,
      kind: metaEntry.kind,
      itemCount: Object.keys(bagRef.values).length + bagRef.custom.length,
      missing: bagRef.missing,
    });
  };

  const pushRepeat = (
    key: AutoApplySectionKey,
    build: () => { item: UpstreamRepeatItem; missing: string[] }[],
  ) => {
    const metaEntry = meta(key);
    if (!selectedSet.has(key)) {
      sections[metaEntry.key] = emptySection(metaEntry);
      return;
    }
    const built = build();
    // Empty items (no values and no custom rows) are dropped from the file
    // — upstream normalizeProfileV2 discards them anyway — but their
    // `missing` notes still reach the report.
    const items = built
      .map((entry) => entry.item)
      .filter(
        (item) =>
          Object.keys(item.values).length > 0 || item.custom.length > 0,
      );
    sections[metaEntry.key] = {
      key: metaEntry.key,
      title: metaEntry.title,
      kind: "repeat",
      items,
    };
    report.sections.push({
      key,
      title: metaEntry.title,
      kind: metaEntry.kind,
      itemCount: items.length,
      missing: [...new Set(built.flatMap((entry) => entry.missing))],
    });
  };

  pushSimple("basic", () => mapBasic(source));

  pushRepeat("intention", () => mapIntention(source));

  pushRepeat("education", () => materialsOf("EDUCATION").map(mapEducationItem));

  pushRepeat("internship", () =>
    materialsOf("INTERNSHIP").map((item, index) => mapWorkLikeItem(item, index, "实习经历")),
  );

  pushRepeat("work", () =>
    materialsOf("EMPLOYMENT").map((item, index) => mapWorkLikeItem(item, index, "工作经历")),
  );

  pushRepeat("project", () => materialsOf("PROJECT").map(mapProjectItem));

  pushRepeat("student", () => materialsOf("CAMPUS_ACTIVITY").map(mapStudentItem));

  pushRepeat("awards", () =>
    [...materialsOf("AWARD"), ...materialsOf("COMPETITION")].map(mapAwardItem),
  );

  pushRepeat("language", () => materialsOf("LANGUAGE").map(mapLanguageItem));

  pushRepeat("computer", () => materialsOf("SKILL").map(mapComputerItem));

  pushRepeat("certificates", () => materialsOf("CERTIFICATION").map(mapCertificateItem));

  pushRepeat("papers", () => materialsOf("PUBLICATION").map(mapPaperItem));

  pushSimple("other", () => mapOther(source));

  // Empty upstream sections with no exportable source stay explicit.
  for (const metaEntry of UPSTREAM_SECTIONS) {
    if (sections[metaEntry.key]) continue;
    sections[metaEntry.key] =
      metaEntry.kind === "repeat"
        ? { key: metaEntry.key, title: metaEntry.title, kind: "repeat", items: [] }
        : { key: metaEntry.key, title: metaEntry.title, kind: "simple", values: {}, custom: [] };
  }

  // --- report: ambiguity / unsupported notes (data-triggered) -------------
  if (source.profile?.phoneCountryCode) {
    report.ambiguous.push("电话国家区号作为自定义字段导出，不会拼接到电话号码。");
  }
  if (source.profile?.homeCity || source.profile?.homeAddress) {
    report.ambiguous.push("家庭所在城市/家庭住址以自定义字段导出，未直接映射为「生源地」或「户籍」。");
  }
  if (source.preference?.availability) {
    report.ambiguous.push("可到岗时间以自定义字段导出，与表单「预计入职时间」语义可能不同，请按需核对。");
  }
  if (materialsOf("EDUCATION").some((item) => detailText(item.detail, "degree"))) {
    report.ambiguous.push("「学位」按资料中的学位字段导出；网申表单的「学历」层级（如本科/硕士）可能需要在插件中另行核对。");
  }
  if (source.preference?.hasConstraints || source.preference?.hasSoftPreferences) {
    report.unsupported.push("求职硬性约束与软性偏好不映射为表单字段，未导出。");
  }
  if (source.profile?.hasExtraData) {
    report.unsupported.push("职业资料中的额外结构数据（extraData）格式未定义，未导出。");
  }
  const research = materialsOf("RESEARCH").length;
  if (research > 0) {
    report.unsupported.push(`科研经历 ${research} 条：上游资料格式没有对应板块，未导出。`);
  }
  const custom = materialsOf("CUSTOM").length;
  if (custom > 0) {
    report.unsupported.push(`自定义材料 ${custom} 条：结构自由无法可靠映射，未导出。`);
  }
  const withStructured = source.materials.filter(
    (item) => item.hasStructuredData && item.type !== "CUSTOM",
  ).length;
  if (withStructured > 0) {
    report.unsupported.push(`${withStructured} 条材料含未映射的扩展结构数据，对应字段未导出。`);
  }
  report.unsupported.push("家庭情况板块属于敏感资料，不导出；有关声明需按每次申请如实确认，不预填。");
  report.unsupported.push("绩效考核、培训经历、专利、自我描述板块暂无来源数据。");

  const profileV2: UpstreamProfileV2 = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    updatedAt: sourceUpdatedAt(source, exportedAt),
    sections,
    customSections: [],
  };

  const backup: AutoApplyBackup = {
    format: PROFILE_BACKUP_FORMAT,
    version: PROFILE_BACKUP_VERSION,
    exportedAt,
    source: {
      app: "Vocatrya",
      appVersion: options.appVersion ?? "unknown",
      channel: "manual-export",
      upstreamRepo: UPSTREAM_REPO_URL,
      upstreamCommit: UPSTREAM_COMMIT,
      upstreamExtensionVersion: UPSTREAM_EXTENSION_VERSION,
    },
    profileV2,
  };

  return { backup, report };
}
