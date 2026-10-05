// @vitest-environment node
import { validateResumeImport, importDate, safeImportName } from "@/lib/career/resumeImportContract";
import { canonicalImportJsonSchema } from "@/lib/ai/resume-import/canonicalSchema";
import { findUnsupportedSchemaKeys, validateStructuredValue } from "@/lib/ai/structured-output";
import { preprocessText } from "@/lib/ai/tools/preprocessing";
import { issueImportApproval, readImportApproval } from "@/lib/career/resumeImportApproval";
import { importFixture, importRawText, importItem } from "./helpers/canonicalImportFixture";

it("accepts Chinese and mixed resume, continuous Chinese, exact metrics and partial dates", async () => {
  expect(validateResumeImport(importFixture, importRawText)).toEqual(importFixture);
  expect((await preprocessText(importRawText)).success).toBe(true);
  expect(importDate("2025.03")).toBeNull();
  expect(importDate("2025")).toBeNull();
  expect(importDate("Present")).toBeNull();
  expect(importDate("2025.03.12")?.toISOString()).toBe("2025-03-12T00:00:00.000Z");
  expect(importDate("2025-02-30")).toBeNull();
});
it("accepts English research, publication, award and unknown sections with missing fields", () => {
  const parsed = structuredClone(importFixture);
  parsed.profile = { fullName: null, headline: null, email: null, phone: null, address: null, linksData: null };
  parsed.profileSourceText = null;
  parsed.sections = [
    { title: "Research", items: [importItem("RESEARCH", "Study", "Study at University", { institution: "University" })] },
    { title: "Publications", items: [importItem("PUBLICATION", "Paper", "Paper in Journal", { venue: "Journal" })] },
    { title: "Awards", items: [importItem("AWARD", "Prize", "Prize from Institute", { issuer: "Institute" })] },
    { title: "Interests", items: [importItem("CUSTOM", "Reading", "Reading")] },
  ];
  const raw = parsed.sections.map((section) => `${section.title}\n${section.items[0].sourceText}`).join("\n");
  expect(validateResumeImport(parsed, raw).sections).toHaveLength(4);
});
it.each(["company", "date", "skill", "metric", "bullet", "profile", "unknown key", "missing fields", "evidence"])("rejects fabricated or malformed %s", (caseName) => {
  const value = structuredClone(importFixture);
  const item = value.sections[1].items[0];
  if (caseName === "company") item.structuredFields.organization = "不存在公司";
  if (caseName === "date") item.structuredFields.startDate = "2025.03.01";
  if (caseName === "skill") value.sections[3].items[0].structuredFields.skillName = "Redis";
  if (caseName === "metric") item.evidenceCandidates[0].content = "P95 从 480ms 降至 100ms";
  if (caseName === "bullet") item.expressions[1] = "大幅优化后端性能";
  if (caseName === "profile") value.profile.fullName = "张三";
  if (caseName === "unknown key") Object.assign(item, { companyId: "arbitrary" });
  if (caseName === "missing fields") delete (item.structuredFields as Partial<typeof item.structuredFields>).endDate;
  if (caseName === "evidence") item.evidenceCandidates[0].expressionIndex = 99;
  expect(() => validateResumeImport(value, importRawText)).toThrow();
});
it("rejects dropped expression wording and reordered sections", () => {
  const parsed = structuredClone(importFixture);
  parsed.sections[1].items[0].expressions.pop();
  expect(() => validateResumeImport(parsed, importRawText)).toThrow();
  parsed.sections.reverse();
  expect(() => validateResumeImport(parsed, importRawText)).toThrow();
});
it("rejects omitted original bullets, sections, or contact blocks even with consistent AI sourceText", () => {
  const missingSection = structuredClone(importFixture);
  missingSection.sections.pop();
  expect(() => validateResumeImport(missingSection, importRawText)).toThrow("IMPORT_SOURCE_INCOMPLETE");
  const shortened = structuredClone(importFixture);
  const item = shortened.sections[1].items[0];
  item.sourceText = item.expressions[0]; item.expressions = [item.expressions[0]]; item.evidenceCandidates = [];
  expect(() => validateResumeImport(shortened, importRawText)).toThrow("IMPORT_SOURCE_INCOMPLETE");
});
it("uses equivalent strict schema inside the verified runtime subset", () => {
  const schema = canonicalImportJsonSchema();
  expect(findUnsupportedSchemaKeys(schema)).toEqual([]);
  expect(validateStructuredValue(importFixture, schema)).toEqual([]);
});
it("sanitizes file names without persisting client paths", () => {
  expect(safeImportName("C:\\Users\\test\\陈启明-简历.pdf")).toBe("陈启明-简历");
  expect(safeImportName("../../<resume>.docx")).toBe("resume");
});
it("binds approvals to the owner and exact draft, and expires them", () => {
  const token = issueImportApproval({ userId: "owner", name: "Synthetic", rawText: importRawText, parsed: importFixture, resolvedConnectionId: "c", resolvedModel: "m" });
  expect(readImportApproval(token, "owner").parsed).toEqual(importFixture);
  expect(() => readImportApproval(token, "other")).toThrow();
  expect(() => readImportApproval(token.replace(/.$/, "!"), "owner")).toThrow();
  const now = Date.now();
  const spy = vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60 * 1000);
  expect(() => readImportApproval(token, "owner")).toThrow();
  spy.mockRestore();
});
