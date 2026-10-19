import Papa from "papaparse";
import { translate } from "@/i18n/translate";
import { JOB_CSV_FIELD_KEYS, jobCsvHeaders, transformJobForCsv, unparseJobsCsv } from "@/lib/jobs/exportJobsCsv";

const job = {
  createdAt: new Date("2026-09-30"), applied: true, appliedDate: new Date("2026-09-01"),
  Company: { label: "中文公司 Remote" }, JobTitle: { label: 'AI, "实习生"\n岗位' },
  jobType: "INTERNSHIP", workplaceType: "ONSITE", Location: { label: "上海 Remote" },
  JobSource: { label: "学校就业群", value: "学校就业群" }, Status: { label: "New", value: "new" },
  salaryRange: "15k–20k·15薪",
};

const SALARY_SAMPLES = [
  "200–250元/天",
  "250元/天起",
  "30元/小时",
  "8k–12k/月",
  "15k–20k·15薪",
  "年薪30万起",
  "最高300元/天",
  "面议",
  "Under 50,000",
];

describe("jobs CSV locale and current schema", () => {
  it.each(["zh-CN", "en"] as const)("localizes only system content in %s", (locale) => {
    const t = (key: string) => translate(locale, key);
    const row = transformJobForCsv(job, 25, t);
    expect(JOB_CSV_FIELD_KEYS).toHaveLength(12);
    expect(row.index).toBe("26");
    expect(row.createdAt).toBe("2026-09-30");
    expect(row.appliedDate).toBe("2026-09-01");
    expect(row.applied).toBe(locale === "en" ? "Yes" : "是");
    expect(transformJobForCsv({ ...job, applied: false }, 0, t).applied).toBe(locale === "en" ? "No" : "否");
    expect(row.jobType).toBe(locale === "en" ? "Internship" : "实习");
    expect(row.Status).toBe(locale === "en" ? "New" : "新建");
    expect(row.workplaceType).toBe(locale === "en" ? "Onsite" : "现场办公");
    expect(row.Company).toBe(job.Company.label);
    expect(row.JobTitle).toBe(job.JobTitle.label);
    expect(row.Location).toBe(job.Location.label);
    expect(row.JobSource).toBe(job.JobSource.label);
    // Raw user text is never localized or rewritten.
    expect(row.salaryRange).toBe("15k–20k·15薪");
    const csv = unparseJobsCsv([row], t, { header: true });
    const parsed = Papa.parse<string[]>(csv).data;
    expect(parsed[0]).toEqual(jobCsvHeaders(t));
    expect(parsed[0]).toContain(locale === "en" ? "Company" : "公司");
    expect(parsed[0]).toContain(locale === "en" ? "Job Type" : "职位类型");
    expect(parsed[0][11]).toBe(locale === "en" ? "Salary" : "薪资待遇");
    expect(parsed[1][5]).toBe(job.JobTitle.label);
    expect(parsed[1][11]).toBe("15k–20k·15薪");
  });

  it.each(SALARY_SAMPLES)("keeps raw salary text verbatim through export: %s", (salary) => {
    const t = (key: string) => translate("zh-CN", key);
    const row = transformJobForCsv({ ...job, salaryRange: salary }, 0, t);
    expect(row.salaryRange).toBe(salary);
    const parsed = Papa.parse<string[]>(unparseJobsCsv([row], t, { header: true })).data;
    expect(parsed[1][11]).toBe(salary);
  });

  it.each(["zh-CN", "en"] as const)("exports an empty cell for a missing salary in %s", (locale) => {
    const t = (key: string) => translate(locale, key);
    for (const empty of [null, undefined]) {
      const row = transformJobForCsv({ ...job, salaryRange: empty }, 0, t);
      expect(row.salaryRange).toBe("");
      const parsed = Papa.parse<string[]>(unparseJobsCsv([row], t, { header: true })).data;
      expect(parsed[1]).toHaveLength(12);
      expect(parsed[1][11]).toBe("");
    }
  });

  it("localizes seeded sources and preserves unknown status/source labels", () => {
    const zh = (key: string) => translate("zh-CN", key);
    const en = (key: string) => translate("en", key);
    expect(transformJobForCsv({ ...job, JobSource: { label: "Shixiseng", value: "shixiseng" } }, 0, zh).JobSource).toBe("实习僧");
    expect(transformJobForCsv({ ...job, JobSource: { label: "Company Career page", value: "careerpage" } }, 0, en).JobSource).toBe("Official Website");
    expect(transformJobForCsv({ ...job, Status: { label: "用户状态", value: "custom" } }, 0, zh).Status).toBe("用户状态");
    expect(transformJobForCsv({ ...job, jobType: "FT" }, 0, zh).jobType).toBe("全职");
    expect(transformJobForCsv({ ...job, jobType: "PT" }, 0, en).jobType).toBe("Part-time");
  });
});
