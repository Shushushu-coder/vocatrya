// @vitest-environment node
/**
 * Task tool extension: extra tools exist ONLY for a Pilot conversation bound
 * to an ACTIVE owned task; the normal Pilot tool set is unchanged, and
 * approval-required tools stay approval-required.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { resolveTaskSessionTools } from "@/lib/agent/task/agentTaskTools";
import { INTERVIEW_SPRINT_TEMPLATE, taskExtraToolsFor } from "@/lib/agent/task/agentTaskTemplates";
import {
  AGENT_TASK_STATUS,
  transitionAgentTaskStatus,
} from "@/lib/agent/task/agentTaskStore";
import { AGENT_ROLE_TOOL_ALLOWLIST } from "@/lib/agent/agentRoles";
import { agentToolApproval, effectiveAgentToolNames } from "@/lib/agent/toolPermissions";
import { buildAgentTools } from "@/lib/agent/tools";
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";
import { seedSprint, type Sprint } from "./helpers/agentTaskHandoffFixtures";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let sprint: Sprint;

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  sprint = await seedSprint(prisma);
});

const EXTRAS = INTERVIEW_SPRINT_TEMPLATE.extraTools;

describe("template declaration", () => {
  it("declares its extra tools explicitly, all outside the Pilot allowlist", () => {
    expect(EXTRAS).toEqual(["match_job", "get_resume"]);
    for (const name of EXTRAS) {
      expect(AGENT_ROLE_TOOL_ALLOWLIST.pilot).not.toContain(name);
    }
    expect(taskExtraToolsFor("INTERVIEW_SPRINT")).toEqual(EXTRAS);
    expect(taskExtraToolsFor("UNKNOWN_TEMPLATE")).toEqual([]);
  });
});

describe("effectiveAgentToolNames with a task extension", () => {
  const base = { freshNativeFull: false, notionTools: ["notion_search", "notion_read"] };

  it("adds the extras to Pilot only, leaving the allowlisted tools in place", () => {
    const normal = effectiveAgentToolNames({ ...base, agentRole: "pilot" });
    const task = effectiveAgentToolNames({ ...base, agentRole: "pilot", taskExtraTools: EXTRAS });
    expect(normal).not.toContain("match_job");
    expect(normal).not.toContain("get_resume");
    expect(task).toEqual(expect.arrayContaining([...normal, ...EXTRAS]));
    expect(task.filter((name) => !normal.includes(name)).sort()).toEqual([...EXTRAS].sort());
  });

  it("normal Pilot conversations are unchanged for every runtime variant", () => {
    for (const freshNativeFull of [false, true]) {
      const plain = effectiveAgentToolNames({ agentRole: "pilot", freshNativeFull, notionTools: ["notion_read"] });
      expect(effectiveAgentToolNames({ agentRole: "pilot", freshNativeFull, notionTools: ["notion_read"], taskExtraTools: null })).toEqual(plain);
      expect(effectiveAgentToolNames({ agentRole: "pilot", freshNativeFull, notionTools: ["notion_read"], taskExtraTools: [] })).toEqual(plain);
    }
  });

  it("other roles never take the extension", () => {
    for (const agentRole of ["insight", "reflect", null, "bogus"]) {
      const plain = effectiveAgentToolNames({ agentRole, freshNativeFull: false });
      expect(effectiveAgentToolNames({ agentRole, freshNativeFull: false, taskExtraTools: EXTRAS })).toEqual(plain);
    }
  });

  it("cannot add anything the runtime does not register (fresh-native drops cover letters)", () => {
    const names = effectiveAgentToolNames({
      agentRole: "pilot",
      freshNativeFull: true,
      taskExtraTools: ["generate_cover_letter", "match_job", "not_a_tool"],
    });
    expect(names).not.toContain("generate_cover_letter");
    expect(names).not.toContain("not_a_tool");
    expect(names).toContain("match_job");
  });

  it("approval-required tools stay approval-required", () => {
    expect(agentToolApproval("match_job", true, "ask")).toBe("always");
    expect(agentToolApproval("add_job", true, "ask")).toBe("conditional");
    expect(agentToolApproval("notion_create_page", false, "ask")).toBe("always");
    expect(agentToolApproval("notion_delete_pages", false, "full")).toBe("always");
    expect(agentToolApproval("get_resume", true, "ask")).toBe("none");
  });
});

describe("resolveTaskSessionTools (the single decision point)", () => {
  const resolve = (over: Partial<Parameters<typeof resolveTaskSessionTools>[1]> = {}) =>
    resolveTaskSessionTools(prisma, {
      userId: sprint.userId,
      agentTaskId: sprint.task.id,
      agentRole: "pilot",
      ...over,
    });

  it("grants the template extras to a Pilot conversation bound to an ACTIVE owned task", async () => {
    expect(await resolve()).toEqual(EXTRAS);
  });

  it("grants nothing without a binding, with another role, or for a foreign task", async () => {
    expect(await resolve({ agentTaskId: null })).toBeNull();
    expect(await resolve({ agentTaskId: undefined })).toBeNull();
    expect(await resolve({ agentRole: "insight" })).toBeNull();
    expect(await resolve({ agentRole: null })).toBeNull();
    const intruder = await seedAccount(prisma, `t-${randomUUID()}@example.com`);
    expect(await resolve({ userId: intruder })).toBeNull();
    expect(await resolve({ agentTaskId: "missing" })).toBeNull();
  });

  it("stops granting once the task leaves ACTIVE, and resumes when it returns", async () => {
    await transitionAgentTaskStatus(prisma, { userId: sprint.userId, taskId: sprint.task.id, to: AGENT_TASK_STATUS.PAUSED });
    expect(await resolve()).toBeNull();
    await transitionAgentTaskStatus(prisma, {
      userId: sprint.userId,
      taskId: sprint.task.id,
      to: AGENT_TASK_STATUS.ACTIVE,
    });
    expect(await resolve()).toEqual(EXTRAS);
    await transitionAgentTaskStatus(prisma, {
      userId: sprint.userId,
      taskId: sprint.task.id,
      to: AGENT_TASK_STATUS.BLOCKED,
      blockedReason: "MISSING_FACTS",
    });
    expect(await resolve()).toBeNull();
    await transitionAgentTaskStatus(prisma, { userId: sprint.userId, taskId: sprint.task.id, to: AGENT_TASK_STATUS.ABANDONED });
    expect(await resolve()).toBeNull();
  });

  it("an archived task grants nothing", async () => {
    await prisma.agentTask.update({ where: { id: sprint.task.id }, data: { archivedAt: new Date() } });
    expect(await resolve()).toBeNull();
  });
});

describe("registry (buildAgentTools)", () => {
  const ctxFor = (extra: Record<string, unknown>) =>
    ({
      userId: sprint.userId,
      model: {} as never,
      provider: "OPENAI",
      modelName: "m",
      writer: { write: () => {}, merge: () => {} } as never,
      agentRole: "pilot",
      ...extra,
    }) as Parameters<typeof buildAgentTools>[0];

  it("registers match_job and get_resume only when the task extension is passed", async () => {
    const extras = await resolveTaskSessionTools(prisma, {
      userId: sprint.userId,
      agentTaskId: sprint.task.id,
      agentRole: "pilot",
    });
    const plain = Object.keys(buildAgentTools(ctxFor({}))).sort();
    const task = Object.keys(buildAgentTools(ctxFor({ taskExtraTools: extras }))).sort();
    expect(plain).not.toContain("match_job");
    expect(plain).not.toContain("get_resume");
    expect(task).toEqual([...plain, ...EXTRAS].sort());
  });

  it("the fresh-native match_job keeps its approval gate in a task session", () => {
    const tools = buildAgentTools(ctxFor({ freshNativeFull: true, canonicalJobs: true, taskExtraTools: EXTRAS }));
    expect(tools.match_job).toBeDefined();
    expect(tools.match_job.needsApproval).toBeTruthy();
  });

  it("keeps the gate in a task session under rules mode (CORE-1)", () => {
    // Task conversations default to permissionMode "rules"; de-gating the
    // canonical variant there made the send turn execute it without an
    // admitted approval and die on CONVERSATION_TURN_CONFLICT.
    const tools = buildAgentTools(
      ctxFor({ freshNativeFull: true, canonicalJobs: true, taskExtraTools: EXTRAS, permissionMode: "rules" }),
    );
    expect(tools.match_job.needsApproval).toBe(true);
  });

  it("non-Pilot roles ignore the extension in the live registry", () => {
    const plain = Object.keys(buildAgentTools(ctxFor({ agentRole: "reflect" }))).sort();
    const withExtra = Object.keys(buildAgentTools(ctxFor({ agentRole: "reflect", taskExtraTools: EXTRAS }))).sort();
    expect(withExtra).toEqual(plain);
  });
});
