// @vitest-environment node
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
} from '@/lib/agent/nativeBusinessMcp.server';
import { normalizeNativeToolEvent } from '@/lib/agent/nativeSession.server';
import db from '@/lib/db';
const ctx=await vi.hoisted(async()=>{const h=await import('./helpers/backupTestDb');const d=h.makeTestDbUrl();h.pushSchema(d.url);return d;});
vi.mock('@/lib/db',async()=>{const {PrismaClient}=await import('@prisma/client');return {default:new PrismaClient({datasources:{db:{url:ctx.url}}})};});
let userId:string;
beforeAll(async()=>{userId=await seedAccount(db,'native-mcp@vocatrya.test');});
afterAll(async()=>{await db.$disconnect();});
beforeEach(()=>resetNativeBusinessTickets());
const CONV='conv-mcp-1',REQ='req-mcp-1';
const mint=(allowedTools=['list_jobs','get_job','get_resume','today_plan_read'],overrides:Partial<Parameters<typeof mintNativeBusinessTicket>[0]>={})=>
  mintNativeBusinessTicket({userId,conversationId:CONV,requestId:REQ,allowedTools,...overrides});
// Ownership re-check is injectable so the spec does not depend on schema
// columns owned by a parallel window (nativeMemoryBlock on chatConversation).
const ownedDb={chatConversation:{findFirst:async({where}:{where:Record<string,unknown>})=>
  where.userId===userId&&where.id===CONV&&where.activeRequestId===REQ?{id:CONV}:null}};
it('mints, resolves and revokes a per-turn bearer ticket',()=>{
  const record=mintNativeBusinessTicket({userId,conversationId:'c1',requestId:'r1',allowedTools:['list_jobs','add_job']});
  expect(record.token.startsWith('nbt_')).toBe(true);
  // Non-read tools are stripped at mint time — the store never carries them.
  expect(record.allowedTools).toEqual(['list_jobs']);
  expect(resolveNativeBusinessTicket(record.token)).toMatchObject({userId,conversationId:'c1',requestId:'r1'});
  revokeNativeBusinessTicket(record.token);
  expect(resolveNativeBusinessTicket(record.token)).toBeNull();
  expect(resolveNativeBusinessTicket('nbt_forged')).toBeNull();
});
it('expires tickets past the turn window',()=>{
  const record=mintNativeBusinessTicket({userId,conversationId:'c',requestId:'r',allowedTools:['list_jobs'],now:1000});
  expect(resolveNativeBusinessTicket(record.token,{now:1000+60_000})).not.toBeNull();
  expect(resolveNativeBusinessTicket(record.token,{now:1000+141_000})).toBeNull();
});
it('allowlist intersects the role-aware registry with the read-only surface',()=>{
  expect(nativeBusinessAllowedTools({})).toEqual(['list_jobs','get_job','get_resume','today_plan_read']);
  expect(nativeBusinessAllowedTools({notionTools:['notion_search','notion_read','notion_create_page'],feishuTools:['feishu_search_docs','feishu_create_doc']})).toEqual(['list_jobs','get_job','get_resume','today_plan_read','notion_search','notion_read','feishu_search_docs']);
  const narrowed=nativeBusinessAllowedTools({agentRole:'insight'});
  expect(narrowed.every(n=>['list_jobs','get_job','get_resume','today_plan_read'].includes(n)||n.startsWith('notion_')||n.startsWith('feishu_'))).toBe(true);
});
it('tools/call runs an owned core read and returns bounded text',async()=>{
  const ticket=mint();
  const result=await executeNativeBusinessToolCall({record:ticket,name:'list_jobs',args:{},db:ownedDb as never});
  expect(result.ok).toBe(true);
  if(result.ok) expect(result.content[0].text).toContain('status');
});
it('denies calls outside the allowlist, after revocation, and on foreign conversations',async()=>{
  const ticket=mint();
  expect((await executeNativeBusinessToolCall({record:ticket,name:'add_job',args:{},db:ownedDb as never}))).toMatchObject({ok:false});
  const forged=mintNativeBusinessTicket({userId:'other-user',conversationId:CONV,requestId:REQ,allowedTools:['list_jobs']});
  expect((await executeNativeBusinessToolCall({record:forged,name:'list_jobs',args:{},db:ownedDb as never}))).toMatchObject({ok:false});
  const stale=mintNativeBusinessTicket({userId,conversationId:CONV,requestId:'stale-request',allowedTools:['list_jobs']});
  expect((await executeNativeBusinessToolCall({record:stale,name:'list_jobs',args:{},db:ownedDb as never}))).toMatchObject({ok:false});
  const deniedDb={chatConversation:{findFirst:async()=>null}};
  expect((await executeNativeBusinessToolCall({record:mint(),name:'list_jobs',args:{},db:deniedDb as never}))).toMatchObject({ok:false});
});
it('tools/list projection only surfaces allowlisted read tools',()=>{
  const ticket=mint();
  for(const name of ticket.allowedTools){
    const def=findNativeBusinessTool(ticket,name);
    expect(def).not.toBeNull();
    expect(def!.description.length).toBeGreaterThan(0);
  }
  expect(findNativeBusinessTool(ticket,'add_job')).toBeNull();
  expect(findNativeBusinessTool(ticket,'exec')).toBeNull();
});
it('normalizes bridge tool events and rejects foreign servers/tools',()=>{
  const expected={conversationId:'conv-1',nativeSessionId:'thread-1',allowedTools:['list_jobs','get_job']};
  const call=normalizeNativeToolEvent({type:'native-event',version:1,kind:'tool_call',nativeSessionId:'thread-1',nativeTurnId:'turn-1',itemId:'call_1',occurredAt:'2026-11-25T05:00:00Z',payload:{tool:'list_jobs',status:'running'}},expected);
  expect(call).toMatchObject({kind:'tool_call',conversationId:'conv-1',itemId:'call_1',payload:{tool:'list_jobs',status:'running'}});
  const result=normalizeNativeToolEvent({type:'native-event',version:1,kind:'tool_result',nativeSessionId:'thread-1',nativeTurnId:'turn-1',itemId:'call_1',occurredAt:'x'.repeat(10),payload:{tool:'list_jobs',status:'completed',resultSummary:'{"jobs":[]}'}},expected);
  expect(result).toMatchObject({kind:'tool_result',payload:{tool:'list_jobs',status:'completed',resultSummary:'{"jobs":[]}'}});
  expect(normalizeNativeToolEvent({...call!,payload:{tool:'list_mcp_resources',status:'running'}},expected)).toBeNull();
  expect(normalizeNativeToolEvent({...call!,kind:'search'},expected)).toBeNull();
  expect(normalizeNativeToolEvent({...call!,nativeSessionId:'other'},expected)).toBeNull();
  expect(normalizeNativeToolEvent({...call!,payload:{tool:'add_job',status:'running'}},expected)).toBeNull();
  expect(normalizeNativeToolEvent({...call!,payload:{tool:'list_jobs',status:'unknown'}},expected)).toBeNull();
});
it('token env var stays fixed for the desktop spawn contract',()=>{
  expect(NATIVE_BUSINESS_MCP_TOKEN_ENV).toBe('VOCATRYA_NATIVE_BUSINESS_MCP_TOKEN');
});

