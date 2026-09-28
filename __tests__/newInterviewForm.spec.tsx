import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import NewInterviewForm from "@/components/interview/NewInterviewForm";

vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${Object.values(params).join("/")}` : key,
  }),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/lib/toast", () => ({
  toastError: vi.fn(),
}));

const createInterviewSessionAction = vi.fn();
vi.mock("@/actions/interview.actions", () => ({
  createInterviewSessionAction: (...args: unknown[]) =>
    createInterviewSessionAction(...args),
}));

const jobs = [
  {
    id: "job-1",
    title: "Backend Engineer",
    jdVersions: [{ id: "jd-1", versionNumber: 1 }],
  },
  {
    id: "job-2",
    title: "Product Manager",
    jdVersions: [
      { id: "jd-2a", versionNumber: 1 },
      { id: "jd-2b", versionNumber: 2 },
    ],
  },
];

describe("NewInterviewForm (product flow)", () => {
  beforeEach(() => {
    push.mockReset();
    createInterviewSessionAction.mockReset();
  });

  it("renders job selection only — no question-bank checkboxes", () => {
    render(<NewInterviewForm jobs={jobs} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/question bank/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: "interview.startInterviewCta" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("interview.optionalJob")).toBeInTheDocument();
  });

  it("submits a general interview with no job selected", async () => {
    createInterviewSessionAction.mockResolvedValue({
      success: true,
      data: { session: { id: "s-1" }, instances: [] },
    });
    render(<NewInterviewForm jobs={jobs} />);
    fireEvent.click(
      screen.getByRole("button", { name: "interview.startInterviewCta" }),
    );
    await waitFor(() =>
      expect(createInterviewSessionAction).toHaveBeenCalledWith({
        jobOpportunityId: null,
        jobDescriptionVersionId: null,
      }),
    );
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/dashboard/interview/s-1"),
    );
  });

  it("auto-binds the single JD version of a selected job", async () => {
    createInterviewSessionAction.mockResolvedValue({
      success: true,
      data: { session: { id: "s-2" }, instances: [] },
    });
    render(<NewInterviewForm jobs={jobs} />);
    fireEvent.change(screen.getByLabelText("interview.optionalJob"), {
      target: { value: "job-1" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "interview.startInterviewCta" }),
    );
    await waitFor(() =>
      expect(createInterviewSessionAction).toHaveBeenCalledWith({
        jobOpportunityId: "job-1",
        jobDescriptionVersionId: "jd-1",
      }),
    );
  });

  it("requires a JD pick when a job has several versions", async () => {
    const { toastError } = await import("@/lib/toast");
    render(<NewInterviewForm jobs={jobs} />);
    fireEvent.change(screen.getByLabelText("interview.optionalJob"), {
      target: { value: "job-2" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "interview.startInterviewCta" }),
    );
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(createInterviewSessionAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("interview.selectJd"), {
      target: { value: "jd-2b" },
    });
    createInterviewSessionAction.mockResolvedValue({
      success: true,
      data: { session: { id: "s-3" }, instances: [] },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "interview.startInterviewCta" }),
    );
    await waitFor(() =>
      expect(createInterviewSessionAction).toHaveBeenCalledWith({
        jobOpportunityId: "job-2",
        jobDescriptionVersionId: "jd-2b",
      }),
    );
  });
});
