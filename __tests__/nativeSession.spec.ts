// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { seedAccount } from './helpers/backupTestDb';
import { beginNativeTurn, saveNativeBinding, restartNativeContext, nativeReadiness, resolveNativeChatEntry, normalizeNativeSearchEvent } from '@/lib/agent/nativeSession.server';
import { AGENT_NATIVE_SEARCH_PART_TYPE } from '@/models/agent.model';
import type { ConversationRequest } from '@/lib/agent/conversationRequest';
import db from '@/lib/db';
import { buildBackupZip } from '@/lib/backup/export';
import { importBackup } from '@/lib/backup/import';
const ctx=await vi.hoisted(async()=>{const h=await import('./helpers/backupTestDb');const d=h.makeTestDbUrl();h.pushSchema(d.url);return {...d,runtimeVersion:'0.169.0'};});
vi.mock('@/lib/db',async()=>{const {PrismaClient}=await import('@prisma/client');return {default:new PrismaClient({datasources:{db:{url:ctx.url}}})};});
vi.mock('@/lib/ai/streaming-execution',()=>({fetchAccountRuntimeState:vi.fn(async()=>({runtimeReady:true,runtimeVersion:ctx.runtimeVersion,nativeSession:{ready:true,version:'0.169.0',models:['gpt-6.1-sol'],configHash:'config'}}))}));
vi.mock('@/lib/scheduler',()=>({syncSchedulerState:vi.fn()}));
let userId:string,connectionId:string;
beforeAll(async()=>{userId=await seedAccount(db,'native-test@vocatrya.test');connectionId=(await db.aIConnection.create({data:{userId,provider:'OPENAI',backendKind:'CODEX_RUNTIME',displayName:'fixture',runtimeProfileRef:'rp_fixture'}})).id;});
afterAll(async()=>{await db.$disconnect();});
async function conversation(native=true){return db.chatConversation.create({data:{userId,messages:'[]',context:'{"version":1,"items":[],"permissionMode":"ask"}',resolvedConnectionId:connectionId,resolvedModel:'gpt-6.1-sol',...(native?{executionPath:'NATIVE_CODEX_V1'}:{}),activeRequestId:randomUUID(),activeRequestExpiresAt:new Date(Date.now()+60000)}});}
function request(row:Awaited<ReturnType<typeof conversation>>):ConversationRequest{return {userId,conversationId:row.id,requestId:row.activeRequestId!,revision:row.revision,messages:[],responseMessageId:'answer',released:false,wrote:false};}
const session={type:'native-session' as const,threadId:'thread-saved',resumed:false,runtimeVersion:'0.169.0',runtimeProfileRef:'rp_fixture',configHash:'config'};
it('historical default stays application-orchestrated and cannot enter native dispatch',async()=>{const row=await conversation(false);expect(row.executionPath).toBe('APP_ORCHESTRATED');await expect(beginNativeTurn(request(row))).rejects.toMatchObject({code:'NATIVE_CONTEXT_LOST'});});
it('first attempt is durable; a lost binding is never treated as first creation',async()=>{const row=await conversation();const req=request(row);expect(await beginNativeTurn(req)).toBeNull();expect((await db.chatConversation.findUniqueOrThrow({where:{id:row.id}})).nativeInitializationState).toBe('IN_FLIGHT');await expect(beginNativeTurn(req)).rejects.toMatchObject({code:'NATIVE_CONTEXT_LOST'});});
it('a saved binding survives a new DB client and preserves exact identity',async()=>{const row=await conversation();const req=request(row);await beginNativeTurn(req);await saveNativeBinding(req,session,{connectionId,model:'gpt-6.1-sol',promptHash:'prompt'});const {PrismaClient}=await import('@prisma/client');const reopened=new PrismaClient({datasources:{db:{url:ctx.url}}});try{await reopened.chatConversation.update({where:{id:row.id},data:{nativeInitializationState:'READY'}});expect((await beginNativeTurn(req,reopened))?.threadId).toBe('thread-saved');}finally{await reopened.$disconnect();}});
it('late callbacks cannot write after lease loss',async()=>{const row=await conversation();const req=request(row);await beginNativeTurn(req);await db.chatConversation.update({where:{id:row.id},data:{activeRequestId:'replacement'}});await expect(saveNativeBinding(req,session,{connectionId,model:'gpt-6.1-sol',promptHash:'p'})).rejects.toMatchObject({code:'NATIVE_CONTEXT_LOST'});expect(await db.nativeConversationBinding.findUnique({where:{conversationId:row.id}})).toBeNull();});
it('wrong user and archived conversations cannot create bindings',async()=>{const row=await conversation();await expect(beginNativeTurn({...request(row),userId:'other'})).rejects.toThrow();await db.chatConversation.update({where:{id:row.id},data:{archivedAt:new Date()}});await expect(beginNativeTurn(request(row))).rejects.toThrow();});
it('explicit restart requires idle ownership and preserves lock/permission/history',async()=>{const row=await conversation();const req=request(row);await beginNativeTurn(req);await saveNativeBinding(req,session,{connectionId,model:'gpt-6.1-sol',promptHash:'p'});await expect(restartNativeContext(userId,row.id)).rejects.toThrow();await db.chatConversation.update({where:{id:row.id},data:{activeRequestId:null,activeRequestExpiresAt:null}});await restartNativeContext(userId,row.id);const after=await db.chatConversation.findUniqueOrThrow({where:{id:row.id}});expect(after.nativeInitializationState).toBe('NEVER_ATTEMPTED');expect(after.context).toBe(row.context);expect(after.resolvedConnectionId).toBe(connectionId);expect(after.messages).toBe(row.messages);expect(await db.nativeConversationBinding.findUnique({where:{conversationId:row.id}})).toBeNull();});
it('runtime drift and connection ownership are gated before a native request',async()=>{await expect(nativeReadiness(userId,connectionId,'gpt-6.1-sol')).resolves.toMatchObject({runtimeVersion:'0.169.0'});ctx.runtimeVersion='changed';await expect(nativeReadiness(userId,connectionId,'gpt-6.1-sol')).rejects.toMatchObject({code:'NATIVE_SESSION_UNAVAILABLE'});ctx.runtimeVersion='0.169.0';await expect(nativeReadiness('other',connectionId,'gpt-6.1-sol')).rejects.toThrow();});
it('backup round-trip preserves messages but clears native execution and binding',async()=>{const row=await conversation();const req=request(row);await beginNativeTurn(req);await saveNativeBinding(req,session,{connectionId,model:'gpt-6.1-sol',promptHash:'p'});await db.chatConversation.updateMany({where:{userId},data:{activeRequestId:null,activeRequestExpiresAt:null}});const {buffer}=await buildBackupZip(userId,'native-test@vocatrya.test');await importBackup(buffer,userId,'native-test@vocatrya.test',true);expect(await db.nativeConversationBinding.count({where:{userId}})).toBe(0);const restored=await db.chatConversation.findMany({where:{userId}});expect(restored.length).toBeGreaterThan(0);expect(restored.every(x=>x.executionPath==='APP_ORCHESTRATED'&&x.nativeInitializationState==='NEVER_ATTEMPTED')).toBe(true);});

