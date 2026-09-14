import nodemailer from 'nodemailer';
import { nanoid } from 'nanoid';
import { bus, TOPICS } from '../domain/bus.js';
import { db } from '../infra/db.js';
import { repo } from '../infra/repo.js';

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

function describe(inc) {
  const where = inc.zone || inc.feeder || inc.substation || 'the network';
  return { where };
}

export function startNotifier() {
  bus.subscribe(TOPICS.INCIDENT_CREATED, async (inc) => {
    const { where } = describe(inc);
    const subject = `Power outage reported in ${where}`;
    const body = `We have detected a power outage affecting ${where}` +
      (inc.customers ? ` (approx. ${inc.customers} customers)` : '') +
      `. Our crews have been notified and are responding. Incident ref: ${inc.id}.`;
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
