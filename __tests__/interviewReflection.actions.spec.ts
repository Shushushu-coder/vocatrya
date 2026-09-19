import {
  getInterviewReflection,
  saveInterviewReflection,
} from "@/actions/application.actions";
import {
  AB_ROLLOUT_SCOPE_ENV,
  CAREER_RUNTIME_MODE,
} from "@/lib/career/identities";
import { getCurrentUser } from "@/utils/user.utils";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";

const { getServiceReflection, saveServiceReflection } = vi.hoisted(() => ({
  getServiceReflection: vi.fn(),
  saveServiceReflection: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ default: {} }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn(),
}));
vi.mock("@/lib/career/runtimeMode", () => ({
  resolveCareerRuntimeMode: vi.fn(),
}));

vi.mock("@/lib/career/applicationService", () => ({
  ApplicationService: class {
    getInterviewReflection = getServiceReflection;
    saveInterviewReflection = saveServiceReflection;
  },
}));

const getUser = vi.mocked(getCurrentUser);
const resolveRuntime = vi.mocked(resolveCareerRuntimeMode);

describe("interview reflection actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ id: "user-1" } as never);
    getServiceReflection.mockResolvedValue({
      applicationProcessStepId: "step-1",
      reflectionText: null,
      items: [],
    });
    saveServiceReflection.mockResolvedValue({
      applicationProcessStepId: "step-1",
      reflectionText: "整场复盘",
      items: [],
    });
  });

  it("reads through the A+B timeline read gate", async () => {
    resolveRuntime.mockResolvedValue({
      mode: CAREER_RUNTIME_MODE.AB_READY_DISABLED,
    } as never);
    const result = await getInterviewReflection("step-1");
    expect(result.success).toBe(true);
    expect(getServiceReflection).toHaveBeenCalledWith("step-1");
  });

  it("does not enter the reflection product path in LEGACY_ONLY", async () => {
    resolveRuntime.mockResolvedValue({
      mode: CAREER_RUNTIME_MODE.LEGACY_ONLY,
    } as never);
    const result = await getInterviewReflection("step-1");
    expect(result.success).toBe(false);
    expect(getServiceReflection).not.toHaveBeenCalled();
    expect(saveServiceReflection).not.toHaveBeenCalled();
  });

  it("blocks writes in AB_READY_DISABLED", async () => {
    resolveRuntime.mockResolvedValue({
      mode: CAREER_RUNTIME_MODE.AB_READY_DISABLED,
    } as never);
    const result = await saveInterviewReflection({
      applicationProcessStepId: "step-1",
      items: [{ questionText: "介绍一下你的推荐系统项目" }],
    });
    expect(result.success).toBe(false);
    expect(saveServiceReflection).not.toHaveBeenCalled();
  });

  it("saves through ApplicationService when AB_ENABLED with full scope", async () => {
    const previous = process.env[AB_ROLLOUT_SCOPE_ENV];
    process.env[AB_ROLLOUT_SCOPE_ENV] = "full";
    try {
      resolveRuntime.mockResolvedValue({
        mode: CAREER_RUNTIME_MODE.AB_ENABLED,
      } as never);
      const result = await saveInterviewReflection({
        applicationProcessStepId: "step-1",
        reflectionText: "整场复盘",
        items: [{ questionText: "介绍一下你的推荐系统项目" }],
      });
      expect(result.success).toBe(true);
      expect(saveServiceReflection).toHaveBeenCalledWith({
        applicationProcessStepId: "step-1",
        reflectionText: "整场复盘",
        items: [{ questionText: "介绍一下你的推荐系统项目" }],
      });
    } finally {
      if (previous === undefined) delete process.env[AB_ROLLOUT_SCOPE_ENV];
      else process.env[AB_ROLLOUT_SCOPE_ENV] = previous;
    }
  });

  it("rejects reflection writes in AB_ENABLED resume_v1 scope", async () => {
    const previous = process.env[AB_ROLLOUT_SCOPE_ENV];
    process.env[AB_ROLLOUT_SCOPE_ENV] = "resume_v1";
    try {
      resolveRuntime.mockResolvedValue({
        mode: CAREER_RUNTIME_MODE.AB_ENABLED,
      } as never);
      const result = await saveInterviewReflection({
        applicationProcessStepId: "step-1",
        items: [{ questionText: "介绍一下你的推荐系统项目" }],
      });
      expect(result.success).toBe(false);
      expect(saveServiceReflection).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env[AB_ROLLOUT_SCOPE_ENV];
      else process.env[AB_ROLLOUT_SCOPE_ENV] = previous;
    }
  });
});
