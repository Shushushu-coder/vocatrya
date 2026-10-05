import type { ParsedResumeImport, ResumeImportItem } from "@/lib/career/resumeImportContract";

export function importItem(type: ResumeImportItem["type"], title: string, sourceText: string,
  fields: Partial<ResumeImportItem["structuredFields"]> = {}): ResumeImportItem {
  return { type, title, sourceText, structuredFields: {
    organization: null, role: null, institution: null, degree: null, fieldOfStudy: null,
    location: null, startDate: null, endDate: null, url: null, venue: null,
    authors: null, issuer: null, skillName: null, proficiency: null, ...fields,
  }, expressions: sourceText.split("\n"), uncertainty: null,
  evidenceCandidates: sourceText.split("\n").slice(1).map((content, index) => ({
    content, kind: content.includes("P95") ? "METRIC" : "ACTION", expressionIndex: index + 1,
  })) };
}
export const internshipBullet = "负责订单服务开发并协同团队完成接口设计数据校验异常处理日志记录上线验证与持续维护，P95 从 480ms 降至 120ms";
export const projectBullet = "使用 TypeScript / Node.js / PostgreSQL 完成订单系统，实现订单查询与事务处理。";
export const importFixture: ParsedResumeImport = {
  profile: { fullName: "陈启明", headline: null, email: "synthetic@example.com", phone: "13900000000", address: null, linksData: null },
  profileSourceText: "陈启明\nsynthetic@example.com\n13900000000",
  sections: [
    { title: "教育经历", items: [importItem("EDUCATION", "某大学", "某大学 / 计算机科学 / 2022–2026", { institution: "某大学", fieldOfStudy: "计算机科学", startDate: "2022", endDate: "2026" })] },
    { title: "实习经历", items: [importItem("INTERNSHIP", "后端开发实习", `某科技公司 / 后端开发实习 / 2025.03–2025.06\n${internshipBullet}`, { organization: "某科技公司", role: "后端开发实习", startDate: "2025.03", endDate: "2025.06" })] },
    { title: "项目经历", items: [importItem("PROJECT", "订单系统", `订单系统\n${projectBullet}`)] },
    { title: "技能", items: [importItem("SKILL", "TypeScript", "TypeScript / Node.js / PostgreSQL", { skillName: "TypeScript" })] },
  ],
};
export const importRawText = `${importFixture.profile.fullName}\n${importFixture.profile.email}\n${importFixture.profile.phone}\n` +
  importFixture.sections.map((section) => section.title + "\n" + section.items.map((item) => item.sourceText).join("\n")).join("\n");
