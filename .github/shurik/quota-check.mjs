/** A hard OpenCode usage cap must not produce another zero-wait retry storm. */
import { readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export function hardQuotaError(value) {
  const error = value?.error;
  return /GoUsageLimitError|Go usage limit exceeded/i.test(typeof error === 'string' ? error : JSON.stringify(error ?? ''));
}
async function main() {
  const generation = process.env.SHURIK_GENERATION, iteration = process.env.SHURIK_ITERATION;
  if (!/^\d+$/.test(generation ?? '') || !/^\d+$/.test(iteration ?? '')) throw new Error('Missing iteration identity.');
  let limited = false;
  if (process.env.SHURIK_LOGS_PATH) {
    try { limited = hardQuotaError(JSON.parse(await readFile(join(process.env.SHURIK_LOGS_PATH, `${generation}-${iteration}-worker.json`), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await appendFile(process.env.GITHUB_OUTPUT, `limited=${limited}\n`);
  if (limited) console.log('::error::OpenCode Go quota is exhausted. Stopping this loop; an explicit resume is required after quota recovers.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
