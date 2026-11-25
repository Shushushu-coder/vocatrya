import {it as test} from 'vitest';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import nativeModule from './native-session.js';
const {createNativeSessionParser,nativeSessionReady,NATIVE_CONFIG,NATIVE_CATALOG,NATIVE_VERIFIED_VERSIONS,NATIVE_VERSION,NATIVE_MCP_SERVER_KEY,NATIVE_MCP_TOKEN_ENV,reportedCodexVersion}=nativeModule;
const HS={id:1,result:{userAgent:'vocatrya-native/0.169.0 (Windows 10.0; x86_64) unknown (vocatrya-native; 1)'}};
const MCP={url:'http://127.0.0.1:43110/mcp',envVar:NATIVE_MCP_TOKEN_ENV,token:'nbt_test',allowedTools:['list_jobs','get_job','get_resume','today_plan_read']};
function safeConfig(mcpServers){return {web_search:'live',project_doc_max_bytes:0,include_environment_context:false,mcp_servers:mcpServers===undefined?{[NATIVE_MCP_SERVER_KEY]:{url:MCP.url,bearer_token_env_var:NATIVE_MCP_TOKEN_ENV,default_tools_approval_mode:'approve',enabled_tools:[...MCP.allowedTools]}}:mcpServers,features:Object.fromEntries(Object.entries(NATIVE_CONFIG).filter(([k])=>k.startsWith('features.')).map(([k,v])=>[k.slice(9),v]))};}
function h(threadId,expectedVersion,nativeMcp=MCP){const writes=[];const stdin=new EventEmitter();stdin.write=s=>writes.push(JSON.parse(s));stdin.end=()=>{};const parser=createNativeSessionParser({model:'gpt-6.1-sol',prompt:'user input',instructions:'career only',threadId,cwd:'C:\\managed\\work',profileDir:'C:\\managed\\profile',expectedVersion,nativeMcp});parser.attach(stdin);return {parser,writes,stdin,push:m=>{const events=parser.push(Buffer.from(JSON.stringify(m)+'\n'));if(m.id===1){events.push(...parser.push(Buffer.from(JSON.stringify({id:5,result:{config:safeConfig(m.__configMcpServers)}})+'\n')));writes.splice(2,1);}return events;}};}
function opened(threadId){const x=h(threadId);x.push(HS);x.push({id:2,result:{thread:{id:threadId||'thread-A'},model:'gpt-6.1-sol'}});return x;}
function active(){const x=opened();x.push({id:3,result:{turn:{id:'turn-A'}}});return x;}
const note=(method,extra={})=>({method,params:{threadId:'thread-A',turnId:'turn-A',...extra}});
function answer(x,text='answer'){x.push(note('item/agentMessage/delta',{itemId:'m',delta:text}));x.push(note('item/completed',{item:{id:'m',type:'agentMessage',text}}));x.push(note('turn/completed',{turn:{id:'turn-A',status:'completed'}}));}
test('new native thread is persistent and only current user text enters turn',()=>{const x=opened();assert.equal(x.writes[2].method,'thread/start');assert.equal(x.writes[2].params.ephemeral,false);assert.equal(x.writes[2].params.developerInstructions,'career only');assert.deepEqual(x.writes[3].params.input,[{type:'text',text:'user input'}]);});
test('saved id resumes, never starts a replacement thread',()=>{const x=opened('saved-id');assert.equal(x.writes[2].method,'thread/resume');assert.equal(x.writes[2].params.threadId,'saved-id');assert.equal(x.writes.filter(w=>w.method==='thread/start').length,0);});
test('resume failure sends no turn or replacement request',()=>{const x=h('saved');x.push(HS);x.push({id:2,error:{code:-32600}});assert.equal(x.parser.result().code,'NATIVE_RESUME_FAILED');assert.equal(x.writes.length,3);});
test('runtime cannot substitute thread identity',()=>{const x=h('saved');x.push(HS);x.push({id:2,result:{thread:{id:'other'}}});assert.equal(x.parser.result().ok,false);assert.equal(x.writes.some(w=>w.method==='turn/start'),false);});
test('runtime cannot substitute model',()=>{const x=h();x.push(HS);x.push({id:2,result:{thread:{id:'thread-A'},model:'other'}});assert.equal(x.parser.result().ok,false);});
test('canonical streamed text completes',()=>{const x=active();answer(x);assert.deepEqual(x.parser.result(),{ok:true,text:'answer',threadId:'thread-A'});});
test('different thread notifications fail without delivering text',()=>{const x=active();const e=x.push(note('item/agentMessage/delta',{threadId:'other',itemId:'m',delta:'leak'}));assert.equal(e.some(v=>v.type==='text-delta'),false);assert.equal(x.parser.result().ok,false);});
test('different turn notifications fail without delivering text',()=>{const x=active();x.push(note('item/agentMessage/delta',{turnId:'other',itemId:'m',delta:'leak'}));assert.equal(x.parser.result().ok,false);});
test('turn started may arrive before response',()=>{const x=opened();x.push(note('turn/started',{turn:{id:'turn-A',status:'inProgress'}}));x.push({id:3,result:{turn:{id:'turn-A'}}});answer(x);assert.equal(x.parser.result().ok,true);});
test('duplicate handshake response cannot resubmit user input',()=>{const x=active();const n=x.writes.length;x.push({id:2,result:{thread:{id:'thread-A'}}});assert.equal(x.writes.length,n);assert.equal(x.parser.result().ok,false);});
test('foreign callback requests are denied',()=>{const x=active();x.push({id:100,method:'item/tool/call',params:{}});assert.equal(x.parser.result().code,'NATIVE_UNEXPECTED_TOOL');assert.equal(x.writes.at(-1).error.code,-32601);});
test('unexpected command item fails closed',()=>{const x=active();x.push(note('item/started',{item:{id:'cmd',type:'commandExecution'}}));assert.equal(x.parser.result().code,'NATIVE_UNEXPECTED_TOOL');});
test('asynchronous stdin errors are observed',()=>{const x=h();x.stdin.emit('error',new Error('EPIPE'));assert.equal(x.parser.result().ok,false);});
test('cancel interrupts owned turn and ignores late text',()=>{const x=active();x.parser.interrupt();assert.equal(x.writes.at(-1).method,'turn/interrupt');assert.equal(x.push(note('item/agentMessage/delta',{itemId:'m',delta:'late'})).length,0);x.push(note('turn/completed',{turn:{id:'turn-A',status:'interrupted'}}));assert.equal(x.parser.result().code,'NATIVE_CANCELLED');});
test('text reconciliation does not accept truncated deltas',()=>{const x=active();x.push(note('item/agentMessage/delta',{itemId:'m',delta:'a'}));x.push(note('item/completed',{item:{id:'m',type:'agentMessage',text:'ab'}}));x.push(note('turn/completed',{turn:{id:'turn-A',status:'completed'}}));assert.equal(x.parser.result().ok,false);});
test('outside instruction files block dispatch',()=>{const x=h();x.push(HS);x.push({id:2,result:{thread:{id:'thread-A'},instructionSources:[{path:'C:\\Users\\someone\\AGENTS.md'}]}});assert.equal(x.parser.result().code,'NATIVE_BOUNDARY_NOT_READY');assert.equal(x.writes.some(w=>w.method==='turn/start'),false);});
test('malformed protocol and oversized lines fail closed',()=>{const x=h();x.parser.push(Buffer.from('{bad}\n'));assert.equal(x.parser.result().ok,false);const y=h();y.parser.push(Buffer.alloc(600000,65));assert.equal(y.parser.result().ok,false);});
test('permission config and frozen catalog expose live web_search only and keep other tools off',()=>{assert.equal(NATIVE_CONFIG.web_search,'live');assert.equal(NATIVE_CONFIG['features.shell_tool'],false);assert(NATIVE_CATALOG.models.every(m=>m.supports_search_tool===true&&m.shell_type==='disabled'&&m.apply_patch_tool_type===null&&m.experimental_supported_tools.length===0));assert.equal(nativeSessionReady('0.169.0','gpt-6.1-sol'),true);assert.equal(nativeSessionReady('0.165.0','gpt-6.1-sol'),true);assert.equal(nativeSessionReady('0.171.0','gpt-6.1-sol'),true);assert.equal(nativeSessionReady('0.164.9','gpt-6.1-sol'),false);assert.equal(nativeSessionReady('0.169.0','unverified'),false);});

