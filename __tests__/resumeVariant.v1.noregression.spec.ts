// @vitest-environment node
import fs from "node:fs";
import path from "path";

const REPO = path.resolve(__dirname, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full);
      } else if (exts.some((e) => entry.name.endsWith(e))) {
        out.push(full);
      }
    }
  };
  walk(path.join(REPO, dir));
  return out;
}

const NEW_FILES = [
  "src/actions/resumeVariant.actions.ts",
  "src/lib/career/resumeHeaderSnapshot.ts",
  "src/lib/career/resumeVariantConstants.ts",
  "src/lib/career/resumeVariantService.ts",
  "src/app/dashboard/profile/resumes/page.tsx",
  "src/app/dashboard/profile/resumes/[variantId]/page.tsx",
  "src/components/career/resume-variant/ResumeVariantList.tsx",
  "src/components/career/resume-variant/ResumeVariantWorkspace.tsx",
  "src/components/career/resume-variant/ResumePreview.tsx",
  "src/components/career/resume-variant/SubmitResumePicker.tsx",
  "src/components/career/resume-variant/SubmittedResumePanel.tsx",
  "src/components/myjobs/job-details/ApplicationResumeBindingPanel.tsx",
  "src/lib/career/legacyJobOpportunityMapping.ts",
];

describe("Resume Variant V1 AI no-regression", () => {
  it("does not add AI runtime paths", () => {
    for (const rel of NEW_FILES) {
      const content = read(rel);
      expect(content).not.toMatch(/from ["']@\/lib\/ai\//);
      expect(content).not.toMatch(/from ["']@\/lib\/agent\//);
      expect(content).not.toContain("CareerContextBuilder");
      expect(content).not.toContain("generateResumePdf");
      expect(content).not.toMatch(/resumeArtifact\.create/);
    }
    const action = read("src/actions/resumeVariant.actions.ts");
    expect(action).not.toContain("prompt");
    expect(action.toLowerCase()).not.toContain("openai");
  });
});

describe("Resume Variant V1 legacy no-regression", () => {
  it("does not dual-write or fall back to legacy resume models", () => {
    const action = read("src/actions/resumeVariant.actions.ts");
    expect(action).not.toMatch(
      /prisma\.(contactInfo|resumeSection|workExperience|education|skill|resume)\b/,
    );
    expect(action).not.toContain("legacyMigration");
    const workspace = read(
      "src/components/career/resume-variant/ResumeVariantWorkspace.tsx",
    );
    expect(workspace).not.toContain("generateResumePdf");
    expect(workspace).not.toContain("Export PDF");
    expect(workspace).not.toContain("Download PDF");
  });

  it("does not treat legacy Job.id as JobOpportunity.id on the restricted path", () => {
    const action = read("src/actions/application.actions.ts");
    expect(action).toContain("getSubmittedResumeBindingsForLegacyJob");
    const service = read("src/lib/career/applicationService.ts");
    expect(service).toContain("resolveOwnedMappedOpportunityId");
    const mapping = read("src/lib/career/legacyJobOpportunityMapping.ts");
    expect(mapping).toContain("legacyMigrationMap");
    expect(mapping).toContain("LEGACY.JOB");
    expect(mapping).toContain("TARGET.JOB_OPPORTUNITY");
    expect(mapping).not.toMatch(/title|company/);
    const panel = read(
      "src/components/myjobs/job-details/ApplicationResumeBindingPanel.tsx",
    );
    expect(panel).not.toContain("jobOpportunityId");
    expect(panel).not.toContain("legacyMigrationMap");
  });

  it("gates B-side fetch behind resume_v1 capability", () => {
    const listPage = read("src/app/dashboard/profile/resumes/page.tsx");
    const workspacePage = read(
      "src/app/dashboard/profile/resumes/[variantId]/page.tsx",
    );
    expect(listPage).toContain("isResumeV1CapabilityEnabled");
    expect(workspacePage).toContain("isResumeV1CapabilityEnabled");
    expect(listPage).not.toContain("listResumeVariants");
    expect(workspacePage).not.toContain("getResumeVariant(");
    expect(listPage).not.toContain("CAREER_RUNTIME_MODE.AB_ENABLED");
    expect(workspacePage).not.toContain("CAREER_RUNTIME_MODE.AB_ENABLED");
  });

  it("does not add a first-level sidebar entry", () => {
    const sidebarFiles = listFiles("src/components", [".ts", ".tsx"]).filter((file) =>
      /sidebar|nav|AppSidebar|SideBar/i.test(file),
    );
    for (const file of sidebarFiles) {
      const content = fs.readFileSync(file, "utf8");
      expect(content).not.toContain("/dashboard/profile/resumes");
    }
  });
});

describe("Resume Variant V1 i18n coverage", () => {
  it("covers required product strings in en and zh-CN", () => {
    const en = JSON.parse(read("src/i18n/messages/en.json")) as {
      resumeVariants: Record<string, string>;
    };
    const zh = JSON.parse(read("src/i18n/messages/zh-CN.json")) as {
      resumeVariants: Record<string, string>;
    };
    const required = [
      "title",
      "create",
      "rename",
      "archive",
      "version",
      "statusDraft",
      "statusFrozen",
      "statusSubmitted",
      "addSection",
      "addMaterial",
      "addExpression",
      "unlinked",
      "preview",
      "freeze",
      "createNewDraft",
    ];
    for (const key of required) {
      expect(en.resumeVariants[key]).toBeTruthy();
      expect(zh.resumeVariants[key]).toBeTruthy();
    }
    expect(Object.keys(en.resumeVariants).sort()).toEqual(
      Object.keys(zh.resumeVariants).sort(),
    );
  });
});
