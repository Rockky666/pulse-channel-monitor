import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TikTokStore,tiktokSnapshot} from './tiktok.mjs';
import worker from './worker.mjs';
const env={TIKTOK_CLIENT_KEY:'test-key',TIKTOK_CLIENT_SECRET:'test-secret',TIKTOK_REDIRECT_URI:'https://pulse.test/auth/tiktok/callback'};
const scopes='user.info.basic,user.info.profile,user.info.stats,video.list';
const proof='a'.repeat(64);
class Storage{
 constructor(){this.map=new Map();this.alarm=null}
 async put(k,v){this.map.set(k,structuredClone(v))}
 async get(k){return structuredClone(this.map.get(k))}
 async delete(k){return this.map.delete(k)}
 async list({prefix}){return new Map([...this.map].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>[k,structuredClone(v)]))}
 async setAlarm(t){this.alarm=t}
 async getAlarm(){return this.alarm}
}
const tokens=(overrides={})=>({access_token:'access-test',refresh_token:'refresh-test',open_id:'open-test',expires_in:7200,refresh_expires_in:86400,scope:scopes,...overrides});
const profile={open_id:'open-test',username:'channel',display_name:'Test channel',follower_count:321,likes_count:1000,video_count:2};
function mockProvider(calls=[]){return async (input,options={})=>{const u=new URL(input);calls.push({url:u.href,body:String(options.body||''),headers:options.headers});
 if(u.pathname==='/v2/oauth/token/'){const form=new URLSearchParams(options.body);return Response.json(tokens(form.get('grant_type')==='refresh_token'?{access_token:'new-access',refresh_token:'new-refresh'}:{}))}
 if(u.pathname==='/v2/oauth/revoke/')return Response.json({});
 if(u.pathname==='/v2/user/info/')return Response.json({data:{user:profile},error:{code:'ok'}});
 if(u.pathname==='/v2/video/list/')return Response.json({data:{has_more:false,videos:[{id:'123',title:'Test',create_time:1700000000,duration:45,view_count:80,cover_image_url:'https://example.com/cover.jpg'}]},error:{code:'ok'}});
 throw Error('Unexpected upstream');}}
