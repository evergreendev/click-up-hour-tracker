import {createHash} from 'node:crypto';
import {renewContract} from './renewal.js';
const BEGIN='<!-- retainer-balance:start -->', END='<!-- retainer-balance:end -->';
const fail = message => { throw Error(message); };
const FIELD_NAMES=['Enabled','Auto-renew','Client Folder','Contract start','Contract end','Hours allowance','Monthly budget hours','Current month budget hours','Hours remaining','Budget remaining','Timezone','Alert thresholds','List allowlist','AdOrbit opening hours','Cutover date'];
const fieldName=name=>FIELD_NAMES.find(n=>n.toLowerCase()===String(name).trim().toLowerCase()) ?? String(name).trim();
export function fields(task) {
  const f={};
  for (const field of task.custom_fields || []) {
    const name=fieldName(field.name);
    if (Object.hasOwn(f,name)) fail(`Duplicate field: ${name}`);
    f[name]=field.value;
  }
  return f;
}
export function link(value, type, workspace) {
  const u=new URL(String(value));
  if (u.protocol!=='https:' || u.hostname!=='app.clickup.com') fail(`Invalid ${type} link`);
  const patterns=type==='folder' ? [/^\/(\d+)\/v\/f\/(\d+)$/, /^\/(\d+)\/v\/o\/f\/(\d+)$/] : [/^\/(\d+)\/v\/li\/(\d+)$/, /^\/(\d+)\/v\/l\/6-(\d+)-\d+$/];
  const m=patterns.map(p=>u.pathname.match(p)).find(Boolean);
  if (!m || m[1]!==workspace) fail(`Invalid or cross-workspace ${type} link`);
  return m[2];
}
export async function resolveFolderTask(api,task,workspace) {
  const value=fields(task)['Client Folder'];
  let url;
  try {url=new URL(String(value));} catch {fail('Client Folder: enter a ClickUp Folder link');}
  const match=url.pathname.match(/^\/(\d+)\/v\/db\/([a-zA-Z0-9-]+)\/?$/);
  if(!match) return task;
  if(url.protocol!=='https:' || url.hostname!=='app.clickup.com' || match[1]!==workspace) fail('Invalid or cross-workspace folder link');
  const {view}=await api.view(match[2]);
  if(Number(view?.parent?.type)!==5 || !/^\d+$/.test(String(view?.parent?.id))) fail('Client Folder: this view is not located in a Folder. Use a view from the client Folder.');
  const resolved=`https://app.clickup.com/${workspace}/v/f/${view.parent.id}`;
  return {...task,custom_fields:task.custom_fields.map(f=>fieldName(f.name)==='Client Folder'?{...f,value:resolved}:f)};
}
export function midnight(date, zone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0,10)!==date) fail('Dates must be YYYY-MM-DD');
  const target=Date.parse(date+'T00:00:00Z'); let value=target;
  const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  for(let i=0;i<4;i++) {
    const p=Object.fromEntries(fmt.formatToParts(value).map(p=>[p.type,p.value]));
    const actual=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
    if(actual===target) return value;
    value+=target-actual;
  }
  fail('Cannot resolve local midnight');
}
function date(v, zone) {
  if (typeof v==='number' || /^\d{13}$/.test(String(v))) {
    if (!zone) fail('Authorized user timezone required to read ClickUp Date fields');
    const timestamp=Number(v);
    if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) fail('Invalid Date field timestamp');
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(timestamp).map(p=>[p.type,p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  return String(v);
}
export function contract(task,workspace,dateTimezone) {
  const f=fields(task), zone=f.Timezone || 'America/Denver';
  for (const field of task.custom_fields || []) {
    if (['Contract start','Contract end','Cutover date'].includes(fieldName(field.name)) && field.type==='date' && field.value_options?.time===true) fail(`${field.name}: select a date without a time`);
  }
  for (const name of ['Contract start','Contract end']) if(f[name]===undefined || f[name]===null || f[name]==='') fail(`${name}: select a date in the task's Date custom field`);
  const startDate=date(f['Contract start'],dateTimezone), endDate=date(f['Contract end'],dateTimezone);
  const next=new Date(endDate+'T00:00:00Z'); next.setUTCDate(next.getUTCDate()+1);
  const start=midnight(startDate,zone), end=midnight(next.toISOString().slice(0,10),zone);
  midnight(endDate,zone);
  const monthly=f['Monthly budget hours']!==undefined && f['Monthly budget hours']!==null && f['Monthly budget hours']!=='';
  const allowance=Number(monthly ? f['Monthly budget hours'] : f['Hours allowance']);
  const hasOverall=f['Hours allowance']!==undefined && f['Hours allowance']!==null && f['Hours allowance']!=='';
  const contractMonths=(Number(endDate.slice(0,4))-Number(startDate.slice(0,4)))*12+Number(endDate.slice(5,7))-Number(startDate.slice(5,7))+1;
  const overallAllowance=monthly && !hasOverall ? allowance*contractMonths : Number(f['Hours allowance']);
  if(!Number.isFinite(overallAllowance) || overallAllowance<=0) fail('Hours allowance must be positive when set');
  const budgetField=task.custom_fields?.find(v=>fieldName(v.name)==='Current month budget hours');
  const remainingField=task.custom_fields?.find(v=>String(v.name).trim().toLowerCase()==='hours remaining');
  const progressField=task.custom_fields?.find(v=>fieldName(v.name)==='Budget remaining');
  if(progressField) {
    const config=progressField.type_config;
    if(!progressField.id || !(progressField.type==='manual_progress' || (progressField.type==='progress' && config?.method==='manual'))) fail('Budget remaining must be a Progress (Manual) custom field');
    if(config?.start===undefined || config?.end===undefined || config.start===null || config.end===null || !Number.isFinite(Number(config.start)) || !Number.isFinite(Number(config.end)) || Number(config.end)<=Number(config.start)) fail('Budget remaining requires a valid progress range with end greater than start');
  }
  if(remainingField && (!remainingField.id || remainingField.type!=='number')) fail('Hours remaining must be a Number custom field');
  if(monthly && (!budgetField?.id || budgetField.type!=='number')) fail('Monthly budgets require a Number field named Current month budget hours');
  if (!(allowance>0) || !Number.isFinite(allowance) || start>=end) fail('Invalid allowance or period');
  const hasOpening=f['AdOrbit opening hours']!==undefined && f['AdOrbit opening hours']!==null && f['AdOrbit opening hours']!=='';
  const hasCutover=!!f['Cutover date'];
  if(hasOpening!==hasCutover) fail('Opening hours and cutover date required together');
  const opening=hasOpening?Number(f['AdOrbit opening hours']):0;
  const from=hasCutover?midnight(date(f['Cutover date'],dateTimezone),zone):start;
  if(!Number.isFinite(opening)||opening<0||from<start||from>=end) fail('Invalid migration data');
  const thresholds=String(f['Alert thresholds'] ?? '80,100').split(',').map(Number);
  if(!thresholds.length || thresholds.some(n=>!Number.isFinite(n)||n<=0)) fail('Invalid thresholds');
  const allow=f['List allowlist']?String(f['List allowlist']).split(/[\s,]+/).filter(Boolean).map(v=>link(v,'list',workspace)):null;
  return {id:String(task.id),name:task.name,folder:link(f['Client Folder'],'folder',workspace),start,end,from,zone,opening,allowance,overallAllowance,monthly,budgetField,remainingField,progressField,thresholds:[...new Set(thresholds)].sort((a,b)=>a-b),allow};
}
export async function scope(api,c) {
  const root=await api.folder(c.folder), folders=[];
  function walk(f) { if(!f.id) fail('Incomplete Folder'); folders.push(f.id); for(const child of f.folders || []) walk(child); }
  walk(root);
  const lists=new Map();
  for(const id of folders) for(const list of await api.lists(id)) lists.set(String(list.id),list);
  if(c.allow) for(const id of c.allow) if(!lists.has(id)) fail(`Allowlisted List ${id} outside Folder tree or inaccessible`);
  const result=[...lists.values()].filter(l=>!c.allow || c.allow.includes(String(l.id)));
  if(!result.length) fail('Empty scope');
  return result;
}
export function balance(description, used, allowance, changed) {
  const block=`${BEGIN}\nRetainer balance\nHours used: ${used.toFixed(2)}\n${used>allowance?'Hours over':'Hours remaining'}: ${Math.abs(allowance-used).toFixed(2)}\nBalance last changed: ${changed}\n${END}`;
  if(description.includes(BEGIN)!==description.includes(END) || description.split(BEGIN).length>2 || description.split(END).length>2) fail('Malformed managed balance block');
  if(description.includes(BEGIN)) {
    if(description.indexOf(END)<description.indexOf(BEGIN)) fail('Malformed managed balance block');
    return description.slice(0,description.indexOf(BEGIN))+block+description.slice(description.indexOf(END)+END.length);
  }
  return description+(description?'\n\n':'')+block;
}
// Rebuild carryover from history, rather than incrementing a mutable budget.
export function monthlyBalance(c, entries, instant) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:c.zone,year:'numeric',month:'2-digit'}).formatToParts(new Date(instant)).map(p=>[p.type,p.value]));
  const period=`${parts.year}-${parts.month}`;
  const monthStart=midnight(period+'-01',c.zone);
  const next=new Date(`${period}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth()+1);
  const monthEnd=midnight(next.toISOString().slice(0,10),c.zone);
  if(monthStart>=c.end || monthEnd<=c.start) fail('Current month is outside the contract period');
  // Use formatted parts instead of locale-dependent date parsing.
  const startParts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:c.zone,year:'numeric',month:'2-digit'}).formatToParts(c.start).map(p=>[p.type,p.value]));
  const months=(Number(parts.year)-Number(startParts.year))*12+Number(parts.month)-Number(startParts.month);
  // Opening hours are cumulative pre-cutover usage, not this month's work.
  // Apply them to available budget, including when cutover is mid-month.
  let prior=c.opening;
  let current=0;
  for(const e of entries.values()) {
    const start=Number(e.start), duration=Number(e.duration);
    if(duration<0 || start<c.from || start>=Math.min(c.end,monthEnd)) continue;
    if(start<monthStart) prior+=duration/3600000;
    else current+=duration/3600000;
  }
  const carryover=months*c.allowance-prior;
  return {period,baseBudget:c.allowance,carryover,allowance:c.allowance+carryover,used:current,remaining:c.allowance+carryover-current,monthStart,monthEnd};
}
export async function sync({api,workspace,registry,state={},save=async()=>{},dryRun=true,taskId,now=()=>new Date().toISOString()}) {
  const instant=now();
  const tasks=await api.registry(registry), results=[];
  const staff=await api.members(workspace);
  for(const item of tasks) {
    if(taskId && String(item.id)!==taskId) continue;
    try {
      const task=await api.task(item.id);
      const active=String(task.status?.status ?? '').trim().toLowerCase()==='active';
      if(!active && !dryRun && (!state[String(item.id)]?.renewal || state[String(item.id)].renewal.status==='complete')) {
        results.push({id:String(item.id),name:task.name,skipped:true,reason:'Task status is not ACTIVE. Run dry-run to preview this task.'});
        continue;
      }
      const resolvedTask=await resolveFolderTask(api,task,workspace);
      const c=contract(resolvedTask,workspace,api.dateTimezone), lists=await scope(api,c);
      const renewal=await renewContract({api,task,c,workspace,registry,tasks,state,save,dryRun,instant,midnight});
      if(renewal) {results.push(renewal);continue;}
      const entries=new Map();
      for(const list of lists) for(const e of await api.entries(workspace,list.id,staff,c.from,c.end)) {
        if(!e.id || !Number.isFinite(Number(e.duration)) || !Number.isFinite(Number(e.start))) fail('Malformed time entry');
        if(entries.has(String(e.id)) && JSON.stringify(entries.get(String(e.id)))!==JSON.stringify(e)) fail('Inconsistent duplicate entry; retry');
        entries.set(String(e.id),e);
      }
      let ms=0;
      // Attribute completed entries by their start date; duration is authoritative.
      for(const e of entries.values()) if(Number(e.duration)>=0 && Number(e.start)>=c.from && Number(e.start)<c.end) ms+=Number(e.duration);
      const month=c.monthly ? monthlyBalance(c,entries,instant) : null;
      if(month) Object.assign(c,{allowance:month.allowance});
      const used=month ? month.used : c.opening+ms/3600000;
      const overallUsed=c.opening+ms/3600000;
      const overallRemaining=c.overallAllowance-overallUsed;
      const remainingValue=Number(overallRemaining.toFixed(2));
      const updateRemaining=c.remainingField && (c.remainingField.value===undefined || c.remainingField.value===null || c.remainingField.value==='' || Number(c.remainingField.value)!==remainingValue);
      const budgetRemainingPercent=Number((Math.max(0,Math.min(1,overallRemaining/c.overallAllowance))*100).toFixed(2));
      let progressValue, updateProgress=false;
      if(c.progressField) {
        const {start,end}=c.progressField.type_config;
        progressValue=Number((Number(start)+(Number(end)-Number(start))*budgetRemainingPercent/100).toFixed(6));
        const current=c.progressField.value?.current ?? c.progressField.value;
        updateProgress=current===undefined || current===null || current==='' || Number(current)!==progressValue;
      }
      const stored=state[c.id];
      const previous=month && stored?.period!==month.period && !stored?.pending ? undefined : stored;
      const reached=c.thresholds.filter(t=>(c.allowance<=0 ? used>=c.allowance : used/c.allowance*100>=t));
      const newly=previous?.pending?.thresholds ?? (previous?reached.filter(t=>!previous.fired.includes(t)):[]);
      const changed=previous?.used===used && previous?.allowance===c.allowance ? previous.changed : instant;
      const description=task.markdown_description ?? task.description ?? '';
      const proposed=balance(description,used,c.allowance,changed).replace('Retainer balance\n',month ? `Retainer balance (${month.period})\nBase monthly budget: ${month.baseBudget.toFixed(2)}\nCarryover: ${month.carryover.toFixed(2)}\nCurrent month budget: ${month.allowance.toFixed(2)}\n` : 'Retainer balance\n');
      const marker=previous?.pending?.text?.match(/\[retainer:[^\]]+\]/)?.[0] ?? (newly.length?`[retainer:${c.id}:${createHash('sha256').update(JSON.stringify([month?.period,newly])).digest('hex').slice(0,20)}]`:null);
      const comment=previous?.pending?.text ?? (marker?`${c.name}: ${newly.join('%, ')}% retainer threshold reached. ${used.toFixed(2)} / ${c.allowance} hours used. ${marker}`:null);
      // Complete every read and validate before publishing anything.
      const comments=comment?await api.comments(c.id):[];
      const already=marker && comments.some(v=>String(v.comment_text ?? v.text ?? v.comment?.map(p=>p.text).join('') ?? '').includes(marker));
      const progressPreview=c.progressField ? {overallAllowance:c.overallAllowance,overallUsed,overallRemaining,budgetRemainingPercent,proposedProgressUpdate:updateProgress ? {fieldId:c.progressField.id,value:{current:progressValue}} : null} : {};
      results.push({id:c.id,name:c.name,status:task.status?.status,active,...progressPreview,lists:lists.map(l=>({id:l.id,name:l.name})),timezone:c.zone,start:new Date(c.start).toISOString(),endExclusive:new Date(c.end).toISOString(),countFrom:new Date(c.from).toISOString(),...(month ? {monthly:month} : {}),openingHours:c.opening,clickUpHours:ms/3600000,used,remaining:overallRemaining,firstRunReached:previous?[]:reached,proposedComment:already?null:comment});
      if(!dryRun) {
        if(proposed!==description) await api.update(c.id,proposed);
        if(month && (c.budgetField.value===undefined || Number(c.budgetField.value)!==c.allowance)) await api.setField(c.id,c.budgetField.id,c.allowance);
        if(updateRemaining) await api.setField(c.id,c.remainingField.id,remainingValue);
        if(updateProgress) await api.setField(c.id,c.progressField.id,{current:progressValue});
        if(comment && !previous?.pending) {
          const pending={...previous,pending:{thresholds:newly,text:comment}};
          await save({...state,[c.id]:pending});
          state[c.id]=pending;
        }
        if(comment && !already) await api.comment(c.id,comment);
        const next={used,changed,allowance:c.allowance,...(month ? {period:previous?.pending ? previous.period : month.period} : {}),fired:[...new Set([...(previous?.fired || []),...(previous ? newly : reached)])]};
        await save({...state,[c.id]:next});
        state[c.id]=next;
      }
    } catch(error) { results.push({id:String(item.id),error:error.message}); }
  }
  if(taskId && !results.length) results.push({id:taskId,error:'Task not found in the configured registry List'});
  if(!taskId && !tasks.length) results.push({skipped:true,reason:'No tasks found in registry List '+registry+'. Check CLICKUP_REGISTRY_LIST_ID and move the existing balance task into that List.'});
  return results;
}