describe('internal MCP route',()=>{
  const URL='http://127.0.0.1/api/internal/native-business-mcp';
  const rpc=(token:string|null,body:unknown)=>new Request(URL,{method:'POST',headers:{
    'content-type':'application/json',
    accept:'application/json, text/event-stream',
    ...(token?{authorization:`Bearer ${token}`}:{}),
  },body:JSON.stringify(body)});
  it('rejects missing and unknown bearer tickets before any MCP handling',async()=>{
    const {POST}=await import('@/app/api/internal/native-business-mcp/route');
    const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'t',version:'0'}}};
    expect((await POST(rpc(null,init))).status).toBe(401);
    expect((await POST(rpc('nbt_forged',init))).status).toBe(401);
    const revoked=mint();
    revokeNativeBusinessTicket(revoked.token);
    expect((await POST(rpc(revoked.token,init))).status).toBe(401);
  });
  it('rejects GET and projects only allowlisted read tools on tools/list',async()=>{
    const {GET,POST}=await import('@/app/api/internal/native-business-mcp/route');
    expect((await GET()).status).toBe(405);
    const ticket=mint(['list_jobs','get_job']);
    const init=rpc(ticket.token,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'t',version:'0'}}});
    const initRes=await POST(init);
    expect(initRes.status).toBe(200);
    const listRes=await POST(rpc(ticket.token,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}}));
    const list=await listRes.json();
    expect(list.result.tools.map((t:{name:string})=>t.name).sort()).toEqual(['get_job','list_jobs']);
  });
});
