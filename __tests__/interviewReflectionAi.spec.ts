// CAREER_REFLECTION draft generation: resolution gating, the TEXT_ONLY
// one-shot call, strict draft parsing, and the never-write-back guarantee
// (the draft store is only touched through saveInterviewReflection after
// the user applies and saves).
import {
  generateInterviewReflectionDraft,
  parseInterviewReflectionDraft,
  type InterviewReflectionDraftDeps,
} from "@/lib/career/interviewReflectionAi";
import { generateInterviewReflectionDraft as generateDraftAction } from "@/actions/interviewReflectionAi.actions";
import { executeAIConnectionText } from "@/lib/ai/execution";
import { AIBusinessError } from "@/lib/ai/connections";
import { CareerRuntimeError } from "@/lib/career/errors";
import {
  AB_ROLLOUT_SCOPE_ENV,
  CAREER_RUNTIME_MODE,
} from "@/lib/career/identities";
import { getCurrentUser } from "@/utils/user.utils";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";

const dbFindFirst = vi.hoisted(() => vi.fn());
const dbAssignmentFindMany = vi.hoisted(() => vi.fn());
const writeDelegates = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    applicationProcessStep: { findFirst: dbFindFirst },
    aIBusinessAssignment: { findMany: dbAssignmentFindMany },
    aIConnection: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
    },
    userSettings: { findUnique: vi.fn(async () => null) },
    // Present so the spec can assert the generation path performs no
    // writes — persistence is exclusively the manual save path's job.
    applicationInterviewDetail: writeDelegates,
    applicationInterviewReflectionItem: writeDelegates,
  },
}));
vi.mock("@/utils/user.utils", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/career/runtimeMode", () => ({
  resolveCareerRuntimeMode: vi.fn(),
}));
vi.mock("@/lib/ai/execution", () => ({
  executeAIConnectionText: vi.fn(),
}));

const getUser = vi.mocked(getCurrentUser);
const resolveRuntime = vi.mocked(resolveCareerRuntimeMode);
const execSeam = vi.mocked(executeAIConnectionText);

function stepFixture() {
  return {
    id: "step-1",
    category: "INTERVIEW",
    label: "一面",
    status: "COMPLETED",
    scheduledAt: new Date("2026-10-20T02:00:00.000Z"),
    completedAt: new Date("2026-10-20T03:00:00.000Z"),
    result: null,
    notes: "聊了推荐系统项目",
    interviewDetail: {
      interviewFormat: "VIDEO",
      locationText: null,
      interviewerNames: "王面试官",
      durationMinutes: 60,
    },
    applicationAttempt: {
      channelLabel: "BOSS直聘",
      archivedAt: null as Date | null,
      jobOpportunity: {
        title: "推荐算法工程师",
        locationText: "上海",
        employmentType: "全职",
        archivedAt: null as Date | null,
        company: { label: "Acme" },
        currentJdVersion: { rawContent: "当前 JD 内容" },
      },
      submittedAgainstJdVersion: { rawContent: "投递时 JD 内容" },
      submittedResumeVersion: {
        versionNumber: 3,
        resumeVariant: { name: "算法岗简历" },
      },
    },
  };
}

const BYOK_CONNECTION = {
  id: "conn-byok",
  userId: "user-1",
  provider: "DEEPSEEK",
  backendKind: "LOCAL_BYOK",
  authType: "API_KEY",
  credentialRef: "9b2d1c2a-0000-4000-8000-000000000001",
  runtimeProfileRef: null,
  accountIdentity: null,
  displayName: "DeepSeek (API key)",
  status: "CONNECTED",
  archivedAt: null,
};

const MANAGED_CONNECTION = {
  ...BYOK_CONNECTION,
  id: "conn-managed",
  provider: "VOCATRYA",
  backendKind: "MANAGED_GATEWAY",
  authType: "MANAGED",
  credentialRef: null,
  displayName: "Vocatrya Managed",
};

