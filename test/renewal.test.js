import test from 'node:test';
import assert from 'node:assert/strict';
import {sync,midnight} from '../src/sync.js';
function fixture({monthly=true,dates=false}={}) {
 const values={'Auto-renew':true,'Client Folder':'https://app.clickup.com/1/v/f/10','Contract start':'2026-01-01','Contract end':'2026-12-31','Hours allowance':336,'AdOrbit opening hours':180.5,'Cutover date':'2026-11-20','Hours remaining':155.5,'Budget remaining':{current:46.28}};
 if(monthly) Object.assign(values,{'Monthly budget hours':28,'Current month budget hours':127.5});
 const tasks=[{id:'old',status:{status:'ACTIVE'},name:'UWBH 2026',markdown_description:'Human notes\n<!-- retainer-balance:start -->\nOld balance\n<!-- retainer-balance:end -->',watchers:[{id:123}],assignees:[{id:123}],tags:[{name:'client'}],custom_fields:Object.entries(values).map(([name,value],i)=>({id:'f'+i,name,value,type:['Enabled','Auto-renew'].includes(name)?'checkbox':name==='Budget remaining'?'manual_progress':/hours|allowance/i.test(name)?'number':dates&&['Contract start','Contract end','Cutover date'].includes(name)?'date':'text',type_config:name==='Budget remaining'?{start:0,end:100}:undefined}))}];
 if(dates) for(const f of tasks[0].custom_fields) if(f.type==='date') f.value=midnight(f.value,'Asia/Tokyo')+4*3600000;
 const state={},writes=[],creates=[];let timeout=false,followersFail=false,scopeFail=false,usage=0;
 const api={list:async()=>({statuses:[{status:'ACTIVE'},{status:'CLOSED'}]}),setStatus:async(id,status)=>{writes.push({id,status});tasks.find(t=>t.id===id).status={status};},dateTimezone:'Asia/Tokyo',registry:async()=>structuredClone(tasks),members:async()=>['123'],task:async id=>structuredClone(tasks.find(t=>t.id===String(id))),folder:async()=>{if(scopeFail)throw Error('scope failed');return {id:'10'};},lists:async()=>[{id:'20',name:'Service'}],entries:async(w,l,s,start)=>usage?[{id:'entry',start,duration:usage*3600000}]:[],comments:async()=>[],comment:async()=>{writes.push('comment');},update:async(id,text)=>{writes.push('description');tasks.find(t=>t.id===id).markdown_description=text;},
 createTask:async(list,body)=>{creates.push(structuredClone(body));const original=tasks[0];const child={id:'new'+creates.length,status:{status:body.status},name:body.name,markdown_description:body.markdown_content,watchers:[],assignees:body.assignees.map(id=>({id})),custom_fields:original.custom_fields.map(f=>({...f,value:body.custom_fields.find(v=>v.id===f.id)?.value}))};tasks.push(child);if(timeout){timeout=false;throw Error('timeout after create');}return structuredClone(child);},
 setField:async(id,field,value)=>{writes.push({id,field,value});tasks.find(t=>t.id===id).custom_fields.find(f=>f.id===field).value=value;},clearField:async(id,field)=>{writes.push('clear');delete tasks.find(t=>t.id===id).custom_fields.find(f=>f.id===field).value;},setFollowers:async(id,users)=>{if(followersFail)throw Error('followers failed');writes.push('followers');tasks.find(t=>t.id===id).watchers=users.map(id=>({id}));}};
 const field=(task,name)=>task.custom_fields.find(f=>f.name===name);
 return {tasks,state,writes,creates,api,field,timeout:()=>timeout=true,failFollowers:v=>followersFail=v,failScope:v=>scopeFail=v,usage:v=>usage=v,run:(options={})=>sync({api,workspace:'1',registry:'registry',state,dryRun:false,now:()=> '2027-01-01T08:00:00Z',...options})};
}
test('annual renewal creates new year dates, fresh budgets, followers and disables source; next run does not duplicate',async()=>{
 const f=fixture();f.state.old={used:180.5,changed:'2026-12-31T12:00:00Z',fired:[80,100]};
 let r=await f.run();assert.ok(!r.some(v=>v.error),JSON.stringify(r));assert.equal(f.creates.length,1);
 const child=f.tasks[1];assert.equal(child.name,'UWBH 2027');assert.equal(f.field(child,'Contract start').value,'2027-01-01');assert.equal(f.field(child,'Contract end').value,'2027-12-31');
 assert.equal(f.field(child,'Auto-renew').value,true);assert.equal(f.field(child,'Enabled'),undefined);
 assert.equal(child.status.status,'ACTIVE');assert.equal(f.tasks[0].status.status,'CLOSED');
 assert.equal(f.field(child,'AdOrbit opening hours').value,undefined);assert.equal(f.field(child,'Cutover date').value,undefined);
 assert.equal(f.field(child,'Hours remaining').value,336);assert.equal(f.field(child,'Current month budget hours').value,28);assert.deepEqual(f.field(child,'Budget remaining').value,{current:100});
 assert.deepEqual(child.watchers,[{id:123}]);assert.match(child.markdown_description,/Human notes/);assert.doesNotMatch(child.markdown_description,/Old balance/);
 assert.deepEqual(f.state[child.id].fired,[]);assert.equal(f.state.old.renewal.status,'complete');
 await f.run();assert.equal(f.creates.length,1);
});
test('renewal respects contract timezone midnight, catches up after missed January 1, and supports Date fields',async()=>{
 const f=fixture({dates:true});await f.run({now:()=> '2027-01-01T06:59:00Z'});assert.equal(f.creates.length,0);
 const r=await f.run({now:()=> '2027-01-03T12:00:00Z'});assert.ok(!r.some(v=>v.error),JSON.stringify(r));
 assert.equal(f.field(f.tasks[1],'Contract start').value,midnight('2027-01-01','Asia/Tokyo')+4*3600000);
});
test('dry-run previews renewal with no writes or state; unchecked Auto-renew does not create',async()=>{
 const f=fixture();const [r]=await f.run({dryRun:true});assert.equal(r.renewal.year,2027);assert.equal(r.renewal.newTaskStatus,'ACTIVE');assert.equal(r.renewal.sourceTaskStatus,'CLOSED');assert.equal(f.creates.length,0);assert.equal(f.writes.length,0);assert.deepEqual(f.state,{});
 f.field(f.tasks[0],'Auto-renew').value=false;await f.run();assert.equal(f.creates.length,0);
});
test('accepted create timeout is reconciled by marker without another create',async()=>{
 const f=fixture();f.timeout();let r=await f.run();assert.match(r[0].error,/timeout/);assert.equal(f.creates.length,1);assert.equal(f.tasks[0].status.status,'ACTIVE');
 r=await f.run();assert.ok(!r.some(v=>v.error),JSON.stringify(r));assert.equal(f.creates.length,1);assert.equal(f.state.old.renewal.status,'complete');
});
test('followers failure preserves old ACTIVE contract, leaves new task CLOSED, and resumes',async()=>{
 const f=fixture();f.failFollowers(true);let r=await f.run();assert.match(r[0].error,/followers/);
 assert.equal(f.tasks[0].status.status,'ACTIVE');assert.equal(f.tasks[1].status.status,'CLOSED');
 f.failFollowers(false);r=await f.run();assert.ok(!r.some(v=>v.error),JSON.stringify(r));assert.equal(f.creates.length,1);
});
test('scope failure never creates a renewal and future years renew from the new task',async()=>{
 const f=fixture({monthly:false});f.failScope(true);await f.run();assert.equal(f.creates.length,0);assert.deepEqual(f.state,{});
 f.failScope(false);await f.run();await f.run({now:()=> '2028-01-02T12:00:00Z'});assert.equal(f.creates.length,2);
 assert.equal(f.tasks[2].name,'UWBH 2028');assert.equal(f.field(f.tasks[2],'Contract end').value,'2028-12-31');
});
test('ambiguous missing creation is never retried blindly',async()=>{
 const f=fixture();f.api.createTask=async()=>{throw Error('network error');};await f.run();
 const r=await f.run();assert.match(r[0].error,/uncertain outcome/);
});

