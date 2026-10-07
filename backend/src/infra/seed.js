import { db, migrate, syncIdSequences } from './db.js';

// Seed mirrors the UPCL "Ganga Corridor" reference data from the SRS/screens:
// Dehradun, Haridwar, Rishikesh — real coordinates, CIM-style feeder IDs, UNS tags.
export async function seed({ force = false } = {}) {
  await migrate();
  const { n } = await db.one('SELECT COUNT(*) n FROM incidents');
  if (Number(n) > 0 && !force) return { skipped: true };

  await db.tx(async (t) => {
    for (const table of ['job_updates','jobs','incident_events','trouble_calls','alarms','audit_log','complaints','incidents','crews']) {
      await t.none(`DELETE FROM ${table}`);
    }
  });

  const now = new Date();
  const iso = (mMinAgo) => new Date(now.getTime() - mMinAgo * 60000).toISOString();
  const hhmm = (d) => new Date(d).toTimeString().slice(0, 5);

  const crews = [
    ['C001','Crew Alpha-3','Rajesh Kumar','in_service','Bhoopatwala','INC-2026-000001',29.9709,78.1819,'HV,Underground'],
    ['C002','Crew Beta-1','Amit Sharma','in_transit','Industrial Area','INC-2026-000002',29.9455,78.1440,'MV,Recloser'],
    ['C003','Crew Gamma-2','Priya Singh','in_transit','Mayapur','INC-2026-000004',29.9390,78.1490,'HV,Transformer'],
    ['C004','Crew Delta-4','Suresh Patel','available','Kankhal Depot',null,29.9183,78.1436,'MV,Fuse'],
    ['C005','Crew Echo-1','Meena Rao','available','Gurukul Depot',null,29.9200,78.1161,'MV,LV'],
    ['C006','Crew Zeta-2','Vijay Nair','on_break','Jwalapur Depot',null,29.9281,78.0850,'HV,Substation'],
  ];
  for (const c of crews) {
    await db.none(`INSERT INTO crews (id,name,lead,status,location,job_id,lat,lon,skills)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, c);
  }

  const SLA = { critical: 90, high: 180, medium: 360, low: 720 }; // minutes
  const incidents = [
    ['INC-2026-000001','Power Outage','critical','in_progress','Bhoopatwala','UPCL-BW-A',1240,'Transformer failure',29.971419,78.182491,'C001',126,'33/11 kV BHOOPATWALA S/s'],
    ['INC-2026-000002','Power Outage','high','dispatched','Industrial Area','UPCL-IA-B',620,'Tree contact',29.948153,78.146462,'C002',78,'33/11 kV INDUSTRIAL AREA S/s'],
    ['INC-2026-000003','Partial Power','medium','open','Jwalapur-I','UPCL-JW-B',310,'Cable fault',29.920357,78.098809,null,55,'33/11 kV JWALAPUR-I S/s'],
    ['INC-2026-000004','Power Outage','critical','pending','Mayapur','UPCL-MP-A',890,'Breaker trip',29.940311,78.147653,'C003',145,'33/11 kV MAYAPUR S/s'],
    ['INC-2026-000005','Power Outage','low','resolved','Kankhal-2','UPCL-KK-C',120,'Equipment failure',29.918303,78.143566,'C004',220,'33/11 kV KANKHAL- 2 S/s'],
    ['INC-2026-000006','Power Outage','high','open','Bairagi Camp','UPCL-BC-A',445,'No Supply',29.938929,78.157583,null,8,'33/11 kV BAIRAGI CAMP S/s'],
    ['INC-2026-000007','Scheduled','low','scheduled','Gurukul','UPCL-GK-D',200,'Maintenance',29.920027,78.116094,'C005',0,'33/11 kV GURUKUL S/s'],
    // raised from trouble calls (source 'TCS'): one closed, one cancelled as a false alarm
    ['INC-2026-000008','Power Outage','medium','closed','Kankhal-2','UPCL-KK-C',1,'Customer reported',29.918303,78.143566,'C004',600,'33/11 kV KANKHAL- 2 S/s','TCS'],
    ['INC-2026-000009','Power Outage','medium','cancelled','Jwalapur-I','UPCL-JW-B',1,'Customer reported',29.920357,78.098809,null,400,'33/11 kV JWALAPUR-I S/s','TCS'],
  ];

  let evtN = 0;
  for (const [id,type,severity,status,zone,feeder,customers,cause,lat,lon,crew,openMin,substation,src] of incidents) {
    const opened = iso(openMin);
    const slaDue = new Date(new Date(opened).getTime() + SLA[severity]*60000).toISOString();
    await db.none(`INSERT INTO incidents
      (id,type,severity,status,zone,feeder,customers,cause,lat,lon,crew_id,opened_at,ert,sla_due_at,source,substation)
      VALUES ($/id/,$/type/,$/severity/,$/status/,$/zone/,$/feeder/,$/customers/,$/cause/,$/lat/,$/lon/,$/crew_id/,$/opened_at/,$/ert/,$/sla_due_at/,$/source/,$/substation/)`,
      {
        id, type, severity, status, zone, feeder, customers, cause, lat, lon,
        crew_id: crew, opened_at: opened,
        ert: ['resolved', 'closed', 'cancelled'].includes(status) ? null : iso(openMin - 120),
        sla_due_at: slaDue, source: src || (type === 'Scheduled' ? 'PLANNED' : 'SCADA'), substation
      });
    await db.none(`INSERT INTO incident_events (id,incident_id,ts,actor,kind,note) VALUES ($1,$2,$3,$4,$5,$6)`,
      ['EV'+(++evtN), id, opened, 'SCADA', 'created', `${cause} detected on ${feeder}`]);
    if (crew) await db.none(`INSERT INTO incident_events (id,incident_id,ts,actor,kind,note) VALUES ($1,$2,$3,$4,$5,$6)`,
      ['EV'+(++evtN), id, iso(openMin-10), 'Dispatcher', 'assigned', `${crew} assigned`]);
    if (status === 'resolved') await db.none(`INSERT INTO incident_events (id,incident_id,ts,actor,kind,note) VALUES ($1,$2,$3,$4,$5,$6)`,
      ['EV'+(++evtN), id, iso(openMin-180), 'Crew', 'restored', 'Supply restored, confirmed']);
  }

  const alarms = [
    ['ALM-001','DEHRA.SE01.T1.MW','CRITICAL','110%',1,'Transformer T1 overload — 112% rated capacity',2,0],
    ['ALM-002','DEHRA.SE01.F02.DPI','MAJOR','OPEN',2,'Feeder F02 breaker open — DPI state changed',6,0],
    ['ALM-003','HW02.FDR01.I_A','MAJOR','95A',2,'Phase A overcurrent on Haridwar Feeder 01',22,1],
    ['ALM-004','RK03.FDR04.COMM','MINOR','FAIL',3,'FRTU communication failure — Rishikesh East F04',35,1],
    ['ALM-005','DEHRA.SE02.F01.DPI','CRITICAL','OPEN',1,'Feeder F01 breaker trip — circuit protection',145,0],
  ];
  for (const [id,tag,cond,lim,pri,msg,min,ack] of alarms) {
    await db.none(`INSERT INTO alarms (id,tag,condition,limit_val,priority,message,ts,ack)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id,tag,cond,lim,pri,msg,iso(min),ack]);
  }

  // Displayed state is derived from the linked incident (see domain/callState.js);
  // only 'rejected' is stored. Area = substation, same string format as incidents.substation.
  const BW = '33/11 kV BHOOPATWALA S/s', IA = '33/11 kV INDUSTRIAL AREA S/s', JW = '33/11 kV JWALAPUR-I S/s';
  const MP = '33/11 kV MAYAPUR S/s', KK = '33/11 kV KANKHAL- 2 S/s', BC = '33/11 kV BAIRAGI CAMP S/s';
  const calls = [
    // id, customer, phone, address, category, status, linked incident, minutes ago, area, reject reason
    ['CALL-001','Suresh Agarwal','9876543210','12 Rajpur Rd, Dehradun','Normal','incident','INC-2026-000001',128,BW],             // Assigned (in_progress)
    ['CALL-002','Anita Mehta','9811234567','45 Haridwar Bypass','Medical','unassigned',null,5,IA],                                  // Unassigned
    ['CALL-003','Ram Prasad','9988776655','7 Laxman Jhula Rd, Rishikesh','Critical','incident','INC-2026-000003',57,JW],           // Incident (open, no crew)
    ['CALL-004','Kavita Sharma','9765432109','23 Hardwar Rd, Rishikesh','Normal','incident','INC-2026-000005',232,KK],             // Completed (resolved)
    ['CALL-005','Dr. Mukesh Gupta','9012345678','Hospital Colony, Dehradun','Medical','incident','INC-2026-000004',140,MP],        // Assigned (pending)
    ['CALL-006','Maharaja Resorts','9897001122','Rajpur Road Hotel Strip, Dehradun','Premium-VIP','unassigned',null,12,MP],        // Unassigned, VIP
    ['CALL-007','Rohit Negi','9837055500','Plot 9, Sapt Sarovar Marg','Normal','rejected',null,90,BW,'Duplicate of CALL-001 (same feeder fault)'], // Rejected
    ['CALL-008','Seema Kapoor','9719023456','88 Kankhal Main Rd','Normal','incident','INC-2026-000008',590,KK],                    // Closed
    ['CALL-009','Imran Qureshi','9760077889','14 Jwalapur Market','Normal','incident','INC-2026-000009',395,JW],                   // Rejected (incident cancelled)
    ['CALL-010','Poonam Rawat','9412099001','31 Bairagi Camp Road','Critical','incident','INC-2026-000006',6,BC],                  // Incident (open, no crew)
    ['CALL-011','Hari Om Dairy','9927011223','Industrial Area Ph-2','Premium-VIP','incident','INC-2026-000002',70,IA],             // Assigned (dispatched)
  ];
  for (const [id,cust,ph,addr,cat,st,link,min,area,rejectReason] of calls) {
    await db.none(`INSERT INTO trouble_calls (id,customer,phone,address,category,status,linked_id,ts,area,reject_reason,rejected_at,rejected_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id,cust,ph,addr,cat,st,link,iso(min),area,rejectReason || null,rejectReason ? iso(min - 20) : null,rejectReason ? 'operator' : null]);
  }

  // jobs derived from assigned incidents
  const jobs = [
    ['JOB-001','INC-2026-000001','C001','Urgent','On Site','Dehradun Central substation SE01', iso(30)],
    ['JOB-002','INC-2026-000002','C002','Normal','En Route','Haridwar North feeder HW02', iso(12)],
    ['JOB-004','INC-2026-000004','C003','Urgent','En Route','Dehradun West feeder SE02', iso(20)],
  ];
  for (const j of jobs) {
    await db.none(`INSERT INTO jobs (id,incident_id,crew_id,priority,status,address,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, j);
  }

  // pre-existing complaints (already ingested via the API), showing merge vs individual
  const comps = [
    ['QRY-2026-000001','EXT-448201','Ramesh Chauhan','9837012345','Bhoopatwala Rd','No Supply',29.9714,78.1825,null,'UPCL-BW-A','33/11 kV BHOOPATWALA S/s','INC-2026-000001','merged',118],
    ['QRY-2026-000002','EXT-448233','Geeta Rani','9837099887','Sapt Sarovar','No Supply',29.9718,78.1820,null,'UPCL-BW-A','33/11 kV BHOOPATWALA S/s','INC-2026-000001','merged',96],
    ['QRY-2026-000003','EXT-449120','Farhan Ali','9837045678','Sector 4 Ind. Area','No Supply',29.9481,78.1465,null,'UPCL-IA-B','33/11 kV INDUSTRIAL AREA S/s','INC-2026-000002','merged',70],
    ['QRY-2026-000004','EXT-450871','Nisha Thapa','9837023456','Bairagi Camp','No Supply',29.9389,78.1576,null,'UPCL-BC-A','33/11 kV BAIRAGI CAMP S/s','INC-2026-000006','created',8],
  ];
  for (const c of comps) {
    await db.none(`INSERT INTO complaints
      (qid,external_id,customer,phone,address,category,lat,lon,dt_id,feeder,substation,incident_id,action,ts)
      VALUES ($/qid/,$/external_id/,$/customer/,$/phone/,$/address/,$/category/,$/lat/,$/lon/,$/dt_id/,$/feeder/,$/substation/,$/incident_id/,$/action/,$/ts/)`,
      { qid: c[0], external_id: c[1], customer: c[2], phone: c[3], address: c[4], category: c[5], lat: c[6], lon: c[7], dt_id: c[8], feeder: c[9], substation: c[10], incident_id: c[11], action: c[12], ts: iso(c[13]) });
  }

  // The demo incidents/complaints above use hand-written IDs, inserted after
  // migrate() already set the counters (on empty tables). Move the counters past
  // them now, or the next real incident collides with seed data.
  await syncIdSequences();

  return { seeded: true, incidents: incidents.length, crews: crews.length };
}

// allow `npm run seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await seed({ force: process.argv.includes('--force') });
  console.log('[seed]', r);
}