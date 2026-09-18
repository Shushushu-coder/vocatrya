// @vitest-environment node
import fs from "node:fs";
import en from "@/i18n/messages/en.json";
import zh from "@/i18n/messages/zh-CN.json";
import { maskName, maskPhone } from "@/lib/career/sensitiveMask";
import {
  buildApplicationProjectionText,
  buildEducationSectionText,
  buildExperienceSectionText,
  buildMaterialItemText,
  buildSkillsSectionText,
} from "@/lib/career/applicationCopy";
import { resolveLocalDbDisplayPath } from "@/lib/career/localDbPath";

describe("sensitive masking", () => {
  it("masks name partially and phone as ****1234", () => {
    expect(maskName("张三")).toBe("张*");
    expect(maskName("John")).not.toContain("ohn");
    expect(maskName("John").startsWith("J")).toBe(true);
    expect(maskPhone("13800138000")).toBe("****8000");
    expect(maskPhone("+86 138 0013 8000")).toBe("****8000");
  });

  it("masked values never equal full values", () => {
    const name = "SENSITIVE_FULL_NAME_ABC";
    const phone = "SENSITIVE_PHONE_13900001111";
    expect(maskName(name)).not.toContain(name);
    expect(maskPhone(phone)).not.toContain(phone);
    expect(maskPhone(phone)).toContain("1111");
  });
});

describe("section copy excludes sensitive and internal preferences", () => {
  const SENTINEL = "SENSITIVE_SENTINEL_9Z9Z9Z";

  it("material item text never includes sensitive sentinel", () => {
    const text = buildMaterialItemText({
      title: "Fixture",
      notes: "notes",
      evidence: [{ content: "did X", metricText: "100%" }],
    });
    expect(text).not.toContain(SENTINEL);
    expect(text).toContain("Fixture");
  });

  it("education/experience/skills section copies exclude sensitive", () => {
    const items = [{ title: "Uni", notes: SENTINEL.replace("SENSITIVE", "NOTE") }];
    // Even if notes contained a sentinel, section builders only join known fields;
    // simulate a sensitive leak attempt by ensuring builders do not pull sensitive keys.
    expect(buildEducationSectionText(items)).not.toContain("emergencyContact");
    expect(buildExperienceSectionText(items)).not.toContain("emergencyContact");
    expect(buildSkillsSectionText(items)).not.toContain("emergencyContact");
  });

  it("projection excludes hardConstraints/softPreferences/sensitive", () => {
    const text = buildApplicationProjectionText({
      profile: { fullName: "A", email: "a@example.com" },
      preference: {
        targetRoles: "Frontend",
        preferredCities: "Shanghai",
        preferredIndustries: "Internet",
        recruitmentTypes: "Campus",
        availability: "July",
      },
      education: [{ title: "Uni" }],
      experience: [],
      skills: [],
    });
    expect(text).toContain("Frontend");
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("hardConstraints");
    expect(text).not.toContain("softPreferences");
    expect(text).not.toContain("emergencyContact");
    expect(text).not.toContain("idNumber");
  });

  it("section and overview copy omit SENSITIVE_PHONE_SENTINEL even if stuffed onto items", () => {
    const PHONE = "SENSITIVE_PHONE_SENTINEL";
    const stuffed = {
      title: "Uni",
      notes: "notes",
      emergencyContactPhone: PHONE,
      phone: PHONE,
    } as unknown as Parameters<typeof buildEducationSectionText>[0][number];
    expect(buildEducationSectionText([stuffed])).not.toContain(PHONE);
    expect(buildExperienceSectionText([stuffed])).not.toContain(PHONE);
    expect(buildSkillsSectionText([stuffed])).not.toContain(PHONE);
    const overview = buildApplicationProjectionText({
      profile: { fullName: "A", email: "a@example.com", phone: "13800000000" },
      preference: { targetRoles: "Frontend" },
      education: [stuffed],
      experience: [stuffed],
      skills: [stuffed],
    });
    expect(overview).not.toContain(PHONE);
  });
});

