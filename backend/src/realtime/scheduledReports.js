import cron from 'node-cron';
import { repo } from '../infra/repo.js';
import { computeIndices } from '../domain/indices.js';
import { buildPdf } from '../domain/reports.js';
import { transport } from './notifier.js'; // reuses the same Brevo SMTP connection notifier.js already sets up

const RECIPIENTS = (process.env.REPORT_RECIPIENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const FROM = process.env.NOTIFY_FROM;
// Default: every Monday 06:00 — a standard weekly regulatory-reporting
// cadence. Override via REPORT_CRON if the utility wants a different
// schedule (e.g. monthly: '0 6 1 * *').
const SCHEDULE = process.env.REPORT_CRON || '0 6 * * 1';

async function generateAndSend() {
  if (!RECIPIENTS.length) {
    console.log('[scheduled-reports] no REPORT_RECIPIENTS configured — skipping scheduled send');
    return;
  }
  const incidents = await repo.incidents();
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  const indices = computeIndices(incidents, { from: from.toISOString(), to: to.toISOString() });
  const meta = { generatedAt: to.toISOString(), filters: indices.filters };
  const pdf = await buildPdf(indices, meta);

  const info = await transport.sendMail({
    from: FROM,
    to: RECIPIENTS.join(','),
    subject: `Weekly Reliability Report — ${from.toDateString()} to ${to.toDateString()}`,
    text: `Attached: SAIDI ${indices.saidi} min, SAIFI ${indices.saifi}, CAIDI ${indices.caidi} min. Generated automatically.`,
    attachments: [{ filename: 'reliability-report.pdf', content: pdf }],
  });
  console.log(`[scheduled-reports] sent to ${RECIPIENTS.length} recipient(s), messageId=${info.messageId}`);
  return info;
}

export function startScheduledReports() {
  if (!cron.validate(SCHEDULE)) {
    console.error(`[scheduled-reports] invalid REPORT_CRON expression "${SCHEDULE}" — scheduler not started`);
    return;
  }
  // Weekly cron run: swallow errors here specifically, so one bad send
  // (network blip, temporary SMTP issue) doesn't crash the whole app —
  // this is the one place silent-catch is actually correct.
  cron.schedule(SCHEDULE, () => generateAndSend().catch((err) =>
    console.error('[scheduled-reports] failed to generate/send:', err.message)));
  console.log(`[scheduled-reports] active — cron "${SCHEDULE}", ${RECIPIENTS.length} recipient(s) configured`);
}

// Manual "send now" (admin button / test) — deliberately lets errors
// propagate, unlike the cron path above, since the whole point of a manual
// trigger is finding out whether it actually worked.
export { generateAndSend as sendReportNow };