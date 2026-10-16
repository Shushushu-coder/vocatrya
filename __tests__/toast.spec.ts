import { toast } from "sonner";
import { toastSuccess, toastError, toastActionResult } from "@/lib/toast";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("toastSuccess", () => {
  it("passes the message with a dedupe id when no title is given", () => {
    toastSuccess("Job has been created successfully");
    expect(toast.success).toHaveBeenCalledWith("Job has been created successfully", {
      id: "vocatrya:success::Job has been created successfully",
      duration: undefined,
    });
  });

  it("promotes the title to the message and the message to the description", () => {
    toastSuccess("Saved to Downloads.", "PDF exported");
    expect(toast.success).toHaveBeenCalledWith("PDF exported", {
      id: "vocatrya:success:PDF exported:Saved to Downloads.",
      description: "Saved to Downloads.",
      duration: undefined,
    });
  });

  it("keeps a sticky toast visible until dismissed", () => {
    toastSuccess("Saved", undefined, { sticky: true });
    expect(toast.success).toHaveBeenCalledWith("Saved", {
      id: "vocatrya:success::Saved",
      duration: Infinity,
    });
  });
});

describe("toastError", () => {
  it("passes the message with a dedupe id when no title is given", () => {
    toastError("Failed to save job");
    expect(toast.error).toHaveBeenCalledWith("Failed to save job", {
      id: "vocatrya:error::Failed to save job",
      duration: undefined,
    });
  });

  it("promotes the title to the message and the message to the description", () => {
    toastError("Remove it from resumes first.", "Skill is in use!");
    expect(toast.error).toHaveBeenCalledWith("Skill is in use!", {
      id: "vocatrya:error:Skill is in use!:Remove it from resumes first.",
      description: "Remove it from resumes first.",
      duration: undefined,
    });
  });

  it("falls back to a generic message when no message is given", () => {
    toastError();
    expect(toast.error).toHaveBeenCalledWith("Something went wrong. Please try again.", {
      id: "vocatrya:error::Something went wrong. Please try again.",
      duration: undefined,
    });
  });

  it("keeps a sticky error visible until dismissed", () => {
    toastError("Save failed", undefined, { sticky: true });
    expect(toast.error).toHaveBeenCalledWith("Save failed", {
      id: "vocatrya:error::Save failed",
      duration: Infinity,
    });
  });
});

describe("toastActionResult", () => {
  it("toasts success and calls onSuccess with the result data on success", () => {
    const onSuccess = vi.fn();
    toastActionResult(
      { success: true, data: { id: "1" } },
      { success: "Job has been created successfully", onSuccess },
    );

    expect(toast.success).toHaveBeenCalledWith("Job has been created successfully", {
      id: "vocatrya:success::Job has been created successfully",
      duration: undefined,
    });
    expect(onSuccess).toHaveBeenCalledWith({ id: "1" });
  });

  it("does not call onSuccess on failure and toasts result.message", () => {
    const onSuccess = vi.fn();
    toastActionResult(
      { success: false, message: "Failed to save job" },
      { success: "Job has been created successfully", onSuccess },
    );

    expect(toast.error).toHaveBeenCalledWith("Failed to save job", {
      id: "vocatrya:error::Failed to save job",
      duration: undefined,
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("toasts the error override when result is undefined", () => {
    toastActionResult(undefined, {
      success: "Job has been created successfully",
      error: "Could not create job",
    });

    expect(toast.error).toHaveBeenCalledWith("Could not create job", {
      id: "vocatrya:error::Could not create job",
      duration: undefined,
    });
  });

  it("falls back to the generic message when result is undefined and no error override is given", () => {
    toastActionResult(undefined, { success: "Job has been created successfully" });

    expect(toast.error).toHaveBeenCalledWith("Something went wrong. Please try again.", {
      id: "vocatrya:error::Something went wrong. Please try again.",
      duration: undefined,
    });
  });
});