test('webSearch items emit normalized neutral search events and filter unsafe URLs',()=>{
  const x=active();
  const started=x.push(note('item/started',{item:{id:'ws-1',type:'webSearch',query:'engineer roles',action:{type:'search',query:'engineer roles',queries:null},results:null}}));
  assert.equal(started.length,1);
  assert.deepEqual(started[0],{type:'native-event',version:1,kind:'search',nativeSessionId:'thread-A',nativeTurnId:'turn-A',itemId:'ws-1',occurredAt:started[0].occurredAt,payload:{status:'started',actionType:'search',query:'engineer roles',queries:['engineer roles'],sources:[]}});
  const completed=x.push(note('item/completed',{item:{id:'ws-1',type:'webSearch',query:'engineer roles',action:{type:'search',query:'engineer roles',queries:['engineer roles','engineer jobs'],sources:[{url:'https://example.com/jobs',title:'Example Jobs'},{url:'javascript:alert(1)',title:'XSS'},{url:'https://user:pass@evil.test/secret'}]},results:[{url:'https://example.com/jobs',title:'Example Jobs'},{url:'file:///C:/secrets.db',title:'Local'}]}}));
  assert.equal(completed.length,1);
  assert.equal(completed[0].payload.status,'completed');
  assert.deepEqual(completed[0].payload.queries,['engineer roles','engineer jobs']);
  assert.deepEqual(completed[0].payload.sources,[{url:'https://example.com/jobs',host:'example.com',title:'Example Jobs'}]);
  const open=x.push(note('item/completed',{item:{id:'ws-2',type:'webSearch',query:'https://docs.example.org/guide',action:{type:'openPage',url:'https://docs.example.org/guide'},results:null}}));
  assert.equal(open[0].payload.actionType,'open_page');
  assert.deepEqual(open[0].payload.sources,[{url:'https://docs.example.org/guide',host:'docs.example.org'}]);
  const find=x.push(note('item/completed',{item:{id:'ws-3',type:'webSearch',query:"'salary' in https://docs.example.org/guide",action:{type:'findInPage',url:'https://docs.example.org/guide',pattern:'salary'},results:null}}));
  assert.equal(find[0].payload.actionType,'find_in_page');
  assert.equal(find[0].payload.pattern,'salary');
  answer(x);
  assert.deepEqual(x.parser.result(),{ok:true,text:'answer',threadId:'thread-A'});
});

