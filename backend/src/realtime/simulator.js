import { repo } from '../infra/repo.js';
import { bus, TOPICS } from '../domain/bus.js';
import { nanoid } from 'nanoid';
import { substations as netSubstations } from '../infra/geo.js';

// Stands in for the SCADA/DMS field-event stream (SDP FEP ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Kafka).
// Drives the "live" feel: crew GPS drift, occasional alarms and trouble calls.
const TAGS = ['DEHRA.SE01.T2.MW','HW02.FDR02.I_B','RK01.FDR03.DPI','DEHRA.SE03.V_AN','HW03.FDR01.COMM'];
const NAMES = ['Anil Verma','Sunita Devi','Rakesh Joshi','Pooja Bisht','Deepak Rana'];
const ADDR = ['Ballupur, Dehradun','Jwalapur, Haridwar','Tapovan, Rishikesh','Clement Town, Dehradun'];

export function startSimulator() {
  // crew GPS drift every 8s ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ live map movement (FR-OMS-018)
  setInterval(async () => {
    try {
      const all = await repo.crews();
      const crews = all.filter(c => c.status === 'in_transit');
      for (const c of crews) {
        const lat = c.lat + (Math.random() - 0.5) * 0.004;
        const lon = c.lon + (Math.random() - 0.5) * 0.004;
        await repo.updateCrew(c.id, { lat, lon });
        bus.publish(TOPICS.CREW_UPDATED, await repo.crew(c.id));
      }
    } catch (e) { console.error('[simulator] crew drift error', e); }
  }, 8000);

  // occasional SCADA alarm every ~22s
  setInterval(async () => {
    if (Math.random() > 0.55) return;
    try {
      const conds = ['MINOR','MAJOR','CRITICAL'];
      const cond = conds[Math.floor(Math.random() * conds.length)];
      const s = netSubstations[Math.floor(Math.random() * netSubstations.length)] || { lat: 29.95, lon: 78.13 };
      const a = await repo.createAlarm({
        id: 'ALM-' + nanoid(5), tag: TAGS[Math.floor(Math.random() * TAGS.length)],
        condition: cond, limit_val: cond === 'CRITICAL' ? 'TRIP' : '95A',
        priority: cond === 'CRITICAL' ? 1 : cond === 'MAJOR' ? 2 : 3,
        message: `${cond} condition detected on field device`, ts: new Date().toISOString(), ack: 0,
      });
      bus.publish(TOPICS.ALARM_RAISED, { ...a, lat: s.lat, lon: s.lon });
      bus.publish(TOPICS.ALARM_RAISED, a);
    } catch (e) { console.error('[simulator] alarm error', e); }
  }, 22000);

  // occasional customer trouble call every ~30s
  setInterval(async () => {
    if (Math.random() > 0.5) return;
    try {
      const c = await repo.createCall({
        id: 'CALL-' + nanoid(5), customer: NAMES[Math.floor(Math.random() * NAMES.length)],
        phone: '98' + Math.floor(10000000 + Math.random() * 89999999),
        address: ADDR[Math.floor(Math.random() * ADDR.length)],
        category: Math.random() > 0.8 ? 'Medical' : 'Normal', status: 'unassigned',
        linked_id: null, ts: new Date().toISOString(),
      });
      bus.publish(TOPICS.CALL_RECEIVED, c);
    } catch (e) { console.error('[simulator] trouble call error', e); }
  }, 30000);
}