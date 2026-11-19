// @vitest-environment node
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? "h05-agent-write-test-key";
/**
 * Durable Notion write proposals (H05) against an isolated SQLite/Prisma
 * database — no real network: the MCP client factory is a controllable seam.
 *
 *   decide CAS: same replay, opposite conflict, one proposal → one task
 *   approval+task atomicity; withdraw/expiry/archive boundaries
 *   VERIFY → DISPATCH → SETTLE with epoch fencing
 *   dispatch boundary: crash after claim settles UNCERTAIN, never resends
 *   remote failure shapes: success / denied / network → zero auto-retry
 *   source delete SetNull keeps evidence; manual reconciliation evidence
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  writeInstanceMigrationState,
} from "@/lib/career";
import { sealApiKeySecret } from "@/lib/ai/credential-store";
import { claimHarnessTask } from "@/lib/harness/taskService";
import { executeAgentWriteTask } from "@/lib/harness/agentWrite";
import { harnessRunnerTick } from "@/lib/harness/runner";
import {
  HARNESS_TASK_KIND,
  HARNESS_TASK_STATUS,
} from "@/lib/harness/types";
import {
  decideOperationProposal,
  getOperationProposal,
  prepareConversationDelete,
  reproposeOperation,
  resolveUncertainProposal,
  withdrawOperationProposal,
  OperationProposalError,
} from "@/lib/agent/operationProposal";
import {
  AGENT_PROPOSAL_OUTCOME,
  AGENT_PROPOSAL_STATUS,
} from "@/lib/agent/operationProposalContract";
import { notionWriteInputHash } from "@/lib/agent/notionWriteSpec";
import { admitConversationRequest } from "@/lib/agent/conversationRequest";
import { NOTION_REMOTE } from "@/lib/extensions/notion/constants";
import { NOTION_STATUS } from "@/lib/extensions/notion/store";
import { setNotionMcpClientFactory } from "@/lib/extensions/notion/mcpClient";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const FEATURE_ON = {
  ...process.env,
  [AB_RUNTIME_FEATURE_ENV]: "true",
  [AB_ROLLOUT_SCOPE_ENV]: "full",
};

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {}
});

// ---------------------------------------------------------------------------
// Controllable remote — the factory seam records every call.
// ---------------------------------------------------------------------------
type Call = { name: string; arguments?: Record<string, unknown> };
const remote = {
  calls: [] as Call[],
  next: undefined as
    | ((call: Call) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }>)
    | undefined,
};

beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, `h05-${Date.now()}@example.com`);
  await writeInstanceMigrationState(prisma, {
    status: AB_MIGRATION_STATUS.COMPLETED,
    completedAt: new Date(),
    verifiedAt: new Date(),
  });
  remote.calls = [];
  remote.next = undefined;
  setNotionMcpClientFactory(async () => ({
    listTools: async () => ({ tools: [] }),
    callTool: async (params: {
      name: string;
      arguments?: Record<string, unknown>;
    }) => {
      remote.calls.push(params);
      if (remote.next) return remote.next(params);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              object: "page",
              id: "1234567812341234123412341234abcd",
              url: "https://notion.so/1234567812341234123412341234abcd",
              title: "Offer log",
            }),
          },
        ],
      };
    },
    close: async () => {},
  }));
});

async function connectNotion() {
  const sealed = await sealApiKeySecret(
    JSON.stringify({
      v: 1,
      accessToken: "tok_test",
      expiresAt: Date.now() + 3600_000,
    }),
  );
  await prisma.notionConnection.create({
    data: {
      userId,
      status: NOTION_STATUS.CONNECTED,
      workspaceId: "ws-1",
      availableTools: JSON.stringify([
        { name: NOTION_REMOTE.createPages },
        { name: NOTION_REMOTE.updatePage },
        { name: NOTION_REMOTE.search },
        { name: NOTION_REMOTE.fetch },
      ]),
      encryptedCredential: sealed.encryptedKey,
      credentialIv: sealed.iv,
    },
  });
}

const WRITE_INPUT = {
  target: "p-1",
  targetType: "page",
  title: "Offer log",
  content: "hello notion",
};

describe("regenerate admission with durable detached-write authority", () => {
  it("allows regeneration after rejection when no write was authorized", async () => {
    const proposal = await makeProposal({ status: AGENT_PROPOSAL_STATUS.REJECTED });
    await prisma.chatConversation.update({ where: { id: proposal.conversationId! }, data: {
      messages: JSON.stringify([{ id: "tail", role: "assistant", parts: [{
        type: "tool-notion_create_page", toolCallId: proposal.toolCallId,
        input: WRITE_INPUT, state: "output-available",
        approval: { id: proposal.approvalId, approved: false }, output: { saved: false, status: "denied" },
      }] }]),
    } });
    const admitted = await admitConversationRequest({
      userId, conversationId: proposal.conversationId!, requestId: randomUUID(),
      expectedRevision: 0, operation: "regenerate", targetMessageId: "tail",
    }, prisma);
    expect(admitted.messages).toEqual([]);
    expect(remote.calls).toHaveLength(0);
  });
  it.each(["QUEUED", "RUNNING", "TASK_MISSING", "DISPATCHED", "SUCCEEDED"])(
    "rejects regeneration for %s even without a successful stub receipt",
    async (state) => {
      await connectNotion();
      const proposal = await makeProposal();
      await decideOperationProposal(prisma, {
        userId, proposalId: proposal.id, decision: "approve",
      });
      const approved = await prisma.agentOperationProposal.findUniqueOrThrow({ where: { id: proposal.id } });
      if (state === "TASK_MISSING") {
        await prisma.agentOperationProposal.update({ where: { id: proposal.id }, data: { harnessTaskId: null } });
        await prisma.harnessTask.delete({ where: { id: approved.harnessTaskId! } });
      } else {
        await prisma.harnessTask.update({ where: { id: approved.harnessTaskId! }, data: {
          status: state === "QUEUED" ? "QUEUED" : state === "SUCCEEDED" ? "SUCCEEDED" : "RUNNING",
        } });
      }
      if (state === "DISPATCHED" || state === "SUCCEEDED") {
        await prisma.agentOperationProposal.update({ where: { id: proposal.id }, data: {
          dispatchedAt: new Date(), outcomeStatus: state === "SUCCEEDED" ? "SUCCEEDED" : null,
        } });
      }
      const messages = [{ id: "tail", role: "assistant", parts: [{
        type: "tool-notion_create_page", toolCallId: proposal.toolCallId,
        input: WRITE_INPUT, state: "output-available", approval: { id: proposal.approvalId, approved: true },
        output: { status: "queued", saved: false },
      }] }];
      await prisma.chatConversation.update({ where: { id: proposal.conversationId! }, data: { messages: JSON.stringify(messages) } });
      await expect(admitConversationRequest({
        userId, conversationId: proposal.conversationId!, requestId: randomUUID(),
        expectedRevision: 0, operation: "regenerate", targetMessageId: "tail",
      }, prisma)).rejects.toMatchObject({ code: "CONVERSATION_TURN_CONFLICT" });
      const conversation = await prisma.chatConversation.findUniqueOrThrow({ where: { id: proposal.conversationId! } });
      expect(JSON.parse(conversation.messages)).toEqual(messages);
      expect(conversation.activeRequestId).toBeNull();
      expect(remote.calls).toHaveLength(0);
    },
  );

  it("allows regeneration after a rejected proposal with no side effect", async () => {
    const proposal = await makeProposal({ status: "REJECTED" });
    await prisma.chatConversation.update({ where: { id: proposal.conversationId! }, data: {
      messages: JSON.stringify([{ id: "tail", role: "assistant", parts: [{
        type: "tool-notion_create_page", toolCallId: proposal.toolCallId,
        input: WRITE_INPUT, state: "output-denied", approval: { id: proposal.approvalId, approved: false },
      }] }]),
    } });
    const request = await admitConversationRequest({
      userId, conversationId: proposal.conversationId!, requestId: randomUUID(),
      expectedRevision: 0, operation: "regenerate", targetMessageId: "tail",
    }, prisma);
    expect(request.messages).toEqual([]);
    expect(remote.calls).toHaveLength(0);
  });
});

async function makeProposal(overrides: Partial<{
  status: string;
  expiresAt: Date;
  conversationId: string | null;
  dispatchedAt: Date | null;
}> = {}) {
  const conversationId =
    overrides.conversationId !== undefined
      ? overrides.conversationId
      : (
          await prisma.chatConversation.create({
            data: { userId, messages: "[]" },
          })
        ).id;
  return prisma.agentOperationProposal.create({
    data: {
      userId,
      conversationId,
      messageId: null,
      toolCallId: `tc-${randomUUID()}`,
      approvalId: `ap-${randomUUID()}`,
      turnKey: `turn-${randomUUID()}`,
      toolName: "notion_create_page",
      inputJson: JSON.stringify(WRITE_INPUT),
      inputHash: notionWriteInputHash(WRITE_INPUT),
      materialJson: JSON.stringify({ workspaceId: "ws-1" }),
      status: overrides.status ?? AGENT_PROPOSAL_STATUS.PROPOSED,
      expiresAt:
        overrides.expiresAt ?? new Date(Date.now() + 7 * 24 * 3600_000),
      dispatchedAt: overrides.dispatchedAt ?? null,
    },
  });
}

async function claim(taskId: string, owner = "runner-1") {
  const c = await claimHarnessTask(prisma, {
    taskId,
    owner,
    leaseMs: 60_000,
  });
  if (!c) throw new Error("claim failed");
  return c;
}

// ---------------------------------------------------------------------------

describe("decision CAS", () => {
  it("concurrent same-decision approvals settle idempotently with one task", async () => {
    await connectNotion();
    const proposal = await makeProposal();
    const decide = () =>
      decideOperationProposal(prisma, { userId, proposalId: proposal.id, decision: "approve" });
    const results = await Promise.allSettled([decide(), decide(), decide()]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const states = results.map((r) => (r as PromiseFulfilledResult<{ state: string }>).value.state);
    expect(states.filter((s) => s === "approved")).toHaveLength(1);
    expect(states.filter((s) => s === "already")).toHaveLength(2);
    expect(await prisma.harnessTask.count()).toBe(1);
  });

  it("concurrent opposite decisions: exactly one wins, the loser gets PROPOSAL_ALREADY_DECIDED", async () => {
    await connectNotion();
    const proposal = await makeProposal();
    const results = await Promise.allSettled([
      decideOperationProposal(prisma, { userId, proposalId: proposal.id, decision: "approve" }),
      decideOperationProposal(prisma, { userId, proposalId: proposal.id, decision: "reject" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ code: "PROPOSAL_ALREADY_DECIDED" });
  });
  it("approves atomically with one task; same replay returns, opposite conflicts", async () => {
    await connectNotion();
    const proposal = await makeProposal();
    const approved = await decideOperationProposal(prisma, {
      userId,
      proposalId: proposal.id,
      decision: "approve",
    });
    expect(approved.state).toBe("approved");
    const taskId = approved.state === "approved" ? approved.taskId : "";

    const row = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    expect(row.status).toBe(AGENT_PROPOSAL_STATUS.APPROVED);
    expect(row.harnessTaskId).toBe(taskId);
    const task = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: taskId },
    });
    expect(task.kind).toBe(HARNESS_TASK_KIND.AGENT_TOOL_WRITE);
    expect(task.status).toBe(HARNESS_TASK_STATUS.QUEUED);
    expect(task.jobOpportunityId).toBeNull();
    expect(await prisma.harnessTask.count()).toBe(1);

    // Same-decision replay → stored state, no second task.
    const again = await decideOperationProposal(prisma, {
      userId,
      proposalId: proposal.id,
      decision: "approve",
    });
    expect(again.state).toBe("already");
    expect(await prisma.harnessTask.count()).toBe(1);

    // Opposite decision conflicts — never flips.
    await expect(
      decideOperationProposal(prisma, {
        userId,
        proposalId: proposal.id,
        decision: "reject",
      }),
    ).rejects.toBeInstanceOf(OperationProposalError);
    const stable = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    expect(stable.status).toBe(AGENT_PROPOSAL_STATUS.APPROVED);
  });

  it("rejects approval when the source conversation is archived", async () => {
    await connectNotion();
    const conv = await prisma.chatConversation.create({
      data: { userId, messages: "[]", archivedAt: new Date() },
    });
    const proposal = await makeProposal({ conversationId: conv.id });
    await expect(
      decideOperationProposal(prisma, {
        userId,
        proposalId: proposal.id,
        decision: "approve",
      }),
    ).rejects.toMatchObject({ code: "PROPOSAL_SOURCE_ARCHIVED" });
    // Reject stays legal under archive.
    const rejected = await decideOperationProposal(prisma, {
      userId,
      proposalId: proposal.id,
      decision: "reject",
    });
    expect(rejected.state).toBe("rejected");
  });

  it("withdraw locks out a later approve; expired proposal cannot be decided", async () => {
    await connectNotion();
    const proposal = await makeProposal();
    await withdrawOperationProposal(prisma, { userId, proposalId: proposal.id });
    await expect(
      decideOperationProposal(prisma, {
        userId,
        proposalId: proposal.id,
        decision: "approve",
      }),
    ).rejects.toBeInstanceOf(OperationProposalError);

    const stale = await makeProposal({
      expiresAt: new Date(Date.now() - 1000),
    });
    const expired = await decideOperationProposal(prisma, {
      userId,
      proposalId: stale.id,
      decision: "approve",
    });
    expect(expired.state).toBe("expired");
    expect(await prisma.harnessTask.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("executor VERIFY → DISPATCH → SETTLE", () => {
  async function approvedTask() {
    const proposal = await makeProposal();
    const res = await decideOperationProposal(prisma, {
      userId,
      proposalId: proposal.id,
      decision: "approve",
    });
    if (res.state !== "approved") throw new Error("not approved");
    return { proposal, taskId: res.taskId };
  }

  it("dispatches once and settles the receipt atomically", async () => {
    await connectNotion();
    const { proposal, taskId } = await approvedTask();
    await harnessRunnerTick(prisma, undefined, FEATURE_ON);
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0].name).toBe(NOTION_REMOTE.createPages);

    const task = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: taskId },
    });
    const row = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    expect(task.status).toBe(HARNESS_TASK_STATUS.SUCCEEDED);
    expect(row.outcomeStatus).toBe(AGENT_PROPOSAL_OUTCOME.SUCCEEDED);
    expect(row.dispatchedAt).not.toBeNull();
    const outcome = JSON.parse(row.outcomeJson!) as { saved?: boolean };
    expect(outcome.saved).toBe(true);
  });

  it("a dispatch-marker crash never resends — settles UNCERTAIN for reconcile", async () => {
    await connectNotion();
    const { proposal, taskId } = await approvedTask();
    const c = await claim(taskId);
    // Simulate "claim committed, remote call may be out, process died":
    // the dispatchedAt marker is the boundary the next epoch must respect.
    await prisma.agentOperationProposal.update({
      where: { id: proposal.id },
      data: { dispatchedAt: new Date(), dispatchKey: "agent-write:x" },
    });
    await executeAgentWriteTask(prisma, c);
    expect(remote.calls).toHaveLength(0);
    const row = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    const task = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: taskId },
    });
    expect(row.outcomeStatus).toBe(AGENT_PROPOSAL_OUTCOME.UNCERTAIN);
    expect(task.status).toBe(HARNESS_TASK_STATUS.FAILED);
    expect(task.failureCode).toBe("DISPATCH_OUTCOME_UNKNOWN");
  });

  it("network failure settles UNCERTAIN and a re-execution is a no-op", async () => {
    await connectNotion();
    const { proposal, taskId } = await approvedTask();
    remote.next = async () => {
      throw new Error("ECONNRESET");
    };
    const c = await claim(taskId);
    await executeAgentWriteTask(prisma, c);
    expect(remote.calls).toHaveLength(1);
    const row = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    expect(row.outcomeStatus).toBe(AGENT_PROPOSAL_OUTCOME.UNCERTAIN);

    // A stale/second executor run must not resend: outcome is settled.
    remote.calls = [];
    await executeAgentWriteTask(prisma, c);
    expect(remote.calls).toHaveLength(0);
  });

  it("approved-but-undispatched expiry cancels with AUTHORIZATION_EXPIRED", async () => {
    await connectNotion();
    const { proposal, taskId } = await approvedTask();
    await prisma.agentOperationProposal.update({
      where: { id: proposal.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const c = await claim(taskId);
    await executeAgentWriteTask(prisma, c);
    expect(remote.calls).toHaveLength(0);
    const task = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: taskId },
    });
    expect(task.status).toBe(HARNESS_TASK_STATUS.CANCELLED);
    expect(task.failureCode).toBe("AUTHORIZATION_EXPIRED");
    const row = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    // Approval history is kept — the outcome records why it never ran.
    expect(row.status).toBe(AGENT_PROPOSAL_STATUS.APPROVED);
    expect(row.outcomeStatus).toBe(AGENT_PROPOSAL_OUTCOME.CANCELLED);
  });

  it("a disconnected connection fails at VERIFY without any remote call", async () => {
    await connectNotion();
    const { proposal, taskId } = await approvedTask();
    // Approve under a live connection, then the connection goes away —
    // VERIFY must fail the task, never silently dispatch.
    await prisma.notionConnection.delete({ where: { userId } });
    const c = await claim(taskId);
    await executeAgentWriteTask(prisma, c);
    expect(remote.calls).toHaveLength(0);
    const row = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    expect(row.outcomeStatus).toBe(AGENT_PROPOSAL_OUTCOME.FAILED);
  });
});

// ---------------------------------------------------------------------------

describe("source lifecycle + reconciliation", () => {
  it("hard delete detaches the source and revokes undecided proposals", async () => {
    const proposal = await makeProposal();
    const convId = proposal.conversationId!;
    await prisma.$transaction(async (tx) => {
      await prepareConversationDelete(tx, {
        userId,
        conversationId: convId,
      });
    });
    await prisma.chatConversation.delete({ where: { id: convId } });
    const row = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    expect(row.conversationId).toBeNull();
    expect(row.status).not.toBe(AGENT_PROPOSAL_STATUS.PROPOSED);
    const dto = (await getOperationProposal(prisma, {
      userId,
      proposalId: proposal.id,
    })) as { conversationId: string | null };
    expect(dto.conversationId).toBeNull();
  });

  it("manual reconciliation records the user's attestation, not a forged receipt", async () => {
    const proposal = await makeProposal({
      status: AGENT_PROPOSAL_STATUS.APPROVED,
      dispatchedAt: new Date(),
    });
    await prisma.agentOperationProposal.update({
      where: { id: proposal.id },
      data: {
        outcomeStatus: AGENT_PROPOSAL_OUTCOME.UNCERTAIN,
        outcomeJson: JSON.stringify({
          saved: false,
          tool: "notion_create_page",
          status: "unknown",
          code: "NOTION_OUTCOME_UNKNOWN",
        }),
      },
    });
    await resolveUncertainProposal(prisma, {
      userId,
      proposalId: proposal.id,
      resolution: "HAPPENED",
    });
    const row = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    expect(row.manualResolution).toBe("HAPPENED");
    // The stored outcome stays "unknown" — attestation is evidence, not a
    // fabricated saved:true receipt.
    const outcome = JSON.parse(row.outcomeJson!) as { saved?: boolean };
    expect(outcome.saved).toBe(false);
  });

  it("re-proposal mints a new row linked to the old history", async () => {
    const proposal = await makeProposal({
      status: AGENT_PROPOSAL_STATUS.EXPIRED,
    });
    const { proposalId } = await reproposeOperation(prisma, {
      userId,
      proposalId: proposal.id,
    });
    const fresh = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: proposalId },
    });
    const old = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.supersedesId).toBe(old.id);
    expect(fresh.status).toBe(AGENT_PROPOSAL_STATUS.PROPOSED);
    // The old row keeps its terminal history — history is evidence, never
    // re-armed; only the new proposal can carry a new decision.
    expect(old.status).toBe(AGENT_PROPOSAL_STATUS.EXPIRED);
  });

  it("an approved proposal with a live task stays active for re-proposal", async () => {
    await connectNotion();
    const proposal = await makeProposal();
    const res = await decideOperationProposal(prisma, {
      userId,
      proposalId: proposal.id,
      decision: "approve",
    });
    expect(res.state).toBe("approved");
    await expect(
      reproposeOperation(prisma, { userId, proposalId: proposal.id }),
    ).rejects.toMatchObject({ code: "PROPOSAL_STILL_ACTIVE" });
  });
});

// ---------------------------------------------------------------------------

describe("restore + reconciliation closure", () => {
  // Backup restore clears harnessTaskId: an APPROVED proposal with no
  // outcome and no dispatch marker is "unverified" — never auto-replayed,
  // but the manual-reconcile → re-propose → re-approve loop must work.
  async function restoredUnverified() {
    return makeProposal({
      status: AGENT_PROPOSAL_STATUS.APPROVED,
      dispatchedAt: null,
    });
  }

  it("restored unverified proposal attests then re-executes as a new proposal", async () => {
    await connectNotion();
    const restored = await restoredUnverified();
    // Before any attestation a re-proposal is refused: "no dispatch marker"
    // is not proof the write never went out.
    await expect(
      reproposeOperation(prisma, { userId, proposalId: restored.id }),
    ).rejects.toMatchObject({ code: "PROPOSAL_NEEDS_RECONCILE" });

    // The reconcile action now accepts the unverified (no-outcome) row.
    await resolveUncertainProposal(prisma, {
      userId,
      proposalId: restored.id,
      resolution: "NOT_HAPPENED",
    });
    const { proposalId } = await reproposeOperation(prisma, {
      userId,
      proposalId: restored.id,
    });
    const fresh = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: proposalId },
    });
    expect(fresh.supersedesId).toBe(restored.id);

    const res = await decideOperationProposal(prisma, {
      userId,
      proposalId,
      decision: "approve",
    });
    expect(res.state).toBe("approved");
    await harnessRunnerTick(prisma, undefined, FEATURE_ON);
    // The attestation released the input-level block — the new task ran.
    expect(remote.calls).toHaveLength(1);
    const settled = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: proposalId },
    });
    expect(settled.outcomeStatus).toBe(AGENT_PROPOSAL_OUTCOME.SUCCEEDED);
    // The old row keeps its evidence: attested, never auto-executed.
    const old = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: restored.id },
    });
    expect(old.manualResolution).toBe("NOT_HAPPENED");
    expect(old.outcomeStatus).toBeNull();
  });

  it("UNCERTAIN needs attestation before re-proposal; NOT_HAPPENED releases the input block", async () => {
    await connectNotion();
    const old = await makeProposal({
      status: AGENT_PROPOSAL_STATUS.APPROVED,
      dispatchedAt: new Date(),
    });
    await prisma.agentOperationProposal.update({
      where: { id: old.id },
      data: { outcomeStatus: AGENT_PROPOSAL_OUTCOME.UNCERTAIN },
    });
    await expect(
      reproposeOperation(prisma, { userId, proposalId: old.id }),
    ).rejects.toMatchObject({ code: "PROPOSAL_NEEDS_RECONCILE" });

    await resolveUncertainProposal(prisma, {
      userId,
      proposalId: old.id,
      resolution: "NOT_HAPPENED",
    });
    const { proposalId } = await reproposeOperation(prisma, {
      userId,
      proposalId: old.id,
    });
    const res = await decideOperationProposal(prisma, {
      userId,
      proposalId,
      decision: "approve",
    });
    expect(res.state).toBe("approved");
    await harnessRunnerTick(prisma, undefined, FEATURE_ON);
    expect(remote.calls).toHaveLength(1);
    const settled = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: proposalId },
    });
    expect(settled.outcomeStatus).toBe(AGENT_PROPOSAL_OUTCOME.SUCCEEDED);
  });

  it.each(["STILL_UNCERTAIN", "HAPPENED"] as const)(
    "%s keeps the duplicate-write block on the new proposal",
    async (resolution) => {
      await connectNotion();
      const old = await makeProposal({
        status: AGENT_PROPOSAL_STATUS.APPROVED,
        dispatchedAt: new Date(),
      });
      await prisma.agentOperationProposal.update({
        where: { id: old.id },
        data: { outcomeStatus: AGENT_PROPOSAL_OUTCOME.UNCERTAIN },
      });
      await resolveUncertainProposal(prisma, {
        userId,
        proposalId: old.id,
        resolution,
      });
      // Attested → the re-proposal itself is allowed…
      const { proposalId } = await reproposeOperation(prisma, {
        userId,
        proposalId: old.id,
      });
      const res = await decideOperationProposal(prisma, {
        userId,
        proposalId,
        decision: "approve",
      });
      expect(res.state).toBe("approved");
      await harnessRunnerTick(prisma, undefined, FEATURE_ON);
      // …but the executor still refuses to resend: zero remote calls.
      expect(remote.calls).toHaveLength(0);
      const settled = await prisma.agentOperationProposal.findUniqueOrThrow({
        where: { id: proposalId },
      });
      expect(settled.outcomeStatus).toBe(AGENT_PROPOSAL_OUTCOME.UNCERTAIN);
    },
  );

  it("an approved-no-outcome row blocks same-input dispatch until attested", async () => {
    await connectNotion();
    // A crashed/restored APPROVED row without a dispatch marker still
    // counts as "may already be out" for a same-input successor.
    await makeProposal({
      status: AGENT_PROPOSAL_STATUS.APPROVED,
      dispatchedAt: null,
    });
    const fresh = await makeProposal();
    const res = await decideOperationProposal(prisma, {
      userId,
      proposalId: fresh.id,
      decision: "approve",
    });
    expect(res.state).toBe("approved");
    await harnessRunnerTick(prisma, undefined, FEATURE_ON);
    expect(remote.calls).toHaveLength(0);
    const settled = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: fresh.id },
    });
    expect(settled.outcomeStatus).toBe(AGENT_PROPOSAL_OUTCOME.UNCERTAIN);
  });

  it("attestation releases only its own operation — a later UNCERTAIN row still blocks", async () => {
    await connectNotion();
    // A dispatched, went UNCERTAIN, and the user checked: it did NOT happen.
    const a = await makeProposal({
      status: AGENT_PROPOSAL_STATUS.APPROVED,
      dispatchedAt: new Date(),
    });
    await prisma.agentOperationProposal.update({
      where: { id: a.id },
      data: { outcomeStatus: AGENT_PROPOSAL_OUTCOME.UNCERTAIN },
    });
    await resolveUncertainProposal(prisma, {
      userId,
      proposalId: a.id,
      resolution: "NOT_HAPPENED",
    });
    // B dispatched later for the same input and is also uncertain — A's
    // attestation says nothing about B's operation.
    const b = await makeProposal({
      status: AGENT_PROPOSAL_STATUS.APPROVED,
      dispatchedAt: new Date(),
    });
    await prisma.agentOperationProposal.update({
      where: { id: b.id },
      data: { outcomeStatus: AGENT_PROPOSAL_OUTCOME.UNCERTAIN },
    });
    // C re-proposed + approved — B's unresolved operation keeps blocking.
    const c = await makeProposal();
    const cRes = await decideOperationProposal(prisma, {
      userId,
      proposalId: c.id,
      decision: "approve",
    });
    expect(cRes.state).toBe("approved");
    await harnessRunnerTick(prisma, undefined, FEATURE_ON);
    expect(remote.calls).toHaveLength(0);
    const cRow = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: c.id },
    });
    expect(cRow.outcomeStatus).toBe(AGENT_PROPOSAL_OUTCOME.UNCERTAIN);

    // Only after B is attested NOT_HAPPENED may a new proposal execute —
    // and C itself needs its own attestation before re-proposal.
    await resolveUncertainProposal(prisma, {
      userId,
      proposalId: b.id,
      resolution: "NOT_HAPPENED",
    });
    await expect(
      reproposeOperation(prisma, { userId, proposalId: c.id }),
    ).rejects.toMatchObject({ code: "PROPOSAL_NEEDS_RECONCILE" });
    await resolveUncertainProposal(prisma, {
      userId,
      proposalId: c.id,
      resolution: "NOT_HAPPENED",
    });
    const { proposalId } = await reproposeOperation(prisma, {
      userId,
      proposalId: c.id,
    });
    const res = await decideOperationProposal(prisma, {
      userId,
      proposalId,
      decision: "approve",
    });
    expect(res.state).toBe("approved");
    await harnessRunnerTick(prisma, undefined, FEATURE_ON);
    expect(remote.calls).toHaveLength(1);
    const settled = await prisma.agentOperationProposal.findUniqueOrThrow({
      where: { id: proposalId },
    });
    expect(settled.outcomeStatus).toBe(AGENT_PROPOSAL_OUTCOME.SUCCEEDED);
  });

  it("attestation cannot bypass a live task — the row stays non-attestable", async () => {
    await connectNotion();
    const proposal = await makeProposal();
    const res = await decideOperationProposal(prisma, {
      userId,
      proposalId: proposal.id,
      decision: "approve",
    });
    expect(res.state).toBe("approved");
    await expect(
      resolveUncertainProposal(prisma, {
        userId,
        proposalId: proposal.id,
        resolution: "NOT_HAPPENED",
      }),
    ).rejects.toMatchObject({ code: "PROPOSAL_NOT_UNCERTAIN" });
  });
});