function assignmentRow(connection: unknown = BYOK_CONNECTION) {
  return {
    id: "assign-1",
    purpose: "CAREER_REFLECTION",
    connectionId:
      (connection as { id?: string } | null)?.id ?? "conn-gone",
    model: "deepseek-chat",
    connection,
  };
}

const MODEL_OUTPUT = JSON.stringify({
  reflectionText: "【面试概况】一面（视频，60 分钟）\n【待补充：发挥如何】",
  items: [
    { questionText: "介绍一下你的推荐系统项目", answerNotes: "讲了模型结构" },
    { questionText: "如何处理冷启动", answerNotes: null },
  ],
});

function fakeDb(overrides: {
  step?: unknown;
  assignments?: unknown[];
  onAssignmentRead?: () => void;
}): NonNullable<InterviewReflectionDraftDeps["dbClient"]> {
  return {
    applicationProcessStep: {
      findFirst: vi.fn(async () =>
        "step" in overrides ? overrides.step : stepFixture(),
      ),
    },
    aIBusinessAssignment: {
      findMany: vi.fn(async () => {
        overrides.onAssignmentRead?.();
        return overrides.assignments ?? [];
      }),
    },
    aIConnection: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
    },
    userSettings: { findUnique: vi.fn(async () => null) },
    applicationInterviewDetail: writeDelegates,
    applicationInterviewReflectionItem: writeDelegates,
  } as unknown as NonNullable<InterviewReflectionDraftDeps["dbClient"]>;
}

