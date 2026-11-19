let tiktokFlow=null;
function tiktokSettings(){const groups=state.groups.filter(g=>!g.demo);return `<div class="settings-box"><h2>Подключить TikTok · Sandbox</h2><p>Выберите свою группу и разрешите Pulse читать её TikTok-аккаунт. Пароль вводится только на сайте TikTok. Токены хранятся в вашем Worker, а не в браузере.</p>${tiktokFlow?'<p>Авторизация открыта в отдельном окне TikTok.</p><button class="btn" data-action="cancel-tiktok">Отменить подключение</button>':''}${groups.length?`<label class="field">Группа для TikTok<select id="tiktok-group">${groups.map(g=>`<option value="${esc(g.id)}" ${g.id===activeId?'selected':''}>${esc(g.name)}${g.channels.tiktok.connectionId?' · аккаунт подключён':''}</option>`).join('')}</select></label><div class="actions" style="flex-wrap:wrap"><button class="btn primary" data-action="connect-tiktok">Подключить TikTok</button><button class="btn" data-action="check-tiktok">Проверить бэкенд</button></div>`:`<p>Сначала создайте собственную группу. Демонстрационные группы не подключаются к аккаунтам.</p><button class="btn primary" data-action="add-group">Добавить группу</button>`}<p style="margin-top:16px">Client key: <code>sbawgcg7ufolbtr27p</code>. Нужны продукты Login Kit и Display API, разрешения user.info.basic, user.info.profile, user.info.stats и video.list. Аккаунт должен быть добавлен в Target users вашего Sandbox.</p><a class="text-btn" href="https://github.com/Rockky666/pulse-channel-monitor/blob/main/TIKTOK-RU.md" target="_blank" rel="noopener">Инструкция подключения TikTok</a></div>`}
function tiktokAccountUI(g){const c=g.channels.tiktok,linked=!!c.connectionId;return `<div style="margin-top:18px;border-top:1px solid #ececf2;padding-top:14px"><p style="font-size:13px;margin-bottom:12px">${linked?`Подключён ${esc(c.username?'@'+c.username:c.displayName||'аккаунт')}.`:'Аккаунт ещё не авторизован.'}${c.syncedAt?` Просмотры: сумма ${c.loadedVideos||0} последних загруженных роликов${c.hasMore?' (не весь канал)':''}. Превью временные; обновляйте их вместе с метриками.`:''}</p><div class="actions" style="flex-wrap:wrap"><button class="btn ${linked?'':'primary'}" data-action="${linked?'sync-tiktok':'connect-tiktok'}">${linked?'Обновить TikTok':'Подключить TikTok'}</button>${linked?'<button class="text-btn danger" data-action="disconnect-tiktok">Отключить</button>':''}</div></div>`}
function cancelTikTok(){if(tiktokFlow){try{tiktokFlow.popup.close()}catch{}tiktokFlow=null;render();toast('Подключение отменено')}}
function bindTikTok(){} // Actions use the existing unified event binding.
function apiContext(){return {origin:backendOrigin,token:personalToken}}
async function tiktokAPI(route,body={},context=apiContext()){
 if(!context.origin||!context.token)throw Error('Сначала укажите Worker и код доступа Pulse в «Подключениях».');
 let r;try{r=await fetch(context.origin+'/api/tiktok/'+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+context.token},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)})}catch(e){throw Error(e.name==='TimeoutError'?'TikTok не ответил вовремя. Повторите позже.':'Не удалось связаться с Worker. Проверьте адрес, ALLOWED_ORIGIN и подключение.')}
 let d;try{d=await r.json()}catch{throw Error('Worker вернул некорректный ответ. Обновите его код из GitHub.')}
 if(!r.ok)throw Error(r.status===404?'Обновите код Worker из репозитория: маршруты TikTok ещё не опубликованы.':typeof d.error==='string'?d.error:'Ошибка TikTok API.');return d;
}
function requireBackend(){if(backendOrigin&&personalToken)return true;page='settings';render();toast('Введите адрес Worker и код доступа Pulse');return false}
async function checkTikTokBackend(){if(!requireBackend())return;try{const d=await tiktokAPI('status');toast(d.ready?'Worker готов. Добавьте аккаунт в Target users и подключите TikTok.':'Нужен актуальный Worker с TIKTOK_STORE и секретом TIKTOK_CLIENT_SECRET.')}catch(e){toast(e.message)}}
function tiktokTarget(){return state.groups.find(g=>g.id===($('#tiktok-group')?.value||activeId)&&!g.demo)}
async function connectTikTok(){
 if(tiktokFlow){toast('Подключение уже открыто в другом окне. Завершите его или закройте окно.');return}
 const g=tiktokTarget();if(!g){toast('Выберите свою группу для подключения TikTok');return}if(!requireBackend())return;
 const context=apiContext(),groupId=g.id,oldURL=g.channels.tiktok.url;
 const popup=window.open('about:blank','_blank','popup,width=560,height=760');if(!popup){toast('Разрешите всплывающее окно для подключения TikTok');return}
 popup.opener=null;popup.document.title='Pulse — подключение TikTok';popup.document.body.textContent='Готовим авторизацию TikTok…';
 const proof=Array.from(crypto.getRandomValues(new Uint8Array(32))).map(n=>n.toString(16).padStart(2,'0')).join('');
 const flow={popup,context,groupId};tiktokFlow=flow;render();
 try{
  const start=await tiktokAPI('connect',{proof},context);const url=new URL(start.authorizeUrl);
  if(url.origin!=='https://www.tiktok.com'||url.pathname!=='/v2/auth/authorize/'||typeof start.flowId!=='string')throw Error('Worker вернул неверный адрес авторизации.');
  popup.location.href=url.href;toast('Завершите вход и разрешите доступ в окне TikTok');
  for(let i=0;i<200;i++){
   await new Promise(resolve=>setTimeout(resolve,2500));
   if(tiktokFlow!==flow)throw Error('Подключение отменено.');if(backendOrigin!==context.origin||personalToken!==context.token)throw Error('Настройки бэкенда изменились. Повторите подключение.');
   const result=await tiktokAPI('complete',{flowId:start.flowId,proof},context);
   if(result.status==='waiting')continue;
   if(result.status!=='connected'||!/^[a-f0-9]{64}$/.test(result.connectionId||'')||!result.profile||!safeURL(result.profile.url,'tiktok'))throw Error('Не удалось подтвердить аккаунт TikTok.');
   const current=state.groups.find(x=>x.id===groupId);if(!current||current.channels.tiktok.url!==oldURL)throw Error('Группа изменилась во время подключения. Повторите подключение в нужной группе.');
   if(!popup.closed)popup.close();tiktokFlow=null;
   const attach=()=>{current.channels.tiktok={url:result.profile.url,followers:result.profile.followers??0,hiddenFollowers:result.profile.followers===null,views:0,connectionId:result.connectionId,backendOrigin:context.origin,username:result.profile.username,displayName:result.profile.displayName};save();activeId=groupId;page='detail';render();toast('TikTok подключён. Загружаю метрики…');syncTikTok(groupId)};
   const handle=u=>{try{return decodeURIComponent(new URL(u).pathname).split('/').filter(Boolean)[0]?.toLowerCase()}catch{return ''}};
   if(oldURL&&handle(oldURL)!==handle(result.profile.url)){confirmModal('Подключить этот TikTok-аккаунт?',`Вы разрешили доступ к @${result.profile.username}. Заменить ссылку TikTok в группе «${current.name}»? Сохранённые публикации останутся.`,attach)}else attach();return;
  }
  throw Error('Время подключения истекло. Повторите попытку.');
 }catch(e){if(!popup.closed)popup.close();toast(e.message)}finally{if(tiktokFlow===flow)tiktokFlow=null;render()}
}
function tiktokVideoId(url){try{return new URL(url).pathname.match(/\/video\/([^/]+)/)?.[1]||''}catch{return ''}}
function mergeTikTok(group,data){
 if(!data?.channel||data.channel.viewsKind!=='loadedVideos'||!Number.isFinite(data.channel.views)||data.channel.views<0||!(data.channel.followers===null||Number.isFinite(data.channel.followers)&&data.channel.followers>=0)||!Array.isArray(data.videos)||data.videos.length>100)throw Error('Некорректные метрики TikTok.');
 const videos=data.videos.map(v=>{if(typeof v.externalId!=='string'||typeof v.title!=='string'||!Number.isFinite(Date.parse(v.date))||!safeURL(v.url,'tiktok')||!Number.isFinite(v.views)||v.views<0)throw Error('Некорректные данные видео TikTok.');return v});
 const c=group.channels.tiktok;Object.assign(c,{views:data.channel.views,followers:data.channel.followers??0,hiddenFollowers:data.channel.followers===null,syncedAt:data.updatedAt,loadedVideos:videos.length,hasMore:!!data.channel.hasMore,likes:data.channel.likes,videoCount:data.channel.videoCount,viewsKind:'loadedVideos'});group.updatedAt=data.updatedAt;
 videos.forEach(v=>{const old=state.videos.find(x=>x.groupId===group.id&&tiktokVideoId(x.versions.tiktok?.url)===v.externalId);if(old){old.versions.tiktok={url:v.url,views:v.views};if(old.source==='tiktok')Object.assign(old,{title:v.title,date:v.date,thumbnail:v.thumbnail,duration:v.duration})}else state.videos.push({id:uid(),groupId:group.id,title:v.title,date:v.date,thumbnail:v.thumbnail,duration:v.duration,demo:false,source:'tiktok',versions:{tiktok:{url:v.url,views:v.views}}})});
}
async function syncTikTok(groupId=activeId){
 if(syncBusy){toast('Дождитесь текущего обновления');return}const g=state.groups.find(g=>g.id===groupId&&!g.demo);if(!g)return;if(!requireBackend())return;
 const context=apiContext(),id=g.channels.tiktok.connectionId;if(!id){toast('Сначала подключите TikTok в этой группе');return}if(g.channels.tiktok.backendOrigin!==context.origin){toast('Этот аккаунт подключён к другому Worker. Верните прежний адрес или подключите TikTok заново.');return}
 syncBusy=true;const btn=$('[data-action="sync-tiktok"]');if(btn){btn.disabled=true;btn.textContent='Обновляю…'}
 try{const data=await tiktokAPI('sync',{connectionId:id},context),current=state.groups.find(x=>x.id===g.id);if(!current||current.channels.tiktok.connectionId!==id||backendOrigin!==context.origin)throw Error('Группа или бэкенд изменились. Повторите обновление.');mergeTikTok(current,data);save();toast(`TikTok обновлён: ${data.videos.length} роликов.${data.channel.hasMore?' Учтены последние 100, а не весь канал.':''}`)}catch(e){toast(e.message)}finally{syncBusy=false;render()}
}
function disconnectTikTok(){
 const g=state.groups.find(g=>g.id===activeId);if(!g?.channels.tiktok.connectionId||!requireBackend())return;const context=apiContext(),id=g.channels.tiktok.connectionId;
 if(g.channels.tiktok.backendOrigin!==context.origin){toast('Для отключения укажите Worker, к которому подключён аккаунт');return}
 confirmModal('Отключить TikTok?',`Доступ Pulse к этому аккаунту будет отозван. Подключение удалится из всех групп с этим аккаунтом. Сохранённые метрики и видео останутся.`,async()=>{try{await tiktokAPI('disconnect',{connectionId:id},context);for(const group of state.groups)if(group.channels.tiktok.connectionId===id&&group.channels.tiktok.backendOrigin===context.origin){delete group.channels.tiktok.connectionId;delete group.channels.tiktok.backendOrigin}save();render();toast('Доступ TikTok отозван, подключение удалено')}catch(e){toast(e.message)}});
}
render();
