import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { approvedRequest, launchReady } from '../.github/shurik/sourcing-launch.mjs';
import { hardQuotaError } from '../.github/shurik/quota-check.mjs';
const raw = await readFile(new URL('../.github/shurik/sourcing-run.json', import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const now = Date.parse('2026-10-20T08:00:00Z');
const request = approvedRequest(raw, hash(raw), now);
const stopped = () => Response.json({content:Buffer.from(JSON.stringify({status:'stopped',owner:null})).toString('base64')});

test('the reviewed sourcing launch retains the exact three-agent model, budget and deadline', () => {
  assert.equal(request.inputs.swarm.agents,3);
  assert.equal(request.inputs.model.name,'deepseek-v4.1-flash');
  assert.equal(request.inputs['work-seconds'],1800);
  assert.equal(request.inputs['wait-seconds'],0);
  assert.equal(request.inputs['checkpoint-seconds'],0);
  assert.equal(Date.parse(request.localDeadline),Date.parse(request.inputs.deadline));
});
test('a rename cannot turn a changed request into an accidental new swarm', () => {
  const changed=JSON.stringify({...request,inputs:{...request.inputs,loop_id:'renamed-swarm'}});
  assert.throws(()=>approvedRequest(changed,hash(raw),now),/changed/);
  assert.throws(()=>approvedRequest(changed,hash(changed),now),/exactly/);
  assert.throws(()=>approvedRequest(raw,hash(raw),Date.parse(request.inputs.deadline)),/expired/);
});
test('the workflow pins the reviewed request and ordinary edits do not launch it',async()=>{
  const workflow=await readFile(new URL('../.github/workflows/shurik-source-launch.yml',import.meta.url),'utf8');
  assert.ok(workflow.includes(`APPROVED_REQUEST_SHA256: ${hash(raw)}`));
  assert.match(workflow,/paths: \[\.github\/shurik\/sourcing-run\.json\]/);
  assert.doesNotMatch(workflow,/schedule:|paths:.*launch\.json/);
});
test('only absent sourcing controls and inactive retired loops allow startup', async () => {
  assert.equal(await launchReady(request,async path=>path.startsWith('git/ref/')?new Response(null,{status:404}):stopped()),true);
  assert.equal(await launchReady(request,async path=>path.endsWith('-0')?Response.json({ref:'exists'}):new Response(null,{status:404})),false,'reruns cannot implicitly resume an initialized member');
  await assert.rejects(launchReady(request,async()=>new Response(null,{status:403})),/403/,'auth errors are not mistaken for missing controls');
  await assert.rejects(launchReady(request,async path=>path.startsWith('git/ref/')?new Response(null,{status:404}):Response.json({content:Buffer.from(JSON.stringify({status:'running',owner:null})).toString('base64')})),/retired agent/);
});
test('exhausted OpenCode quota stops retries while temporary HTTP 429 is distinguished',()=>{
  assert.equal(hardQuotaError({error:{detail:'429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}'}}),true);
  assert.equal(hardQuotaError({error:'Go usage limit exceeded'}),true);
  assert.equal(hardQuotaError({error:'HTTP 429 temporary rate limit'}),false);
  assert.equal(hardQuotaError({outcome:'yielded'}),false);
});
test('the quota stop runs in the inference job even when the model step fails',async()=>{
  const workflow=await readFile(new URL('../.github/workflows/shurik.yml',import.meta.url),'utf8');
  const iteration=workflow.split('\n  iteration:\n')[1].split('\n  recovery:\n')[0];
  assert.match(iteration,/Detect a hard model quota limit[\s\S]*?if: always\(\)/);
  assert.match(iteration,/if: always\(\) && steps.quota.outputs.limited == 'true'[\s\S]*?command: stop/);
  assert.match(iteration,/SHURIK_LOGS_PATH: \$\{\{ steps.shurik.outputs.logs-path \}\}/);
});
