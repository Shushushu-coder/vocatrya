import {
  PERSONAL_INFO_COPY_FIELDS,
  buildApplicationProjectionSections,
  buildApplicationProjectionText,
  buildBasicsSectionText,
  buildPersonalInfoText,
  type ApplicationProjectionInput,
} from "@/lib/career/applicationCopy";

const FULL_INPUT: ApplicationProjectionInput = {
  profile: {
    fullName: "Lin Mu",
    email: "lin@example.com",
    phone: "13800138000",
    address: "Shanghai",
    gender: "女",
    birthDate: "2002-03-04",
    ethnicity: "汉族",
    politicalStatus: "共青团员",
    nativePlace: "浙江杭州",
    householdRegistration: "上海",
    graduationCohort: "2026届",
  },
  preference: null,
  education: [
    {
      title: "Fudan University",
      educationDetail: { institution: "Fudan", degree: "本科" },
      startDate: "2020-09-01",
      endDate: "2024-06-30",
    },
  ],
  experience: [
    {
      title: "Summer Intern",
      internshipDetail: { organizationName: "Acme", roleTitle: "Dev" },
      evidence: [{ content: "did X", metricText: "100%" }],
    },
  ],
  skills: [
    { title: "Python", skillDetail: { skillName: "Python", proficiency: "熟练" } },
  ],
};

describe("PERSONAL_INFO_COPY_FIELDS whitelist", () => {
  it("contains the approved non-sensitive personal fields and no sensitive keys", () => {
    const keys = PERSONAL_INFO_COPY_FIELDS.map((f) => f.key);
    expect(keys).toEqual([
      "fullName",
      "email",
      "phoneCountryCode",
      "phone",
      "address",
      "countryOrRegion",
      "wechatId",
      "qqNumber",
      "currentCity",
      "homeCity",
      "homeAddress",
      "gender",
      "birthDate",
      "ethnicity",
      "politicalStatus",
      "nativePlace",
      "householdRegistration",
      "graduationCohort",
      "highestEducation",
      "schoolCity",
      "linksData",
    ]);
    for (const key of keys) {
      expect(key).not.toMatch(/idNumber|emergency|familyMember|reference/i);
    }
  });
});

describe("buildPersonalInfoText", () => {
  it("emits labeled lines in whitelist order, skipping empty values", () => {
    const text = buildPersonalInfoText({
      fullName: "Lin Mu",
      email: "  lin@example.com  ",
      phone: "   ",
      gender: "女",
    });
    expect(text).toBe("姓名：Lin Mu\n邮箱：lin@example.com\n性别：女");
  });

  it("returns empty string for null or all-empty profiles", () => {
    expect(buildPersonalInfoText(null)).toBe("");
    expect(buildPersonalInfoText({ fullName: "  " })).toBe("");
  });

  it("never includes values stuffed under non-whitelisted sensitive keys", () => {
    const SENTINEL = "SENSITIVE_ID_SENTINEL";
    const stuffed = {
      fullName: "Lin Mu",
      idNumber: SENTINEL,
      emergencyContactPhone: SENTINEL,
    } as unknown as Parameters<typeof buildPersonalInfoText>[0];
    const text = buildPersonalInfoText(stuffed);
    expect(text).toContain("Lin Mu");
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("idNumber");
    expect(text).not.toContain("emergencyContact");
  });
});

describe("buildBasicsSectionText", () => {
  it("joins bare trimmed values without labels", () => {
    expect(
      buildBasicsSectionText({ fullName: "Lin Mu", email: "lin@example.com" }),
    ).toBe("Lin Mu\nlin@example.com");
    expect(buildBasicsSectionText(null)).toBe("");
  });
});

describe("buildApplicationProjectionSections", () => {
  it("all sections joined reproduce the full projection text exactly", () => {
    const sections = buildApplicationProjectionSections(FULL_INPUT);
    expect(sections.map((s) => s.id)).toEqual([
      "basics",
      "education",
      "experience",
      "skills",
    ]);
    const joined = sections.map((s) => s.text).join("\n\n");
    expect(joined).toBe(buildApplicationProjectionText(FULL_INPUT));
    for (const id of ["basics", "education", "experience", "skills"]) {
      expect(joined).toContain(
        { basics: "基本资料", education: "教育经历", experience: "经历素材", skills: "技能证书" }[
          id as "basics" | "education" | "experience" | "skills"
        ],
      );
    }
  });

  it("a selected subset yields exactly that slice of the summary", () => {
    const sections = buildApplicationProjectionSections(FULL_INPUT);
    const selected = sections
      .filter((s) => s.id === "basics" || s.id === "skills")
      .map((s) => s.text)
      .join("\n\n");
    expect(selected).toContain("基本资料");
    expect(selected).toContain("技能证书");
    expect(selected).not.toContain("教育经历");
    expect(selected).not.toContain("经历素材");
    expect(selected).toBe(
      buildApplicationProjectionText(FULL_INPUT)
        .split("\n\n")
        .filter((b) => b.startsWith("基本资料") || b.startsWith("技能证书"))
        .join("\n\n"),
    );
  });

  it("omits sections with no content", () => {
    const sections = buildApplicationProjectionSections({
      profile: null,
      preference: null,
      education: [],
      experience: [],
      skills: [],
    });
    expect(sections).toEqual([]);
    expect(
      buildApplicationProjectionText({
        profile: null,
        preference: null,
        education: [],
        experience: [],
        skills: [],
      }),
    ).toBe("");
  });
});
