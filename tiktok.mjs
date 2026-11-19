// Personal TikTok integration. Only the outer Worker exposes authenticated routes.
// Tokens remain in this private SQLite-backed Durable Object; never returned to the browser.
const TTL=10*60*1000;
const requiredScopes=['user.info.basic','user.info.profile','video.list'];
const defaultScopes=[...requiredScopes,'user.info.stats'];
const response=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export class TikTokError extends Error{constructor(message,status=400){super(message);this.status=status}}
const random=()=>crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(n=>n.toString(16).padStart(2,'0')).join('');
export function callbackPage(ok){return new Response(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pulse — TikTok</title><style>body{font:18px/1.7 system-ui;background:#f7f8fc;color:#242535;padding:8vw}main{max-width:650px;margin:auto}h1{color:#7971e8}</style></head><body><main><h1>${ok?'Авторизация получена':'Авторизация не завершена'}</h1><p>${ok?'Вернитесь в исходную вкладку Pulse. Она завершит подключение аккаунта. Это окно можно закрыть.':'Вернитесь в исходную вкладку Pulse, чтобы увидеть результат и повторить подключение.'}</p></main></body></html>`,{status:ok?200:400,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",'X-Content-Type-Options':'nosniff'}})}
function sanitizeError(error,fallback){
 if(error==='invalid_client'||error==='client_key_invalid')return 'Проверьте Client key и TIKTOK_CLIENT_SECRET: оба должны относиться к одному Sandbox.';
 if(error==='invalid_grant')return 'Разрешение TikTok истекло или отозвано. Подключите аккаунт заново.';
 if(error==='scope_not_authorized'||error==='scope_not_authorized_by_user')return 'Не предоставлены необходимые разрешения TikTok. Проверьте scopes в Sandbox и подключите аккаунт заново.';
 if(error==='rate_limit_exceeded')return 'Лимит запросов TikTok достигнут. Повторите позже.';
 if(error==='access_token_invalid')return 'Доступ TikTok истёк или отозван. Подключите аккаунт заново.';
 return fallback;
}
async function providerJSON(url,options,fetcher){
 let r,d;try{r=await fetcher(url,{...options,signal:AbortSignal.timeout(12000)});d=await r.json()}catch{throw new TikTokError('TikTok не ответил. Повторите позже.',502)}
 const error=typeof d.error==='string'?d.error:d.error?.code;
 if(!r.ok||(error&&error!=='ok'))throw new TikTokError(sanitizeError(error,'Ошибка TikTok API. Проверьте продукты, scopes и Target users в Sandbox.'),502);
 return d;
}
async function tokenCall(env,params,fetcher){return providerJSON('https://open.tiktokapis.com/v2/oauth/token/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_key:env.TIKTOK_CLIENT_KEY,client_secret:env.TIKTOK_CLIENT_SECRET,...params})},fetcher)}
function tokenRecord(data,previous){
 if(typeof data.access_token!=='string'||typeof data.refresh_token!=='string'||typeof data.open_id!=='string'||!Number.isFinite(data.expires_in)||!Number.isFinite(data.refresh_expires_in)||data.expires_in<=0||data.refresh_expires_in<=0)throw new TikTokError('Неполный ответ авторизации TikTok.',502);
 if(previous&&data.open_id!==previous.openId)throw new TikTokError('TikTok вернул другой аккаунт. Подключите аккаунт заново.',502);
 const scopes=typeof data.scope==='string'?data.scope.split(','):previous?.scopes||[];
 return {accessToken:data.access_token,refreshToken:data.refresh_token,openId:data.open_id,scopes,expiresAt:Date.now()+data.expires_in*1000,refreshExpiresAt:Date.now()+data.refresh_expires_in*1000};
}
async function profile(record,fetcher){
 const fields=['open_id','display_name','username','profile_deep_link'];if(record.scopes.includes('user.info.stats'))fields.push('follower_count','likes_count','video_count');
 const d=await providerJSON('https://open.tiktokapis.com/v2/user/info/?fields='+fields.join(','),{headers:{Authorization:'Bearer '+record.accessToken}},fetcher);
 const user=d.data?.user;
 if(!user||user.open_id!==record.openId||typeof user.username!=='string'||!user.username||user.username.length>100)throw new TikTokError('Не удалось определить TikTok-профиль. Проверьте разрешение user.info.profile.',502);
 return {username:user.username,displayName:typeof user.display_name==='string'?user.display_name:user.username,url:'https://www.tiktok.com/@'+encodeURIComponent(user.username),followers:Number.isFinite(user.follower_count)?user.follower_count:null,likes:Number.isFinite(user.likes_count)?user.likes_count:null,videoCount:Number.isFinite(user.video_count)?user.video_count:null};
}
async function revoke(env,record,fetcher){await providerJSON('https://open.tiktokapis.com/v2/oauth/revoke/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_key:env.TIKTOK_CLIENT_KEY,client_secret:env.TIKTOK_CLIENT_SECRET,token:record.accessToken})},fetcher)}
export async function tiktokSnapshot(record,fetcher=fetch){
 const user=await profile(record,fetcher),videos=[];let cursor,hasMore=false;
 for(let page=0;page<5;page++){
  const body={max_count:20};if(cursor!==undefined)body.cursor=cursor;
  const d=await providerJSON('https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,create_time,cover_image_url,share_url,duration,view_count,like_count,comment_count,share_count',{method:'POST',headers:{Authorization:'Bearer '+record.accessToken,'Content-Type':'application/json'},body:JSON.stringify(body)},fetcher);
  if(!Array.isArray(d.data?.videos))throw new TikTokError('TikTok не вернул список видео.',502);
  for(const v of d.data.videos){if(typeof v.id!=='string'||!Number.isFinite(v.create_time)||!Number.isFinite(v.view_count)||v.view_count<0)throw new TikTokError('Некорректные данные видео TikTok.',502);
   if(!videos.some(x=>x.externalId===v.id))videos.push({externalId:v.id,title:v.title||v.video_description||'Видео TikTok',date:new Date(v.create_time*1000).toISOString(),thumbnail:typeof v.cover_image_url==='string'?v.cover_image_url:'',url:'https://www.tiktok.com/@'+encodeURIComponent(user.username)+'/video/'+encodeURIComponent(v.id),views:v.view_count,duration:Number.isFinite(v.duration)?`${Math.floor(v.duration/60)}:${String(Math.floor(v.duration%60)).padStart(2,'0')}`:'',likes:Number.isFinite(v.like_count)?v.like_count:null});
  }
  hasMore=!!d.data.has_more;if(!hasMore)break;
  if(!Number.isFinite(d.data.cursor)||d.data.cursor===cursor)throw new TikTokError('TikTok вернул некорректную страницу видео.',502);cursor=d.data.cursor;
 }
 return {channel:{...user,views:videos.reduce((s,v)=>s+v.views,0),viewsKind:'loadedVideos',hasMore,loadedVideos:videos.length},videos,updatedAt:new Date().toISOString()};
}
export class TikTokStore{
 constructor(state,env){this.storage=state.storage;this.env=env;this.queue=Promise.resolve();this.fetcher=(...args)=>fetch(...args)}
 fetch(request){const task=this.queue.then(()=>this.route(request));this.queue=task.catch(()=>{});return task}
 alarm(){const task=this.queue.then(()=>this.cleanup());this.queue=task.catch(()=>{});return task}
 async schedule(when){const current=await this.storage.getAlarm();if(!current||current>when)await this.storage.setAlarm(when)}
 async cleanup(){
  const flows=await this.storage.list({prefix:'flow:'});let next=Infinity;
  for(const [key,flow] of flows){if(flow.expiresAt<=Date.now()){if(flow.tokens){const accounts=await this.storage.list({prefix:'account:'});const newer=[...accounts.values()].some(a=>a.openId===flow.tokens.openId&&a.createdAt>=(flow.createdAt||0));if(!newer)try{await revoke(this.env,flow.tokens,this.fetcher)}catch{}}await this.storage.delete(key);await this.storage.delete('state:'+flow.state)}else next=Math.min(next,flow.expiresAt)}
  const accounts=await this.storage.list({prefix:'account:'});
  for(const [key,a] of accounts){if(a.refreshExpiresAt<=Date.now()){await this.storage.put(key,{id:a.id,username:a.username,needsReconnect:true,expiredAt:Date.now()})}else if(Number.isFinite(a.refreshExpiresAt))next=Math.min(next,a.refreshExpiresAt)}
  if(Number.isFinite(next))await this.storage.setAlarm(next);
 }
 async route(request){
  const path=new URL(request.url).pathname;
  try{
   if(path==='/auth/tiktok/callback')return await this.callback(request);
   const body=await request.json();
   if(path==='/api/tiktok/connect')return await this.start(body);
   if(path==='/api/tiktok/complete')return await this.complete(body);
   if(path==='/api/tiktok/sync')return await this.sync(body);
   if(path==='/api/tiktok/disconnect')return await this.disconnect(body);
   return response({error:'Маршрут не найден.'},404);
  }catch(e){if(path==='/auth/tiktok/callback')return callbackPage(false);return response({error:e instanceof TikTokError?e.message:'Ошибка обработки TikTok. Повторите позже.'},e instanceof TikTokError?e.status:502)}
 }
 async start(body){
  if(typeof body.proof!=='string'||!/^[a-f0-9]{64}$/.test(body.proof))throw new TikTokError('Неверный код сессии подключения.');
  await this.cleanup();const flows=await this.storage.list({prefix:'flow:'});if(flows.size>=20)throw new TikTokError('Слишком много попыток подключения. Подождите 10 минут.',429);
  const state=random(),flowId=random(),expiresAt=Date.now()+TTL;
  const requested=(this.env.TIKTOK_SCOPES||defaultScopes.join(',')).split(',').map(s=>s.trim()).filter(Boolean);
  if(requiredScopes.some(s=>!requested.includes(s))||requested.some(s=>!defaultScopes.includes(s)))throw new TikTokError('Проверьте TIKTOK_SCOPES в Worker.',503);
  await this.storage.put('flow:'+flowId,{state,proofHash:await digest(body.proof),expiresAt,status:'waiting',createdAt:Date.now()});await this.storage.put('state:'+state,flowId);await this.schedule(expiresAt);
  const url=new URL('https://www.tiktok.com/v2/auth/authorize/');
  for(const [key,value] of Object.entries({client_key:this.env.TIKTOK_CLIENT_KEY,response_type:'code',scope:requested.join(','),redirect_uri:this.env.TIKTOK_REDIRECT_URI,state,disable_auto_auth:'1'}))url.searchParams.set(key,value);
  return response({flowId,authorizeUrl:url.href,expiresAt});
 }
 async callback(request){
  const u=new URL(request.url),state=u.searchParams.get('state');if(!state||state.length!==64)return callbackPage(false);
  const flowId=await this.storage.get('state:'+state);if(!flowId)return callbackPage(false);
  const key='flow:'+flowId,flow=await this.storage.get(key);
  // Consume state before the upstream exchange: a callback may never be replayed.
  await this.storage.delete('state:'+state);
  if(!flow||flow.state!==state||flow.expiresAt<=Date.now()||flow.status!=='waiting')return callbackPage(false);
  flow.status='processing';await this.storage.put(key,flow);
  try{
   if(u.searchParams.has('error'))throw new TikTokError('Авторизация TikTok отменена или отклонена. Повторите подключение.');
   const code=u.searchParams.get('code');if(!code||code.length>4096)throw new TikTokError('TikTok не передал код авторизации.');
   const tokenData=await tokenCall(this.env,{grant_type:'authorization_code',code,redirect_uri:this.env.TIKTOK_REDIRECT_URI},this.fetcher);
   // Keep issued credentials for cleanup even if required permissions/profile fail.
   flow.tokens=tokenRecord(tokenData);if(requiredScopes.some(s=>!flow.tokens.scopes.includes(s)))throw new TikTokError('Разрешите user.info.basic, user.info.profile и video.list при подключении TikTok.');flow.profile=await profile(flow.tokens,this.fetcher);flow.status='ready';
  }catch(e){if(flow.tokens){try{await revoke(this.env,flow.tokens,this.fetcher)}catch{}delete flow.tokens}flow.status='failed';flow.error=e instanceof TikTokError?e.message:'Не удалось завершить авторизацию TikTok. Повторите подключение.'}
  await this.storage.put(key,flow);return callbackPage(flow.status==='ready');
 }
 async complete(body){
  if(typeof body.flowId!=='string'||!/^[a-f0-9]{64}$/.test(body.flowId)||typeof body.proof!=='string'||!/^[a-f0-9]{64}$/.test(body.proof))throw new TikTokError('Неверная сессия подключения.');
  const key='flow:'+body.flowId,flow=await this.storage.get(key);
  if(!flow||flow.expiresAt<=Date.now()||flow.proofHash!==await digest(body.proof))throw new TikTokError('Сессия подключения истекла или не принадлежит этой вкладке.',401);
  if(flow.status==='failed'){await this.storage.delete(key);throw new TikTokError(flow.error)}
  if(flow.status!=='ready')return response({status:'waiting',createdAt:Date.now()},202);
  const accounts=await this.storage.list({prefix:'account:'});let id;
  for(const a of accounts.values())if(a.openId===flow.tokens.openId)id=a.id;
  if(!id&&accounts.size>=20)throw new TikTokError('Достигнут лимит 20 подключённых TikTok-аккаунтов.');
  id=id||random();await this.storage.put('account:'+id,{id,...flow.tokens,...flow.profile,createdAt:Date.now()});await this.schedule(flow.tokens.refreshExpiresAt);
  await this.storage.delete(key);
  return response({status:'connected',connectionId:id,profile:flow.profile,scopes:flow.tokens.scopes});
 }
 async account(body){
  if(typeof body.connectionId!=='string'||!/^[a-f0-9]{64}$/.test(body.connectionId))throw new TikTokError('Подключите TikTok-аккаунт в этой группе.',401);
  let a=await this.storage.get('account:'+body.connectionId);
  if(!a||a.needsReconnect)throw new TikTokError('Подключение TikTok не найдено. Подключите аккаунт заново.',401);
  if(a.refreshExpiresAt<=Date.now()){await this.storage.put('account:'+a.id,{id:a.id,username:a.username,needsReconnect:true});throw new TikTokError('Разрешение TikTok истекло. Подключите аккаунт заново.',401)}
  if(a.expiresAt<=Date.now()+120000){
   const refreshed=tokenRecord(await tokenCall(this.env,{grant_type:'refresh_token',refresh_token:a.refreshToken},this.fetcher),a);
   a={...a,...refreshed};await this.storage.put('account:'+a.id,a);await this.schedule(a.refreshExpiresAt);
  }
  if(requiredScopes.some(s=>!a.scopes.includes(s)))throw new TikTokError('Нужны разрешения user.info.basic, user.info.profile и video.list. Подключите аккаунт заново.',401);
  return a;
 }
 async sync(body){const a=await this.account(body),data=await tiktokSnapshot(a,this.fetcher);return response({...data,connectionId:a.id})}
 async disconnect(body){
  if(typeof body.connectionId!=='string'||!/^[a-f0-9]{64}$/.test(body.connectionId))throw new TikTokError('Неверный идентификатор подключения.');
  let a=await this.storage.get('account:'+body.connectionId);
  if(!a||a.needsReconnect||(a.refreshExpiresAt<=Date.now()&&a.expiresAt<=Date.now())){await this.storage.delete('account:'+body.connectionId);return response({disconnected:true})}
  if(a.expiresAt<=Date.now())a=await this.account(body);
  await revoke(this.env,a,this.fetcher);await this.storage.delete('account:'+a.id);return response({disconnected:true});
 }
}
