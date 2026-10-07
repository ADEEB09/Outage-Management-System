import nodemailer from 'nodemailer';
import { nanoid } from 'nanoid';
import { bus, TOPICS } from '../domain/bus.js';
import { db } from '../infra/db.js';
import { repo } from '../infra/repo.js';
import { deriveCallState, cleanSubstation } from '../domain/callState.js';

export const transport = nodemailer.createTransport({
  host: process.env.BREVO_SMTP_HOST,
  port: Number(process.env.BREVO_SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_USER,
    pass: process.env.BREVO_SMTP_KEY,
  },
});

const FROM = process.env.NOTIFY_FROM;
const TEST_TO = process.env.NOTIFY_TEST_TO;

async function record(incidentId, channel, recipient, subject, body, status, error) {
  try {
    await db.none(
      `INSERT INTO notifications (id, incident_id, channel, recipient, subject, body, status, error, ts)
       VALUES ($/id/, $/incident_id/, $/channel/, $/recipient/, $/subject/, $/body/, $/status/, $/error/, $/ts/)`,
      { id: 'NOT' + nanoid(8), incident_id: incidentId, channel, recipient, subject, body, status,
        error: error || null, ts: new Date().toISOString() }
    );
  } catch (e) {
    console.error('[notifier] could not record notification:', e.message);
  }
}

async function sendEmail(incidentId, subject, body) {
  if (await repo.isOptedOut(TEST_TO, 'email')) {
    console.log(`[notifier] EMAIL skipped (opted out) -> ${TEST_TO}`);
    await record(incidentId, 'email', TEST_TO, subject, body, 'skipped-optout', null);
    return;
  }
  try {
    await transport.sendMail({ from: FROM, to: TEST_TO, subject, text: body });
    console.log(`[notifier] EMAIL sent -> ${TEST_TO}: ${subject}`);
    await record(incidentId, 'email', TEST_TO, subject, body, 'sent', null);
  } catch (e) {
    console.error('[notifier] EMAIL failed:', e.message);
    await record(incidentId, 'email', TEST_TO, subject, body, 'failed', e.message);
  }
}

async function sendSms(incidentId, body) {
  if (await repo.isOptedOut(TEST_TO, 'sms')) {
    console.log(`[notifier] SMS skipped (opted out) -> ${TEST_TO}`);
    await record(incidentId, 'sms', TEST_TO, null, body, 'skipped-optout', null);
    return;
  }
  console.log(`[notifier] SMS (console only) -> customer: ${body}`);
  await record(incidentId, 'sms', TEST_TO, null, body, 'logged', null);
}

// ---- Restoration callbacks (OMS-02) ----
// One SMS per trouble call / complaint linked to a restored incident. Like the
// SMS above this is console-only (no SMS gateway yet), recorded in
// notifications. Phone numbers are only held in memory: the DB row, logs and
// timeline get a masked number. Idempotent per (incident, contact_ref) via a
// unique index, so a retry or a second reclose never sends twice.
const maskPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d ? '*'.repeat(Math.max(0, d.length - 4)) + d.slice(-4) : null;
};

async function claimCallback(incidentId, contactRef, recipient, body, status) {
  const row = await db.oneOrNone(
    `INSERT INTO notifications (id, incident_id, channel, recipient, subject, body, status, error, ts, contact_ref)
     VALUES ($/id/, $/incident_id/, 'sms', $/recipient/, 'Restoration callback', $/body/, $/status/, NULL, $/ts/, $/contact_ref/)
     ON CONFLICT (incident_id, contact_ref) WHERE contact_ref IS NOT NULL DO NOTHING
     RETURNING id`,
    { id: 'NOT' + nanoid(8), incident_id: incidentId, recipient, body, status, ts: new Date().toISOString(), contact_ref: contactRef });
  return !!row;
}

