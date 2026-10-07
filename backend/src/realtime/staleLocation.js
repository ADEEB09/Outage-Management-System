// Flags crews whose tracking is "on" but whose phone has stopped sending
// positions: the phone's Location switched off, the app killed by the OS,
// a dead battery, or a long dead zone. The crew app sends a fix at least once
// a minute even when parked, so STALE_AFTER_MS of silence means something
// is wrong. Publishes crew.location.stale once when a crew goes quiet and
// once more (stale: false) when positions resume.
import { bus, TOPICS } from '../domain/bus.js';
import { repo } from '../infra/repo.js';

const STALE_AFTER_MS = Number(process.env.STALE_LOCATION_MINUTES || 5) * 60 * 1000;
const CHECK_EVERY_MS = 60 * 1000;

export function startStaleLocationMonitor() {
  const stale = new Map(); // crewId -> last location_updated_at when flagged

  const check = async () => {
    const now = Date.now();
    for (const c of await repo.crews()) {
      const last = c.location_updated_at ? new Date(c.location_updated_at).getTime() : null;
      // Reference point for "silent since": the last fix, or when tracking
      // was switched on if no fix arrived after that.
      const on = c.tracking_state === 'on';
      const since = Math.max(last || 0, c.tracking_changed_at ? new Date(c.tracking_changed_at).getTime() : 0);
      const isStale = on && since > 0 && now - since > STALE_AFTER_MS;

      if (isStale && !stale.has(c.id)) {
        stale.set(c.id, last);
        bus.publish(TOPICS.CREW_LOCATION_STALE, {
          crewId: c.id, crewName: c.name, stale: true,
          lastSeenAt: c.location_updated_at || null,
          minutes: Math.round((now - since) / 60000),
          ts: new Date().toISOString(),
        });
      } else if (!isStale && stale.has(c.id)) {
        stale.delete(c.id);
        // Tracking switched off is reported on its own (crew.tracking.changed);
        // only announce a recovery when positions really came back.
        if (on) bus.publish(TOPICS.CREW_LOCATION_STALE, { crewId: c.id, crewName: c.name, stale: false, lastSeenAt: c.location_updated_at, ts: new Date().toISOString() });
      }
    }
  };

  const run = () => check().catch((e) => console.error('[staleLocation] check failed:', e.message));
  run();
  return setInterval(run, CHECK_EVERY_MS);
}