test('renewal resumes after source was CLOSED but completion state could not be saved',async()=>{
 const f=fixture();let fail=true;
 let r=await f.run({save:async data=>{if(fail && data.old?.renewal?.status==='complete'){fail=false;throw Error('state disk error');}}});
 assert.ok(r.some(v=>/state disk error/.test(v.error || '')));
 assert.equal(f.tasks[0].status.status,'CLOSED');
 assert.equal(f.state.old.renewal.status,'created');
 r=await f.run();assert.ok(!r.some(v=>v.error),JSON.stringify(r));
 assert.equal(f.creates.length,1);assert.equal(f.state.old.renewal.status,'complete');
});

test('renewal fails before writes if the required List statuses are unavailable',async()=>{
 const f=fixture();f.api.list=async()=>({statuses:[{status:'OPEN'},{status:'CLOSED'}]});
 const [r]=await f.run();assert.match(r.error,/ACTIVE and CLOSED/);
 assert.equal(f.creates.length,0);assert.equal(f.writes.length,0);assert.deepEqual(f.state,{});
});
test('failed activation leaves source open; retry completes status changes without duplicate creation',async()=>{
 const f=fixture();const setStatus=f.api.setStatus;let fail=true;
 f.api.setStatus=async(id,status)=>{if(status==='ACTIVE'&&fail){fail=false;throw Error('activation failed');}return setStatus(id,status);};
 let [r]=await f.run();assert.match(r.error,/activation failed/);
 assert.notEqual(f.tasks[0].status?.status,'CLOSED');assert.equal(f.tasks[0].status.status,'ACTIVE');
 assert.equal(f.tasks[1].status.status,'CLOSED');
 await f.run();assert.equal(f.creates.length,1);assert.equal(f.tasks[1].status.status,'ACTIVE');assert.equal(f.tasks[0].status.status,'CLOSED');
});
test('failed closing preserves pending renewal and retries without another task',async()=>{
 const f=fixture();const setStatus=f.api.setStatus;let fail=true;
 f.api.setStatus=async(id,status)=>{if(status==='CLOSED'&&fail){fail=false;throw Error('close failed');}return setStatus(id,status);};
 let [r]=await f.run();assert.match(r.error,/close failed/);assert.equal(f.state.old.renewal.status,'created');
 assert.equal(f.tasks[0].status.status,'ACTIVE');assert.equal(f.tasks[1].status.status,'ACTIVE');
 await f.run();assert.equal(f.creates.length,1);assert.equal(f.tasks[0].status.status,'CLOSED');assert.equal(f.state.old.renewal.status,'complete');
});