test('prose claiming search occurred without webSearch item emits no search event',()=>{
  const x=active();
  const events=x.push(note('item/agentMessage/delta',{itemId:'m',delta:'我已经搜索了 https://example.com'}));
  assert.equal(events.some(e=>e.type==='native-event'),false);
  x.push(note('item/completed',{item:{id:'m',type:'agentMessage',text:'我已经搜索了 https://example.com'}}));
  x.push(note('turn/completed',{turn:{id:'turn-A',status:'completed'}}));
  assert.equal(x.parser.result().ok,true);
});

test('unapproved tool items and disabled web_search config fail closed',()=>{
  for (const type of ['fileChange','mcpToolCall','dynamicToolCall','imageView']) {
    const x=active();
    x.push(note('item/started',{item:{id:'bad-1',type}}));
    assert.equal(x.parser.result().code,'NATIVE_UNEXPECTED_TOOL');
  }
  const y=h();
  y.parser.push(Buffer.from(JSON.stringify(HS)+'\n'));
  y.push({id:5,result:{config:{...safeConfig(),web_search:'disabled'}}});
  assert.equal(y.parser.result().code,'NATIVE_BOUNDARY_NOT_READY');
  assert.equal(y.writes.some(w=>w.method==='thread/start'),false);
});

test('resumed thread preserves thread identity across turns with webSearch',()=>{
  const x=opened('saved-thread');
  x.push({id:3,result:{turn:{id:'turn-2'}}});
  const ev=x.push(note('item/completed',{threadId:'saved-thread',turnId:'turn-2',item:{id:'ws-r',type:'webSearch',query:'resume test',action:{type:'openPage',url:'https://example.org/'},results:null}}));
  assert.equal(ev[0].nativeSessionId,'saved-thread');
  x.push(note('item/agentMessage/delta',{threadId:'saved-thread',turnId:'turn-2',itemId:'m2',delta:'resumed'}));
  x.push(note('item/completed',{threadId:'saved-thread',turnId:'turn-2',item:{id:'m2',type:'agentMessage',text:'resumed'}}));
  x.push(note('turn/completed',{threadId:'saved-thread',turnId:'turn-2',turn:{id:'turn-2',status:'completed'}}));
  assert.deepEqual(x.parser.result(),{ok:true,text:'resumed',threadId:'saved-thread'});
});

