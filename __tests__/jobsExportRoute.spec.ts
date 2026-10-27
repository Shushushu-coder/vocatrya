// @vitest-environment node
import Papa from "papaparse";
import { POST } from "@/app/api/jobs/export/route";
import { auth } from "@/auth";
import { cookies } from "next/headers";
const getJobsIterator = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/actions/job.actions", () => ({ getJobsIterator }));
vi.mock("@/lib/telemetry", () => ({ log: { error: vi.fn() } }));

const job = {
  applied: true, jobType: "INTERNSHIP", workplaceType: "REMOTE",
  Company: { label: "中文公司" }, JobTitle: { label: "实习岗位" },
  Location: { label: "用户地点" }, JobSource: { label: "自定义渠道", value: "custom" },
  Status: { label: "Interview", value: "interview" },
  salaryRange: "15k–20k·15薪",
};

describe("CSV POST request locale", () => {
  beforeEach(() => { vi.mocked(auth).mockResolvedValue({ user: { id: "user" } } as never); });

  it.each(["zh-CN", "en"])("uses the current %s cookie and emits BOM once across chunks", async (locale) => {
    vi.mocked(cookies).mockResolvedValue({ get: () => ({ value: locale }) } as never);
    vi.mocked(getJobsIterator).mockImplementation(async function* () {
      yield [job]; yield [{ ...job, applied: false, salaryRange: null }];
    });
    const response = await POST();
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = bytes.toString("utf8");
    expect(csv.split("\uFEFF")).toHaveLength(2);
    const rows = Papa.parse<string[]>(csv.slice(1)).data;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveLength(13);
    expect(rows[0][4]).toBe(locale === "en" ? "Company" : "公司");
    expect(rows[0][11]).toBe(locale === "en" ? "Salary" : "薪资待遇");
    expect(rows[0][12]).toBe(locale === "en" ? "Deadline" : "截止日期");
    expect(rows[1][2]).toBe(locale === "en" ? "Yes" : "是");
    expect(rows[2][2]).toBe(locale === "en" ? "No" : "否");
    expect(rows[1][6]).toBe(locale === "en" ? "Internship" : "实习");
    expect(rows[1][10]).toBe(locale === "en" ? "Interview" : "面试中");
    expect(rows[1][4]).toBe("中文公司");
    expect(rows[1][9]).toBe("自定义渠道");
    expect(rows[1][11]).toBe("15k–20k·15薪");
    expect(rows[2][11]).toBe("");
    expect(rows[2][0]).toBe("2");
  });

  it("exports localized headers and BOM even when there are no jobs", async () => {
    vi.mocked(cookies).mockResolvedValue({ get: () => ({ value: "zh-CN" }) } as never);
    vi.mocked(getJobsIterator).mockImplementation(async function* () {});
    const bytes = Buffer.from(await (await POST()).arrayBuffer());
    expect(bytes.toString("utf8")).toMatch(/^\uFEFF序号,/);
  });

  it("preserves unauthorized behavior", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await POST()).status).toBe(401);
  });
});
