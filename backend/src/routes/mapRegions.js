// Region-aware map routes, mounted under /api/map BEFORE the generic forwarder (see api.js).
//
//   GET  /api/map/regions               regions the caller may use (crew devices only see crew regions)
//   GET  /api/map/my-region             the region this crew's phone should download (from its position / config)
//   POST /api/map/regions/:id/export    ask the map server to cut that region into one file
//                                       -> then use /api/map/export/:jobId and /api/map/export/:jobId/file as before
//
// Everything else under /api/map falls through to mapProxy.js. Regions come from the OMS's own GIS data and
// infra/map-regions.json, so the apps never need coordinates.
import express from 'express';
import { buildCatalogue, pickCrewRegion, readJson } from '../infra/mapRegions.js';

const publicRegion = ({ id, name, kind, center, bbox, areaKm2, forCrews }) => ({ id, name, kind, center, bbox, areaKm2, forCrews });
const isCrewDevice = (req) => Boolean(req.user?.crewId);

export function createMapRegionRoutes({ getNetwork, getCrew } = {}) {
  const router = express.Router();
  const mapUrl = () => (process.env.MAP_SERVER_URL || 'http://127.0.0.1:8095').replace(/\/+$/, '');

  // Rebuilt per request: it is cheap, and editing map-regions.json then needs no restart.
  const load = () => {
    const config = readJson('map-regions.json', {});
    return { config, catalogue: buildCatalogue({ network: getNetwork?.() ?? null, config }) };
  };

  router.get('/regions', (req, res) => {
    const { config, catalogue } = load();
    const visible = isCrewDevice(req) ? catalogue.filter((r) => r.forCrews) : catalogue;
    res.json({ regions: visible.map(publicRegion), default: config.defaultCrewRegion || null });
  });

  router.get('/my-region', async (req, res) => {
    const { config, catalogue } = load();
    // A crew phone is identified by its token. An operator may pass ?crewId= to see what a given crew would get.
    const crewId = req.user?.crewId || (typeof req.query.crewId === 'string' ? req.query.crewId : null);
    let crew = null;
    if (crewId && getCrew) { try { crew = await getCrew(crewId); } catch { crew = null; } }
    const { region, reason } = pickCrewRegion(catalogue, config, { crewId, lat: crew?.lat, lon: crew?.lon });
    if (!region) return res.status(404).json({ error: 'No regions are configured.' });
    res.json({ region: publicRegion(region), reason });
  });

  router.post('/regions/:id/export', async (req, res) => {
    const { catalogue } = load();
    const region = catalogue.find((r) => r.id === req.params.id);
    if (!region) return res.status(404).json({ error: `Unknown region "${req.params.id}".` });
    if (isCrewDevice(req) && !region.forCrews) return res.status(403).json({ error: 'This region is not available to crew devices.' });

    const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
    const minZoom = num(req.body?.minZoom, region.minZoom ?? 8);
    const maxZoom = num(req.body?.maxZoom, region.maxZoom ?? 14);
    if (![minZoom, maxZoom].every(Number.isInteger) || minZoom < 0 || maxZoom > 22 || minZoom > maxZoom) {
      return res.status(400).json({ error: 'minZoom and maxZoom must be whole numbers with 0 <= minZoom <= maxZoom <= 22.' });
    }

    let upstream, body;
    try {
      upstream = await fetch(`${mapUrl()}/api/map/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(process.env.MAP_API_KEY ? { 'x-api-key': process.env.MAP_API_KEY } : {}) },
        body: JSON.stringify({ bbox: region.bbox.join(','), minZoom, maxZoom, label: region.id }),
        signal: AbortSignal.timeout(30000),
      });
      body = await upstream.json().catch(() => ({}));
    } catch {
      return res.status(502).json({ error: 'map server unavailable' });
    }
    if (upstream.status === 401) return res.status(502).json({ error: "The map server refused the OMS's key. An administrator should check MAP_API_KEY in backend/.env." });
    if (upstream.status !== 202) return res.status(upstream.status).json({ error: body.error || 'The map server could not prepare this region.' });

    // Relative paths: they work wherever the OMS is deployed (the map server's own links are not needed).
    res.status(202).json({
      region: publicRegion(region), jobId: body.jobId, status: body.status, tiles: body.tiles, sizeMb: body.sizeMb,
      statusPath: `${req.baseUrl}/export/${body.jobId}`, filePath: `${req.baseUrl}/export/${body.jobId}/file`,
    });
  });

  return router;
}
