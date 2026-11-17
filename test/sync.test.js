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

function monthlyFixture() {
 const f=fixture();
 f.tasks[0]=task('uwbh',{'Monthly budget hours':20});
 f.tasks[0].custom_fields.push({id:'budget',name:'Current month budget hours',type:'number'});
 f.api.setField=async(id,field,value)=>{f.writes.push({field,value});f.tasks[0].custom_fields.find(v=>v.id===field).value=value;};
 let entries=[];
 f.api.entries=async()=>entries;
 return {...f,entries:v=>entries=v,month:date=>f.run({now:()=>date+'T12:00:00Z'})};
}
const entry=(id,date,hours)=>({id,start:midnight(date,'America/Denver'),duration:hours*3600000});
test('monthly budget carries unused hours and overages, recalculates and does not compound',async()=>{
 const f=monthlyFixture();f.entries([entry('jan','2026-01-15',15),entry('feb','2026-02-05',3)]);
 let [r]=await f.month('2026-02-10');assert.equal(r.monthly.allowance,25);assert.equal(r.used,3);assert.equal(r.remaining,22);
 const writes=f.writes.length;await f.month('2026-02-10');assert.equal(f.writes.length,writes);
 f.entries([entry('jan','2026-01-15',25)]);[r]=await f.month('2026-02-10');assert.equal(r.monthly.allowance,15);
 [r]=await f.month('2026-04-10');assert.equal(r.monthly.allowance,55);
 assert.match(f.tasks[0].markdown_description,/2026-04/);
});
test('monthly mode dry run, negative carryover, validation and migration',async()=>{
 const f=monthlyFixture();f.entries([entry('jan','2026-01-15',50)]);
 let [r]=await f.run({dryRun:true,now:()=> '2026-02-10T12:00:00Z'});
 assert.equal(r.monthly.allowance,-10);assert.equal(f.writes.length,0);assert.deepEqual(f.state,{});
 [r]=await f.month('2027-01-10');assert.match(r.error,/outside/);
 f.tasks[0].custom_fields=f.tasks[0].custom_fields.filter(v=>v.id!=='budget');
 [r]=await f.month('2026-02-10');assert.match(r.error,/Current month budget/);
 const g=monthlyFixture();g.tasks[0].custom_fields.push({name:'AdOrbit opening hours',value:25},{name:'Cutover date',value:'2026-02-01'});
 [r]=await g.month('2026-03-10');assert.equal(r.monthly.allowance,35);
});
test('custom field adapter uses dedicated endpoint and write guard',async()=>{
 const api=new ClickUp('mock');await assert.rejects(api.setField('x','b',25),/disabled/);
 api.request=async(...args)=>args;assert.deepEqual(await api.setField('x','b',25),['task/x/field/b',{},'POST',{value:25}]);
});
