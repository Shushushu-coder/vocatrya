// @vitest-environment node
import fs from "node:fs";
import type { PrismaClient } from "@prisma/client";
import type { UIMessage } from "ai";
import { executeAIConnectionText } from "@/lib/ai/execution";
import { executeAIConnectionTextStream } from "@/lib/ai/streaming-execution";
import {
  AB_ROLLOUT_SCOPE_ENV,
  AB_RUNTIME_FEATURE_ENV,
  activateFreshAbNative,
} from "@/lib/career";
import { createJobFromNames } from "@/lib/jobs/createJobFromNames";
import { getOpportunityAsJob } from "@/lib/career/jobOpportunityAdapter";
import { jobDescriptionEditorHtml } from "@/lib/jobs/description";
import {
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

vi.mock("@/lib/jobs/createJobFromNames", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/jobs/createJobFromNames")>();
  return {
    ...actual,
    createJobFromNames: vi.fn(actual.createJobFromNames),
  };
});
vi.mock("@/lib/ai/execution", () => ({
  executeAIConnectionText: vi.fn(),
}));
vi.mock("@/lib/ai/streaming-execution", () => ({
  executeAIConnectionTextStream: vi.fn(),
  checkStreamingTurnReadiness: vi.fn(),
}));

// The career barrel imports db before module body env assignment. Bind the
// disposable database explicitly so a worktree needs no production .env.
const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const ctx = helpers.makeTestDbUrl();
  helpers.pushSchema(ctx.url);
  return ctx;
});
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return { default: new PrismaClient({ datasources: { db: { url: ctx.url } } }) };
});
delete process.env[AB_RUNTIME_FEATURE_ENV];
delete process.env[AB_ROLLOUT_SCOPE_ENV];

const CHINESE_JD = "负责后端服务开发参与商业化系统迭代并与产品同学协作完成需求上线同时保障接口稳定与数据正确这是一段连续中文职位描述";

let appPrisma: PrismaClient;
let buildAddJobTool: typeof import("@/lib/agent/tools/addJob").buildAddJobTool;
let runAccountAgentTurn: typeof import("@/lib/agent/accountTurn").runAccountAgentTurn;
let listJobsForAgent: typeof import("@/lib/agent/canonicalJobRead").listJobsForAgent;
let getJobForAgent: typeof import("@/lib/agent/canonicalJobRead").getJobForAgent;
let listJobs: typeof import("@/lib/career/jobsReadDispatch").listJobs;
let getJob: typeof import("@/lib/career/jobsReadDispatch").getJob;
let userId: string;

beforeAll(async () => {
  const dbMod = await import("@/lib/db");
  appPrisma = dbMod.default;
  buildAddJobTool = (await import("@/lib/agent/tools/addJob")).buildAddJobTool;
  runAccountAgentTurn = (await import("@/lib/agent/accountTurn")).runAccountAgentTurn;
  const reads = await import("@/lib/agent/canonicalJobRead");
  listJobsForAgent = reads.listJobsForAgent;
  getJobForAgent = reads.getJobForAgent;
  const dispatch = await import("@/lib/career/jobsReadDispatch");
  listJobs = dispatch.listJobs;
  getJob = dispatch.getJob;
}, 120_000);

afterAll(async () => {
  await appPrisma?.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env[AB_RUNTIME_FEATURE_ENV];
  delete process.env[AB_ROLLOUT_SCOPE_ENV];
  await resetDisposableDb(appPrisma);
  userId = await seedAccount(appPrisma, `agent-add-${Date.now()}@example.com`);
});

function enableFull() {
  process.env[AB_RUNTIME_FEATURE_ENV] = "true";
  process.env[AB_ROLLOUT_SCOPE_ENV] = "full";
}

async function freshFull() {
  enableFull();
  await activateFreshAbNative(appPrisma);
}

function execute(
  tool: {
    execute?: (
      input: never,
      ctx: never,
    ) => PromiseLike<unknown> | AsyncIterable<unknown> | unknown;
  },
  input: unknown,
  toolCallId = "call-1",
) {
  return Promise.resolve(
    tool.execute!(input as never, { toolCallId, messages: [] } as never) as PromiseLike<unknown>,
  );
}

async function counts() {
  const [opportunities, jobs, attempts, notes, parses, versions, companies] = await Promise.all([
    appPrisma.jobOpportunity.count(),
    appPrisma.job.count(),
    appPrisma.applicationAttempt.count(),
    appPrisma.note.count(),
    appPrisma.jobDescriptionParse.count(),
    appPrisma.jobDescriptionVersion.count(),
    appPrisma.company.count(),
  ]);
  return { opportunities, jobs, attempts, notes, parses, versions, companies };
}

function canonicalTool(pastedText?: string) {
  return buildAddJobTool(userId, pastedText, { canonical: true });
}

