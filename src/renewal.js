// Annual renewal is journaled before creation because ClickUp has no create idempotency key.
const normalized=name=>String(name).trim().toLowerCase();
const checked=value=>[true,'true',1,'1'].includes(value);
const get=(task,name)=>task.custom_fields?.find(f=>normalized(f.name)===normalized(name));
const managed=['Auto-renew','Client Folder','Contract start','Contract end','Hours allowance','Monthly budget hours','Current month budget hours','Hours remaining','Budget remaining','Timezone','Alert thresholds','List allowlist'];
const startMarker='<!-- retainer-balance:start -->',endMarker='<!-- retainer-balance:end -->';

export async function renewContract({api,task,c,workspace,registry,tasks,state,save,dryRun,instant,midnight}) {
  const year=Number(new Intl.DateTimeFormat('en-US',{timeZone:c.zone,year:'numeric'}).format(new Date(instant)));
  const start=midnight(`${year}-01-01`,c.zone);
  const auto=get(task,'Auto-renew');
  const prior=state[c.id]?.renewal;
  if(prior?.status==='complete') return null;
  if(!prior && (normalized(task.status?.status)!=='active' || !checked(auto?.value) || c.end>start)) return null;
  if(auto?.type && auto.type!=='checkbox') throw Error('Auto-renew must be a Checkbox field');
  const localEnd=new Intl.DateTimeFormat('en-US',{timeZone:c.zone,month:'2-digit',day:'2-digit'}).format(new Date(c.end-1));
  if(localEnd!=='12/31') throw Error('Auto-renew requires a contract ending December 31');
  const list=await api.list(registry);
  const active=list.statuses?.find(s=>normalized(s.status)==='active')?.status;
  const closed=list.statuses?.find(s=>normalized(s.status)==='closed')?.status;
  if(!active || !closed) throw Error('Auto-renew requires ACTIVE and CLOSED statuses in the Client Retainers List');
  const startField=get(task,'Contract start'),endField=get(task,'Contract end');
  if(!auto?.id || !startField?.id || !endField?.id) throw Error('Auto-renew requires field IDs for Auto-renew, Contract start and Contract end');
  let journal=prior;
  const targetYear=journal?.year ?? year;
  const marker=`[retainer-renewal:${c.id}:${targetYear}]`;
  const nextStart=`${targetYear}-01-01`,nextEnd=`${targetYear}-12-31`;
  function encode(field,date) {
    if(field.type==='date') {
      if(!api.dateTimezone) throw Error('Authorized user timezone required for renewal dates');
      return midnight(date,api.dateTimezone)+4*3600000;
    }
    return date;
  }
  let description=task.markdown_description ?? task.description ?? '';
  if(description.includes(startMarker)) {
    if(!description.includes(endMarker) || description.indexOf(endMarker)<description.indexOf(startMarker) || description.split(startMarker).length>2 || description.split(endMarker).length>2) throw Error('Malformed managed balance block');
    description=description.slice(0,description.indexOf(startMarker))+description.slice(description.indexOf(endMarker)+endMarker.length);
  } else if(description.includes(endMarker)) throw Error('Malformed managed balance block');
  description=description.replace(/\[retainer-renewal:[^\]]+\]/g,'').trim();
  const sourceYear=new Intl.DateTimeFormat('en-US',{timeZone:c.zone,year:'numeric'}).format(c.end-1);
  const name=task.name.match(new RegExp(`\\b${sourceYear}\\b`)) ? task.name.replace(new RegExp(`\\b${sourceYear}\\b`,'g'),String(targetYear)) : `${task.name} - ${targetYear}`;
  const initialBudget=c.monthly ? Number(get(task,'Monthly budget hours').value) : c.overallAllowance;
  const custom_fields=[];
  for(const field of task.custom_fields || []) {
    const key=managed.find(n=>normalized(n)===normalized(field.name));
    if(!key) continue;
    if(!field.id) throw Error(`Auto-renew requires a field ID for ${field.name}`);
    let value=field.value;
    if(key==='Auto-renew') value=true;
    if(key==='Contract start') value=encode(field,nextStart);
    if(key==='Contract end') value=encode(field,nextEnd);
    if(key==='Current month budget hours') value=initialBudget;
    if(key==='Hours remaining') value=c.overallAllowance;
    if(key==='Budget remaining') value={current:Number(field.type_config.end)};
    if(value!==undefined && value!==null && value!=='') custom_fields.push({id:field.id,value});
  }
  const payload={name,status:closed,markdown_content:`${description}${description?'\n\n':''}${marker}`,start_date:midnight(nextStart,c.zone),due_date:midnight(nextEnd,c.zone),start_date_time:false,due_date_time:false,notify_all:false,custom_fields,assignees:(task.assignees || []).map(u=>Number(u.id)),tags:(task.tags || []).map(t=>t.name),custom_item_id:task.custom_item_id ?? 0};
  const followers=(task.watchers || []).map(u=>Number(u.id));
  if(followers.some(id=>!Number.isSafeInteger(id))) throw Error('Invalid follower ID on renewal source');
  const matches=[];
  for(const item of tasks) {
    if(String(item.id)===c.id) continue;
    const candidate=await api.task(item.id);
    if((candidate.markdown_description ?? candidate.description ?? '').includes(marker)) matches.push(candidate);
  }
  if(matches.length>1) throw Error('Multiple renewal tasks found; resolve duplicates before continuing');
  if(dryRun) return {id:c.id,name:task.name,renewal:{year:targetYear,existingTaskId:matches[0]?.id ?? journal?.taskId ?? null,proposedTask:journal?.payload ?? payload,followers:journal?.followers ?? followers,newTaskStatus:active,sourceTaskStatus:closed}};
  const record=async renewal=>{
    const next={used:0,changed:instant,fired:[],...state[c.id],renewal};
    await save({...state,[c.id]:next});state[c.id]=next;
  };
  if(!journal) {
    journal={year:targetYear,status:'prepared',payload,followers};
    await record(journal);
  }
  let child=matches[0];
  if(!child && journal.taskId) child=await api.task(journal.taskId);
  if(!child) {
    if(journal.status==='creating') throw Error('Renewal creation has an uncertain outcome. No marked task is visible; creation will not be retried automatically. Check ClickUp and the renewal journal before retrying.');
    journal={...journal,status:'creating'};await record(journal);
    child=await api.createTask(registry,journal.payload);
    if(!child?.id) throw Error('Renewal creation returned no task ID; reconcile before retrying');
    journal={...journal,status:'created',taskId:String(child.id)};await record(journal);
  } else if(!journal.taskId) {
    journal={...journal,status:'created',taskId:String(child.id)};await record(journal);
  }
  const id=String(child.id);
  // Older journals may include the retired Enabled checkbox; it no longer gates activation.
  const expectedFields=journal.payload.custom_fields.filter(expected=>task.custom_fields.some(f=>f.id===expected.id && managed.some(n=>normalized(n)===normalized(f.name))));
  await api.setFollowers(id,journal.followers);
  // Confirm custom fields were actually saved for this task type before activation.
  child=await api.task(id);
  for(const expected of expectedFields) {
    const actual=child.custom_fields?.find(f=>f.id===expected.id);
    if(!actual) throw Error(`Renewal task ${id} is missing custom field ${expected.id}`);
    const value=typeof expected.value==='object' ? actual.value?.current : actual.value;
    const target=typeof expected.value==='object' ? expected.value.current : expected.value;
    if(String(value)!==String(target)) await api.setField(id,expected.id,expected.value);
  }
  for(const field of child.custom_fields || []) if(['adorbit opening hours','cutover date'].includes(normalized(field.name)) && field.value!==undefined && field.value!==null && field.value!=='') await api.clearField(id,field.id);
  child=await api.task(id);
  for(const expected of expectedFields) {
    const actual=child.custom_fields?.find(f=>f.id===expected.id)?.value;
    const value=typeof expected.value==='object' ? actual?.current : actual;
    const target=typeof expected.value==='object' ? expected.value.current : expected.value;
    if(String(value)!==String(target)) throw Error(`Renewal task ${id} custom field ${expected.id} was not saved; old contract remains ACTIVE`);
  }
  if((child.custom_fields || []).some(f=>['adorbit opening hours','cutover date'].includes(normalized(f.name)) && f.value!==undefined && f.value!==null && f.value!=='')) throw Error('Renewal migration fields were not cleared');
  const actualFollowers=new Set((child.watchers || []).map(u=>Number(u.id)));
  if(journal.followers.some(u=>!actualFollowers.has(u))) throw Error(`Renewal task ${id} followers were not copied; old contract remains ACTIVE`);
  await api.setStatus(id,active);
  child=await api.task(id);
  if(normalized(child.status?.status)!==normalized(active)) throw Error(`Renewal task ${id} did not become ACTIVE; old contract remains ACTIVE`);
  await api.setStatus(c.id,closed);
  await record({...journal,status:'complete'});
  if(!tasks.some(t=>String(t.id)===id)) tasks.push({id});
  return {id:c.id,name:task.name,renewal:{year:targetYear,taskId:id,status:'created'}};
}