export async function sendRestorationCallbacks(inc) {
  const where = cleanSubstation(inc.substation) || inc.zone || inc.feeder || 'your area';
  const body = `Supply has been restored to your area (${where}). Thank you for your patience. Ref: ${inc.id}.`;
  const calls = (await repo.callsForIncident(inc.id)).filter((c) => deriveCallState(c, inc).state !== 'Rejected');
  // Complaint phones need the pgcrypto migrations (db/migrations/*phone*.sql);
  // a database without them must not stop the trouble-call callbacks.
  let complaints = [];
  try { complaints = await repo.complaintsForIncident(inc.id); }
  catch (e) {
    console.error('[notifier] complaint contacts unavailable for callbacks:', e.message);
    await repo.addIncidentEvent(inc.id, 'SCADA', 'callback', 'Complaint contacts unavailable for callback (phone decryption not set up on this database)');
  }
  const contacts = [
    ...calls.map((c) => ({ ref: c.id, phone: c.phone })),
    ...complaints.map((c) => ({ ref: c.qid, phone: c.phone })),
  ];
  const tally = { sent: 0, optedOut: 0, noPhone: 0, already: 0 };
  for (const c of contacts) {
    const masked = maskPhone(c.phone);
    let status = 'logged';
    if (!masked) status = 'skipped-no-contact';
    else if (await repo.isOptedOut(c.phone, 'sms')) status = 'skipped-optout';
    if (!(await claimCallback(inc.id, c.ref, masked, body, status))) { tally.already++; continue; }
    if (status === 'logged') {
      console.log(`[notifier] CALLBACK SMS (console only) -> ${masked} (${c.ref}): ${body}`);
      tally.sent++;
    } else if (status === 'skipped-optout') tally.optedOut++;
    else tally.noPhone++;
  }
  if (tally.sent || tally.optedOut || tally.noPhone) {
    const extra = [tally.optedOut && `${tally.optedOut} opted out`, tally.noPhone && `${tally.noPhone} no phone`].filter(Boolean).join(', ');
    await repo.addIncidentEvent(inc.id, 'SCADA', 'callback',
      `Callback initiated to ${tally.sent} customer${tally.sent === 1 ? '' : 's'}${extra ? ` (${extra})` : ''}`);
  }
  return tally;
}

function describe(inc) {
  const where = inc.zone || inc.feeder || inc.substation || 'the network';
  return { where };
}

export function startNotifier() {
  bus.subscribe(TOPICS.INCIDENT_CREATED, async (inc) => {
    // A planned outage is not "detected"; it gets its own advance notice below.
    if (inc.type === 'Scheduled') return;
    const { where } = describe(inc);
    const subject = `Power outage reported in ${where}`;
    const body = `We have detected a power outage affecting ${where}` +
      (inc.customers ? ` (approx. ${inc.customers} customers)` : '') +
      `. Our crews have been notified and are responding. Incident ref: ${inc.id}.`;
    await sendEmail(inc.id, subject, body);
    await sendSms(inc.id, body);
  });

  // OMS-01 advance notice of a planned outage. The restoration notice is the
  // ordinary "power restored" message below, sent when it is resolved.
  bus.subscribe(TOPICS.PLANNED_NOTICE, async ({ incident: inc, windowStart, windowEnd, workDescription }) => {
    const { where } = describe(inc);
    const fmt = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
    const subject = `Planned power shutdown in ${where}`;
    const body = `Planned shutdown in ${where} from ${fmt(windowStart)} to ${fmt(windowEnd)} for ${workDescription}` +
      (inc.customers ? ` (approx. ${inc.customers} customers)` : '') +
      `. Supply will be restored as soon as the work is complete. Ref: ${inc.id}.`;
    await sendEmail(inc.id, subject, body);
    await sendSms(inc.id, body);
  });

  bus.subscribe(TOPICS.INCIDENT_UPDATED, async (inc) => {
    const s = (inc.status || '').toLowerCase();
    if (s === 'resolved' || s === 'restored' || s === 'closed') {
      const { where } = describe(inc);
      const subject = `Power restored in ${where}`;
      const body = `Power has been restored in ${where}. Thank you for your patience. Incident ref: ${inc.id}.`;
      await sendEmail(inc.id, subject, body);
      await sendSms(inc.id, body);
    }
  });

  bus.subscribe(TOPICS.ERT_CHANGED, async (inc) => {
    const { where } = describe(inc);
    const subject = `Updated restoration time for ${where}`;
    const body = `The estimated restoration time for the outage in ${where} has changed to ` +
      `${new Date(inc.ert).toLocaleString()}. Incident ref: ${inc.id}.`;
    await sendEmail(inc.id, subject, body);
    await sendSms(inc.id, body);
  });

  console.log('[notifier] started - listening for incident events');
}