it('backup export excludes the native binding and does not carry executionPath (designed contract)',async()=>{const row=await conversation();const req=request(row);await beginNativeTurn(req);await saveNativeBinding(req,session,{connectionId,model:'gpt-6.1-sol',promptHash:'p'});await db.chatConversation.updateMany({where:{userId},data:{activeRequestId:null,activeRequestExpiresAt:null}});expect(await db.nativeConversationBinding.count({where:{conversationId:row.id}})).toBe(1);const {collectBackupData}=await import('@/lib/backup/export');const data=await collectBackupData(userId) as unknown as Record<string,unknown>;expect(Object.keys(data)).not.toContain('NativeConversationBinding');const exported=(data.ChatConversation as Record<string,unknown>[]).find(x=>x.id===row.id);expect(exported).toBeDefined();expect(exported).not.toHaveProperty('executionPath');expect(exported).not.toHaveProperty('nativeInitializationState');const {buffer}=await buildBackupZip(userId,'native-test@vocatrya.test');const JSZip=(await import('jszip')).default;const json=await (await JSZip.loadAsync(buffer)).file('data.json')!.async('string');expect(json).not.toContain('thread-saved');expect(json).not.toContain('NATIVE_CODEX_V1');});
it('uncertain turns with saved native history require explicit restart',async()=>{const row=await conversation();const req=request(row);await beginNativeTurn(req);await saveNativeBinding(req,session,{connectionId,model:'gpt-6.1-sol',promptHash:'p'});await expect(beginNativeTurn(req)).rejects.toMatchObject({code:'NATIVE_CONTEXT_LOST'});});

