import { buildAgentTools } from "@/lib/agent/tools";
import { buildGetJobTool } from "@/lib/agent/tools/getJob";
import { buildListJobsTool } from "@/lib/agent/tools/listJobs";
import { getJobForAgent, listJobsForAgent } from "@/lib/agent/canonicalJobRead";

vi.mock("@/lib/agent/canonicalJobRead", () => ({
  listJobsForAgent: vi.fn(),
  getJobForAgent: vi.fn(),
}));

const list = listJobsForAgent as unknown as ReturnType<typeof vi.fn>;
const get = getJobForAgent as unknown as ReturnType<typeof vi.fn>;

const execute = (agentTool: any, input?: unknown) =>
  agentTool.execute(input, { toolCallId: "c", messages: [] });

const toolCtx = {
  userId: "user-1",
  pageContext: { jobId: "page-job" },
  model: {} as never,
  provider: "ollama",
  modelName: "qwen3.5:9b",
  writer: { write: () => {}, merge: () => {}, onError: undefined } as never,
};

describe("list_jobs and get_job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue({ status: "ok", jobs: [], total: 0, truncated: false });
    get.mockResolvedValue({ status: "no_job" });
  });

  it("registers both read tools without an approval gate", () => {
    const tools = buildAgentTools(toolCtx);
    expect(Object.keys(tools)).toEqual([
      "add_job",
      "list_jobs",
      "get_job",
      "read_webpage",
      "get_resume",
      "review_resume",
      "match_job",
      "generate_cover_letter",
      "today_plan_read",
      "today_plan",
    ]);
    expect(buildListJobsTool("user-1").needsApproval).toBeUndefined();
    expect(buildGetJobTool("user-1").needsApproval).toBeUndefined();
  });

  it("lists jobs for the session user", async () => {
    await execute(buildListJobsTool("session-user"), { userId: "attacker" });
    expect(list).toHaveBeenCalledWith("session-user");
  });

  it("reads the page job when the model omits an id, and the model id when it sends one", async () => {
    await execute(buildGetJobTool("session-user", "page-job"), { userId: "attacker" });
    expect(get).toHaveBeenCalledWith("session-user", "page-job");

    await execute(buildGetJobTool("session-user", "page-job"), { jobId: "listed-job" });
    expect(get).toHaveBeenCalledWith("session-user", "listed-job");
  });
});
