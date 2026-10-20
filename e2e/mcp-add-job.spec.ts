import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { test, expect, uniqueName } from "./fixtures";
import { PrismaClient } from "@prisma/client";
import { configureE2EDatabase } from "./support/database";
import { readE2ERuntimeContract } from "./support/runtimeContract";
import { E2E_TEST_USER } from "./support/testUser";
import { generateToken } from "../src/lib/mcp/tokens";

const prisma = new PrismaClient({ datasourceUrl: configureE2EDatabase().url });
test.afterAll(async () => { await prisma.$disconnect(); });

// Drives real HTTP JSON-RPC in every family. The legacy surface creates its
// token through Settings; fresh-full seeds a disposable token to prove that
// hiding the UI is backed by a server-side legacy-write refusal.
test.describe("MCP add_job", () => {
  test("enforces the instance MCP surface and real tool write contract", async ({ page, baseURL, cleanup }) => {
    const runtime = await readE2ERuntimeContract(prisma);
    const tokenName = uniqueName("e2e mcp token");
    const jobTitle = uniqueName("mcp job title");
    const company = uniqueName("mcp company");
    const location = uniqueName("mcp remote");
    // Register unique catalog names before the HTTP call can persist them.
    cleanup.mcpToken(tokenName);
    cleanup.title(jobTitle);
    cleanup.company(company);
    cleanup.location(location);

    await page.goto("/dashboard/settings");
    let token: string;
    if (runtime.freshNativeFull) {
      await expect(page.locator("main nav").getByRole("button", { name: "General", exact: true })).toBeVisible();
      await expect(page.getByText("MCP Access", { exact: true })).toHaveCount(0);
      // A synthetic token deliberately bypasses the hidden settings surface:
      // the real HTTP tool must still refuse the legacy write on the server.
      const user = await prisma.user.findUniqueOrThrow({ where: { email: E2E_TEST_USER.email } });
      const generated = generateToken();
      await prisma.mcpAccessToken.create({ data: {
        userId: user.id, name: tokenName, tokenHash: generated.hash,
        tokenPrefix: generated.prefix, scopes: JSON.stringify(["jobs:write"]),
        expiresAt: new Date(Date.now() + 86_400_000),
      } });
      token = generated.plaintext;
    } else {
      await page.getByText("MCP Access", { exact: true }).click();
      await page.getByRole("button", { name: "Generate" }).click();
      await page.getByPlaceholder("e.g. Claude Desktop").fill(tokenName);
      await page.getByRole("button", { name: "Generate" }).click();

      const revealDialog = page.getByRole("dialog", { name: "Token Created" });
      await expect(revealDialog).toBeVisible();
      token = await revealDialog.getByRole("textbox").inputValue();
      expect(token).toMatch(/^jsync_/);
      await page.getByRole("button", { name: "I saved my token" }).click();
    }

    const transport = new StreamableHTTPClientTransport(
      new URL("/api/mcp", baseURL),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const client = new Client({ name: "e2e-test-client", version: "1.0.0" });
    let result;
    try {
      await client.connect(transport);
      result = await client.callTool({
        name: "add_job",
        arguments: {
          company,
          jobTitle,
          jobDescription:
            "We are hiring a software engineer to build and maintain our core platform, work closely with product and design, and ship features end to end.",
          location,
        },
      });
    } finally {
      await client.close();
    }

    const text = (result.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? "")
      .join("\n");
    if (!runtime.legacyWritesAllowed) {
      expect(text).toContain("Error:");
      expect(text).toMatch(/legacy career writes|legacy Job\/Resume writes|not legacy Prisma/);
      expect(await prisma.job.count({ where: { JobTitle: { label: jobTitle } } })).toBe(0);
      expect(await prisma.jobOpportunity.count({ where: { title: jobTitle } })).toBe(0);
      expect(await prisma.company.count({ where: { label: company } })).toBe(0);
      expect(await prisma.jobTitle.count({ where: { label: jobTitle } })).toBe(0);
      expect(await prisma.location.count({ where: { label: location } })).toBe(0);
      return;
    }
    expect(text).toContain("Job created");

    const jobId = text.match(/Job created \(id: ([^)]+)\)/)?.[1];
    expect(jobId).toBeTruthy();
    cleanup.job(jobId!);

    await page.goto("/dashboard/myjobs");
    await expect(page.getByRole("row", { name: jobTitle }).first()).toBeVisible();
  });

  test("rejects a tool call with an invalid token", async ({ baseURL }) => {
    const transport = new StreamableHTTPClientTransport(
      new URL("/api/mcp", baseURL),
      { requestInit: { headers: { Authorization: "Bearer jsync_not-a-real-token" } } },
    );
    const client = new Client({ name: "e2e-test-client", version: "1.0.0" });

    await expect(client.connect(transport)).rejects.toThrow();
  });
});
