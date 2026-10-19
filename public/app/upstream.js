/**
 * JSON from an allowlisted upstream (IIIF manifest, image service `info.json`).
 *
 * The site ships a strict `connect-src 'self'` CSP (public/_headers), so the
 * same-origin Worker proxy (`/api/fetch`, edge-cached, host allowlist) is the
 * *primary* path — it is also what keeps the e-rara/other collections usable
 * when their CORS headers change. The direct call stays as a fallback for a
 * deployment without the Worker (e.g. plain static hosting): e-rara sends
 * `access-control-allow-origin: *` (verified 2026-10-18, see docs/data-sources.md).
 *
 * The error message keeps both attempts' raw text (for logs/tests);
 * `describeUpstreamError` in iiif.js is what turns it into a sentence a visitor
 * can act on. No other module should re-implement this ladder.
 */
export async function fetchUpstreamJson(url) {
  try {
    const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}&accept=application/json`);
    if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
    return await res.json();
  } catch (proxyError) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (directError) {
      throw new Error(`${proxyError.message} / ${directError.message}`);
    }
  }
}
