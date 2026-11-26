// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { LanguageModel } from 'ai';
import { seedAccount } from './helpers/backupTestDb';
import {
  mintNativeBusinessTicket,
  resolveNativeBusinessTicket,
  revokeNativeBusinessTicket,
  resetNativeBusinessTickets,
  nativeBusinessAllowedTools,
  executeNativeBusinessToolCall,
  findNativeBusinessTool,
  NATIVE_BUSINESS_MCP_TOKEN_ENV,
  NATIVE_BUSINESS_TOOLS_MAX,
} from '@/lib/agent/nativeBusinessMcp.server';
import { normalizeNativeToolEvent } from '@/lib/agent/nativeSession.server';
import {
  decideOperationProposal,
  getOperationProposal,
} from '@/lib/agent/operationProposal';
import { finishConversationRequest, type ConversationRequest } from '@/lib/agent/conversationRequest';
import { harnessRunnerTick } from '@/lib/harness/runner';
import { NOTION_TOOL, NOTION_REMOTE } from '@/lib/extensions/notion/constants';
import { FEISHU_CAPABILITY, FEISHU_TOOL } from '@/lib/extensions/feishu/constants';
import db from '@/lib/db';

const ctx = await vi.hoisted(async () => {
  const h = await import('./helpers/backupTestDb');
  const d = h.makeTestDbUrl();
  h.pushSchema(d.url);
  return d;
});

vi.mock('@/lib/db', async () => {
  const { PrismaClient } = await import('@prisma/client');
  return { default: new PrismaClient({ datasources: { db: { url: ctx.url } } }) };
});

let userId: string;
beforeAll(async () => {
  userId = await seedAccount(db, 'native-mcp@vocatrya.test');
});
afterAll(async () => {
  await db.$disconnect();
});
beforeEach(() => resetNativeBusinessTickets());

const CONV = 'conv-mcp-1';
const REQ = 'req-mcp-1';

const mint = (
  allowedTools = ['list_jobs', 'get_job', 'get_resume', 'today_plan_read'],
  overrides: Partial<Parameters<typeof mintNativeBusinessTicket>[0]> = {},
) =>
  mintNativeBusinessTicket({
    userId,
    conversationId: CONV,
    requestId: REQ,
    allowedTools,
    ...overrides,
  });

// Minimal mock DB for pure isolation tests that do not need real conversation rows.
const ownedDb = {
  chatConversation: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      where.userId === userId && where.id === CONV && where.activeRequestId === REQ
        ? { id: CONV }
        : null,
  },
};

async function createOwnedConversation(opts: {
  agentRole?: string | null;
  permissionMode?: 'ask' | 'rules' | 'full';
} = {}) {
  const reqId = `req-${randomUUID()}`;
  const row = await db.chatConversation.create({
    data: {
      userId,
      executionPath: 'NATIVE_CODEX_V1',
      agentRole: opts.agentRole ?? null,
      context: JSON.stringify({
        version: 1,
        items: [],
        permissionMode: opts.permissionMode ?? 'ask',
      }),
      messages: '[]',
      activeRequestId: reqId,
      activeRequestExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  return { conversation: row, requestId: reqId };
}

function makeStubReviewModel(text: string): LanguageModel {
  return {
    specificationVersion: 'v2',
    provider: 'test',
    modelId: 'stub-review',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('unexpected doGenerate');
    },
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 't1' });
          controller.enqueue({ type: 'text-delta', id: 't1', delta: text });
          controller.enqueue({ type: 'text-end', id: 't1' });
          controller.enqueue({
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          });
          controller.close();
        },
      }),
    }),
  } as unknown as LanguageModel;
}

