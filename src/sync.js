import {createHash} from 'node:crypto';
const BEGIN='<!-- retainer-balance:start -->', END='<!-- retainer-balance:end -->';
const fail = message => { throw Error(message); };
export function fields(task) {
  const f={};
  for (const field of task.custom_fields || []) {
    if (Object.hasOwn(f,field.name)) fail(`Duplicate field: ${field.name}`);
    f[field.name]=field.value;
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
function date(v) {
  if (typeof v==='number' || /^\d{13}$/.test(String(v))) return new Date(Number(v)).toISOString().slice(0,10);
  return String(v);
}
export function contract(task,workspace) {
  const f=fields(task), zone=f.Timezone || 'America/Denver';
  const startDate=date(f['Contract start']), endDate=date(f['Contract end']);
  const next=new Date(endDate+'T00:00:00Z'); next.setUTCDate(next.getUTCDate()+1);
  const start=midnight(startDate,zone), end=midnight(next.toISOString().slice(0,10),zone);
  midnight(endDate,zone);
  const monthly=f['Monthly budget hours']!==undefined && f['Monthly budget hours']!==null && f['Monthly budget hours']!=='';
  const allowance=Number(monthly ? f['Monthly budget hours'] : f['Hours allowance']);
  const budgetField=task.custom_fields?.find(v=>v.name==='Current month budget hours');
  if(monthly && (!budgetField?.id || budgetField.type!=='number')) fail('Monthly budgets require a Number field named Current month budget hours');
  if (!(allowance>0) || !Number.isFinite(allowance) || start>=end) fail('Invalid allowance or period');
  const hasOpening=f['AdOrbit opening hours']!==undefined && f['AdOrbit opening hours']!==null && f['AdOrbit opening hours']!=='';
  const hasCutover=!!f['Cutover date'];
  if(hasOpening!==hasCutover) fail('Opening hours and cutover date required together');
  const opening=hasOpening?Number(f['AdOrbit opening hours']):0;
  const from=hasCutover?midnight(date(f['Cutover date']),zone):start;
  if(!Number.isFinite(opening)||opening<0||from<start||from>=end) fail('Invalid migration data');
  const thresholds=String(f['Alert thresholds'] ?? '80,100').split(',').map(Number);
  if(!thresholds.length || thresholds.some(n=>!Number.isFinite(n)||n<=0)) fail('Invalid thresholds');
  const allow=f['List allowlist']?String(f['List allowlist']).split(/[\s,]+/).filter(Boolean).map(v=>link(v,'list',workspace)):null;
  return {id:String(task.id),name:task.name,folder:link(f['Client Folder'],'folder',workspace),start,end,from,zone,opening,allowance,monthly,budgetField,thresholds:[...new Set(thresholds)].sort((a,b)=>a-b),allow};
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
  let prior= c.from<monthStart ? c.opening : 0;
  let current=c.from>=monthStart ? c.opening : 0;
  for(const e of entries.values()) {
    const start=Number(e.start), duration=Number(e.duration);
    if(duration<0 || start<c.from || start>=Math.min(c.end,monthEnd)) continue;
    if(start<monthStart) prior+=duration/3600000;
    else current+=duration/3600000;
  }
  const carryover=months*c.allowance-prior;
  return {period,baseBudget:c.allowance,carryover,allowance:c.allowance+carryover,used:current,monthStart,monthEnd};
}
export async function sync({api,workspace,registry,state={},save=async()=>{},dryRun=true,taskId,now=()=>new Date().toISOString()}) {
  const tasks=await api.registry(registry), results=[];
  const staff=await api.members(workspace);
  for(const item of tasks) {
    if(taskId && String(item.id)!==taskId) continue;
    try {
      const task=await api.task(item.id), f=fields(task);
      if(![true,'true',1,'1'].includes(f.Enabled) && !(dryRun && taskId)) continue;
      const c=contract(task,workspace), instant=now(), lists=await scope(api,c), entries=new Map();
      const monthly=c.monthly ? monthlyBalance(c,entries,instant) : null;
      const queryEnd=monthly ? Math.min(c.end,monthly.monthEnd) : c.end;
      for(const list of lists) for(const e of await api.entries(workspace,list.id,staff,c.from,queryEnd)) {
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
      results.push({id:c.id,name:c.name,lists:lists.map(l=>({id:l.id,name:l.name})),timezone:c.zone,start:new Date(c.start).toISOString(),endExclusive:new Date(c.end).toISOString(),countFrom:new Date(c.from).toISOString(),...(month ? {monthly:month} : {}),openingHours:c.opening,clickUpHours:ms/3600000,used,remaining:c.allowance-used,firstRunReached:previous?[]:reached,proposedComment:already?null:comment});
      if(!dryRun) {
        if(proposed!==description) await api.update(c.id,proposed);
        if(month && (c.budgetField.value===undefined || Number(c.budgetField.value)!==c.allowance)) await api.setField(c.id,c.budgetField.id,c.allowance);
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
  if(taskId && !results.length) results.push({id:taskId,error:'Enabled contract not found in registry'});
  return results;
}

