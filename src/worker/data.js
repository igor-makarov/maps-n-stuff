/**
 * Read the bundled catalogue through the static-assets binding.
 *
 * `records.json` is the core document; `records.json.shards` lists further
 * `/data/records/<name>.json` documents. The browser loader, the Worker route
 * `/api/records` and the georeference lookup all have to see the same merged
 * set, so the merge lives here rather than in each caller.
 */
const SHARD_PATH = /^\/data\/records\/[a-z0-9][a-z0-9-]*\.json$/;

async function assetJson(env, request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = '';
  const response = await env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }));
  if (!response.ok) throw new Error(`${response.status} ${pathname}`);
  return response.json();
}

/**
 * @returns {Promise<{core: object, records: object[], shardErrors: string[]}>}
 * A missing core asset throws. A missing/malformed shard is reported in
 * `shardErrors` and the remaining records are still returned; callers decide
 * whether a partial catalogue is acceptable (the UI says so; `/api/records`
 * returns 502 rather than silently pretending to be complete).
 */
export async function loadCatalogue(env, request) {
  const core = await assetJson(env, request, '/data/records.json');
  const records = [];
  const seen = new Set();
  const add = (record) => {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string' || seen.has(record.id)) return;
    seen.add(record.id);
    records.push(record);
  };
  for (const record of Array.isArray(core.records) ? core.records : []) add(record);
  const shardErrors = [];
  for (const shardPath of Array.isArray(core.shards) ? core.shards : []) {
    if (typeof shardPath !== 'string' || !SHARD_PATH.test(shardPath)) {
      shardErrors.push(`invalid shard URL: ${shardPath}`);
      continue;
    }
    try {
      const shard = await assetJson(env, request, shardPath);
      if (!Array.isArray(shard.records)) throw new Error('shard has no records array');
      for (const record of shard.records) add(record);
    } catch (error) {
      shardErrors.push(`${shardPath}: ${error?.message || error}`);
    }
  }
  return { core, records, shardErrors };
}