// The native entry resolves its own Codex pair instead of the generic chat
// lock: a non-Codex default must not make the entry CONNECTION_INELIGIBLE.
// The backup round-trip above wipes connection rows (credentials are never
// exported), so each case re-creates its own Codex connection.
async function entryConnection(){return (await db.aIConnection.create({data:{userId,provider:'OPENAI',backendKind:'CODEX_RUNTIME',displayName:'entry-fixture',runtimeProfileRef:'rp_entry'}})).id;}
it('native entry resolves the connected Codex pair with an allowlisted model',async()=>{
  const conn=await entryConnection();
  const entry=await resolveNativeChatEntry(userId);
  expect(entry).toMatchObject({ok:true,connectionId:conn,model:'gpt-6.1-sol'});
});
it('native entry prefers the draft pick when it is an allowlisted model',async()=>{
  const conn=await entryConnection();
  const mocked=await import('@/lib/ai/streaming-execution');
  vi.mocked(mocked.fetchAccountRuntimeState).mockResolvedValueOnce({runtimeReady:true,runtimeVersion:'0.169.0',nativeSession:{ready:true,version:'0.169.0',models:['gpt-5.4','gpt-6.1-sol'],configHash:'config'}} as any);
  await expect(resolveNativeChatEntry(userId,{connectionId:conn,model:'gpt-5.4'})).resolves.toMatchObject({ok:true,connectionId:conn,model:'gpt-5.4'});
  vi.mocked(mocked.fetchAccountRuntimeState).mockResolvedValueOnce({runtimeReady:true,runtimeVersion:'0.169.0',nativeSession:{ready:true,version:'0.169.0',models:['gpt-5.4','gpt-6.1-sol'],configHash:'config'}} as any);
  await expect(resolveNativeChatEntry(userId,{connectionId:'other',model:'not-allowlisted'})).resolves.toMatchObject({ok:true,connectionId:conn,model:'gpt-5.4'});
});
it('native entry reports the exact blocker instead of failing on click',async()=>{
  await expect(resolveNativeChatEntry('other')).resolves.toMatchObject({ok:false,details:{reason:'CONNECTION_INELIGIBLE'}});
  await entryConnection();
  ctx.runtimeVersion='0.164.0';
  await expect(resolveNativeChatEntry(userId)).resolves.toMatchObject({ok:false,details:{reason:'RUNTIME_VERSION_MISMATCH',runtimeVersion:'0.164.0',requiredVersion:'0.169.0'}});
  ctx.runtimeVersion='0.169.0';
});
it('readiness accepts any desktop-supported version >= baseline, binds to the installed one, and fails closed otherwise',async()=>{
  const conn=await entryConnection();
  const mocked=await import('@/lib/ai/streaming-execution');
  const state=(runtimeVersion:string,verifiedVersions?:string[],ready=true)=>({runtimeReady:true,runtimeVersion,nativeSession:{ready,version:'0.170.0',minVersion:'0.165.0',...(verifiedVersions?{verifiedVersions}:{}),models:['gpt-6.1-sol'],configHash:'config'}}) as any;
  vi.mocked(mocked.fetchAccountRuntimeState).mockResolvedValueOnce(state('0.169.0',['0.169.0','0.170.0']));
  await expect(nativeReadiness(userId,conn,'gpt-6.1-sol')).resolves.toMatchObject({runtimeVersion:'0.169.0'});
  // Newer or baseline-compatible builds (0.165.0 / 0.171.0) are accepted when desktop reports ready.
  vi.mocked(mocked.fetchAccountRuntimeState).mockResolvedValueOnce(state('0.171.0',['0.169.0','0.170.0']));
  await expect(nativeReadiness(userId,conn,'gpt-6.1-sol')).resolves.toMatchObject({runtimeVersion:'0.171.0'});
  vi.mocked(mocked.fetchAccountRuntimeState).mockResolvedValueOnce(state('0.165.0',['0.169.0','0.170.0']));
  await expect(nativeReadiness(userId,conn,'gpt-6.1-sol')).resolves.toMatchObject({runtimeVersion:'0.165.0'});
  // Below minimum baseline or desktop ready=false still fails closed.
  vi.mocked(mocked.fetchAccountRuntimeState).mockResolvedValueOnce(state('0.164.9',['0.169.0','0.170.0']));
  await expect(nativeReadiness(userId,conn,'gpt-6.1-sol')).rejects.toMatchObject({details:{reason:'RUNTIME_VERSION_MISMATCH',runtimeVersion:'0.164.9',requiredVersion:'0.170.0'}});
  vi.mocked(mocked.fetchAccountRuntimeState).mockResolvedValueOnce(state('0.171.0',['0.169.0','0.170.0'],false));
  await expect(nativeReadiness(userId,conn,'gpt-6.1-sol')).rejects.toMatchObject({details:{reason:'RUNTIME_VERSION_MISMATCH'}});
  // Streaming/exec may run a different binary: readiness follows the native binary's version.
  vi.mocked(mocked.fetchAccountRuntimeState).mockResolvedValueOnce({...state('0.164.0',['0.169.0','0.170.0']),nativeSession:{...state('0.164.0',['0.169.0','0.170.0']).nativeSession,runtimeVersion:'0.171.0'}});
  await expect(nativeReadiness(userId,conn,'gpt-6.1-sol')).resolves.toMatchObject({runtimeVersion:'0.171.0'});
});

