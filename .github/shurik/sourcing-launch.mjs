/** Validate the one authorized request before invoking the official Shurik action. */
import { createHash } from 'node:crypto';
import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function approvedRequest(raw, expectedHash, now = Date.now()) {
  if (!expectedHash || createHash('sha256').update(raw).digest('hex') !== expectedHash) throw new Error('The launch request has changed; explicit review is required. No agents started.');
  const request = JSON.parse(raw), i = request.inputs;
  if (request.requestId !== 'sourcing-2026-10-20' || i.command !== 'start' || i.loop_id !== 'maps-n-stuff-sources-20261020' || i.swarm?.agents !== 3) throw new Error('This request is authorized for exactly the three sourcing agents.');
  if (i.model?.provider !== 'opencode-go' || i.model.name !== 'deepseek-v4.1-flash' || i.model.reasoning !== 'max' || i['work-seconds'] !== 1800 || i['wait-seconds'] !== 0 || i['checkpoint-seconds'] !== 0 || i.create_pr !== 'false' || i.prompt !== 'SOURCING_PROMPT.md') throw new Error('Model or run settings do not match the authorized request.');
  const deadline = Date.parse(i.deadline);
  if (!Number.isFinite(deadline) || deadline <= now || Date.parse(request.localDeadline) !== deadline) throw new Error('The authorized deadline has expired or is invalid. No agents started.');
  return request;
}
export async function launchReady(request, get) {
  const prefix = request.inputs.loop_id;
  const existing = await Promise.all([0, 1, 2].map(async n => {
    const res = await get(`git/ref/heads/shurik-control/${prefix}-${n}`);
    if (!res.ok && res.status !== 404) throw new Error(`Cannot inspect saved sourcing loop: HTTP ${res.status}`);
    return res.ok;
  }));
  if (existing.some(Boolean)) return false; // No implicit resume or new-prefix fallback.
  for (const retired of ['maps-n-stuff', 'zurich-maps']) for (let n = 0; n < 4; n++) {
    const res = await get(`contents/control.json?ref=${encodeURIComponent(`shurik-control/${retired}-${n}`)}`);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`Cannot verify retired loop: HTTP ${res.status}`);
    const body = await res.json();
    const control = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
    if (control.status === 'running' || control.owner) throw new Error('A retired agent is still active. Refusing to exceed three active agents.');
  }
  return true;
}
async function main() {
  const raw = await readFile('.github/shurik/sourcing-run.json', 'utf8');
  const request = approvedRequest(raw, process.env.APPROVED_REQUEST_SHA256);
  const get = path => fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}`, {
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000),
  });
  const ready = await launchReady(request, get);
  await appendFile(process.env.GITHUB_OUTPUT, `launch=${ready}\ninputs=${JSON.stringify(request.inputs)}\n`);
  console.log(ready ? 'Validated the explicit three-agent sourcing request.' : 'This sourcing request was already initialized; no agents were started or resumed.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