describe("canonical add_job", () => {
  it("stores a DateOnly deadline and returns its declared precision without an instant", async () => {
    await freshFull();
    const result = await execute(canonicalTool(), {
      company: "Acme", jobTitle: "Engineer", deadlineOn: "2026-11-30",
    });
    const id = (result as { jobOpportunityId: string }).jobOpportunityId;
    expect(result).toMatchObject({ created: true });
    expect(await appPrisma.jobOpportunity.findUniqueOrThrow({ where: { id } }))
      .toMatchObject({ deadlineOn: "2026-11-30", deadline: null, deadlinePrecision: "dateOnly" });
    expect(await getJobForAgent(userId, id)).toMatchObject({
      status: "ok", job: { deadlineOn: "2026-11-30", deadlinePrecision: "dateOnly", dueDate: null },
    });
    expect(createJobFromNames).not.toHaveBeenCalled();
  });

  it("asks for approval before a company and title can be written, including without a description", async () => {
    const tool = canonicalTool();
    const gate = tool.needsApproval as (input: unknown, ctx: unknown) => boolean;
    expect(gate({ company: "腾讯", jobTitle: "后端开发实习" }, { toolCallId: "c", messages: [] })).toBe(true);
    expect(gate({ company: "腾讯" }, { toolCallId: "c", messages: [] })).toBe(false);
    expect(await counts()).toMatchObject({ opportunities: 0, jobs: 0, companies: 0 });
    expect(createJobFromNames).not.toHaveBeenCalled();
  });

  it("creates one opportunity from company and title and does not write legacy rows", async () => {
    await freshFull();
    const result = await execute(canonicalTool(), {
      company: "腾讯",
      jobTitle: "后端开发实习",
      location: "深圳",
      applied: true,
      status: "applied",
      tags: ["Go"],
    });
    expect(result).toMatchObject({
      created: true,
      company: "腾讯",
      title: "后端开发实习",
    });
    const id = (result as { jobOpportunityId: string }).jobOpportunityId;
    expect((result as { jobId: string }).jobId).toBe(id);
    expect(await counts()).toMatchObject({
      opportunities: 1,
      jobs: 0,
      attempts: 0,
      notes: 0,
      parses: 0,
      versions: 0,
    });
    const row = await appPrisma.jobOpportunity.findUniqueOrThrow({
      where: { id },
      include: { company: true },
    });
    expect(row.userId).toBe(userId);
    expect(row.company.label).toBe("腾讯");
    expect(row.title).toBe("后端开发实习");
    expect(row.locationText).toBe("深圳");
    expect(row.status).toBe("UNKNOWN");
    expect(row.campaignId).toBeNull();
    expect(row.currentJdVersionId).toBeNull();
    expect(row.employmentType).toBeNull();
    expect(createJobFromNames).not.toHaveBeenCalled();
  });

  it("stores a continuous Chinese description as the raw JD version", async () => {
    await freshFull();
    const url = "https://jobs.example.com/tencent/backend";
    const result = await execute(canonicalTool(), {
      company: "字节跳动",
      jobTitle: "商业化后端实习",
      location: "上海",
      source: "BOSS Zhipin",
      jobUrl: url,
      jobDescription: CHINESE_JD,
      salaryRange: "400元/天",
    });
    const id = (result as { jobOpportunityId: string }).jobOpportunityId;
    const version = await appPrisma.jobDescriptionVersion.findFirstOrThrow({
      where: { jobOpportunityId: id },
    });
    expect(version.rawContent).toBe(CHINESE_JD);
    expect(version.rawContentFormat).toBe("PLAIN_TEXT");
    const row = await appPrisma.jobOpportunity.findUniqueOrThrow({ where: { id } });
    expect(row.currentJdVersionId).toBe(version.id);
    expect(row.sourceUrl).toBe(url);
    expect(row.salaryText).toBe("400元/天");
    expect(row.sourceLabel).toBe("BOSS Zhipin");
    expect(await appPrisma.jobDescriptionParse.count()).toBe(0);
    expect(await appPrisma.applicationAttempt.count()).toBe(0);
    expect(await appPrisma.job.count()).toBe(0);
  });

  it("projects multiline plain JD safely for the rich text viewer while preserving stored source and existing HTML", async () => {
    await freshFull();
    const source = '岗位职责\r\n负责研发 <Agent> & 产品\r\n\r\n任职要求\n熟悉 TypeScript';
    const result = await execute(canonicalTool(), { company: "测试公司", jobTitle: "产品经理", jobDescription: source });
    const id = (result as { jobOpportunityId: string }).jobOpportunityId;
    const version = await appPrisma.jobDescriptionVersion.findFirstOrThrow({ where: { jobOpportunityId: id } });
    expect(version.rawContent).toBe(source);
    const view = await getOpportunityAsJob(appPrisma, userId, id);
    expect(view?.description).toBe(source);
    expect(view?.descriptionFormat).toBe("PLAIN_TEXT");
    expect(jobDescriptionEditorHtml(view!)).toBe('<p>岗位职责<br>负责研发 &lt;Agent&gt; &amp; 产品<br><br>任职要求<br>熟悉 TypeScript</p>');
    const html = '<h2>岗位职责</h2><p>负责研发<br>保留格式</p>';
    await appPrisma.jobDescriptionVersion.update({ where: { id: version.id }, data: { rawContent: html, rawContentFormat: "HTML" } });
    expect(jobDescriptionEditorHtml((await getOpportunityAsJob(appPrisma, userId, id))!)).toBe(html);
  });

  it("reuses an existing company and creates a new one only when the name is new", async () => {
    await freshFull();
    await execute(canonicalTool(), { company: "腾讯", jobTitle: "后端开发实习" }, "first");
    const afterFirst = await appPrisma.company.count({ where: { createdBy: userId } });
    await execute(canonicalTool(), { company: " 腾讯 ", jobTitle: "后端工程师" }, "second");
    expect(await appPrisma.company.count({ where: { createdBy: userId } })).toBe(afterFirst);
    expect(await appPrisma.jobOpportunity.count()).toBe(2);
    await execute(canonicalTool(), { company: "网易", jobTitle: "后端开发实习" }, "third");
    expect(await appPrisma.company.count({ where: { createdBy: userId } })).toBe(afterFirst + 1);
  });

  it("replays the same approved tool call as one opportunity", async () => {
    await freshFull();
    const input = { company: "腾讯", jobTitle: "后端开发实习", location: "深圳" };
    const first = await execute(canonicalTool(), input, "same-call");
    const second = await execute(canonicalTool(), input, "same-call");
    expect((first as { jobOpportunityId: string }).jobOpportunityId).toBe(
      (second as { jobOpportunityId: string }).jobOpportunityId,
    );
    expect(await appPrisma.jobOpportunity.count()).toBe(1);
    expect(await appPrisma.company.count({ where: { createdBy: userId } })).toBe(1);
  });

  it("returns a validation error and writes nothing for missing company/title or an invalid URL", async () => {
    await freshFull();
    for (const input of [{ company: "腾讯" }, { jobTitle: "后端开发实习" }]) {
      const missing = await execute(canonicalTool(), input);
      expect(missing).toMatchObject({ created: false });
      expect(await counts()).toMatchObject({ opportunities: 0, jobs: 0, companies: 0, versions: 0 });
    }
    const blank = await execute(canonicalTool(), { company: "腾讯", jobTitle: "   " });
    expect(blank).toMatchObject({ created: false });
    expect((blank as { validationError: string }).validationError).toMatch(/jobTitle|title/i);
    const badUrl = await execute(canonicalTool(), {
      company: "腾讯",
      jobTitle: "后端开发实习",
      jobUrl: "not-a-url",
    });
    expect(badUrl).toMatchObject({ created: false });
    expect((badUrl as { validationError: string }).validationError).toMatch(/jobUrl/);
    expect(await counts()).toMatchObject({ opportunities: 0, jobs: 0, companies: 0, versions: 0 });
  });

  it("does not fall back to a legacy job when the canonical writer fails", async () => {
    await freshFull();
    const { OpportunityService } = await import("@/lib/career/opportunityService");
    const spy = vi.spyOn(OpportunityService.prototype, "create").mockRejectedValueOnce(new Error("canonical down"));
    try {
      const result = await execute(canonicalTool(), {
        company: "回滚公司",
        jobTitle: "后端开发实习",
        jobDescription: CHINESE_JD,
      });
      expect(result).toMatchObject({ created: false });
      expect(JSON.stringify(result)).not.toMatch(/canonical down|已添加/);
      expect(createJobFromNames).not.toHaveBeenCalled();
      expect(await counts()).toMatchObject({
        opportunities: 0,
        jobs: 0,
        companies: 0,
        versions: 0,
        attempts: 0,
        notes: 0,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("is visible to list_jobs, get_job, and the My Jobs read path", async () => {
    await freshFull();
    const created = await execute(canonicalTool(), {
      company: "腾讯",
      jobTitle: "后端开发实习",
      location: "深圳",
      jobDescription: CHINESE_JD,
    });
    const id = (created as { jobOpportunityId: string }).jobOpportunityId;
    const listed = await listJobsForAgent(userId);
    expect(listed.status).toBe("ok");
    if (listed.status !== "ok") return;
    expect(listed.jobs.map((job) => job.id)).toContain(id);
    const loaded = await getJobForAgent(userId, id);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.job.company).toBe("腾讯");
      expect(loaded.job.title).toBe("后端开发实习");
      expect(loaded.job.location).toBe("深圳");
      expect(loaded.job.jobDescription).toBe(CHINESE_JD);
    }
    const uiList = await listJobs(appPrisma, userId, {});
    if (uiList.blocked) throw new Error(uiList.message);
    expect(uiList.data.map((job) => job.id)).toContain(id);
    const uiJob = await getJob(appPrisma, userId, id);
    if (uiJob.blocked) throw new Error(uiJob.message);
    expect(uiJob.job?.id).toBe(id);
    expect(uiJob.job?.description).toContain("负责后端服务开发");
  });
});

describe("canonical add_job approval gate", () => {
  function writer() {
    const chunks: { type: string }[] = [];
    return {
      chunks,
      write: (part: { type: string }) => {
        chunks.push(part);
      },
      merge: () => {},
      onError: undefined,
    };
  }

  const base = {
    provider: "DEVIN",
    backendKind: "DEVIN_RUNTIME",
    modelName: "swe-2",
    systemPrompt: "system",
    freshNativeFull: true,
    canonicalJobs: true,
  } as const;

  it("proposes add_job without writing", async () => {
    await freshFull();
    (executeAIConnectionText as any).mockResolvedValue({
      text: '{"type":"tool_call","tool":"add_job","arguments":"{\\"company\\":\\"腾讯\\",\\"jobTitle\\":\\"后端开发实习\\"}"}',
    });
    const sink = writer();
    const result = await runAccountAgentTurn({
      ...base,
      userId,
      connectionId: "conn-1",
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "帮我添加腾讯的后端开发实习" }] }] as UIMessage[],
      writer: sink as never,
      signal: new AbortController().signal,
    });
    expect(result.paused).toBe(true);
    expect(sink.chunks.map((chunk) => chunk.type)).toContain("tool-approval-request");
    expect(sink.chunks.map((chunk) => chunk.type)).not.toContain("tool-output-available");
    expect(await counts()).toMatchObject({ opportunities: 0, jobs: 0, companies: 0 });
  });

  it("writes nothing when the approval is rejected", async () => {
    await freshFull();
    (executeAIConnectionText as any).mockResolvedValue({
      text: '{"type":"assistant_response","tool":null,"arguments":null}',
    });
    (executeAIConnectionTextStream as any).mockReturnValue((async function* () {
      yield { type: "text-delta", delta: "好的" };
      yield { type: "completed", text: "好的" };
    })());
    const denied = {
      id: "asst-1",
      role: "assistant",
      parts: [
        {
          type: "tool-add_job",
          toolCallId: "call-reject",
          state: "approval-responded",
          input: { company: "腾讯", jobTitle: "后端开发实习" },
          approval: { id: "ap-1", approved: false, reason: "不对" },
        },
      ],
    } as unknown as UIMessage;
    const sink = writer();
    await runAccountAgentTurn({
      ...base,
      userId,
      connectionId: "conn-1",
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "添加职位" }] } as UIMessage,
        denied,
      ],
      writer: sink as never,
      signal: new AbortController().signal,
    });
    expect(sink.chunks.map((chunk) => chunk.type)).toContain("tool-output-denied");
    expect(await counts()).toMatchObject({ opportunities: 0, jobs: 0, companies: 0 });
    expect(createJobFromNames).not.toHaveBeenCalled();
  });

  it("writes exactly one opportunity when the approval is accepted", async () => {
    await freshFull();
    (executeAIConnectionText as any).mockResolvedValue({
      text: '{"type":"assistant_response","tool":null,"arguments":null}',
    });
    (executeAIConnectionTextStream as any).mockReturnValue((async function* () {
      yield { type: "text-delta", delta: "已添加" };
      yield { type: "completed", text: "已添加" };
    })());
    const approved = {
      id: "asst-1",
      role: "assistant",
      parts: [
        {
          type: "tool-add_job",
          toolCallId: "call-approve",
          state: "approval-responded",
          input: { company: "腾讯", jobTitle: "后端开发实习", location: "深圳" },
          approval: { id: "ap-1", approved: true },
        },
      ],
    } as unknown as UIMessage;
    const sink = writer();
    await runAccountAgentTurn({
      ...base,
      userId,
      connectionId: "conn-1",
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "帮我添加腾讯的后端开发实习" }] } as UIMessage,
        approved,
      ],
      writer: sink as never,
      signal: new AbortController().signal,
    });
    expect(await appPrisma.jobOpportunity.count()).toBe(1);
    expect(await appPrisma.job.count()).toBe(0);
    expect(await appPrisma.applicationAttempt.count()).toBe(0);
    const output = sink.chunks.find((chunk) => chunk.type === "tool-output-available") as
      | { output?: { created?: boolean; company?: string; title?: string } }
      | undefined;
    expect(output?.output).toMatchObject({
      created: true,
      company: "腾讯",
      title: "后端开发实习",
    });
  });
});