describe("generateInterviewReflectionDraft (lib)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports NOT_CONFIGURED without executing when nothing resolves", async () => {
    const execText = vi.fn(async (_input: { prompt: string }) => ({ text: MODEL_OUTPUT }));
    const outcome = await generateInterviewReflectionDraft(
      { userId: "user-1", applicationProcessStepId: "step-1" },
      { dbClient: fakeDb({ assignments: [] }), execText },
    );
    expect(outcome).toEqual({ status: "NOT_CONFIGURED" });
    expect(execText).not.toHaveBeenCalled();
  });

  it("reports INVALID_ASSIGNMENT with the resolution code and never executes", async () => {
    const execText = vi.fn(async (_input: { prompt: string }) => ({ text: MODEL_OUTPUT }));
    // A dangling assignment: the pinned connection row no longer exists.
    const outcome = await generateInterviewReflectionDraft(
      { userId: "user-1", applicationProcessStepId: "step-1" },
      {
        dbClient: fakeDb({ assignments: [assignmentRow(null)] }),
        execText,
      },
    );
    expect(outcome).toEqual({
      status: "INVALID_ASSIGNMENT",
      code: "ASSIGNED_CONNECTION_UNAVAILABLE",
    });
    expect(execText).not.toHaveBeenCalled();
  });

  it("falls back to GLOBAL_DEFAULT and executes on the resolved pair", async () => {
    const execText = vi.fn(async (_input: { prompt: string }) => ({ text: MODEL_OUTPUT }));
    const outcome = await generateInterviewReflectionDraft(
      { userId: "user-1", applicationProcessStepId: "step-1" },
      {
        dbClient: fakeDb({
          assignments: [
            { ...assignmentRow(), id: "gd", purpose: "GLOBAL_DEFAULT" },
          ],
        }),
        execText,
      },
    );
    expect(outcome.status).toBe("DRAFT");
    expect(execText).toHaveBeenCalledTimes(1);
    expect(execText).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        connectionId: "conn-byok",
        model: "deepseek-chat",
      }),
    );
  });

  it("sends step, position, material context and recorded notes as one TEXT_ONLY prompt", async () => {
    const execText = vi.fn(async (_input: { prompt: string }) => ({ text: MODEL_OUTPUT }));
    await generateInterviewReflectionDraft(
      {
        userId: "user-1",
        applicationProcessStepId: "step-1",
        current: {
          reflectionText: "已经写了一半的反思",
          items: [
            { questionText: "用户已记录的问题", answerNotes: "用户已写的要点" },
          ],
        },
      },
      { dbClient: fakeDb({ assignments: [assignmentRow()] }), execText },
    );
    const prompt = execText.mock.calls[0][0].prompt;
    expect(prompt).toContain("一面");
    expect(prompt).toContain("Acme");
    expect(prompt).toContain("推荐算法工程师");
    expect(prompt).toContain("投递时 JD 内容");
    expect(prompt).toContain("王面试官");
    expect(prompt).toContain("算法岗简历");
    expect(prompt).toContain("用户已记录的问题");
    expect(prompt).toContain("已经写了一半的反思");
    expect(prompt).toContain("Simplified Chinese");
  });

  it("managed resolution executes with a fresh operation id and the reflection resource key", async () => {
    const execText = vi.fn(async (_input: { prompt: string }) => ({ text: MODEL_OUTPUT }));
    const outcome = await generateInterviewReflectionDraft(
      { userId: "user-1", applicationProcessStepId: "step-1" },
      {
        dbClient: fakeDb({ assignments: [assignmentRow(MANAGED_CONNECTION)] }),
        execText,
        createOperationId: () => "op-fixed",
      },
    );
    expect(outcome.status).toBe("DRAFT");
    expect(execText).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-managed",
        operationId: "op-fixed",
        managedResource: {
          business: "CAREER_REFLECTION",
          resourceKey: "interview-reflection:step-1",
        },
      }),
    );
  });

  it("returns a parsed draft and performs no writes on the reflection store", async () => {
    const execText = vi.fn(async (_input: { prompt: string }) => ({ text: MODEL_OUTPUT }));
    const outcome = await generateInterviewReflectionDraft(
      { userId: "user-1", applicationProcessStepId: "step-1" },
      { dbClient: fakeDb({ assignments: [assignmentRow()] }), execText },
    );
    expect(outcome).toEqual({
      status: "DRAFT",
      draft: {
        reflectionText:
          "【面试概况】一面（视频，60 分钟）\n【待补充：发挥如何】",
        items: [
          {
            questionText: "介绍一下你的推荐系统项目",
            answerNotes: "讲了模型结构",
          },
          { questionText: "如何处理冷启动", answerNotes: null },
        ],
      },
    });
    for (const write of Object.values(writeDelegates)) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("throws on malformed model output", async () => {
    const execText = vi.fn(async () => ({ text: "not json at all" }));
    await expect(
      generateInterviewReflectionDraft(
        { userId: "user-1", applicationProcessStepId: "step-1" },
        { dbClient: fakeDb({ assignments: [assignmentRow()] }), execText },
      ),
    ).rejects.toBeInstanceOf(AIBusinessError);
  });

  it("throws when the draft is entirely empty", async () => {
    const execText = vi.fn(async () => ({ text: "{}" }));
    await expect(
      generateInterviewReflectionDraft(
        { userId: "user-1", applicationProcessStepId: "step-1" },
        { dbClient: fakeDb({ assignments: [assignmentRow()] }), execText },
      ),
    ).rejects.toBeInstanceOf(AIBusinessError);
  });

  it("rejects an archived opportunity before resolving or executing", async () => {
    const execText = vi.fn(async (_input: { prompt: string }) => ({ text: MODEL_OUTPUT }));
    const step = stepFixture();
    step.applicationAttempt.jobOpportunity.archivedAt = new Date(
      "2026-10-21T00:00:00.000Z",
    );
    const db = fakeDb({ step, assignments: [assignmentRow()] })!;
    await expect(
      generateInterviewReflectionDraft(
        { userId: "user-1", applicationProcessStepId: "step-1" },
        { dbClient: db, execText },
      ),
    ).rejects.toMatchObject({
      name: "CareerRuntimeError",
      code: "OPPORTUNITY_ARCHIVED",
    });
    expect(execText).not.toHaveBeenCalled();
    expect(db.aIBusinessAssignment.findMany).not.toHaveBeenCalled();
  });

  it("rejects an archived application attempt before resolving or executing", async () => {
    const execText = vi.fn(async (_input: { prompt: string }) => ({ text: MODEL_OUTPUT }));
    const step = stepFixture();
    step.applicationAttempt.archivedAt = new Date("2026-10-21T00:00:00.000Z");
    const db = fakeDb({ step, assignments: [assignmentRow()] })!;
    await expect(
      generateInterviewReflectionDraft(
        { userId: "user-1", applicationProcessStepId: "step-1" },
        { dbClient: db, execText },
      ),
    ).rejects.toMatchObject({
      name: "CareerRuntimeError",
      code: "ATTEMPT_ARCHIVED",
    });
    expect(execText).not.toHaveBeenCalled();
    expect(db.aIBusinessAssignment.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ["opportunity", "OPPORTUNITY_ARCHIVED"],
    ["attempt", "ATTEMPT_ARCHIVED"],
    ["removed step", "PROCESS_STEP_NOT_FOUND"],
  ])("rejects a %s changed during AI configuration resolution", async (source, code) => {
    const execText = vi.fn(async (_input: { prompt: string }) => ({ text: MODEL_OUTPUT }));
    const initial = stepFixture();
    const updated = stepFixture();
    if (source === "opportunity") {
      updated.applicationAttempt.jobOpportunity.archivedAt = new Date();
    } else {
      updated.applicationAttempt.archivedAt = new Date();
    }
    const db = fakeDb({
      step: initial,
      assignments: [assignmentRow()],
      onAssignmentRead: () => {
        vi.mocked(db.applicationProcessStep.findFirst).mockResolvedValueOnce(
          (source === "removed step" ? null : updated) as never,
        );
      },
    });
    await expect(
      generateInterviewReflectionDraft(
        { userId: "user-1", applicationProcessStepId: "step-1" },
        { dbClient: db, execText },
      ),
    ).rejects.toMatchObject({ code });
    expect(execText).not.toHaveBeenCalled();
  });

  it("rejects a non-interview step before resolving or executing", async () => {
    const execText = vi.fn(async (_input: { prompt: string }) => ({ text: MODEL_OUTPUT }));
    const assignments = [assignmentRow()];
    const db = fakeDb({ step: { ...stepFixture(), category: "ASSESSMENT" }, assignments })!;
    await expect(
      generateInterviewReflectionDraft(
        { userId: "user-1", applicationProcessStepId: "step-1" },
        { dbClient: db, execText },
      ),
    ).rejects.toMatchObject({
      name: "CareerRuntimeError",
      code: "INTERVIEW_REFLECTION_STEP_CATEGORY_INVALID",
    });
    expect(execText).not.toHaveBeenCalled();
    expect(db.aIBusinessAssignment.findMany).not.toHaveBeenCalled();
  });

  it("fails closed when the step is not owned by the user", async () => {
    const execText = vi.fn(async (_input: { prompt: string }) => ({ text: MODEL_OUTPUT }));
    await expect(
      generateInterviewReflectionDraft(
        { userId: "user-1", applicationProcessStepId: "step-1" },
        { dbClient: fakeDb({ step: null }), execText },
      ),
    ).rejects.toBeInstanceOf(CareerRuntimeError);
    expect(execText).not.toHaveBeenCalled();
  });
});

describe("parseInterviewReflectionDraft", () => {
  it("accepts a fenced JSON object and drops malformed items", () => {
    const draft = parseInterviewReflectionDraft(
      "```json\n" +
        JSON.stringify({
          reflectionText: "  整体反思  ",
          items: [
            { questionText: "有效问题", answerNotes: "  " },
            { questionText: "   " },
            { answerNotes: "没有问题" },
            "not-an-object",
            { questionText: "第二个问题" },
          ],
        }) +
        "\n```",
    );
    expect(draft.reflectionText).toBe("整体反思");
    expect(draft.items).toEqual([
      { questionText: "有效问题", answerNotes: null },
      { questionText: "第二个问题", answerNotes: null },
    ]);
  });

  it("rejects non-object output", () => {
    expect(() => parseInterviewReflectionDraft("[1,2,3]")).toThrow(
      AIBusinessError,
    );
    expect(() => parseInterviewReflectionDraft("")).toThrow(AIBusinessError);
    expect(() => parseInterviewReflectionDraft("plain text")).toThrow(
      AIBusinessError,
    );
  });
});

describe("generateInterviewReflectionDraft (action)", () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ id: "user-1" } as never);
    dbFindFirst.mockResolvedValue(stepFixture());
    dbAssignmentFindMany.mockResolvedValue([]);
    execSeam.mockResolvedValue({ text: MODEL_OUTPUT } as never);
  });

  it("is blocked in LEGACY_ONLY like the rest of the reflection surface", async () => {
    resolveRuntime.mockResolvedValue({
      mode: CAREER_RUNTIME_MODE.LEGACY_ONLY,
    } as never);
    const result = await generateDraftAction({
      applicationProcessStepId: "step-1",
    });
    expect(result.success).toBe(false);
    expect(dbFindFirst).not.toHaveBeenCalled();
  });

  it("runs the resolution gate server-side on a read surface", async () => {
    resolveRuntime.mockResolvedValue({
      mode: CAREER_RUNTIME_MODE.AB_READY_DISABLED,
    } as never);
    // No assignment rows → the honest NOT_CONFIGURED outcome, no execution.
    const result = await generateDraftAction({
      applicationProcessStepId: "step-1",
    });
    expect(result).toEqual({
      success: true,
      data: { status: "NOT_CONFIGURED" },
    });
    expect(execSeam).not.toHaveBeenCalled();
  });

  it("surfaces OPPORTUNITY_ARCHIVED and never executes for an archived job", async () => {
    resolveRuntime.mockResolvedValue({
      mode: CAREER_RUNTIME_MODE.AB_READY_DISABLED,
    } as never);
    const step = stepFixture();
    step.applicationAttempt.jobOpportunity.archivedAt = new Date(
      "2026-10-21T00:00:00.000Z",
    );
    dbFindFirst.mockResolvedValue(step);
    const result = await generateDraftAction({
      applicationProcessStepId: "step-1",
    });
    expect(result).toMatchObject({
      success: false,
      code: "OPPORTUNITY_ARCHIVED",
    });
    expect(execSeam).not.toHaveBeenCalled();
    expect(dbAssignmentFindMany).not.toHaveBeenCalled();
  });

  it("executes through the shared seam and returns the draft in AB_ENABLED full scope", async () => {
    const previous = process.env[AB_ROLLOUT_SCOPE_ENV];
    process.env[AB_ROLLOUT_SCOPE_ENV] = "full";
    try {
      resolveRuntime.mockResolvedValue({
        mode: CAREER_RUNTIME_MODE.AB_ENABLED,
        rolloutScope: "full",
      } as never);
      dbAssignmentFindMany.mockResolvedValue([assignmentRow()]);
      const result = await generateDraftAction({
        applicationProcessStepId: "step-1",
        current: { items: [{ questionText: "记录的问题" }] },
      });
      expect(result).toMatchObject({ success: true, data: { status: "DRAFT" } });
      expect(execSeam).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          connectionId: "conn-byok",
          model: "deepseek-chat",
        }),
      );
    } finally {
      if (previous === undefined) delete process.env[AB_ROLLOUT_SCOPE_ENV];
      else process.env[AB_ROLLOUT_SCOPE_ENV] = previous;
    }
  });
});
