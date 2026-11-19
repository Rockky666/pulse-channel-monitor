// Pulse personal API. Deploy as a Cloudflare Worker ES module.
// Required bindings: ALLOWED_ORIGIN (text), YOUTUBE_API_KEY and PULSE_ACCESS_TOKEN (secrets).
const json = (body, status, headers={}) => new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});
class ApiError extends Error { constructor(message,status=400){super(message);this.status=status} }
export function channelFilter(raw){
  let u;try{u=new URL(raw)}catch{throw new ApiError('Некорректная ссылка YouTube.')}
  const host=u.hostname.replace(/^www\./,'');
  if(u.protocol!=='https:'||!['youtube.com','m.youtube.com'].includes(host)||u.username||u.password)throw new ApiError('Нужна HTTPS-ссылка на канал youtube.com.');
  const parts=u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if(parts[0]?.startsWith('@')&&parts[0].length>1)return {forHandle:parts[0]};
  if(parts[0]==='channel'&&/^UC[\w-]{22}$/.test(parts[1]||''))return {id:parts[1]};
  if(parts[0]==='user'&&parts[1])return {forUsername:parts[1]};
  throw new ApiError('Используйте ссылку youtube.com/@имя или youtube.com/channel/UC…');
}
export function durationLabel(iso=''){
  const m=iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);if(!m)return '';
  const h=Number(m[1]||0),minutes=Number(m[2]||0),s=Number(m[3]||0);
  return h?`${h}:${String(minutes).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${minutes}:${String(s).padStart(2,'0')}`;
}
async function yt(resource,params,key,fetcher){
  const u=new URL('https://www.googleapis.com/youtube/v3/'+resource);
  for(const [k,v] of Object.entries({...params,key}))u.searchParams.set(k,String(v));
  const r=await fetcher(u,{signal:AbortSignal.timeout(15000)});let data;try{data=await r.json()}catch{throw new ApiError('YouTube вернул некорректный ответ.',502)}
  if(!r.ok){const reason=data.error?.errors?.[0]?.reason;
    throw new ApiError(reason==='quotaExceeded'?'Квота YouTube API исчерпана. Повторите позже.':reason==='keyInvalid'?'Проверьте YOUTUBE_API_KEY в настройках Worker.':'Ошибка доступа к YouTube API. Проверьте ключ, ограничения и включение YouTube Data API v3.',502)}
  if(!Array.isArray(data.items))throw new ApiError('Нет данных в ответе YouTube.',502);return data.items;
}
export async function youtubeSnapshot(channelUrl,key,fetcher=fetch){
  const channels=await yt('channels',{part:'snippet,statistics,contentDetails',...channelFilter(channelUrl)},key,fetcher);
  const c=channels[0];if(!c)throw new ApiError('Канал не найден.',404);
  const uploads=c.contentDetails?.relatedPlaylists?.uploads;let videos=[];
  if(uploads){const list=await yt('playlistItems',{part:'contentDetails',playlistId:uploads,maxResults:50},key,fetcher);
    const ids=list.map(v=>v.contentDetails?.videoId).filter(Boolean);
    if(ids.length){const items=await yt('videos',{part:'snippet,statistics,contentDetails',id:ids.join(',')},key,fetcher);
      videos=items.filter(v=>v.snippet?.channelId===c.id).map(v=>({externalId:v.id,title:v.snippet.title,date:v.snippet.publishedAt,thumbnail:v.snippet.thumbnails?.high?.url||v.snippet.thumbnails?.default?.url||'',duration:durationLabel(v.contentDetails?.duration),views:Number(v.statistics?.viewCount||0),url:'https://www.youtube.com/watch?v='+encodeURIComponent(v.id)})).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
    }
  }
  return {channel:{id:c.id,title:c.snippet?.title||'',url:'https://www.youtube.com/channel/'+c.id,views:Number(c.statistics?.viewCount||0),followers:c.statistics?.hiddenSubscriberCount?null:Number(c.statistics?.subscriberCount||0)},videos,updatedAt:new Date().toISOString()};
}
export default {
  async fetch(request,env){
    const path=new URL(request.url).pathname;
    if(request.method==='GET'&&path==='/health')return json({ok:true,service:'pulse-api'},200);
    const origin=request.headers.get('Origin');
    if(!env.ALLOWED_ORIGIN||origin!==env.ALLOWED_ORIGIN)return json({error:'Источник запроса не разрешён.'},403);
    const cors={'Access-Control-Allow-Origin':env.ALLOWED_ORIGIN,'Vary':'Origin','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'};
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
    if(path!=='/api/youtube/sync')return json({error:'Маршрут не найден.'},404,cors);
    if(request.method!=='POST')return json({error:'Используйте POST.'},405,cors);
    if(!env.PULSE_ACCESS_TOKEN||env.PULSE_ACCESS_TOKEN.length<32||!env.YOUTUBE_API_KEY)return json({error:'Не настроены секреты Worker: YOUTUBE_API_KEY и PULSE_ACCESS_TOKEN (минимум 32 символа).'},503,cors);
    if(request.headers.get('Authorization')!=='Bearer '+env.PULSE_ACCESS_TOKEN)return json({error:'Неверный код доступа Pulse.'},401,cors);
    if(!request.headers.get('Content-Type')?.includes('application/json'))return json({error:'Нужен JSON.'},415,cors);
    try{
      // Read at most 4 KiB, including streamed bodies without Content-Length.
      const reader=request.body?.getReader();if(!reader)throw new ApiError('Пустой запрос.');let bytes=0,chunks=[];
      while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>4096){await reader.cancel();throw new ApiError('Слишком большой запрос.',413)}chunks.push(value)}
      const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length}
      let body;try{body=JSON.parse(new TextDecoder().decode(buffer))}catch{throw new ApiError('Неверный JSON.')}
      if(typeof body?.channelUrl!=='string'||body.channelUrl.length>500)throw new ApiError('Укажите channelUrl.');
      return json(await youtubeSnapshot(body.channelUrl,env.YOUTUBE_API_KEY),200,cors);
    }catch(e){return json({error:e instanceof ApiError?e.message:'Не удалось получить данные. Повторите позже.'},e instanceof ApiError?e.status:502,cors)}
  }
};
