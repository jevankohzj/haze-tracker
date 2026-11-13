// Shared helper for the Vercel proxy functions. Files starting with "_" are not exposed as routes.
// Proxying keeps the browser from depending on NEA's CORS settings, caches responses at
// Vercel's edge so many users share one upstream call, and lets an API key stay server-side.
const BASE = 'https://api-open.data.gov.sg/v2/real-time/api';

module.exports = function proxy(endpoint) {
  return async function handler(req, res) {
    try {
      const headers = { Accept: 'application/json' };
      if (process.env.NEA_API_KEY) headers['x-api-key'] = process.env.NEA_API_KEY;

      const upstream = await fetch(`${BASE}/${endpoint}`, { headers, signal: AbortSignal.timeout(10000) });
      const body = await upstream.text();

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      // NEA updates hourly, so a couple of minutes of caching is plenty. Never cache errors.
      res.setHeader(
        'Cache-Control',
        upstream.ok ? 'public, s-maxage=120, stale-while-revalidate=600' : 'no-store'
      );
      res.status(upstream.status).send(body);
    } catch (err) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(502).json({ error: 'NEA data is unavailable right now' });
    }
  };
};