function setup(fetcher=mockProvider()){const storage=new Storage(),store=new TikTokStore({storage},env);store.fetcher=fetcher;return {store,storage}}
const request=(route,body)=>new Request('https://internal/api/tiktok/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
async function flow(store){const start=await (await store.fetch(request('connect',{proof}))).json();const state=new URL(start.authorizeUrl).searchParams.get('state');return {...start,state}}
async function authorized(store){const f=await flow(store);const r=await store.fetch(new Request(env.TIKTOK_REDIRECT_URI+'?state='+f.state+'&code=test-code'));assert.equal(r.status,200);return {...f,result:await (await store.fetch(request('complete',{flowId:f.flowId,proof}))).json()}}
test('state and browser proof must match; tokens never reach the browser',async()=>{
 const {store}=setup(),f=await flow(store);
 assert.equal(new URL(f.authorizeUrl).searchParams.get('client_key'),'test-key');
 assert.equal((await store.fetch(new Request(env.TIKTOK_REDIRECT_URI+'?state='+'b'.repeat(64)+'&code=test'))).status,400);
 assert.equal((await store.fetch(request('complete',{flowId:f.flowId,proof:'b'.repeat(64)}))).status,401);
 assert.equal((await (await store.fetch(request('complete',{flowId:f.flowId,proof}))).json()).status,'waiting');
 await store.fetch(new Request(env.TIKTOK_REDIRECT_URI+'?state='+f.state+'&code=test-code'));
 const result=await (await store.fetch(request('complete',{flowId:f.flowId,proof}))).json();assert.equal(result.status,'connected');assert.equal(result.profile.followers,321);
 const text=JSON.stringify(result);assert.ok(!text.includes('access-test'));assert.ok(!text.includes('refresh-test'));assert.ok(!text.includes('test-secret'));
 assert.equal((await store.fetch(request('complete',{flowId:f.flowId,proof}))).status,401);
});
test('callback cannot be replayed and user denial is preserved',async()=>{
 const calls=[],{store}=setup(mockProvider(calls)),f=await flow(store);
 const cb=new Request(env.TIKTOK_REDIRECT_URI+'?state='+f.state+'&error=access_denied');
 assert.equal((await store.fetch(cb)).status,400);assert.equal((await store.fetch(cb)).status,400);
 const r=await store.fetch(request('complete',{flowId:f.flowId,proof}));assert.equal(r.status,400);assert.equal(calls.length,0);
});
test('expired flow and state index are deleted',async()=>{
 const {store,storage}=setup(),f=await flow(store),saved=await storage.get('flow:'+f.flowId);saved.expiresAt=Date.now()-1;await storage.put('flow:'+f.flowId,saved);await store.alarm();assert.equal(await storage.get('state:'+f.state),undefined);assert.equal(await storage.get('flow:'+f.flowId),undefined);
});
test('refresh rotation is persisted and simultaneous syncs refresh only once',async()=>{
 const calls=[],{store,storage}=setup(mockProvider(calls)),{result}=await authorized(store);const key='account:'+result.connectionId,a=await storage.get(key);a.expiresAt=0;await storage.put(key,a);calls.length=0;
 const [one,two]=await Promise.all([store.fetch(request('sync',{connectionId:a.id})),store.fetch(request('sync',{connectionId:a.id}))]);assert.equal(one.status,200);assert.equal(two.status,200);
 const saved=await storage.get(key);assert.equal(saved.refreshToken,'new-refresh');assert.equal(calls.filter(c=>c.body.includes('grant_type=refresh_token')).length,1);
 const data=await one.json();assert.equal(data.channel.views,80);assert.equal(data.channel.viewsKind,'loadedVideos');assert.ok(!JSON.stringify(data).includes('new-access'));
});
test('successful disconnect revokes upstream access before deleting account',async()=>{
 const calls=[],{store,storage}=setup(mockProvider(calls)),{result}=await authorized(store);const r=await store.fetch(request('disconnect',{connectionId:result.connectionId}));assert.equal(r.status,200);assert.equal(await storage.get('account:'+result.connectionId),undefined);assert.ok(calls.some(c=>c.url.endsWith('/oauth/revoke/')));
});
test('failed revoke retains credentials so the user can retry',async()=>{
 const {store,storage}=setup(),{result}=await authorized(store);store.fetcher=async()=>Response.json({error:'invalid_client'},{status:400});assert.equal((await store.fetch(request('disconnect',{connectionId:result.connectionId}))).status,502);assert.ok(await storage.get('account:'+result.connectionId));
});
test('provider error in HTTP 200 is a failure, not an empty successful snapshot',async()=>{
 await assert.rejects(tiktokSnapshot({accessToken:'test',openId:'open-test',scopes:scopes.split(',')},async()=>Response.json({error:{code:'scope_not_authorized'}})),/разрешения/);
});
test('scopes declined during auth revoke temporary tokens and do not create account',async()=>{
 const calls=[],base=mockProvider(calls);const {store,storage}=setup(async (url,options)=>String(url).includes('/oauth/token/')?Response.json(tokens({scope:'user.info.basic'})):base(url,options));const f=await flow(store);assert.equal((await store.fetch(new Request(env.TIKTOK_REDIRECT_URI+'?state='+f.state+'&code=test'))).status,400);assert.equal((await storage.list({prefix:'account:'})).size,0);assert.ok(calls.some(c=>c.url.endsWith('/oauth/revoke/')));
});
test('pagination bounds snapshot to 100 and labels incomplete totals',async()=>{
 let pages=0;const data=await tiktokSnapshot({accessToken:'test',openId:'open-test',scopes:scopes.split(',')},async url=>String(url).includes('/user/info/')?Response.json({data:{user:profile},error:{code:'ok'}}):Response.json({data:{videos:Array.from({length:20},(_,i)=>({id:String(++pages*100+i),title:'v',create_time:1700000000,view_count:1})),cursor:pages,has_more:true},error:{code:'ok'}}));assert.equal(data.videos.length,100);assert.equal(data.channel.views,100);assert.equal(data.channel.hasMore,true);
});
test('outer routes require Pulse authentication and origin; TikTok does not need YouTube key',async()=>{
 const outerEnv={...env,ALLOWED_ORIGIN:'https://front.test',PULSE_ACCESS_TOKEN:'test-pulse-token-long-enough-123456789'};
 const req=(token=outerEnv.PULSE_ACCESS_TOKEN)=>new Request('https://pulse.test/api/tiktok/status',{method:'POST',headers:{Origin:outerEnv.ALLOWED_ORIGIN,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});
 assert.equal((await worker.fetch(req('bad'),outerEnv)).status,401);const r=await worker.fetch(req(),outerEnv);assert.equal(r.status,200);assert.equal((await r.json()).ready,false);
});

test('expired abandoned flow cannot revoke a later successful account authorization',async()=>{
 const calls=[],{store,storage}=setup(mockProvider(calls)),f=await flow(store),saved=await storage.get('flow:'+f.flowId);saved.tokens={accessToken:'old',openId:'same'};saved.expiresAt=Date.now()-1;await storage.put('flow:'+f.flowId,saved);await storage.put('account:'+('c'.repeat(64)),{id:'c'.repeat(64),openId:'same',createdAt:Date.now()+1,refreshExpiresAt:Date.now()+100000});await store.alarm();assert.equal(calls.length,0);assert.equal(await storage.get('flow:'+f.flowId),undefined);
});
test('expired credential metadata can be disconnected without contacting the provider',async()=>{
 const calls=[],{store,storage}=setup(mockProvider(calls));const id='d'.repeat(64);await storage.put('account:'+id,{id,needsReconnect:true,username:'old'});const r=await store.fetch(request('disconnect',{connectionId:id}));assert.equal(r.status,200);assert.equal(await storage.get('account:'+id),undefined);assert.equal(calls.length,0);
});
