import { render, screen } from "@testing-library/react";
import {
  buildResumeEvidenceStart,
  createInitialResumeEvidenceDraft,
} from "@/lib/agent/skills/resumeEvidence";

const chat = {
  messages: [] as any[],
  status: "ready" as string,
  regenerate: vi.fn(),
  resumeStream: vi.fn(),
  addToolApprovalResponse: vi.fn(),
  toolStreams: {} as Record<string, string>,
  contextUsage: null as any,
  approvalPending: false,
  conversationId: "conv-1" as string | null,
};
vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => chat,
}));
vi.mock("@/components/TipTapContentViewer", () => ({
  TipTapContentViewer: ({ content }: { content: string }) => (
    <div dangerouslySetInnerHTML={{ __html: content }} />
  ),
}));

import { AgentChatMessages } from "@/components/agent/AgentChatMessages";

const assistant = (text: string) => ({
  id: "a1",
  role: "assistant",
  parts: [{ type: "text", text }],
});

function validDraft() {
  const start = buildResumeEvidenceStart({ experienceText: "Led a migration" });
  if (!start.ok) throw new Error("setup");
  const draft = createInitialResumeEvidenceDraft(start.pack);
  draft.pending = [
    {
      id: "p1",
      text: "Which part did you do yourself?",
      slot: "personal_contribution",
      reason: "not_yet_asked",
      sourceRefs: ["src-paste"],
    },
  ];
  return draft;
}

describe("Resume Evidence draft card in chat", () => {
  beforeEach(() => {
    chat.messages = [];
  });

  it("renders a valid draft as a read-only, labelled, unsaved card", () => {
    chat.messages = [
      assistant("Summary below.\n```json\n" + JSON.stringify(validDraft()) + "\n```"),
    ];
    render(<AgentChatMessages />);
    const card = screen.getByTestId("resume-evidence-draft-card");
    expect(card).toHaveAttribute("data-persisted", "false");
    expect(screen.getByTestId("resume-evidence-draft-label")).toBeInTheDocument();
    expect(screen.getByTestId("resume-evidence-not-saved")).toBeInTheDocument();
    expect(card).toHaveTextContent("Which part did you do yourself?");
    expect(screen.getByText("Summary below.")).toBeInTheDocument();
    // No save / confirm affordance of any kind.
    expect(screen.queryByRole("button", { name: /save|confirm/i })).toBeNull();
    expect(screen.queryByTestId("resume-evidence-draft-invalid")).toBeNull();
  });

  it("shows a clear could-not-validate state for an invalid draft", () => {
    const bad = { ...validDraft(), saveGate: { saveAuthorized: true, persisted: true } };
    chat.messages = [assistant("```json\n" + JSON.stringify(bad) + "\n```")];
    render(<AgentChatMessages />);
    expect(screen.getByTestId("resume-evidence-draft-invalid")).toHaveTextContent(
      "Draft could not be validated",
    );
    expect(screen.queryByTestId("resume-evidence-draft-card")).toBeNull();
  });

  it("treats unparseable JSON that names the skill as invalid, never as success", () => {
    chat.messages = [
      assistant('```json\n{"skillId": "vocatrya.skill.resume-evidence-deep-dive", oops\n```'),
    ];
    render(<AgentChatMessages />);
    expect(screen.getByTestId("resume-evidence-draft-invalid")).toBeInTheDocument();
    expect(screen.queryByTestId("resume-evidence-draft-card")).toBeNull();
  });

  it("leaves ordinary assistant markdown and json blocks alone", () => {
    chat.messages = [assistant('Plain answer\n```json\n{"a":1}\n```')];
    render(<AgentChatMessages />);
    expect(screen.getByText("Plain answer")).toBeInTheDocument();
    expect(screen.queryByTestId("resume-evidence-draft-card")).toBeNull();
    expect(screen.queryByTestId("resume-evidence-draft-invalid")).toBeNull();
  });
});
