// Forwards /api/map/* to the in-house map server, which only the OMS backend talks to.
// It is mounted inside the authenticated /api router, so only logged-in OMS users and crews can reach the
// map (same protection as /api/tiles), and the map server's own API key never leaves the backend.
//
//   /api/map/style.json, /api/map/tiles.json, /api/map/tiles/{z}/{x}/{y}.pbf, /api/map/fonts/...   map drawing
//   /api/map/export, /api/map/export/:id, /api/map/export/:id/file, /api/map/info                  "give me this area"
//
// Env:  MAP_SERVER_URL (default http://127.0.0.1:8095)   MAP_API_KEY (optional, must match the map server's API_KEY)
import http from 'node:http';

const MAP_URL = new URL(process.env.MAP_SERVER_URL || 'http://127.0.0.1:8095');
const MAP_API_KEY = process.env.MAP_API_KEY || '';

// The map server keeps its area API under /api/map/; everything else (style, tiles, fonts) is at its root.
const toMapServerPath = (url) => (/^\/(export|info)(\/|\?|$)/.test(url) ? '/api/map' + url : url);

export function mapProxy(req, res) {
  if (!['GET', 'HEAD', 'POST'].includes(req.method)) return res.status(405).json({ error: 'method not allowed' });

  // Tell the map server which address the CLIENT used (so links in its answers are right wherever the OMS is deployed).
  const clientHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const clientProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const headers = { ...req.headers, host: MAP_URL.host, 'x-forwarded-host': clientHost, 'x-forwarded-proto': clientProto, 'x-forwarded-prefix': req.baseUrl };
  delete headers.authorization;   // the user's token stays in the backend
  delete headers.cookie;
  delete headers['content-length'];
  if (MAP_API_KEY) headers['x-api-key'] = MAP_API_KEY;

  // express.json() has usually already read a POST body, so send it again from req.body
  const body = req.method === 'POST' ? JSON.stringify(req.body || {}) : null;
  if (body !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }

  const upstream = http.request(
    { hostname: MAP_URL.hostname, port: MAP_URL.port || 80, path: toMapServerPath(req.url), method: req.method, headers },
    (r) => {
      if (r.statusCode === 401) { // the map server refused the OMS's OWN key: a setup problem, not the user's login
        r.resume();
        return res.status(502).json({ error: "The map server refused the OMS's key. An administrator should check MAP_API_KEY in backend/.env." });
      }
      const out = { ...r.headers };
      delete out['access-control-allow-origin'];   // CORS is the backend's job
      res.writeHead(r.statusCode, out);
      r.pipe(res);
    },
  );
  upstream.setTimeout(30000, () => upstream.destroy(new Error('map server timeout')));
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).json({ error: 'map server unavailable' });
    else res.end();
  });
  upstream.end(body);
}
