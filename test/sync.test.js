import test from 'node:test';
import assert from 'node:assert/strict';
import {sync,midnight,contract,balance} from '../src/sync.js';
import {ClickUp} from '../src/api.js';
function task(id='uwbh', extra={}) {
  return {id,name:'UWBH',markdown_description:'Human notes',custom_fields:Object.entries({Enabled:true,'Client Folder':'https://app.clickup.com/1/v/f/10','Contract start':'2026-01-01','Contract end':'2026-12-31','Hours allowance':200,...extra}).map(([name,value])=>({name,value}))};
}
function fixture() {
  const tasks=[task()], writes=[],comments=[];
  let hours=0, broken=false, timeout=false;
  const api={registry:async()=>tasks,task:async id=>structuredClone(tasks.find(t=>t.id===id)),members:async()=>['1','2'],folder:async()=>({id:'10',folders:[{id:'11'}]}),lists:async id=>id==='10'?[{id:'20',name:'ALICE'},{id:'21',name:'Outreach'}]:[{id:'22',name:'Marketing'},{id:'23',name:'Campaign'},{id:'24',name:'Unrelated'}],entries:async(w,l,s,start)=>{if(broken&&l==='22') throw Error('503'); return [{id:'e',start,duration:hours*3600000},{id:'running',start,duration:-1}];},comments:async()=>comments,update:async(id,description)=>{writes.push(id);tasks.find(t=>t.id===id).markdown_description=description;},comment:async(id,text)=>{comments.push({comment_text:text});if(timeout){timeout=false;throw Error('Timeout after acceptance');}}};
  const state={};
  const run=(opts={})=>sync({api,workspace:'1',registry:'registry',state,dryRun:false,...opts});
  return {api,tasks,writes,comments,state,run,hours:v=>hours=v,broken:v=>broken=v,timeout:()=>timeout=true};
}
test('UWBH onboarding: allowance, mixed scope allowlist, dry run no writes/state',async()=>{
  const f=fixture(); f.tasks[0]=task('uwbh',{'List allowlist':['20','21','22','23'].map(id=>`https://app.clickup.com/1/v/li/${id}`).join('\n')});
  f.hours(170);const [r]=await f.run({dryRun:true});
  assert.deepEqual(r.lists.map(l=>l.name),['ALICE','Outreach','Marketing','Campaign']);
  assert.equal(r.used,170);assert.deepEqual(r.firstRunReached,[80]);assert.equal(r.proposedComment,null);assert.deepEqual(f.state,{});assert.equal(f.writes.length,0);
});
test('second client and renewal are registry data only',async()=>{
 const f=fixture();await f.run(); f.tasks.push(task('second'),task('renewal',{'Contract start':'2027-01-01','Contract end':'2027-12-31'}));
 const r=await f.run();assert.equal(r.length,3);assert.equal(Object.keys(f.state).length,3);assert.ok(r[2].start.startsWith('2027'));
});
test('first run baselines; edits/deletions recalculate; rename retains alerts',async()=>{
 const f=fixture();f.hours(170);await f.run();assert.equal(f.comments.length,0);
 f.hours(210);await f.run();assert.equal(f.comments.length,1);f.tasks[0].name='Renamed';await f.run();assert.equal(f.comments.length,1);
 f.hours(0);await f.run();assert.equal(f.state.uwbh.used,0);f.hours(210);await f.run();assert.equal(f.comments.length,1);
});
test('partial API failure leaves balance and alert state intact and continues',async()=>{
 const f=fixture();await f.run();const before=structuredClone(f.state); const writes=f.writes.length;f.broken(true);f.hours(200);f.tasks.push(task('invalid',{'Hours allowance':0}));
 const r=await f.run();assert.ok(r.every(r=>r.error));assert.deepEqual(f.state,before);assert.equal(f.writes.length,writes);
 f.broken(false);f.tasks.push(task('healthy'));const next=await f.run();assert.equal(next.at(-1).used,200);
});
test('ambiguous comment acceptance does not duplicate, even after further threshold crossing',async()=>{
 const f=fixture();await f.run();f.hours(170);f.timeout();await f.run();assert.ok(f.state.uwbh.pending);
 f.hours(210);await f.run();assert.equal(f.comments.length,1);assert.deepEqual(f.state.uwbh.fired,[80]);await f.run();assert.equal(f.comments.length,2);assert.deepEqual(f.state.uwbh.fired,[80,100]);
});
test('simultaneous thresholds produce one comment; unchanged total leaves description alone',async()=>{
 const f=fixture();await f.run();f.hours(210);await f.run();assert.equal(f.comments.length,1);assert.match(f.comments[0].comment_text,/80%, 100%/);
 const count=f.writes.length;await f.run();assert.equal(f.writes.length,count);
});
test('migration pair, DST, invalid scope and managed notes',async()=>{
 assert.equal(midnight('2026-03-09','America/Denver')-midnight('2026-03-08','America/Denver'),23*3600000);
 assert.throws(()=>contract(task('x',{'AdOrbit opening hours':0}),'1'));
 const f=fixture();f.tasks[0]=task('uwbh',{'AdOrbit opening hours':25,'Cutover date':'2026-07-01'});f.hours(10);assert.equal((await f.run())[0].used,35);
 assert.ok(f.tasks[0].markdown_description.startsWith('Human notes'));
 f.tasks[0]=task('uwbh',{'List allowlist':'https://app.clickup.com/1/v/li/999'});assert.match((await f.run())[0].error,/outside/);
 assert.throws(()=>balance('<!-- retainer-balance:start -->',0,1,'now'));
});
test('HTTP adapter handles registry/comments pagination and defaults to blocked writes',async()=>{
 const api=new ClickUp('mock');await assert.rejects(api.update('x','text'),/disabled/);
 const calls=[];api.request=async(path,q)=>{calls.push(q);if(path.endsWith('/task'))return q.page===0?{tasks:[task()],last_page:false}:{tasks:[],last_page:true};return q.start_id?{comments:[]}:{comments:[{id:'c',date:'123'}]};};
 assert.equal((await api.registry('r')).length,1);assert.equal((await api.comments('x')).length,1);assert.equal(calls.at(-1).start_id,'c');
});
