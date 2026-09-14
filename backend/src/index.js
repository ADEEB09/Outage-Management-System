import 'dotenv/config'; // loads .env into process.env
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { migrate } from './infra/db.js';
import { seed } from './infra/seed.js';
import { api } from './routes/api.js';
import { repo } from './infra/repo.js';
import { requireAuth } from './routes/auth.js';
import { bus, initBus } from './domain/bus.js';
import { connectRedis } from './infra/redis.js';
import { startSimulator } from './realtime/simulator.js';
import { startScadaConsumer } from './realtime/scada.js';
import { startRestorationPublisher } from './realtime/restoration.js';
import { startNotifier } from './realtime/notifier.js';
import { startScheduledReports } from './realtime/scheduledReports.js';
// ...alongside your other startX() calls at boot:
startScheduledReports();
const PORT = process.env.PORT || 4000;

 await migrate();
 await seed(); // idempotent — only seeds an empty DB
 await connectRedis(); // non-fatal if unreachable — see infra/redis.js
 await initBus();       // memory driver by default; EVENT_BUS_DRIVER=kafka for the real broker
 startScadaConsumer();  // Phase 2: auto-detect outages from SCADA fault events
 startRestorationPublisher(); // Phase 2: publish restoration commands back to the DMS

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' }));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/portal', express.static(path.join(__dirname, '..', 'public')));
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
// Public, no-login outage status lookup for customers.
app.get('/api/public/outage-status', async (req, res) => {
  try {
    const { ref, zone } = req.query;
    let list = await repo.incidents();
    // only show incidents that are still active (not closed/resolved)
    const active = list.filter((i) => !['resolved', 'restored', 'closed'].includes((i.status || '').toLowerCase()));
    let match = active;
    if (ref) match = active.filter((i) => i.id.toLowerCase() === String(ref).toLowerCase());
    else if (zone) match = active.filter((i) => (i.zone || '').toLowerCase().includes(String(zone).toLowerCase()));
    // expose only safe, public fields
    const safe = match.map((i) => ({
      ref: i.id, zone: i.zone, status: i.status,
      customersAffected: i.customers, estimatedRestoration: i.ert, since: i.opened_at,
    }));
    res.json({ count: safe.length, outages: safe });
  } catch (e) {
    res.status(500).json({ error: 'lookup failed' });
  }
});
app.use('/api', requireAuth, api);

const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });

// Bridge every domain event straight to WebSocket subscribers.
// The frontend and mobile app both listen on these topic names.
bus.onAny(({ topic, payload }) => io.emit(topic, payload));

io.on('connection', (socket) => {
  socket.emit('server.hello', { ts: new Date().toISOString() });
});

http.listen(PORT, () => {
  console.log(`\n  OMS backend running`);
  console.log(`  REST   → http://localhost:${PORT}/api`);
  console.log(`  WS     → ws://localhost:${PORT}`);
  console.log(`  Health → http://localhost:${PORT}/api/health\n`);
  startSimulator();
  startNotifier();
});