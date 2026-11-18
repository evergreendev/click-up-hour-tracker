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
test('UWBH onboarding: entire Folder and subfolders, dry run no writes/state',async()=>{
  const f=fixture();
  f.hours(170);const [r]=await f.run({dryRun:true});
  assert.deepEqual(r.lists.map(l=>l.name),['ALICE','Outreach','Marketing','Campaign','Unrelated']);
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

test('ClickUp Date fields use authorized user calendar date, then contract timezone boundaries',()=>{
  // ClickUp returns 04:00 in the API user's zone. In Tokyo, Jan 1 is still Dec 31 UTC.
  const t=task('dates',{'Contract start':String(Date.parse('2026-01-01T04:00:00+09:00')),'Contract end':String(Date.parse('2026-12-31T04:00:00+09:00')),'AdOrbit opening hours':20,'Cutover date':String(Date.parse('2026-07-01T04:00:00+09:00'))});
  for(const f of t.custom_fields) if(['Contract start','Contract end','Cutover date'].includes(f.name)) {f.type='date';f.value_options={time:false};}
  const c=contract(t,'1','Asia/Tokyo');
  assert.equal(c.start,midnight('2026-01-01','America/Denver'));
  assert.equal(c.end,midnight('2027-01-01','America/Denver'));
  assert.equal(c.from,midnight('2026-07-01','America/Denver'));
  assert.throws(()=>contract(t,'1'),/timezone required/);
  t.custom_fields.find(f=>f.name==='Contract start').value_options.time=true;
  assert.throws(()=>contract(t,'1','Asia/Tokyo'),/without a time/);
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

test('monthly sync accepts ClickUp Date fields and preserves carryover calculation',async()=>{
 const f=monthlyFixture();
 f.api.dateTimezone='Asia/Tokyo';
 for(const field of f.tasks[0].custom_fields) {
   if(['Contract start','Contract end'].includes(field.name)) {
     field.value=String(Date.parse(field.value+'T04:00:00+09:00'));
     field.type='date';
     field.value_options={time:false};
   }
 }
 f.entries([entry('jan','2026-01-15',15),entry('feb','2026-02-05',3)]);
 const [r]=await f.month('2026-02-10');
 assert.equal(r.error,undefined);
 assert.equal(r.monthly.allowance,25);
 assert.equal(r.used,3);
 assert.equal(r.remaining,22);
 assert.equal(f.tasks[0].custom_fields.find(v=>v.id==='budget').value,25);
});

test('dry run previews all tasks regardless of Enabled; apply still skips disabled tasks',async()=>{
 const f=fixture();f.tasks[0]=task('uwbh',{Enabled:false});
 f.tasks.push(task('second'));
 const results=await f.run({dryRun:true});
 assert.equal(results.length,2);
 assert.equal(results[0].enabled,false);assert.equal(results[0].used,0);
 assert.equal(results[1].enabled,true);assert.equal(results[1].used,0);
 f.tasks.pop();
 let [r]=await f.run({dryRun:true});
 assert.equal(r.skipped,undefined);assert.equal(r.used,0);
 [r]=await f.run({dryRun:true,taskId:'uwbh'});assert.equal(r.used,0);
 [r]=await f.run();assert.equal(r.skipped,true);assert.match(r.reason,/unchecked/);
 f.tasks[0].custom_fields=f.tasks[0].custom_fields.filter(v=>v.name!=='Enabled');
 [r]=await f.run({dryRun:true});assert.equal(r.used,0);assert.equal(r.enabled,false);
 [r]=await f.run();assert.match(r.reason,/Missing custom field/);
 f.tasks.length=0;
 [r]=await f.run({dryRun:true});assert.match(r.reason,/No tasks found/);
 assert.equal(f.writes.length,0);assert.deepEqual(f.state,{});
});

test('field matching accepts ClickUp title capitalization, including monthly output field',async()=>{
 const f=monthlyFixture();f.api.dateTimezone='America/Denver';
 for(const field of f.tasks[0].custom_fields) field.name=field.name.replace(/\b\w/g,c=>c.toUpperCase());
 for(const field of f.tasks[0].custom_fields) {
   if(field.name==='Contract Start') {field.type='date';field.value='1767265200000';}
   if(field.name==='Contract End') {field.type='date';field.value='1798714800000';}
 }
 const [r]=await f.month('2026-02-10');
 assert.equal(r.error,undefined);assert.equal(r.monthly.allowance,40);
 assert.throws(()=>contract(task('missing',{'Contract start':undefined}),'1'),/Contract start: select a date/);
 const duplicate=task();duplicate.custom_fields.push({name:'Contract Start',value:'2026-01-01'});
 assert.throws(()=>contract(duplicate,'1'),/Duplicate field/);
});

test('Folder overview links resolve to their Folder without changing task data',async()=>{
 const f=fixture();f.tasks[0]=task('uwbh',{'Client Folder':'https://app.clickup.com/1/v/db/2ky4p13w-5099'});
 const requested=[];f.api.view=async id=>{requested.push(id);return {view:{parent:{type:5,id:'10'}}};};
 let [r]=await f.run({dryRun:true});assert.equal(r.error,undefined);assert.equal(r.lists.length,5);
 assert.deepEqual(requested,['2ky4p13w-5099']);
 assert.equal(f.tasks[0].custom_fields.find(v=>v.name==='Client Folder').value,'https://app.clickup.com/1/v/db/2ky4p13w-5099');
 f.api.view=async()=>({view:{parent:{type:4,id:'10'}}});
 [r]=await f.run({dryRun:true});assert.match(r.error,/not located in a Folder/);
 f.tasks[0]=task('uwbh',{'Client Folder':'https://app.clickup.com/2/v/db/2ky4p13w-5099'});
 [r]=await f.run({dryRun:true});assert.match(r.error,/cross-workspace/);
 assert.equal(f.writes.length,0);assert.deepEqual(f.state,{});
});

test('Hours remaining field updates fixed budget, overage and corrections without redundant writes',async()=>{
 const f=fixture(),updates=[];
 f.tasks[0].custom_fields.push({id:'remaining',name:'Hours remaining',type:'number'});
 f.api.setField=async(id,field,value)=>{updates.push(value);f.tasks[0].custom_fields.find(v=>v.id===field).value=value;};
 f.hours(103.600608);await f.run({dryRun:true});assert.equal(updates.length,0);
 await f.run();assert.deepEqual(updates,[96.4]);await f.run();assert.equal(updates.length,1);
 f.hours(210);await f.run();assert.equal(updates.at(-1),-10);
 f.hours(100);await f.run();assert.equal(updates.at(-1),100);
 f.broken(true);await f.run();assert.equal(updates.length,3);
});
test('Hours remaining uses adjusted monthly budget; invalid field blocks all publishing',async()=>{
 const f=monthlyFixture();
 f.tasks[0].custom_fields.push({id:'remaining',name:'Hours remaining',type:'number'});
 f.entries([entry('jan','2026-01-15',15),entry('feb','2026-02-05',3)]);
 await f.month('2026-02-10');
 assert.equal(f.tasks[0].custom_fields.find(v=>v.id==='remaining').value,22);
 const g=fixture();g.tasks[0].custom_fields.push({id:'remaining',name:'Hours remaining',type:'text'});
 const [r]=await g.run();assert.match(r.error,/must be a Number/);assert.equal(g.writes.length,0);assert.deepEqual(g.state,{});
});

function progressFixture(f=fixture(),start=0,end=100) {
 const updates=[];
 f.tasks[0].custom_fields.push({id:'progress',name:'Budget remaining',type:'manual_progress',type_config:{start,end}},{id:'remaining',name:'Hours remaining',type:'number'});
 f.api.setField=async(id,field,value)=>{updates.push({field,value});f.tasks[0].custom_fields.find(v=>v.id===field).value=value;};
 return {...f,updates};
}
test('Budget remaining previews and updates alongside Hours remaining; unchanged values avoid writes',async()=>{
 const f=progressFixture();f.hours(103.600608);
 const [preview]=await f.run({dryRun:true});
 assert.equal(preview.budgetRemainingPercent,48.2);
 assert.deepEqual(preview.proposedProgressUpdate,{fieldId:'progress',value:{current:48.2}});
 assert.equal(f.updates.length,0);assert.equal(f.writes.length,0);assert.deepEqual(f.state,{});
 await f.run();assert.deepEqual(f.updates,[{field:'remaining',value:96.4},{field:'progress',value:{current:48.2}}]);
 await f.run();assert.equal(f.updates.length,2);
 f.hours(210);await f.run();assert.deepEqual(f.updates.slice(-2),[{field:'remaining',value:-10},{field:'progress',value:{current:0}}]);
 f.hours(0);await f.run();assert.deepEqual(f.updates.at(-1),{field:'progress',value:{current:100}});
 f.broken(true);const count=f.updates.length;await f.run();assert.equal(f.updates.length,count);
});
test('Budget remaining maps percentage to configured range, accepts numeric current strings and legacy manual type',async()=>{
 const f=progressFixture(fixture(),10,30);
 const field=f.tasks[0].custom_fields.find(v=>v.id==='progress');
 field.name='BUDGET REMAINING';field.type='progress';field.type_config.method='manual';
 f.hours(100);await f.run();assert.deepEqual(f.updates.at(-1),{field:'progress',value:{current:20}});
 field.value={current:'20',percent:50};const count=f.updates.length;await f.run();assert.equal(f.updates.length,count);
});
test('monthly progress uses carryover-adjusted budget and handles zero or negative available budgets',async()=>{
 const f=progressFixture(monthlyFixture());
 f.entries([entry('jan','2026-01-15',15),entry('feb','2026-02-05',3)]);
 let [r]=await f.month('2026-02-10');assert.equal(r.budgetRemainingPercent,88);
 assert.deepEqual(f.updates.at(-1),{field:'progress',value:{current:88}});
 f.entries([entry('jan','2026-01-15',40)]);
 [r]=await f.month('2026-02-10');assert.equal(r.monthly.allowance,0);assert.equal(r.budgetRemainingPercent,0);
 f.entries([entry('jan','2026-01-15',50)]);
 [r]=await f.month('2026-02-10');assert.equal(r.monthly.allowance,-10);assert.equal(r.budgetRemainingPercent,0);
});
test('Budget remaining rejects auto progress or invalid ranges before publishing',async()=>{
 for(const config of [{type:'automatic_progress'},{type_config:{start:100,end:0}},{type_config:{start:0}}]) {
   const f=progressFixture();Object.assign(f.tasks[0].custom_fields.find(v=>v.id==='progress'),config);
   const [r]=await f.run();assert.match(r.error,/Budget remaining/);
   assert.equal(f.updates.length,0);assert.equal(f.writes.length,0);assert.deepEqual(f.state,{});
 }
});
