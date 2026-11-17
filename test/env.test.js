import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('.env loads quoted settings, preserves environment overrides, and allows a missing file', async () => {
  const dir=await mkdtemp(join(tmpdir(),'retainer-env-'));
  try {
    const path=join(dir,'.env');
    await writeFile(path, 'CLICKUP_WORKSPACE_ID=123\nRETAINER_STATE_PATH="./state/my balances.json"\n');
    const moduleUrl=new URL('../src/env.js',import.meta.url).href;
    const code=`import {loadEnvironment} from ${JSON.stringify(moduleUrl)};
      loadEnvironment();
      loadEnvironment('missing.env');
      console.log(JSON.stringify([process.env.CLICKUP_WORKSPACE_ID,process.env.RETAINER_STATE_PATH]));`;
    const env={...process.env};
    delete env.CLICKUP_WORKSPACE_ID;
    delete env.RETAINER_STATE_PATH;
    let result=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:dir,env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),['123','./state/my balances.json']);
    env.CLICKUP_WORKSPACE_ID='456';
    result=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:dir,env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout)[0],'456');
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
