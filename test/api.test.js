import test from 'node:test';
import assert from 'node:assert/strict';
import {ClickUp} from '../src/api.js';
function runtime(responses) {
 let time=100000,calls=0;const waits=[],logs=[];
 return {waits,logs,calls:()=>calls,options:{now:()=>time,sleep:async ms=>{waits.push(ms);time+=ms;},log:message=>logs.push(message),fetch:async()=>{const r=responses[Math.min(calls++,responses.length-1)];return new Response(JSON.stringify(r.body ?? {}),{status:r.status,headers:r.headers});}}};
}
test('429 retries honor reset header, preserve read-only guard, and pace requests',async()=>{
 const r=runtime([{status:429,headers:{'X-RateLimit-Reset':'160'}},{status:200}]);
 const api=new ClickUp('mock',false,r.options);
 await api.request('team');assert.equal(r.calls(),2);assert.equal(r.waits.reduce((a,b)=>a+b,0),61000);assert.equal(r.logs.length,1);
 await api.request('team');assert.equal(r.waits.at(-1),650);
 await assert.rejects(api.comment('x','text'),/disabled/);assert.equal(r.calls(),3);
});
test('persistent 429 stops after bounded retries and Retry-After is honored',async()=>{
 const r=runtime([{status:429,headers:{'Retry-After':'2'}}]);
 await assert.rejects(new ClickUp('mock',false,r.options).request('team'),/HTTP 429/);
 assert.equal(r.calls(),6);assert.equal(r.waits[0],2000);
});
test('time queries batch all staff into contiguous 30-day ranges',async()=>{
 const api=new ClickUp('mock'),calls=[];
 api.request=async(path,query)=>{calls.push(query);return {data:[]};};
 const day=86400000;
 await api.entries('w','l',['1','2','3'],0,365*day);
 assert.equal(calls.length,13);assert.ok(calls.every(q=>q.assignee==='1,2,3'));
 assert.equal(calls[0].start_date,0);assert.equal(calls.at(-1).end_date,365*day-1);
 for(let i=1;i<calls.length;i++)assert.equal(calls[i].start_date,calls[i-1].end_date+1);
});
