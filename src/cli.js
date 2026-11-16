#!/usr/bin/env node
import {readFile,writeFile,rename,mkdir,open,unlink} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {ClickUp} from './api.js';
import {sync} from './sync.js';
const args=process.argv.slice(2);
if(args.includes('--help')) {
  console.log('retainers [dry-run|validate|sync] [--task TASK_ID] [--apply]\nEnvironment: CLICKUP_WORKSPACE_ID, CLICKUP_REGISTRY_LIST_ID, CLICKUP_API_TOKEN, RETAINER_STATE_PATH\nsync requires --apply for writes; all other modes are read-only.');
  process.exit(0);
}
let lock;
try {
  const command=args[0] || 'dry-run';
  if(!['dry-run','validate','sync'].includes(command)) throw Error('Unknown command');
  const flags=args.slice(1); let taskId,apply=false;
  for(let i=0;i<flags.length;i++) {
    if(flags[i]==='--apply') apply=true;
    else if(flags[i]==='--task' && flags[i+1] && !flags[i+1].startsWith('--')) taskId=flags[++i];
    else throw Error(`Unknown or incomplete argument: ${flags[i]}`);
  }
  if(apply && command!=='sync') throw Error('--apply is only valid with sync');
  const dryRun=command!=='sync' || !apply;
  const [workspace,registry,token,statePath]=['CLICKUP_WORKSPACE_ID','CLICKUP_REGISTRY_LIST_ID','CLICKUP_API_TOKEN','RETAINER_STATE_PATH'].map(k=>{if(!process.env[k]) throw Error(`Missing ${k}`); return process.env[k];});
  if(!/^\d+$/.test(workspace)||!/^\d+$/.test(registry)) throw Error('Workspace and List IDs must be numeric');
  const path=resolve(statePath); let state={};
  if(!dryRun) {
    await mkdir(dirname(path),{recursive:true});
    lock=await open(path+'.lock','wx');
    await lock.writeFile(String(process.pid));
    lock.path=path+'.lock';
  }
  try { state=JSON.parse(await readFile(path,'utf8')); } catch(e) { if(e.code!=='ENOENT') throw e; }
  if(!state || typeof state!=='object' || Array.isArray(state) || Object.values(state).some(s=>!Array.isArray(s.fired)||!Number.isFinite(s.used)||!s.changed)) throw Error('Invalid state file; restore a backup');
  const save=async data=>{
    const temp=path+'.tmp';
    const handle=await open(temp,'w',0o600);
    try { await handle.writeFile(JSON.stringify(data,null,2)); await handle.sync(); } finally { await handle.close(); }
    await rename(temp,path);
  };
  const results=await sync({api:new ClickUp(token,!dryRun),workspace,registry,state,save,dryRun,taskId});
  console.log(JSON.stringify({mode:dryRun?'read-only':'apply',results},null,2));
  if(results.some(r=>r.error)) process.exitCode=1;
} catch(error) { console.error(error.message); process.exitCode=1; }
finally { if(lock) { await lock.close(); await unlink(lock.path); } }
