import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{channelFilter,youtubeSnapshot} from './worker.mjs';
const origin='https://rockky666.github.io';
const env={ALLOWED_ORIGIN:origin,YOUTUBE_API_KEY:'test-key',PULSE_ACCESS_TOKEN:'test-only-not-a-real-secret-1234567890'};
function request(body,token=env.PULSE_ACCESS_TOKEN,from=origin){return new Request('https://pulse.test/api/youtube/sync',{method:'POST',headers:{Origin:from,'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)})}
test('rejects unauthorized and cross-origin calls before contacting Google',async()=>{
 assert.equal((await worker.fetch(request({channelUrl:'https://youtube.com/@test'},'wrong'),env)).status,401);
 assert.equal((await worker.fetch(request({},env.PULSE_ACCESS_TOKEN,'https://other.example'),env)).status,403);
 assert.equal((await worker.fetch(request({channelUrl:'https://example.com/@test'}),env)).status,400);
});
test('preflight allows only configured origin and does not require bearer',async()=>{
 const r=await worker.fetch(new Request('https://pulse.test/api/youtube/sync',{method:'OPTIONS',headers:{Origin:origin}}),env);
 assert.equal(r.status,204);assert.equal(r.headers.get('Access-Control-Allow-Origin'),origin);
});
test('bounds request bodies and reports missing setup',async()=>{
 assert.equal((await worker.fetch(request({channelUrl:'a'.repeat(5000)}),env)).status,413);
 assert.equal((await worker.fetch(request({}),{ALLOWED_ORIGIN:origin})).status,503);
});
test('resolves handles without arbitrary upstream URLs',()=>{
 assert.deepEqual(channelFilter('https://www.youtube.com/@test/videos'),{forHandle:'@test'});
 assert.throws(()=>channelFilter('https://youtube.com.evil.example/@test'));
 assert.throws(()=>channelFilter('http://youtube.com/@test'));
});
test('combines channel totals and upload video metadata, preserving hidden subscribers',async()=>{
 let calls=[];const fetcher=async input=>{const u=new URL(input);calls.push(u);const resource=u.pathname.split('/').at(-1);const items=resource==='channels'?[{id:'UCtest',snippet:{title:'Test'},statistics:{viewCount:'100',hiddenSubscriberCount:true},contentDetails:{relatedPlaylists:{uploads:'UUtest'}}}]:resource==='playlistItems'?[{contentDetails:{videoId:'abc'}}]:[{id:'abc',snippet:{channelId:'UCtest',title:'Video',publishedAt:'2026-10-01T00:00:00Z',thumbnails:{high:{url:'https://i.ytimg.com/test.jpg'}}},statistics:{viewCount:'20'},contentDetails:{duration:'PT1H2M3S'}}];return Response.json({items})};
 const r=await youtubeSnapshot('https://youtube.com/@test','test-key',fetcher);
 assert.equal(r.channel.views,100);assert.equal(r.channel.followers,null);assert.equal(r.videos[0].views,20);assert.equal(r.videos[0].duration,'1:02:03');assert.equal(calls.length,3);assert.ok(calls.every(u=>u.hostname==='www.googleapis.com'));
});
test('upstream quota errors do not become empty successful data',async()=>{
 await assert.rejects(youtubeSnapshot('https://youtube.com/@test','test',async()=>Response.json({error:{errors:[{reason:'quotaExceeded'}]}},{status:403})),/Квота/);
});