describe('ticket lifecycle, allowlist & fail-closed isolation', () => {
  it('mints, resolves and revokes a per-turn bearer ticket binding permissionMode, role & turnKey', () => {
    const record = mintNativeBusinessTicket({
      userId,
      conversationId: 'c1',
      requestId: 'r1',
      allowedTools: ['list_jobs', 'add_job', 'read_webpage', 'exec', 'generate_cover_letter'],
      permissionMode: 'rules',
      agentRole: 'pilot',
      turnKey: 'u-turn-1',
    });
    expect(record.token.startsWith('nbt_')).toBe(true);
    // Non-bridge tools (read_webpage, exec, generate_cover_letter) are stripped at mint time.
    expect(record.allowedTools).toEqual(['list_jobs', 'add_job']);
    expect(resolveNativeBusinessTicket(record.token)).toMatchObject({
      userId,
      conversationId: 'c1',
      requestId: 'r1',
      permissionMode: 'rules',
      agentRole: 'pilot',
      turnKey: 'u-turn-1',
    });
    revokeNativeBusinessTicket(record.token);
    expect(resolveNativeBusinessTicket(record.token)).toBeNull();
    expect(resolveNativeBusinessTicket('nbt_forged')).toBeNull();
  });

  it('defaults permissionMode to ask and enforces role ceiling at mint time', () => {
    const reflectTicket = mintNativeBusinessTicket({
      userId,
      conversationId: 'c-reflect',
      requestId: 'r-reflect',
      agentRole: 'reflect',
      allowedTools: ['list_jobs', 'today_plan', 'add_job', 'review_resume', 'notion_create_page'],
    });
    expect(reflectTicket.permissionMode).toBe('ask');
    expect(reflectTicket.allowedTools).toEqual(['list_jobs', 'today_plan']);
  });

  it('expires tickets past the turn window', () => {
    const record = mintNativeBusinessTicket({
      userId,
      conversationId: 'c',
      requestId: 'r',
      allowedTools: ['list_jobs'],
      now: 1000,
    });
    expect(resolveNativeBusinessTicket(record.token, { now: 1000 + 60_000 })).not.toBeNull();
    expect(resolveNativeBusinessTicket(record.token, { now: 1000 + 141_000 })).toBeNull();
  });

  it('allowlist dynamically reuses effectiveAgentToolNames across roles and integrations', () => {
    // General assistant (null role): core reads + core writes + connected integration tools.
    expect(nativeBusinessAllowedTools({})).toEqual([
      'add_job',
      'list_jobs',
      'get_job',
      'get_resume',
      'review_resume',
      'match_job',
      'today_plan_read',
      'today_plan',
    ]);
    const withIntegrations = nativeBusinessAllowedTools({
      agentRole: 'pilot',
      notionTools: [NOTION_TOOL.search, NOTION_TOOL.read, NOTION_TOOL.createPage, NOTION_TOOL.deletePages],
      feishuTools: [FEISHU_TOOL.searchDocs, FEISHU_TOOL.createDoc],
    });
    expect(withIntegrations).toContain('add_job');
    expect(withIntegrations).toContain('today_plan');
    expect(withIntegrations).toContain(NOTION_TOOL.createPage);
    expect(withIntegrations).toContain(NOTION_TOOL.deletePages);
    expect(withIntegrations).toContain(FEISHU_TOOL.createDoc);
    expect(withIntegrations).not.toContain('review_resume');
    expect(withIntegrations).not.toContain('match_job');
    expect(withIntegrations).not.toContain('read_webpage');

    const insight = nativeBusinessAllowedTools({
      agentRole: 'insight',
      notionTools: [NOTION_TOOL.search, NOTION_TOOL.createPage],
    });
    expect(insight).toContain('review_resume');
    expect(insight).toContain('match_job');
    expect(insight).toContain('today_plan');
    expect(insight).not.toContain('add_job');
    expect(insight).not.toContain(NOTION_TOOL.createPage);
    expect(NATIVE_BUSINESS_TOOLS_MAX).toBeGreaterThanOrEqual(20);
  });

  it('tools/call runs an owned core read and returns bounded text', async () => {
    const ticket = mint();
    const result = await executeNativeBusinessToolCall({
      record: ticket,
      name: 'list_jobs',
      args: {},
      db: ownedDb as never,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content[0].text).toContain('status');
  });

  it('denies calls outside the allowlist, on wrong role, after lease loss, and on foreign conversations', async () => {
    const ticket = mint();
    expect(
      await executeNativeBusinessToolCall({
        record: ticket,
        name: 'add_job',
        args: { company: 'Acme', jobTitle: 'Engineer', jobDescription: 'Build reliable distributed systems' },
        db: ownedDb as never,
      }),
    ).toMatchObject({ ok: false });

    const forged = mintNativeBusinessTicket({
      userId: 'other-user',
      conversationId: CONV,
      requestId: REQ,
      allowedTools: ['list_jobs'],
    });
    expect(
      await executeNativeBusinessToolCall({
        record: forged,
        name: 'list_jobs',
        args: {},
        db: ownedDb as never,
      }),
    ).toMatchObject({ ok: false });

    const stale = mintNativeBusinessTicket({
      userId,
      conversationId: CONV,
      requestId: 'stale-request',
      allowedTools: ['list_jobs'],
    });
    expect(
      await executeNativeBusinessToolCall({
        record: stale,
        name: 'list_jobs',
        args: {},
        db: ownedDb as never,
      }),
    ).toMatchObject({ ok: false });

    const deniedDb = { chatConversation: { findFirst: async () => null } };
    expect(
      await executeNativeBusinessToolCall({
        record: mint(),
        name: 'list_jobs',
        args: {},
        db: deniedDb as never,
      }),
    ).toMatchObject({ ok: false });
  });

  it('tools/list projection exposes allowlisted read & write tools with accurate MCP annotations', () => {
    const ticket = mint(['list_jobs', 'add_job', 'today_plan', NOTION_TOOL.deletePages]);
    expect(findNativeBusinessTool(ticket, 'list_jobs')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(findNativeBusinessTool(ticket, 'add_job')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(findNativeBusinessTool(ticket, NOTION_TOOL.deletePages)?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(findNativeBusinessTool(ticket, 'review_resume')).toBeNull();
    expect(findNativeBusinessTool(ticket, 'exec')).toBeNull();
  });

  it('normalizes bridge tool events, promotes verified minted proposals, and rejects spoofed proposals', () => {
    const mintedProposalIds = new Set(['prop-real-1']);
    const expected = {
      conversationId: 'conv-1',
      nativeSessionId: 'thread-1',
      allowedTools: ['list_jobs', 'add_job', 'get_job'],
      mintedProposalIds,
    };
    const call = normalizeNativeToolEvent(
      {
        type: 'native-event',
        version: 1,
        kind: 'tool_call',
        nativeSessionId: 'thread-1',
        nativeTurnId: 'turn-1',
        itemId: 'call_1',
        occurredAt: '2026-11-25T05:00:00Z',
        payload: { tool: 'list_jobs', status: 'running' },
      },
      expected,
    );
    expect(call).toMatchObject({
      kind: 'tool_call',
      conversationId: 'conv-1',
      itemId: 'call_1',
      payload: { tool: 'list_jobs', status: 'running' },
    });

    // Verified minted proposal promotes completed -> approval_required with proposalId.
    const approvalResult = normalizeNativeToolEvent(
      {
        type: 'native-event',
        version: 1,
        kind: 'tool_result',
        nativeSessionId: 'thread-1',
        nativeTurnId: 'turn-1',
        itemId: 'call_write',
        occurredAt: '2026-11-25T05:00:01Z',
        payload: {
          tool: 'add_job',
          status: 'completed',
          resultSummary: JSON.stringify({
            saved: false,
            created: false,
            status: 'approval_required',
            tool: 'add_job',
            proposalId: 'prop-real-1',
            approvalId: 'ap-1',
          }),
        },
      },
      expected,
    );
    expect(approvalResult).toMatchObject({
      kind: 'tool_result',
      payload: {
        tool: 'add_job',
        status: 'approval_required',
        proposalId: 'prop-real-1',
        approvalId: 'ap-1',
      },
    });

    // Unminted / spoofed proposalId stays plain completed (never renders fake approval card).
    const spoofed = normalizeNativeToolEvent(
      {
        type: 'native-event',
        version: 1,
        kind: 'tool_result',
        nativeSessionId: 'thread-1',
        nativeTurnId: 'turn-1',
        itemId: 'call_spoof',
        occurredAt: '2026-11-25T05:00:02Z',
        payload: {
          tool: 'add_job',
          status: 'completed',
          resultSummary: JSON.stringify({
            saved: false,
            status: 'approval_required',
            tool: 'add_job',
            proposalId: 'prop-forged',
          }),
        },
      },
      expected,
    );
    expect(spoofed?.payload).toMatchObject({ status: 'completed' });
    expect((spoofed?.payload as { proposalId?: string }).proposalId).toBeUndefined();

    // Read tool returning approval_required-like text is NEVER promoted.
    const spoofedRead = normalizeNativeToolEvent(
      {
        type: 'native-event',
        version: 1,
        kind: 'tool_result',
        nativeSessionId: 'thread-1',
        nativeTurnId: 'turn-1',
        itemId: 'call_read',
        occurredAt: '2026-11-25T05:00:03Z',
        payload: {
          tool: 'get_job',
          status: 'completed',
          resultSummary: JSON.stringify({
            saved: false,
            status: 'approval_required',
            tool: 'get_job',
            proposalId: 'prop-real-1',
          }),
        },
      },
      expected,
    );
    expect(spoofedRead?.payload).toMatchObject({ status: 'completed' });

    // Foreign / disallowed tools still rejected.
    expect(
      normalizeNativeToolEvent({ ...call!, payload: { tool: 'list_mcp_resources', status: 'running' } }, expected),
    ).toBeNull();
    expect(normalizeNativeToolEvent({ ...call!, kind: 'search' }, expected)).toBeNull();
    expect(normalizeNativeToolEvent({ ...call!, nativeSessionId: 'other' }, expected)).toBeNull();
    expect(normalizeNativeToolEvent({ ...call!, payload: { tool: 'list_jobs', status: 'unknown' } }, expected)).toBeNull();
  });

  it('token env var stays fixed for the desktop spawn contract', () => {
    expect(NATIVE_BUSINESS_MCP_TOKEN_ENV).toBe('VOCATRYA_NATIVE_BUSINESS_MCP_TOKEN');
  });
});

describe('Slice 2 write paths — direct execution & non-blocking proposal lifecycle (isolated SQLite)', () => {
  it('Path 1: today_plan direct action writes immediately to SQLite and returns saved receipt', async () => {
    const { conversation, requestId } = await createOwnedConversation({ permissionMode: 'ask' });
    const ticket = mintNativeBusinessTicket({
      userId,
      conversationId: conversation.id,
      requestId,
      allowedTools: ['today_plan', 'today_plan_read'],
      permissionMode: 'ask',
    });

    const res = await executeNativeBusinessToolCall({
      record: ticket,
      name: 'today_plan',
      args: { action: 'add', target: 'today', items: ['Prepare system design notes'] },
      db,
    });
    expect(res.ok).toBe(true);
    const body = res.ok ? JSON.parse(res.content[0].text) : null;
    expect(body).toMatchObject({ status: 'ok', saved: true, action: 'add' });

    const persisted = await db.todayPlanItem.findMany({
      where: { userId, conversationId: conversation.id },
      include: { task: true },
    });
    expect(persisted.map((i) => i.task.title)).toContain('Prepare system design notes');
  });

  it('Path 1: add_job under rules mode persists directly to SQLite and returns created:true', async () => {
    const { conversation, requestId } = await createOwnedConversation({
      agentRole: 'pilot',
      permissionMode: 'rules',
    });
    const ticket = mintNativeBusinessTicket({
      userId,
      conversationId: conversation.id,
      requestId,
      agentRole: 'pilot',
      allowedTools: ['add_job'],
      permissionMode: 'rules',
      canonicalJobs: false,
    });

    const res = await executeNativeBusinessToolCall({
      record: ticket,
      name: 'add_job',
      args: {
        company: 'RulesCo',
        jobTitle: 'Backend Engineer',
        jobDescription: 'Own backend APIs, data pipelines, and production reliability for core services.',
      },
      db,
    });
    expect(res.ok).toBe(true);
    const body = res.ok ? JSON.parse(res.content[0].text) : null;
    expect(body).toMatchObject({ created: true });
    expect(typeof body.jobId).toBe('string');

    const stored = await db.job.findFirst({ where: { id: body.jobId, userId } });
    expect(stored).not.toBeNull();
  });

  it('Path 1: review_resume persists reviewData to SQLite without NextAuth session cookies', async () => {
    const profile =
      (await db.profile.findFirst({ where: { userId } })) ??
      (await db.profile.create({ data: { userId } }));
    const resume = await db.resume.create({
      data: {
        profileId: profile.id,
        title: 'Slice2 Review Resume',
        ResumeSections: {
          create: {
            sectionTitle: 'Summary',
            sectionType: 'summary',
            summary: {
              create: {
                content:
                  'Senior full-stack engineer with 8 years of experience building distributed TypeScript, Next.js, Node.js, Prisma, and SQLite local-first desktop applications. Led reliability, observability, data migration safety, and end-to-end testing initiatives across multiple production releases.',
              },
            },
          },
        },
      },
    });
    const { conversation, requestId } = await createOwnedConversation({
      agentRole: 'insight',
      permissionMode: 'ask',
    });
    const ticket = mintNativeBusinessTicket({
      userId,
      conversationId: conversation.id,
      requestId,
      agentRole: 'insight',
      allowedTools: ['review_resume'],
      permissionMode: 'ask',
      pageResumeId: resume.id,
    });

    const res = await executeNativeBusinessToolCall({
      record: ticket,
      name: 'review_resume',
      args: { resumeTitle: 'Slice2 Review Resume' },
      db,
      model: makeStubReviewModel(
        'SCORES: overall=84 impact=82 clarity=86 ats=80\n\nStrong systems background with clear ownership.',
      ),
    });
    expect(res.ok).toBe(true);
    const body = res.ok ? JSON.parse(res.content[0].text) : null;
    expect(body).toMatchObject({ status: 'ok', saved: true, resumeId: resume.id });
    expect(body.scores).toMatchObject({ overall: 84, impact: 82, clarity: 86 });

    const reloaded = await db.resume.findUniqueOrThrow({ where: { id: resume.id } });
    expect(reloaded.reviewData).toContain('"overall":84');
  });

  it('Path 2: add_job under ask mode creates non-blocking frozen proposal with zero side effects, executes on approve, and stays idempotent', async () => {
    const { conversation, requestId } = await createOwnedConversation({
      agentRole: 'pilot',
      permissionMode: 'ask',
    });
    const beforeJobs = await db.job.count({ where: { userId } });
    const ticket = mintNativeBusinessTicket({
      userId,
      conversationId: conversation.id,
      requestId,
      agentRole: 'pilot',
      allowedTools: ['add_job'],
      permissionMode: 'ask',
      turnKey: 'turn-ask-addjob',
      canonicalJobs: false,
    });

    const res = await executeNativeBusinessToolCall({
      record: ticket,
      name: 'add_job',
      args: {
        company: 'ApprovalCo',
        jobTitle: 'Staff Engineer',
        jobDescription: 'Lead desktop architecture, local-first storage, and reliability across Windows releases.',
      },
      db,
    });
    expect(res.ok).toBe(true);
    const receipt = res.ok ? JSON.parse(res.content[0].text) : null;
    expect(receipt).toMatchObject({
      saved: false,
      created: false,
      status: 'approval_required',
      code: 'APPROVAL_REQUIRED',
      tool: 'add_job',
    });
    expect(typeof receipt.proposalId).toBe('string');
    expect(ticket.mintedProposalIds.has(receipt.proposalId)).toBe(true);
    // Zero side effects before user approves!
    expect(await db.job.count({ where: { userId } })).toBe(beforeJobs);

    // Same-turn identical call is idempotent — returns the same proposalId instead of duplicating.
    const dupRes = await executeNativeBusinessToolCall({
      record: ticket,
      name: 'add_job',
      args: {
        company: 'ApprovalCo',
        jobTitle: 'Staff Engineer',
        jobDescription: 'Lead desktop architecture, local-first storage, and reliability across Windows releases.',
      },
      db,
    });
    expect(dupRes.ok).toBe(true);
    expect(JSON.parse(dupRes.ok ? dupRes.content[0].text : '{}').proposalId).toBe(receipt.proposalId);

    // Finishing the native turn MUST NOT supersede the proposal (messageId is null).
    const convReq: ConversationRequest = {
      operation: 'send',
      userId,
      conversationId: conversation.id,
      requestId,
      revision: conversation.revision,
      messages: [],
      responseMessageId: 'a-native-1',
      released: false,
      wrote: false,
    };
    await finishConversationRequest(
      convReq,
      [
        { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'add this job' }] },
        { id: 'a-native-1', role: 'assistant', parts: [{ type: 'text', text: 'Waiting for approval.' }] },
      ],
      db,
    );
    const afterFinish = await getOperationProposal(db, { userId, proposalId: receipt.proposalId });
    expect(afterFinish?.derived).toBe('pending');

    // Approve -> atomically mints HarnessTask -> duplicate approve is idempotent.
    const approved = await decideOperationProposal(db, {
      userId,
      proposalId: receipt.proposalId,
      decision: 'approve',
    });
    expect(approved.state).toBe('approved');
    const secondApprove = await decideOperationProposal(db, {
      userId,
      proposalId: receipt.proposalId,
      decision: 'approve',
    });
    expect(secondApprove).toMatchObject({ state: 'already', status: 'APPROVED' });

    // Execute queued harness task and verify real persistence + settled receipt.
    await harnessRunnerTick(db);
    expect(await db.job.count({ where: { userId } })).toBe(beforeJobs + 1);
    const settled = await getOperationProposal(db, { userId, proposalId: receipt.proposalId });
    expect(settled?.derived).toBe('succeeded');
    expect(settled?.outcomeStatus).toBe('SUCCEEDED');
    expect(settled?.outcome).toMatchObject({ created: true, saved: true, tool: 'add_job' });
  });

  it('Path 2: today_plan.suggest stays approval-gated even in full mode, and adopts items on approval', async () => {
    const { conversation, requestId } = await createOwnedConversation({ permissionMode: 'full' });
    const ticket = mintNativeBusinessTicket({
      userId,
      conversationId: conversation.id,
      requestId,
      allowedTools: ['today_plan'],
      permissionMode: 'full',
      turnKey: 'turn-suggest-1',
    });

    const res = await executeNativeBusinessToolCall({
      record: ticket,
      name: 'today_plan',
      args: { action: 'suggest', target: 'today', items: ['Review offer comparison', 'Follow up with recruiter'] },
      db,
    });
    expect(res.ok).toBe(true);
    const receipt = JSON.parse(res.ok ? res.content[0].text : '{}');
    expect(receipt).toMatchObject({ saved: false, status: 'approval_required', tool: 'today_plan' });
    expect(await db.todayPlanItem.count({ where: { userId, conversationId: conversation.id } })).toBe(0);

    const decision = await decideOperationProposal(db, {
      userId,
      proposalId: receipt.proposalId,
      decision: 'approve',
    });
    expect(decision.state).toBe('approved');
    await harnessRunnerTick(db);

    const items = await db.todayPlanItem.findMany({
      where: { userId, conversationId: conversation.id },
      include: { task: true },
      orderBy: { position: 'asc' },
    });
    expect(items.map((i) => i.task.title)).toEqual(['Review offer comparison', 'Follow up with recruiter']);
    const settled = await getOperationProposal(db, { userId, proposalId: receipt.proposalId });
    expect(settled?.derived).toBe('succeeded');
  });

  it('Path 2: canonical match_job stays approval-gated across ask/rules/full modes with zero side effects before approval', async () => {
    const { conversation, requestId } = await createOwnedConversation({
      agentRole: 'insight',
      permissionMode: 'full',
    });
    const ticket = mintNativeBusinessTicket({
      userId,
      conversationId: conversation.id,
      requestId,
      agentRole: 'insight',
      allowedTools: ['match_job'],
      permissionMode: 'full',
      freshNativeFull: true,
      turnKey: 'turn-match-1',
    });

    const res = await executeNativeBusinessToolCall({
      record: ticket,
      name: 'match_job',
      args: {},
      db,
    });
    expect(res.ok).toBe(true);
    const receipt = JSON.parse(res.ok ? res.content[0].text : '{}');
    expect(receipt).toMatchObject({ saved: false, status: 'approval_required', tool: 'match_job' });
    const row = await db.agentOperationProposal.findUniqueOrThrow({ where: { id: receipt.proposalId } });
    expect(row.status).toBe('PROPOSED');
  });

  it('Path 2: Notion & Feishu writes fail-closed when disconnected, propose in ask/rules, and keep full-mode honesty', async () => {
    const { conversation, requestId } = await createOwnedConversation({
      agentRole: 'pilot',
      permissionMode: 'ask',
    });
    const ticketAsk = mintNativeBusinessTicket({
      userId,
      conversationId: conversation.id,
      requestId,
      agentRole: 'pilot',
      allowedTools: [NOTION_TOOL.createPage, NOTION_TOOL.deletePages, FEISHU_TOOL.createDoc],
      permissionMode: 'ask',
      turnKey: 'turn-ext-1',
    });

    // Disconnected -> fail-closed with zero proposals.
    const beforeProposals = await db.agentOperationProposal.count({ where: { userId } });
    expect(
      await executeNativeBusinessToolCall({
        record: ticketAsk,
        name: NOTION_TOOL.createPage,
        args: { title: 'Interview Notes', content: 'Round 1 questions' },
        db,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await executeNativeBusinessToolCall({
        record: ticketAsk,
        name: FEISHU_TOOL.createDoc,
        args: { title: 'Prep Doc', content: 'Checklist' },
        db,
      }),
    ).toMatchObject({ ok: false });
    expect(await db.agentOperationProposal.count({ where: { userId } })).toBe(beforeProposals);

    // Seed connected Notion + Feishu rows with write capabilities (no live remote calls!).
    await db.notionConnection.create({
      data: {
        userId,
        status: 'CONNECTED',
        workspaceId: 'ws-test-1',
        workspaceName: 'Test WS',
        availableTools: JSON.stringify([NOTION_REMOTE.createPages, NOTION_REMOTE.deletePages]),
      },
    });
    await db.feishuConnection.create({
      data: {
        userId,
        status: 'CONNECTED',
        appId: 'cli_test_app',
        encryptedCredential: 'sealed',
        availableCapabilities: JSON.stringify([FEISHU_CAPABILITY.docxWrite]),
      },
    });

    // ask mode -> both Notion create_page & Feishu create_doc freeze proposals, zero remote call.
    const notionRes = await executeNativeBusinessToolCall({
      record: ticketAsk,
      name: NOTION_TOOL.createPage,
      args: { title: 'Interview Notes', content: 'Round 1 questions' },
      db,
    });
    expect(notionRes.ok).toBe(true);
    const notionReceipt = JSON.parse(notionRes.ok ? notionRes.content[0].text : '{}');
    expect(notionReceipt).toMatchObject({
      saved: false,
      status: 'approval_required',
      tool: NOTION_TOOL.createPage,
    });
    const notionProposal = await db.agentOperationProposal.findUniqueOrThrow({
      where: { id: notionReceipt.proposalId },
    });
    expect(JSON.parse(notionProposal.materialJson!)).toMatchObject({ workspaceId: 'ws-test-1' });

    const feishuRes = await executeNativeBusinessToolCall({
      record: ticketAsk,
      name: FEISHU_TOOL.createDoc,
      args: { title: 'Prep Doc', content: 'Checklist' },
      db,
    });
    expect(feishuRes.ok).toBe(true);
    const feishuReceipt = JSON.parse(feishuRes.ok ? feishuRes.content[0].text : '{}');
    expect(feishuReceipt).toMatchObject({
      saved: false,
      status: 'approval_required',
      tool: FEISHU_TOOL.createDoc,
    });
    const feishuProposal = await db.agentOperationProposal.findUniqueOrThrow({
      where: { id: feishuReceipt.proposalId },
    });
    expect(JSON.parse(feishuProposal.materialJson!)).toMatchObject({ appId: 'cli_test_app' });

    // full mode: notion_create_page queues via durable proposal + task (NEVER saved:true!),
    // while notion_delete_pages and feishu_create_doc ALWAYS stay approval_required.
    const kickRunner = vi.fn();
    const ticketFull = mintNativeBusinessTicket({
      userId,
      conversationId: conversation.id,
      requestId,
      agentRole: 'pilot',
      allowedTools: [NOTION_TOOL.createPage, NOTION_TOOL.deletePages, FEISHU_TOOL.createDoc],
      permissionMode: 'full',
      turnKey: 'turn-ext-full',
    });
    const fullCreate = await executeNativeBusinessToolCall({
      record: ticketFull,
      name: NOTION_TOOL.createPage,
      args: { title: 'Full Mode Page', content: 'Queued body' },
      db,
      kickRunner,
    });
    expect(fullCreate.ok).toBe(true);
    const fullCreateReceipt = JSON.parse(fullCreate.ok ? fullCreate.content[0].text : '{}');
    expect(fullCreateReceipt).toMatchObject({
      saved: false,
      status: 'queued',
      code: 'QUEUED',
      tool: NOTION_TOOL.createPage,
    });
    expect(typeof fullCreateReceipt.taskId).toBe('string');
    expect(kickRunner).toHaveBeenCalledTimes(1);

    const fullDelete = await executeNativeBusinessToolCall({
      record: ticketFull,
      name: NOTION_TOOL.deletePages,
      args: { targets: ['1234567890abcdef1234567890abcdef'] },
      db,
      kickRunner,
    });
    expect(fullDelete.ok).toBe(true);
    expect(JSON.parse(fullDelete.ok ? fullDelete.content[0].text : '{}')).toMatchObject({
      saved: false,
      status: 'approval_required',
      tool: NOTION_TOOL.deletePages,
    });

    const fullFeishu = await executeNativeBusinessToolCall({
      record: ticketFull,
      name: FEISHU_TOOL.createDoc,
      args: { title: 'Still Gated', content: 'Must ask even in full' },
      db,
      kickRunner,
    });
    expect(fullFeishu.ok).toBe(true);
    expect(JSON.parse(fullFeishu.ok ? fullFeishu.content[0].text : '{}')).toMatchObject({
      saved: false,
      status: 'approval_required',
      tool: FEISHU_TOOL.createDoc,
    });
  });

  it('Path 2: reject, expire, and post-dispatch crash (UNCERTAIN) obey non-resend safety invariants', async () => {
    const { conversation, requestId } = await createOwnedConversation({
      agentRole: 'pilot',
      permissionMode: 'ask',
    });
    const ticket = mintNativeBusinessTicket({
      userId,
      conversationId: conversation.id,
      requestId,
      agentRole: 'pilot',
      allowedTools: ['add_job'],
      permissionMode: 'ask',
      turnKey: 'turn-safety-1',
      canonicalJobs: false,
    });

    // 1) Reject: zero task created, opposite decision fails.
    const r1 = await executeNativeBusinessToolCall({
      record: ticket,
      name: 'add_job',
      args: {
        company: 'RejectCo',
        jobTitle: 'QA Engineer',
        jobDescription: 'Write automated verification tests for desktop workflows.',
      },
      db,
    });
    const p1 = JSON.parse(r1.ok ? r1.content[0].text : '{}').proposalId as string;
    expect(
      await decideOperationProposal(db, { userId, proposalId: p1, decision: 'reject', reason: 'not interested' }),
    ).toMatchObject({ state: 'rejected' });
    await expect(
      decideOperationProposal(db, { userId, proposalId: p1, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_ALREADY_DECIDED' });
    expect((await db.agentOperationProposal.findUniqueOrThrow({ where: { id: p1 } })).harnessTaskId).toBeNull();

    // 2) Expired: returns state:'expired', creates no task.
    const r2 = await executeNativeBusinessToolCall({
      record: ticket,
      name: 'add_job',
      args: {
        company: 'ExpireCo',
        jobTitle: 'Design Engineer',
        jobDescription: 'Design component systems and interactive desktop prototypes.',
      },
      db,
    });
    const p2 = JSON.parse(r2.ok ? r2.content[0].text : '{}').proposalId as string;
    await db.agentOperationProposal.update({
      where: { id: p2 },
      data: { expiresAt: new Date(Date.now() - 10_000) },
    });
    expect(
      await decideOperationProposal(db, { userId, proposalId: p2, decision: 'approve' }),
    ).toMatchObject({ state: 'expired' });
    expect((await db.agentOperationProposal.findUniqueOrThrow({ where: { id: p2 } })).harnessTaskId).toBeNull();

    // 3) Crash after dispatchedAt: runner settles UNCERTAIN (DISPATCH_OUTCOME_UNKNOWN) and NEVER resends.
    const r3 = await executeNativeBusinessToolCall({
      record: ticket,
      name: 'add_job',
      args: {
        company: 'CrashCo',
        jobTitle: 'Security Engineer',
        jobDescription: 'Harden local-first credential storage and process isolation boundaries.',
      },
      db,
    });
    const p3 = JSON.parse(r3.ok ? r3.content[0].text : '{}').proposalId as string;
    const beforeJobs = await db.job.count({ where: { userId } });
    const d3 = await decideOperationProposal(db, { userId, proposalId: p3, decision: 'approve' });
    expect(d3.state).toBe('approved');
    // Simulate a prior process crossing the dispatch marker and dying before settle.
    await db.agentOperationProposal.update({
      where: { id: p3 },
      data: { dispatchKey: `agent-write:${p3}`, dispatchedAt: new Date() },
    });
    await harnessRunnerTick(db);
    expect(await db.job.count({ where: { userId } })).toBe(beforeJobs);
    const settled3 = await getOperationProposal(db, { userId, proposalId: p3 });
    expect(settled3?.derived).toBe('uncertain');
    expect(settled3?.outcomeStatus).toBe('UNCERTAIN');
    expect(settled3?.outcome).toMatchObject({
      saved: false,
      status: 'unknown',
      code: 'DISPATCH_OUTCOME_UNKNOWN',
    });
  });
});

describe('internal MCP route', () => {
  const URL = 'http://127.0.0.1/api/internal/native-business-mcp';
  const rpc = (token: string | null, body: unknown) =>
    new Request(URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it('rejects missing and unknown bearer tickets before any MCP handling', async () => {
    const { POST } = await import('@/app/api/internal/native-business-mcp/route');
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    };
    expect((await POST(rpc(null, init))).status).toBe(401);
    expect((await POST(rpc('nbt_forged', init))).status).toBe(401);
    const revoked = mint();
    revokeNativeBusinessTicket(revoked.token);
    expect((await POST(rpc(revoked.token, init))).status).toBe(401);
  });

  it('rejects GET and projects allowlisted read + write tools with accurate annotations on tools/list', async () => {
    const { GET, POST } = await import('@/app/api/internal/native-business-mcp/route');
    expect((await GET()).status).toBe(405);
    const ticket = mint(['list_jobs', 'get_job', 'add_job', 'today_plan', NOTION_TOOL.deletePages]);
    const init = rpc(ticket.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    expect((await POST(init)).status).toBe(200);
    const listRes = await POST(rpc(ticket.token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    const list = await listRes.json();
    const byName = Object.fromEntries(
      list.result.tools.map((t: { name: string; annotations: Record<string, boolean> }) => [t.name, t.annotations]),
    );
    expect(Object.keys(byName).sort()).toEqual([
      'add_job',
      'get_job',
      'list_jobs',
      'notion_delete_pages',
      'today_plan',
    ]);
    expect(byName.list_jobs).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.add_job).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.today_plan).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.notion_delete_pages).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
