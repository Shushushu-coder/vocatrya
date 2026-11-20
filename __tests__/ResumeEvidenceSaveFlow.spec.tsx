import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { savableDraft } from "./helpers/resumeEvidenceSaveDraft";

const preview = vi.fn();
const confirm = vi.fn();
vi.mock("@/actions/resumeEvidenceSave.actions", () => ({
  previewResumeEvidenceSave: (...a: unknown[]) => preview(...a),
  confirmResumeEvidenceSave: (...a: unknown[]) => confirm(...a),
}));

import { ResumeEvidenceDraftCard } from "@/components/agent/ResumeEvidenceDraftCard";

const PREVIEW = {
  digest: "d1",
  operation: "create_new",
  type: "INTERNSHIP",
  verificationStatus: "USER_CONFIRMED",
  targetMaterialId: null,
  targetTitle: null,
  changes: [],
  material: {
    title: "Acme backend intern",
    startDate: "2024-06-01",
    endDate: "2024-09-01",
    isCurrent: false,
    notes: null,
    detail: [{ key: "organizationName", value: "Acme" }],
  },
  evidence: [
    { content: "Moved 12 services to the new queue", metricText: null },
    { content: "Cut p95 latency", metricText: "30%" },
  ],
};

describe("Resume Evidence save flow (card)", () => {
  beforeEach(() => {
    preview.mockReset();
    confirm.mockReset();
  });

  it("goes draft -> preview -> confirm -> saved, calling confirm once", async () => {
    preview.mockResolvedValue({ success: true, data: PREVIEW });
    let release: (v: unknown) => void = () => {};
    confirm.mockReturnValue(new Promise((r) => (release = r)));
    render(<ResumeEvidenceDraftCard draft={savableDraft()} />);
    expect(screen.getByTestId("resume-evidence-draft-label")).toHaveTextContent("Draft");

    fireEvent.click(screen.getByTestId("resume-evidence-save-button"));
    const pv = await screen.findByTestId("resume-evidence-save-preview");
    expect(pv).toHaveTextContent("Acme backend intern");
    expect(pv).toHaveTextContent("Cut p95 latency");
    expect(pv).toHaveTextContent("30%");
    expect(confirm).not.toHaveBeenCalled();

    const btn = screen.getByTestId("resume-evidence-save-confirm");
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.anything(), "d1");

    release({ success: true, data: { materialId: "m1", evidenceCount: 2, alreadySaved: false } });
    expect(await screen.findByTestId("resume-evidence-saved")).toBeInTheDocument();
    expect(screen.getByTestId("resume-evidence-draft-card")).toHaveAttribute(
      "data-persisted",
      "true",
    );
    expect(screen.queryByTestId("resume-evidence-save-button")).toBeNull();
  });

  it("keeps the draft and preview for retry when the save fails", async () => {
    preview.mockResolvedValue({ success: true, data: PREVIEW });
    confirm.mockResolvedValueOnce({ success: false, message: "boom" });
    render(<ResumeEvidenceDraftCard draft={savableDraft()} />);
    fireEvent.click(screen.getByTestId("resume-evidence-save-button"));
    fireEvent.click(await screen.findByTestId("resume-evidence-save-confirm"));
    expect(await screen.findByTestId("resume-evidence-save-error")).toBeInTheDocument();
    expect(screen.getByTestId("resume-evidence-draft-card")).toHaveAttribute(
      "data-persisted",
      "false",
    );

    confirm.mockResolvedValueOnce({
      success: true,
      data: { materialId: "m1", evidenceCount: 2, alreadySaved: false },
    });
    fireEvent.click(screen.getByTestId("resume-evidence-save-confirm"));
    await waitFor(() => expect(screen.getByTestId("resume-evidence-saved")).toBeInTheDocument());
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("cancelling the preview writes nothing", async () => {
    preview.mockResolvedValue({ success: true, data: PREVIEW });
    render(<ResumeEvidenceDraftCard draft={savableDraft()} />);
    fireEvent.click(screen.getByTestId("resume-evidence-save-button"));
    await screen.findByTestId("resume-evidence-save-preview");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("resume-evidence-save-button")).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("EMPLOYMENT/CUSTOM stay draft-only with an explanation and no save button", () => {
    const draft = savableDraft((d) => {
      d.materialMapping.type = "EMPLOYMENT";
      d.materialMapping.futureOperation = "draft_only";
    });
    render(<ResumeEvidenceDraftCard draft={draft} />);
    expect(screen.getByTestId("resume-evidence-save-unsupported")).toHaveTextContent("EMPLOYMENT");
    expect(screen.queryByTestId("resume-evidence-save-button")).toBeNull();
    expect(screen.getByTestId("resume-evidence-not-saved")).toBeInTheDocument();
  });

  it("non-empty blockedWrites shows the reasons and no save button", () => {
    const draft = savableDraft((d) => {
      d.materialMapping.blockedWrites = [
        { code: "COL", message: "favouriteColour is not writable" },
      ];
    });
    render(<ResumeEvidenceDraftCard draft={draft} />);
    expect(screen.getByTestId("resume-evidence-save-blocked")).toHaveTextContent(
      "favouriteColour is not writable",
    );
    expect(screen.queryByTestId("resume-evidence-save-button")).toBeNull();
  });

  it("update_existing preview lists each changed field as old -> new", async () => {
    preview.mockResolvedValue({
      success: true,
      data: {
        ...PREVIEW,
        operation: "update_existing",
        material: null,
        targetTitle: "Acme backend intern",
        changes: [
          { scope: "detail", field: "roleTitle", old: "Intern", new: "Platform Intern" },
        ],
      },
    });
    render(<ResumeEvidenceDraftCard draft={savableDraft()} />);
    fireEvent.click(screen.getByTestId("resume-evidence-save-button"));
    const pv = await screen.findByTestId("resume-evidence-save-preview");
    expect(pv).toHaveTextContent("roleTitle：Intern → Platform Intern");
  });

  it("names the invalid detail field when the preview fails", async () => {
    preview.mockResolvedValue({
      success: false,
      message: "x",
      code: "invalid_detail",
      field: "gpaValue",
    });
    render(<ResumeEvidenceDraftCard draft={savableDraft()} />);
    fireEvent.click(screen.getByTestId("resume-evidence-save-button"));
    expect(await screen.findByTestId("resume-evidence-save-error")).toHaveTextContent("gpaValue");
  });

  it("offers no save for an unfinished draft", () => {
    render(<ResumeEvidenceDraftCard draft={savableDraft((d) => (d.session.stage = "summarizing"))} />);
    expect(screen.queryByTestId("resume-evidence-save-button")).toBeNull();
  });
});