test('late webSearch items after interrupt are ignored',()=>{
  const x=active();
  x.parser.interrupt();
  assert.equal(x.push(note('item/started',{item:{id:'ws-late',type:'webSearch',query:'late',action:{type:'search',query:'late',queries:null},results:null}})).length,0);
  x.push(note('turn/completed',{turn:{id:'turn-A',status:'interrupted'}}));
  assert.equal(x.parser.result().code,'NATIVE_CANCELLED');
});

test('inherited MCP config fails before opening thread',()=>{const x=h();x.parser.push(Buffer.from(JSON.stringify(HS)+'\n'));const config={...safeConfig(),mcp_servers:{external:{command:'unexpected'}}};x.push({id:5,result:{config}});assert.equal(x.parser.result().code,'NATIVE_BOUNDARY_NOT_READY');assert.equal(x.writes.some(w=>w.method==='thread/start'),false);});
test('minimum baseline version gates readiness; the newest verified entry remains the install target',()=>{assert.equal(NATIVE_VERSION,NATIVE_VERIFIED_VERSIONS.at(-1));assert(NATIVE_VERIFIED_VERSIONS.length>0&&new Set(NATIVE_VERIFIED_VERSIONS).size===NATIVE_VERIFIED_VERSIONS.length);for(const v of [...NATIVE_VERIFIED_VERSIONS,'0.165.0','0.171.0','1.0.0'])assert.equal(nativeSessionReady(v,'gpt-6.1-sol'),true);for(const v of ['0.0.1','0.164.9','0.169.00','',null,undefined,'0.169.0-beta'])assert.equal(nativeSessionReady(v,'gpt-6.1-sol'),false);});
test('handshake self-check reads the version the binary reports',()=>{assert.equal(reportedCodexVersion('vocatrya-native/0.169.0 (Windows)'),'0.169.0');assert.equal(reportedCodexVersion('other/0.169.0'),null);assert.equal(reportedCodexVersion(undefined),null);});
test('below-baseline, missing or mismatched handshake version refuses before config or thread work',()=>{for(const [result,expected] of [[{userAgent:'vocatrya-native/0.164.0 (x)'},undefined],[{},undefined],[{userAgent:'garbage'},undefined],[HS.result,'0.169.1']]){const x=h(undefined,expected);x.parser.push(Buffer.from(JSON.stringify({id:1,result})+'\n'));assert.equal(x.parser.result().code,'NATIVE_BOUNDARY_NOT_READY');assert.equal(x.writes.some(w=>w.method==='config/read'||w.method==='thread/start'),false);}const ok=h(undefined,'0.169.0');ok.parser.push(Buffer.from(JSON.stringify(HS)+'\n'));assert.equal(ok.writes.some(w=>w.method==='config/read'),true);const newer=h(undefined,'0.171.0');newer.parser.push(Buffer.from(JSON.stringify({id:1,result:{userAgent:'vocatrya-native/0.171.0 (Windows)'}})+'\n'));assert.equal(newer.writes.some(w=>w.method==='config/read'),true);});