it('normalizes neutral search events and rejects mismatched thread or unsafe sources',()=>{
  const ok=normalizeNativeSearchEvent({
    type:'native-event',version:1,kind:'search',nativeSessionId:'thread-1',nativeTurnId:'turn-1',itemId:'ws-1',occurredAt:'2026-11-25T05:00:00Z',
    payload:{status:'completed',actionType:'search',query:'vocatrya jobs',queries:['vocatrya jobs'],sources:[{url:'https://example.com/a',title:'Role A'},{url:'javascript:alert(1)',title:'Bad'},{url:'https://u:p@example.com/b'}],rawBlob:'drop-me'},
  },{conversationId:'conv-1',nativeSessionId:'thread-1'});
  expect(ok).toMatchObject({
    type:'native-event',version:1,kind:'search',conversationId:'conv-1',nativeSessionId:'thread-1',itemId:'ws-1',
    payload:{status:'completed',actionType:'search',query:'vocatrya jobs',queries:['vocatrya jobs'],sources:[{url:'https://example.com/a',host:'example.com',title:'Role A'}]},
  });
  expect((ok!.payload as Record<string,unknown>).rawBlob).toBeUndefined();
  expect(normalizeNativeSearchEvent({...ok,nativeSessionId:'other-thread'},{conversationId:'conv-1',nativeSessionId:'thread-1'})).toBeNull();
  expect(normalizeNativeSearchEvent({...ok,kind:'tool_call'},{conversationId:'conv-1',nativeSessionId:'thread-1'})).toBeNull();
});

it('backup round-trip preserves persisted native search sources while excluding native thread bindings',async()=>{
  const messages=[
    {id:'u1',role:'user',parts:[{type:'text',text:'查一下招聘动态'}]},
    {id:'a1',role:'assistant',parts:[
      {type:AGENT_NATIVE_SEARCH_PART_TYPE,id:'native-search-ws1',data:{version:1,kind:'search',itemId:'ws1',status:'completed',actionType:'search',query:'招聘动态',queries:['招聘动态'],sources:[{url:'https://example.com/news',host:'example.com',title:'News'}]}},
      {type:'text',text:'已为你检索最新动态。'},
    ]},
  ];
  const row=await db.chatConversation.create({
    data:{userId,messages:JSON.stringify(messages),context:'{"version":1,"items":[],"permissionMode":"rules"}',resolvedConnectionId:connectionId,resolvedModel:'gpt-6.1-sol',executionPath:'NATIVE_CODEX_V1'},
  });
  await saveNativeBinding({...request(row),activeRequestId:undefined} as any,{...session,threadId:'thread-secret-search'},{connectionId,model:'gpt-6.1-sol',promptHash:'p'}).catch(()=>undefined);
  await db.nativeConversationBinding.create({data:{conversationId:row.id,userId,connectionId,model:'gpt-6.1-sol',threadId:'thread-secret-search',runtimeVersion:'0.169.0',runtimeProfileRef:'rp_fixture',configHash:'config',promptHash:'p'}});
  const {buffer}=await buildBackupZip(userId,'native-test@vocatrya.test');
  await importBackup(buffer,userId,'native-test@vocatrya.test',true);
  const restored=await db.chatConversation.findMany({where:{userId}});
  const matched=restored.find(r=>r.messages.includes('https://example.com/news'));
  expect(matched).toBeDefined();
  expect(matched!.executionPath).toBe('APP_ORCHESTRATED');
  expect(JSON.parse(matched!.messages)[1].parts[0]).toMatchObject({
    type:AGENT_NATIVE_SEARCH_PART_TYPE,
    data:{status:'completed',query:'招聘动态',sources:[{url:'https://example.com/news',title:'News'}]},
  });
  const JSZip=(await import('jszip')).default;
  const json=await (await JSZip.loadAsync(buffer)).file('data.json')!.async('string');
  expect(json).not.toContain('thread-secret-search');
});
