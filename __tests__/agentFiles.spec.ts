// @vitest-environment node
// AWU-FILES: extraction contract, part validation, budget injection and
// admission bounds for the data-file part type.
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import type { UIMessage } from "ai";
import {
  AGENT_FILE_PART_TYPE,
  type AgentFilePart,
} from "@/models/agent.model";
import { AgentChatRequestSchema } from "@/models/agent.schema";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  agentFilePlaceholder,
  fileChipToPartData,
  resolveFileTexts,
  sanitizeAgentFileName,
  sniffAgentFileKind,
  type AgentFileChip,
} from "@/lib/agent/agentFiles";
import { extractAgentFile } from "@/lib/agent/agentFiles.server";
import { buildCareerDialogueContext } from "@/lib/agent/contextBudget";
import { admitConversationRequest } from "@/lib/agent/conversationRequest";
import { makeAbTestDbUrl, preparePrismaProject, migrateDeploy } from "./helpers/abSchemaTestDb";
import { seedAccount } from "./helpers/backupTestDb";

const filePart = (
  id: string,
  overrides?: Partial<AgentFilePart["data"]>,
): AgentFilePart => ({
  type: AGENT_FILE_PART_TYPE,
  id,
  data: {
    id,
    name: `${id}.txt`,
    mediaType: "text/plain",
    size: 12,
    chars: 12,
    truncated: false,
    text: "file contents",
    ...overrides,
  },
});

const userWith = (id: string, parts: UIMessage["parts"]): UIMessage => ({
  id,
  role: "user",
  parts,
});

const text = (body: string) => ({ type: "text" as const, text: body });