test('allowlisted vocatrya_business mcpToolCall normalizes to tool events',()=>{
  const x=active();
  const started=x.push(note('item/started',{item:{id:'call_1',type:'mcpToolCall',server:'vocatrya_business',tool:'list_jobs',status:'inProgress',arguments:{},result:null,error:null,durationMs:null}}));
  assert.equal(started.length,1);
  assert.equal(started[0].kind,'tool_call');
  assert.equal(started[0].nativeSessionId,'thread-A');
  assert.equal(started[0].nativeTurnId,'turn-A');
  assert.equal(started[0].itemId,'call_1');
  assert.equal(started[0].payload.tool,'list_jobs');
  assert.equal(started[0].payload.status,'running');
  const completed=x.push(note('item/completed',{item:{id:'call_1',type:'mcpToolCall',server:'vocatrya_business',tool:'list_jobs',status:'completed',arguments:{},result:{content:[{type:'text',text:'{"status":"ok","jobs":[]}'}],structuredContent:null,_meta:null},error:null,durationMs:42}}));
  assert.equal(completed.length,1);
  assert.equal(completed[0].kind,'tool_result');
  assert.equal(completed[0].payload.status,'completed');
  assert.equal(completed[0].payload.resultSummary,'{"status":"ok","jobs":[]}');
  answer(x);
  assert.equal(x.parser.result().ok,true);
});

test('failed vocatrya_business mcpToolCall surfaces failed status and bounded error text',()=>{
  const x=active();
  x.push(note('item/started',{item:{id:'call_2',type:'mcpToolCall',server:'vocatrya_business',tool:'get_job',status:'inProgress',arguments:{jobId:'j1'},result:null,error:null,durationMs:null}}));
  const failed=x.push(note('item/completed',{item:{id:'call_2',type:'mcpToolCall',server:'vocatrya_business',tool:'get_job',status:'failed',arguments:{jobId:'j1'},result:{content:[{type:'text',text:'tool not allowed for this turn'}]},error:null,durationMs:7}}));
  assert.equal(failed[0].kind,'tool_result');
  assert.equal(failed[0].payload.status,'failed');
  assert.equal(failed[0].payload.resultSummary,'tool not allowed for this turn');
  assert.equal(failed[0].payload.argumentsSummary,'{"jobId":"j1"}');
  assert.equal(x.parser.result().ok,false);
});

test('non-bridge server or non-allowlisted tool mcpToolCall fails closed',()=>{
  const x=active();
  x.push(note('item/started',{item:{id:'call_3',type:'mcpToolCall',server:'codex',tool:'list_mcp_resources',status:'inProgress',arguments:{}}}));
  assert.equal(x.parser.result().code,'NATIVE_UNEXPECTED_TOOL');
  const y=active();
  y.push(note('item/started',{item:{id:'call_4',type:'mcpToolCall',server:'vocatrya_business',tool:'add_job',status:'inProgress',arguments:{}}}));
  assert.equal(y.parser.result().code,'NATIVE_UNEXPECTED_TOOL');
  const z=active();
  z.push(note('item/started',{item:{id:'call_5',type:'mcpToolCall',server:'other_server',tool:'list_jobs',status:'inProgress',arguments:{}}}));
  assert.equal(z.parser.result().code,'NATIVE_UNEXPECTED_TOOL');
});

test('tampered or extra mcp_servers keys fail the config self-check',()=>{
  const validBridge={url:MCP.url,bearer_token_env_var:NATIVE_MCP_TOKEN_ENV,default_tools_approval_mode:'approve',enabled_tools:[...MCP.allowedTools]};
  for (const servers of [
    {},
    {[NATIVE_MCP_SERVER_KEY]:{...validBridge,url:'http://127.0.0.1:9/other'}},
    {[NATIVE_MCP_SERVER_KEY]:{...validBridge,bearer_token_env_var:'OTHER_VAR'}},
    {[NATIVE_MCP_SERVER_KEY]:{...validBridge,default_tools_approval_mode:'prompt'}},
    {[NATIVE_MCP_SERVER_KEY]:{...validBridge,enabled_tools:['list_jobs','add_job']}},
    {[NATIVE_MCP_SERVER_KEY]:validBridge,inherited:{command:'x'}},
    {other:validBridge},
  ]) {
    const x=h();
    x.parser.push(Buffer.from(JSON.stringify(HS)+'\n'));
    x.push({id:5,result:{config:safeConfig(servers)}});
    assert.equal(x.parser.result().code,'NATIVE_BOUNDARY_NOT_READY');
    assert.equal(x.writes.some(w=>w.method==='thread/start'),false);
  }
});
