const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/background.js'),'utf8');
const reply=(data,status=200)=>({ok:status<400,status,text:async()=>JSON.stringify(data)});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const pairing={pairing:'vocatrya-auto-apply://pair?v=1&app=http%3A%2F%2Flocalhost%3A3737&code=next'};
function harness(fetch){
 let listener;
 const store={vocatryaConnection:{accessToken:'old-token',connectionId:'old',appOrigin:'http://localhost:3737'},profileV2:{updatedAt:'local'}};
 const local={async get(keys){return structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,store[k]])));},async set(data){Object.assign(store,structuredClone(data));},async remove(key){delete store[key];},async clear(){for(const k of Object.keys(store))delete store[k];}};
 const chrome={storage:{local},runtime:{getManifest:()=>({version:'1'}),onInstalled:{addListener(){}},onMessage:{addListener(fn){listener=fn;}}},permissions:{contains:(_,cb)=>cb(true)}};
 vm.runInNewContext(source,{chrome,fetch,URL,AbortSignal});
 return {store,send:(type,payload)=>new Promise(r=>listener({type:'OJAF_'+type,payload},{},r))};
}
for(const first of ['STATUS','SYNC'])for(const next of ['VOCATRYA_DISCONNECT','VOCATRYA_PAIR','CLEAR_SETTINGS'])test(`${first} in flight then ${next}`,async()=>{
 const entered=deferred(),release=deferred();let calls=0;
 const h=harness(async url=>{calls++;if(url.endsWith('/status')||url.endsWith('/profile')){entered.resolve();await release.promise;return reply({profileV2:{updatedAt:'new'}});}if(url.endsWith('/disconnect'))return reply({ok:true,revoked:true});return reply({ok:true,connectionId:'new',accessToken:'new-token'});});
 const a=h.send('VOCATRYA_'+first);await entered.promise;const b=h.send(next,pairing);
 await new Promise(setImmediate);assert.equal(calls,1);release.resolve();assert.equal((await a).ok,true);assert.equal((await b).ok,true);
 assert.equal(h.store.vocatryaConnection?.connectionId,next==='VOCATRYA_PAIR'?'new':undefined);
 if(next==='CLEAR_SETTINGS')assert.deepEqual(h.store,{});
});
test('status preserves completed sync bookkeeping and hides token',async()=>{
 const h=harness(async url=>reply(url.endsWith('/profile')?{profileV2:{updatedAt:'version'}}:{sourceUpdatedAt:'remote'}));
 const [a,b]=await Promise.all([h.send('VOCATRYA_SYNC'),h.send('VOCATRYA_STATUS')]);
 assert.equal(b.data.state.lastSyncAt,a.data.state.lastSyncAt);assert.equal(b.data.state.syncedProfileUpdatedAt,'version');assert.equal(b.data.state.syncStatus,'synced');assert.equal(JSON.stringify(b).includes('old-token'),false);
});
for(const failure of ['network','http','unconfirmed'])test(`${failure} preserves credentials/settings for retry`,async()=>{
 let fail=true;const h=harness(async()=>{if(!fail)return reply({ok:true,revoked:true});if(failure==='network')throw Error('offline');return failure==='http'?reply({error:'server'},500):reply({ok:true});});
 for(const type of ['VOCATRYA_DISCONNECT','CLEAR_SETTINGS','VOCATRYA_PAIR']){const r=await h.send(type,pairing);assert.equal(r.ok,false);assert.match(r.error,/保留连接凭据/);assert.equal(h.store.vocatryaConnection.accessToken,'old-token');assert.equal(h.store.profileV2.updatedAt,'local');}
 fail=false;assert.equal((await h.send('VOCATRYA_DISCONNECT')).ok,true);assert.equal(h.store.vocatryaConnection,undefined);
});
test('explicit invalid/revoked accepted; generic unauthorized retained',async()=>{
 for(const code of ['CONNECTION_REVOKED','CONNECTION_INVALID','UNAUTHORIZED']){const h=harness(async()=>reply({ok:false,code},401));assert.equal((await h.send('VOCATRYA_DISCONNECT')).ok,code!=='UNAUTHORIZED');assert.equal(Boolean(h.store.vocatryaConnection),code==='UNAUTHORIZED');}
});
test('sync error preserves profile and queue recovers',async()=>{
 const h=harness(async()=>{throw Error('offline');});assert.equal((await h.send('VOCATRYA_SYNC')).ok,false);assert.equal(h.store.profileV2.updatedAt,'local');const r=await h.send('VOCATRYA_STATUS',{live:false});assert.equal(r.ok,true);assert.equal(r.data.state.syncStatus,'error');
});
for(const failed of [false,true])test(`options sync restores buttons after ${failed?'failure':'success'}`,async()=>{
 const options=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/options.js'),'utf8');
 const section=options.slice(options.indexOf('let connectBusy = false;'),options.indexOf('function sendRuntimeMessage(message)'));
 const element=()=>({disabled:false,textContent:'',classList:{remove(){},add(){},toggle(){}},appendChild(){}});
 const fields={connectStatus:element(),pairConnect:element(),syncProfile:element(),disconnectConnect:element(),connectFeedback:element()};
 const state={connected:true,syncStatus:failed?'error':'synced'};
 const context=vm.createContext({fields,document:{createElement:element},loadSettings:async()=>{},sendRuntimeMessage:async message=>{if(message.type==='OJAF_VOCATRYA_SYNC'&&failed)throw Error('offline');return {state};}});
 vm.runInContext(section,context);await vm.runInContext('syncFromVocatrya()',context);
 assert.equal(fields.pairConnect.disabled,false);assert.equal(fields.syncProfile.disabled,false);assert.equal(fields.disconnectConnect.disabled,false);
 assert.match(fields.connectFeedback.textContent,failed?/offline/:/已同步/);
});
