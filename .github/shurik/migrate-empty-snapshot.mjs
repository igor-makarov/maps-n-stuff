import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// The retired agent-managed patch retained empty snapshot manifests while its
// saved work commit advanced. Native v2 validates that association on restore.
// Repair only empty manifests, leaving task files and control settings intact.
export async function migrateEmptySnapshot({ member, remote, environment = process.env }) {
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(member ?? '')) throw new Error('Invalid member ID');
  const env = { ...environment, GIT_TERMINAL_PROMPT: '0' };
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  async function git(cwd, ...args) {
    return (await execute('git', args, { cwd, env, timeout: 120000, maxBuffer: 1024 * 1024 })).stdout.trim();
  }
  remote ??= await git(process.cwd(), 'remote', 'get-url', 'origin');
  const temporary = await mkdtemp(join(tmpdir(), 'shurik-snapshot-migration-'));
  const checkout = join(temporary, 'control');
  const ref = `refs/heads/shurik-control/${member}`;
  try {
    await git(temporary, 'clone', '--no-checkout', remote, checkout);
    await git(checkout, 'config', 'user.name', 'github-actions[bot]');
    await git(checkout, 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
    for (let attempt = 0; attempt < 5; attempt++) {
      await git(checkout, 'fetch', 'origin', ref);
      await git(checkout, 'checkout', '--detach', 'FETCH_HEAD');
      const control = JSON.parse(await readFile(join(checkout, 'control.json'), 'utf8'));
      if (control.status !== 'stopped') throw new Error('Stop the member before migrating snapshot metadata');
      const path = join(checkout, 'state/task-files.json');
      let snapshot;
      try { snapshot = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
      if (snapshot.workCommit === control.checkpoint?.workCommit) return 'current';
      if (snapshot.version !== 1 || !Array.isArray(snapshot.paths) || snapshot.paths.length !== 0
        || !/^[a-f0-9]{40}$/.test(control.checkpoint?.workCommit ?? '')) {
        throw new Error('Snapshot is not empty; refusing to change retained task data');
      }
      snapshot.workCommit = control.checkpoint.workCommit;
      await writeFile(path, JSON.stringify(snapshot, null, 2) + '\n');
      await git(checkout, 'add', 'state/task-files.json');
      await git(checkout, 'commit', '-m', 'Migrate empty snapshot metadata to official Shurik v2');
      try {
        await git(checkout, 'push', 'origin', `HEAD:${ref}`);
        return 'migrated';
      } catch (error) {
        if (attempt === 4) throw error;
        // Retry against the latest control tip after a concurrent state update.
      }
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(`Empty-snapshot migration: ${await migrateEmptySnapshot({ member: process.env.SHURIK_MEMBER })}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
