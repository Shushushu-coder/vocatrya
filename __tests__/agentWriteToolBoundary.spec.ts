import fs from "node:fs";
import path from "node:path";

function read(relative: string): string {
  return fs.readFileSync(path.join(process.cwd(), relative), "utf8");
}

describe("agent write tools stay off the canonical read dispatch", () => {
  it("keeps the legacy creator and the canonical opportunity writer apart", () => {
    const source = read("src/lib/agent/tools/addJob.ts");
    expect(source).toContain("createJobFromNames");
    expect(source).toContain("createAgentOpportunity");
    expect(source).not.toContain("jobsReadDispatch");
    expect(source).not.toContain("canonicalJobRead");
    expect(source).not.toContain("runNestedGeneration");
    const creator = read("src/lib/career/createAgentOpportunity.ts");
    expect(creator).toContain("OpportunityService");
    expect(creator).not.toContain("createJobFromNames");
    expect(creator).not.toContain("prisma.job.create");
    expect(creator).not.toContain("applicationAttempt");
  });

  it("keeps match_job and generate_cover_letter on the legacy resolvers", () => {
    for (const file of [
      "src/lib/agent/tools/matchJob.ts",
      "src/lib/agent/tools/generateCoverLetter.ts",
    ]) {
      const source = read(file);
      expect(source).toContain("resolveJobForAgent");
      expect(source).toContain("resolveResumeForAgent");
      expect(source).not.toContain("getJobForAgent");
      expect(source).not.toContain("resolveCanonicalResumeForAgent");
      expect(source).not.toContain("jobsReadDispatch");
    }
  });

  it("keeps the legacy job resolver on prisma.job", () => {
    const source = read("src/lib/agent/jobLookup.ts");
    expect(source).toContain("prisma.job.findFirst");
    expect(source).not.toContain("jobsReadDispatch");
  });
});
