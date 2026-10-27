// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

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

describe("application profile AI no-regression", () => {
  it("does not touch AI paths", () => {
    const diffFiles = ["src/lib/ai", "src/lib/agent"];
    for (const rel of diffFiles) {
      const full = path.join(REPO, rel);
      if (!fs.existsSync(full)) continue;
      const files = listFiles(rel, [".ts"]);
      for (const f of files) {
        const content = fs.readFileSync(f, "utf8");
        expect(content).not.toContain("ApplicationProfile");
        expect(content).not.toContain("applicationProfile");
      }
    }
    const action = read("src/actions/applicationProfile.actions.ts");
    expect(action).not.toMatch(/from ["']@\/lib\/ai\//);
    expect(action).not.toMatch(/from ["']@\/lib\/agent\//);
    expect(action).not.toContain("CareerContextBuilder");
    expect(action).not.toContain("prompt");
    expect(action).not.toMatch(/\bprovider\b.*AI|AI.*provider/);

    const workspace = read("src/components/career/application-profile/ApplicationProfileWorkspace.tsx");
    expect(workspace).not.toMatch(/AI_/);
    expect(workspace).not.toContain("CareerContextBuilder");
    expect(workspace.toLowerCase()).not.toContain("ai generate");
    expect(workspace).not.toContain("auto-fill with AI");
  });

  it("does not create AI integration in new career libs", () => {
    for (const rel of [
      "src/lib/career/access.ts",
      "src/lib/career/jobSearchPreferenceService.ts",
      "src/lib/career/applicationCopy.ts",
      "src/lib/career/sensitiveMask.ts",
      "src/lib/career/localDbPath.ts",
      "src/lib/career/careerMaterialInput.ts",
    ]) {
      const content = read(rel);
      expect(content).not.toMatch(/from ["']@\/lib\/ai\//);
      expect(content).not.toContain("CareerContextBuilder");
    }
  });
});

describe("application profile legacy no-regression", () => {
  it("does not dual-write legacy ContactInfo/Education/Skill", () => {
    const action = read("src/actions/applicationProfile.actions.ts");
    expect(action).not.toMatch(/prisma\.(contactInfo|resumeSection|workExperience|education|skill)\b/);
    expect(action).not.toContain("legacyMigration");
    expect(action).not.toContain("ResumeSection");
    // Services touched only B-side services.
    expect(action).toContain("CandidateProfileService");
    expect(action).toContain("JobSearchPreferenceService");
    expect(action).toContain("CareerMaterialService");
  });

  it("profile business code does not interpret runtime mode directly", () => {
    const candidates = [
      "src/actions/applicationProfile.actions.ts",
      "src/app/dashboard/profile/application/page.tsx",
      "src/app/dashboard/profile/page.tsx",
      "src/components/career/application-profile/ApplicationProfileWorkspace.tsx",
      "src/components/career/application-profile/EmergencyContactCard.tsx",
      "src/components/career/application-profile/ApplicationProfileField.tsx",
    ];
    for (const rel of candidates) {
      const content = read(rel);
      // Thin guard is the only allowed interpreter.
      expect(content).not.toContain('=== "AB_ENABLED"');
      expect(content).not.toContain("=== 'AB_ENABLED'");
      expect(content).not.toContain("CAREER_RUNTIME_MODE.AB_ENABLED");
    }
  });

  it("keeps sensitive values inside their dedicated actions only", () => {
    const action = read("src/actions/applicationProfile.actions.ts");
    // W4 opens idNumber/referee/attachment through their own explicit
    // actions; the broad profile + emergency-contact writers must still not
    // accept them.
    const profileInput = action.match(
      /updateApplicationCandidateProfile\(input:\s*\{([\s\S]*?)\}\):/,
    );
    expect(profileInput?.[1]).toBeTruthy();
    expect(profileInput?.[1]).not.toContain("idNumber");
    const emergencyInput = action.match(
      /updateEmergencyContact\(input:\s*\{([\s\S]*?)\}\):/,
    );
    expect(emergencyInput?.[1]).toBeTruthy();
    expect(emergencyInput?.[1]).not.toContain("idNumber");
    // Family members stay deferred; LANGUAGE uses the LANGUAGE material
    // type, never a LANGUAGE_TEST type string.
    expect(action).not.toMatch(/replaceCandidateFamilyMembers|CandidateFamilyMember/);
    expect(action).not.toContain("LANGUAGE_TEST");
    const workspace = read("src/components/career/application-profile/ApplicationProfileWorkspace.tsx");
    expect(workspace).not.toMatch(/idNumber\s*:/);
    expect(workspace).not.toContain("LANGUAGE_TEST");
    // LANGUAGE is a real material type now; the old unsupported hint is gone.
    expect(workspace).not.toContain("languageTestUnsupported");
  });
});
