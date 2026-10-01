import {
  deriveConversationTitle,
  isClearlyUsefulLabel,
  pageContextFromConversation,
  parseConversationContext,
  titleFallbackFromMessages,
} from "@/lib/agent/conversationContext";
import { categorizeAgentErrorCode } from "@/lib/agent/chatErrorUx";
import { historyBucket } from "@/lib/agent/historyGroups";
import { agentToolLabelKey } from "@/lib/agent/toolLabels";
import { readAgentChatError } from "@/lib/agent/chatTransport";

describe("conversation titles and context", () => {
  it("prefers a useful context label over the first message", () => {
    expect(
      deriveConversationTitle({
        context: {
          version: 1,
          items: [
            {
              kind: "job",
              entityId: "job-1",
              labelSnapshot: "AI Product Analyst",
              source: "AUTO",
            },
          ],
        },
        firstUserText: "分析这个岗位",
      }),
    ).toBe("AI Product Analyst");
  });

  it("falls back to the first user message and then to nothing", () => {
    expect(
      deriveConversationTitle({
        context: { version: 1, items: [] },
        firstUserText: "  分析字节跳动产品岗位  ",
      }),
    ).toBe("分析字节跳动产品岗位");
    expect(
      deriveConversationTitle({ context: { version: 1, items: [] } }),
    ).toBeNull();
  });

  it("does not treat a raw id as a title", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    expect(isClearlyUsefulLabel(id, id)).toBe(false);
    expect(
      titleFallbackFromMessages(
        JSON.stringify([
          { role: "user", parts: [{ type: "text", text: "准备面试" }] },
        ]),
      ),
    ).toBe("准备面试");
  });

  it("drops unsupported context kinds and ignores a removed item", () => {
    const parsed = parseConversationContext(
      JSON.stringify({
        version: 1,
        items: [
          {
            kind: "jobOpportunity",
            entityId: "opp-1",
            labelSnapshot: "Nope",
            source: "AUTO",
          },
          {
            kind: "resume",
            entityId: "resume-1",
            labelSnapshot: "Product Resume v3",
            source: "MANUAL",
          },
        ],
      }),
    );
    expect(parsed.items).toEqual([
      {
        kind: "resume",
        entityId: "resume-1",
        labelSnapshot: "Product Resume v3",
        source: "MANUAL",
      },
    ]);
    expect(pageContextFromConversation(parsed)).toEqual({
      resumeId: "resume-1",
    });
    expect(pageContextFromConversation({ version: 1, items: [] })).toEqual({});
  });
});

describe("history buckets", () => {
  const now = new Date(2026, 9, 1, 15, 0, 0);

  it("groups today, yesterday, and earlier", () => {
    expect(historyBucket(new Date(2026, 9, 1, 1), now)).toBe("today");
    expect(historyBucket(new Date(2026, 8, 30, 23), now)).toBe("yesterday");
    expect(historyBucket(new Date(2026, 8, 1), now)).toBe("earlier");
  });
});

describe("tool and error presentation", () => {
  it("maps internal tool names to copy keys", () => {
    expect(agentToolLabelKey("add_job")).toBe("agent.tools.addJob");
    expect(agentToolLabelKey("not_a_tool")).toBeNull();
  });

  it("keeps a stable code and never returns the raw envelope as the message", () => {
    const error = readAgentChatError(
      Object.assign(
        new Error('{"error":"boom","code":"REAUTH_REQUIRED"}'),
        { code: "REAUTH_REQUIRED" },
      ),
    );
    expect(error.code).toBe("REAUTH_REQUIRED");
    expect(error.message).not.toMatch(/^\s*\{/);
    expect(categorizeAgentErrorCode("REAUTH_REQUIRED")).toBe("auth");
    expect(categorizeAgentErrorCode("STREAMING_NOT_SUPPORTED")).toBe(
      "capability",
    );
    expect(categorizeAgentErrorCode("RATE_LIMITED")).toBe("retryable");
  });
});