describe("sniffAgentFileKind", () => {
  it("detects text by extension and by mime", () => {
    expect(sniffAgentFileKind({ name: "a.txt", type: "" })).toBe("text");
    expect(sniffAgentFileKind({ name: "A.MD", type: "application/octet-stream" })).toBe("text");
    expect(sniffAgentFileKind({ name: "notes", type: "text/plain" })).toBe("text");
    expect(sniffAgentFileKind({ name: "notes", mediaType: "text/markdown" })).toBe("text");
  });
  it("detects pdf/docx by mime or extension", () => {
    expect(sniffAgentFileKind({ name: "r.pdf", type: "" })).toBe("pdf");
    expect(sniffAgentFileKind({ name: "r", type: "application/pdf" })).toBe("pdf");
    expect(sniffAgentFileKind({ name: "r.docx", type: "" })).toBe("docx");
    expect(
      sniffAgentFileKind({
        name: "r",
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toBe("docx");
  });
  it("rejects everything else", () => {
    expect(sniffAgentFileKind({ name: "x.png", type: "image/png" })).toBeNull();
    expect(sniffAgentFileKind({ name: "x.exe", type: "application/x-msdownload" })).toBeNull();
    expect(sniffAgentFileKind({ name: "x", type: "" })).toBeNull();
  });
});

describe("sanitizeAgentFileName", () => {
  it("strips path segments and collapses whitespace", () => {
    expect(sanitizeAgentFileName("C:\\Users\\x\\my  cv.pdf")).toBe("my cv.pdf");
    expect(sanitizeAgentFileName("/tmp/a.txt")).toBe("a.txt");
    expect(sanitizeAgentFileName("   ")).toBe("file");
    expect(sanitizeAgentFileName("n".repeat(400)).length).toBe(255);
  });
});

describe("extractAgentFile", () => {
  it("extracts utf8 text files including markdown", async () => {
    const result = await extractAgentFile(
      Buffer.from("# Title\n\nBody text。", "utf8"),
      { name: "notes.md", mediaType: "text/markdown" },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.text).toContain("Body text");
      expect(result.data.truncated).toBe(false);
    }
  });
  it("strips a UTF-8 BOM", async () => {
    const result = await extractAgentFile(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello")]),
      { name: "a.txt", mediaType: "text/plain" },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.text).toBe("hello");
  });
  it("truncates text at the extracted-chars ceiling", async () => {
    const body = "x".repeat(APP_CONSTANTS.AGENT_FILE_MAX_EXTRACTED_CHARS + 100);
    const result = await extractAgentFile(Buffer.from(body), {
      name: "big.txt",
      mediaType: "text/plain",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.text.length).toBe(APP_CONSTANTS.AGENT_FILE_MAX_EXTRACTED_CHARS);
      expect(result.data.truncated).toBe(true);
    }
  });
  it("returns NO_TEXT for an empty file", async () => {
    const result = await extractAgentFile(Buffer.from("   \n"), {
      name: "empty.txt",
      mediaType: "text/plain",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("NO_TEXT");
  });
  it("rejects a renamed binary claiming .pdf", async () => {
    const result = await extractAgentFile(Buffer.from("MZ" + "0".repeat(100), "binary"), {
      name: "evil.pdf",
      mediaType: "application/pdf",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("UNSUPPORTED_FORMAT");
  });
  it("rejects an extension/mime that names no supported format", async () => {
    const result = await extractAgentFile(Buffer.from("plain"), {
      name: "x.png",
      mediaType: "image/png",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("UNSUPPORTED_FORMAT");
  });
});

describe("resolveFileTexts", () => {
  it("collects data-file parts only from the newest user message", () => {
    const messages: UIMessage[] = [
      userWith("m1", [text("hi")]),
      { id: "a1", role: "assistant", parts: [text("ok")] },
      userWith("m2", [text("see"), filePart("f1"), filePart("f2")]),
    ];
    const files = resolveFileTexts(messages);
    expect(files.map((f) => f.name)).toEqual(["f1.txt", "f2.txt"]);
  });
  it("returns nothing when the last message is the assistant's", () => {
    const messages: UIMessage[] = [
      userWith("m1", [filePart("f1")]),
      { id: "a1", role: "assistant", parts: [text("ok")] },
    ];
    expect(resolveFileTexts(messages)).toEqual([]);
  });
  it("caps at the per-message limit", () => {
    const parts = ["f1", "f2", "f3", "f4"].map((id) => filePart(id));
    const files = resolveFileTexts([userWith("m1", parts)]);
    expect(files).toHaveLength(APP_CONSTANTS.AGENT_FILE_MAX_PER_MESSAGE);
  });
});

describe("fileChipToPartData", () => {
  const ready: AgentFileChip = {
    id: "f1",
    name: "cv.txt",
    mediaType: "text/plain",
    size: 10,
    status: "ready",
    chars: 5,
    truncated: false,
    text: "hello",
  };
  it("maps only ready chips", () => {
    expect(fileChipToPartData(ready)?.text).toBe("hello");
    expect(fileChipToPartData({ ...ready, status: "extracting" })).toBeNull();
    expect(fileChipToPartData({ ...ready, status: "error" })).toBeNull();
  });
});

describe("buildCareerDialogueContext file injection", () => {
  it("injects each file line after the paste line on the arriving turn", () => {
    const messages: UIMessage[] = [
      userWith("m1", [text("summarize this"), filePart("f1", { name: "jd.txt", text: "JOB BODY" })]),
    ];
    const result = buildCareerDialogueContext({
      profile: "AGENT_RESPONSE",
      messages,
      fileBlocks: [{ name: "jd.txt", block: "<<<FILE_X>>>\nJOB BODY\n<<<END_FILE_X>>>" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcript).toContain('The user attached the file "jd.txt"');
      expect(result.transcript).toContain("<<<FILE_X>>>");
    }
  });
  it("renders a placeholder for historical file parts instead of replaying text", () => {
    const messages: UIMessage[] = [
      userWith("m1", [filePart("f1", { name: "old.txt", text: "SECRET" })]),
      { id: "a1", role: "assistant", parts: [text("done")] },
      userWith("m2", [text("next")]),
    ];
    const result = buildCareerDialogueContext({
      profile: "AGENT_RESPONSE",
      messages,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcript).toContain(agentFilePlaceholder("old.txt"));
      expect(result.transcript).not.toContain("SECRET");
    }
  });
  it("keeps a file-only send a complete turn", () => {
    const messages: UIMessage[] = [
      userWith("m1", [filePart("f1")]),
      { id: "a1", role: "assistant", parts: [text("done")] },
      userWith("m2", [text("next question")]),
    ];
    const result = buildCareerDialogueContext({ profile: "AGENT_RESPONSE", messages });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcript).toContain(agentFilePlaceholder("f1.txt"));
    }
  });
});

describe("chat request schema data-file part", () => {
  const base = {
    conversationId: "c1",
    expectedRevision: 0,
    requestId: "r1",
    operation: "send" as const,
  };
  it("accepts a data-file part", () => {
    const parsed = AgentChatRequestSchema.safeParse({
      ...base,
      newMessage: userWith("m1", [text("hi"), filePart("f1")]),
    });
    expect(parsed.success).toBe(true);
  });
  it("rejects unknown part types", () => {
    const parsed = AgentChatRequestSchema.safeParse({
      ...base,
      newMessage: userWith("m1", [{ type: "data-evil", data: {} }]),
    });
    expect(parsed.success).toBe(false);
  });
});

// Real SQLite admission — the same harness conversationConcurrency uses.
const ctx = makeAbTestDbUrl();
const db = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let owner = "";
let conversationId = "";

const admit = (parts: UIMessage["parts"]) =>
  admitConversationRequest(
    {
      userId: owner,
      conversationId,
      requestId: `req-${Math.random().toString(36).slice(2)}`,
      expectedRevision: 0,
      operation: "send",
      newMessage: userWith("m1", parts),
    },
    db,
  );

describe("conversation admission for data-file parts", () => {
  beforeAll(async () => {
    fs.writeFileSync(ctx.url.slice(5), "");
    migrateDeploy(ctx.url, preparePrismaProject(ctx.dir));
    owner = await seedAccount(db, "agent-files@example.com");
    const row = await db.chatConversation.create({
      data: { userId: owner, messages: "[]" },
    });
    conversationId = row.id;
  }, 120000);

  afterAll(async () => {
    await db.$disconnect();
    if (ctx.dir.includes("vocatrya-ab-schema-")) {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  });

  it("admits a message carrying valid data-file parts", async () => {
    const request = await admit([text("look"), filePart("f1"), filePart("f2")]);
    expect(request.operation).toBe("send");
    expect(request.messages.at(-1)?.parts).toHaveLength(3);
  });

  it("rejects more than the per-message file cap", async () => {
    await expect(
      admit([text("x"), filePart("f1"), filePart("f2"), filePart("f3"), filePart("f4")]),
    ).rejects.toMatchObject({ code: "CONVERSATION_TURN_CONFLICT" });
  });

  it("rejects a file part missing required fields", async () => {
    const bad = filePart("f1");
    // @ts-expect-error deliberately malformed part
    delete bad.data.text;
    await expect(admit([bad])).rejects.toMatchObject({
      code: "CONVERSATION_TURN_CONFLICT",
    });
  });

  it("rejects extracted text beyond the ceiling plus slack", async () => {
    const huge = "x".repeat(APP_CONSTANTS.AGENT_FILE_MAX_EXTRACTED_CHARS + 5000);
    await expect(
      admit([filePart("f1", { text: huge, chars: huge.length })]),
    ).rejects.toMatchObject({ code: "CONVERSATION_TURN_CONFLICT" });
  });
});
