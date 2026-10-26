import {
  createApplicationAttempt,
  createTransferredAttempt,
  listTransferTargetOpportunities,
} from "@/actions/application.actions";
import { CAREER_RUNTIME_MODE } from "@/lib/career/identities";
import { CareerRuntimeError } from "@/lib/career/errors";
import { getCurrentUser } from "@/utils/user.utils";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { listJobs } from "@/lib/career/jobsReadDispatch";

const { createAttemptService, createTransferredService } = vi.hoisted(() => ({
  createAttemptService: vi.fn(),
  createTransferredService: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ default: {} }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn(),
}));
vi.mock("@/lib/career/runtimeMode", () => ({
  resolveCareerRuntimeMode: vi.fn(),
}));
vi.mock("@/lib/career/jobsReadDispatch", () => ({
  listJobs: vi.fn(),
}));

vi.mock("@/lib/career/applicationService", () => ({
  ApplicationService: class {
    createAttempt = createAttemptService;
    createTransferredAttempt = createTransferredService;
  },
}));

const getUser = vi.mocked(getCurrentUser);
const resolveRuntime = vi.mocked(resolveCareerRuntimeMode);
const jobsList = vi.mocked(listJobs);

const FULL_RUNTIME = {
  mode: CAREER_RUNTIME_MODE.AB_ENABLED,
  rolloutScope: "full",
};

describe("createApplicationAttempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ id: "user-1" } as never);
    resolveRuntime.mockResolvedValue(FULL_RUNTIME as never);
    createAttemptService.mockResolvedValue({ id: "att-new" });
  });

  it("passes trimmed input through the A+B write gate", async () => {
    const result = await createApplicationAttempt({
      jobOpportunityId: " job-1 ",
      channelLabel: " 官网 ",
      notes: null,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ id: "att-new" });
    expect(createAttemptService).toHaveBeenCalledWith({
      jobOpportunityId: "job-1",
      channelLabel: "官网",
      channelCategory: null,
      sourceUrl: null,
      notes: null,
      createdVia: "USER",
    });
  });

  it("rejects writes when A+B mutations are disabled", async () => {
    resolveRuntime.mockResolvedValue({
      mode: CAREER_RUNTIME_MODE.AB_READY_DISABLED,
    } as never);
    const result = await createApplicationAttempt({
      jobOpportunityId: "job-1",
      channelLabel: "官网",
    });
    expect(result.success).toBe(false);
    expect(createAttemptService).not.toHaveBeenCalled();
  });

  it("rejects an empty channel or opportunity id before hitting the service", async () => {
    const noChannel = await createApplicationAttempt({
      jobOpportunityId: "job-1",
      channelLabel: "   ",
    });
    expect(noChannel).toMatchObject({
      success: false,
      code: "ATTEMPT_CHANNEL_REQUIRED",
    });
    const noJob = await createApplicationAttempt({
      jobOpportunityId: "",
      channelLabel: "官网",
    });
    expect(noJob).toMatchObject({ success: false, code: "INVALID_ID" });
    expect(createAttemptService).not.toHaveBeenCalled();
  });

  it("propagates the service error code for stale-state feedback", async () => {
    createAttemptService.mockRejectedValue(
      new CareerRuntimeError("OPPORTUNITY_NOT_FOUND", "Opportunity not found"),
    );
    const result = await createApplicationAttempt({
      jobOpportunityId: "job-1",
      channelLabel: "官网",
    });
    expect(result).toMatchObject({
      success: false,
      code: "OPPORTUNITY_NOT_FOUND",
    });
  });
});

describe("createTransferredAttempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ id: "user-1" } as never);
    resolveRuntime.mockResolvedValue(FULL_RUNTIME as never);
  });

  it("propagates the transfer contract codes to the UI", async () => {
    createTransferredService.mockRejectedValue(
      new CareerRuntimeError(
        "TRANSFER_SAME_OPPORTUNITY",
        "A transferred attempt must target a different job opportunity",
      ),
    );
    const result = await createTransferredAttempt({
      sourceAttemptId: "att-1",
      targetJobOpportunityId: "job-1",
    });
    expect(result).toMatchObject({
      success: false,
      code: "TRANSFER_SAME_OPPORTUNITY",
    });
  });

  it("returns the new attempt id on success", async () => {
    createTransferredService.mockResolvedValue({ id: "att-2" });
    const result = await createTransferredAttempt({
      sourceAttemptId: "att-1",
      targetJobOpportunityId: "job-2",
    });
    expect(result).toEqual({ success: true, data: { id: "att-2" } });
    expect(createTransferredService).toHaveBeenCalledWith({
      sourceAttemptId: "att-1",
      targetJobOpportunityId: "job-2",
    });
  });
});

describe("listTransferTargetOpportunities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ id: "user-1" } as never);
    resolveRuntime.mockResolvedValue(FULL_RUNTIME as never);
  });

  it("reuses the jobs read path and excludes the source opportunity", async () => {
    jobsList.mockResolvedValue({
      blocked: false,
      total: 2,
      data: [
        {
          id: "job-1",
          JobTitle: { label: "软件工程师" },
          Company: { label: "Tencent" },
        },
        {
          id: "job-2",
          JobTitle: { label: "云计算工程师" },
          Company: { label: "OtherCo" },
        },
      ],
    } as never);
    const result = await listTransferTargetOpportunities("job-1");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ items: [
      { id: "job-2", title: "云计算工程师", company: "OtherCo" },
    ], nextOffset: null });
    expect(jobsList).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      expect.objectContaining({ take: expect.any(Number) }),
    );
  });

  it("returns the next page offset before excluding the source", async () => {
    jobsList.mockResolvedValue({ blocked: false, total: 201, data: Array.from({ length: 200 }, (_, i) => ({
      id: `job-${i}`, JobTitle: { label: `Position ${i}` }, Company: { label: "Company" },
    })) } as never);
    const first = await listTransferTargetOpportunities("job-1");
    expect(first.success && first.data?.nextOffset).toBe(200);
    jobsList.mockResolvedValue({ blocked: false, total: 201, data: [{ id: "job-200" }] } as never);
    const second = await listTransferTargetOpportunities("job-1", 200);
    expect(jobsList).toHaveBeenLastCalledWith(expect.anything(), "user-1", { take: 200, skip: 200 });
    expect(second).toEqual({ success: true, data: { items: [{ id: "job-200", title: "", company: "" }], nextOffset: null } });
  });

  it("is unavailable when the timeline read surface is closed", async () => {
    resolveRuntime.mockResolvedValue({
      mode: CAREER_RUNTIME_MODE.LEGACY_ONLY,
    } as never);
    const result = await listTransferTargetOpportunities("job-1");
    expect(result.success).toBe(false);
    expect(jobsList).not.toHaveBeenCalled();
  });

  it("reports a blocked jobs read as a normal failure", async () => {
    jobsList.mockResolvedValue({
      blocked: true,
      message: "jobs unavailable",
    } as never);
    const result = await listTransferTargetOpportunities("job-1");
    expect(result).toEqual({ success: false, message: "jobs unavailable" });
  });
});
