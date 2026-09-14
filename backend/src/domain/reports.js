import PDFDocument from 'pdfkit';

// ---------- CSV ----------
// Hand-rolled rather than pulling in a CSV library: the data shape here is
// simple (flat key/value pairs), and a correct RFC-4180 escaper is about
// 4 lines — not worth a new dependency for.
function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(indices, meta) {
  const rows = [
    ['Metric', 'Value', 'Target', 'Standard'],
    ['SAIDI (min)', indices.saidi, indices.saidiTarget, 'IEEE 1366'],
    ['SAIFI', indices.saifi, indices.saifiTarget, 'IEEE 1366'],
    ['CAIDI (min)', indices.caidi, '', 'IEEE 1366'],
    ['MAIFI', indices.maifi, '', 'IEEE 1366'],
    [],
    ['Customers served', indices.customersServed],
    ['Customers affected', indices.customersAffected],
    ['Incidents counted', indices.incidentCount],
    [],
    ['Filter: from', meta.filters.from || 'all time'],
    ['Filter: to', meta.filters.to || 'all time'],
    ['Filter: zone', meta.filters.zone || 'all zones'],
    ['Filter: source (asset-type stand-in)', meta.filters.assetType || 'all sources'],
    ['Generated at', meta.generatedAt],
  ];
  return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
}

// ---------- PDF ----------
export function buildPdf(indices, meta) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).font('Helvetica-Bold').text('Reliability Indices Report', { align: 'left' });
    doc.fontSize(10).font('Helvetica').fillColor('#61798a')
      .text('Uttarakhand Power Corp · Ganga Corridor Control Centre', { align: 'left' });
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor('#61798a').text(`Generated: ${meta.generatedAt}`);
    doc.text(
      `Period: ${meta.filters.from || 'all time'} \u2013 ${meta.filters.to || 'present'}` +
      (meta.filters.zone ? `  ·  Zone: ${meta.filters.zone}` : '') +
      (meta.filters.assetType ? `  ·  Source: ${meta.filters.assetType}` : '')
    );
    doc.moveDown(1);

    const row = (label, value, target, standard) => {
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#0b2033').text(label, { continued: true });
      doc.font('Helvetica').text(` ${' '.repeat(Math.max(1, 18 - label.length))}${value}`, { continued: !!(target || standard) });
      if (target) doc.fillColor('#61798a').text(`   (target: ${target})`, { continued: !!standard });
      if (standard) doc.text(`   [${standard}]`);
    };

    row('SAIDI (minutes)', indices.saidi, indices.saidiTarget, 'IEEE 1366');
    row('SAIFI', indices.saifi, indices.saifiTarget, 'IEEE 1366');
    row('CAIDI (minutes)', indices.caidi, null, 'IEEE 1366');
    row('MAIFI', indices.maifi, null, 'IEEE 1366 (placeholder — see note below)');

    doc.moveDown(1);
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#0b2033').text('Underlying data');
    doc.fontSize(10).font('Helvetica').fillColor('#0b2033');
    doc.text(`Customers served (base): ${indices.customersServed}`);
    doc.text(`Customers affected: ${indices.customersAffected}`);
    doc.text(`Incidents counted: ${indices.incidentCount}`);

    doc.moveDown(1.2);
    doc.fontSize(8).fillColor('#94a3b8').font('Helvetica-Oblique').text(
      'Note: MAIFI is currently a fixed placeholder value, not computed from real momentary-interruption ' +
      'events — the incidents schema does not yet distinguish momentary (auto-reclose <5 min) events from ' +
      'sustained outages. Treat this figure as illustrative until that data is captured.',
      { width: 500 }
    );

    doc.end();
  });
}