describe("sensitive storage notice", () => {
  it("i18n contains local/unencrypted/no-AI/backup-excluded/path in both locales", () => {
    const enProfile = (en as unknown as { applicationProfile: Record<string, string> }).applicationProfile;
    const zhProfile = (zh as unknown as { applicationProfile: Record<string, string> }).applicationProfile;
    expect(enProfile.sensitiveLocalTitle.toLowerCase()).toContain("unencrypted");
    expect(enProfile.sensitiveLocalDetail.toLowerCase()).toContain("local");
    expect(enProfile.sensitiveNoAi).toMatch(/never sent to AI/i);
    expect(enProfile.sensitiveNoAi.toLowerCase()).toContain("backup");
    expect(enProfile.sensitiveStoragePath).toContain("{path}");

    expect(zhProfile.sensitiveLocalTitle).toContain("未加密");
    expect(zhProfile.sensitiveLocalDetail).toContain("本地");
    expect(zhProfile.sensitiveNoAi).toContain("AI");
    expect(zhProfile.sensitiveNoAi).toContain("备份");
    expect(zhProfile.sensitiveStoragePath).toContain("{path}");
  });

  it("resolves a display path without secrets and without hardcoded dev absolute", () => {
    const display = resolveLocalDbDisplayPath({ DATABASE_URL: "file:./dev.db" } as unknown as NodeJS.ProcessEnv, "/repo");
    expect(display.kind).toBe("local-file");
    if (display.kind !== "local-file") return;
    expect(display.path).toContain("dev.db");
    expect(JSON.stringify(display)).not.toContain("DATABASE_URL");
    expect(JSON.stringify(display)).not.toContain("password");
    // Must not hardcode the developer machine path.
    expect(display.path).not.toBe("E:\\Projects\\vocatrya\\prisma\\dev.db");
  });

  it("does not depend on a fixed absolute developer path", () => {
    const a = resolveLocalDbDisplayPath({ DATABASE_URL: "file:./dev.db" } as unknown as NodeJS.ProcessEnv, "/tmp/repo-a");
    const b = resolveLocalDbDisplayPath({ DATABASE_URL: "file:./dev.db" } as unknown as NodeJS.ProcessEnv, "/tmp/repo-b");
    expect(a).not.toEqual(b);
    expect(fs.existsSync).toBeDefined();
  });

  it("i18n unknown-path copy does not invent prisma/dev.db", () => {
    const enProfile = (en as unknown as { applicationProfile: Record<string, string> }).applicationProfile;
    const zhProfile = (zh as unknown as { applicationProfile: Record<string, string> }).applicationProfile;
    expect(enProfile.sensitiveStorageUnknown.toLowerCase()).toContain("unable to determine");
    expect(enProfile.sensitiveStorageUnknown).not.toContain("{path}");
    expect(enProfile.sensitiveStorageUnknown).not.toContain("prisma/dev.db");
    expect(zhProfile.sensitiveStorageUnknown).toContain("无法从当前数据库配置确定本地数据库文件路径");
    expect(zhProfile.sensitiveStorageUnknown).not.toContain("prisma/dev.db");
  });
});

describe("legacy coexistence copy", () => {
  it("i18n states B-side independence without promising auto-sync", () => {
    const enNotice = (en as unknown as { applicationProfile: Record<string, string> }).applicationProfile.legacyIndependentNotice;
    const zhNotice = (zh as unknown as { applicationProfile: Record<string, string> }).applicationProfile.legacyIndependentNotice;
    expect(enNotice.toLowerCase()).toContain("independent");
    expect(enNotice.toLowerCase()).not.toContain("auto");
    expect(enNotice.toLowerCase()).not.toContain("sync");
    expect(zhNotice).toContain("独立于现有简历管理");
    expect(zhNotice).not.toContain("自动同步");
  });
});
