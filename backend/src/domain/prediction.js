// Downstream prediction (OMS-02): when a protective device trips, which
// distribution transformers and roughly how many customers are behind it.
//
// Two methods, chosen by what the event actually tells us:
//   - 'cim-trace': the event names a CIM equipment mRID that exists in the
//     network schema -> sectionalize.js walks the real topology. Only the
//     Dehradun CIM import has this today, and only when the source supplies
//     the mRID explicitly (there is no tag -> mRID lookup table yet).
//   - 'feeder': every distribution transformer on the tripped feeder in
//     network.json. Switching state is unknown, so this is the whole feeder,
//     an upper bound for a mid-feeder device.
//   - 'none': the feeder code is not in network.json (e.g. a tag-only event
//     whose tag path doesn't use the GIS feeder codes). We say so instead of
//     guessing.
//
// customers_estimate: network.json carries no customer count per
// transformer, so customers are allocated in proportion to installed kVA:
//   round(CUSTOMERS_SERVED * feeder_kva / total_network_kva)
// This is consistent with the reliability-index denominator (the estimates
// over every feeder add up to CUSTOMERS_SERVED). It is an allocation, not a
// meter count.
import { distTx as DIST_TX, substations as SUBSTATIONS } from '../infra/geo.js';
import { traceSection } from './sectionalize.js';
import { customersServed } from './indices.js';

const kvaOf = (d) => Number(d.kva) || 0;
const TOTAL_KVA = DIST_TX.reduce((s, d) => s + kvaOf(d), 0);

const byFeeder = new Map();
for (const d of DIST_TX) {
  if (!d.feeder) continue;
  if (!byFeeder.has(d.feeder)) byFeeder.set(d.feeder, []);
  byFeeder.get(d.feeder).push(d);
}

export const allocateCustomers = (kva) => (TOTAL_KVA ? Math.round(customersServed() * kva / TOTAL_KVA) : 0);

// Every feeder code in network.json with its allocated customers (selftest uses this).
export function feederAllocations() {
  return [...byFeeder.entries()].map(([feeder, list]) => {
    const kva = list.reduce((s, d) => s + kvaOf(d), 0);
    return { feeder, kva, customers: allocateCustomers(kva) };
  });
}

// Full substation name (the incidents.substation format) for a network.json feeder code.
export function substationForFeeder(feeder) {
  const list = byFeeder.get(feeder);
  if (!list || !list.length) return null;
  const ss = SUBSTATIONS.find((s) => s.code === list[0].ss);
  return ss ? ss.name : null;
}

export async function predictDownstream({ feeder, cim_mrid } = {}) {
  const BASIS_ALLOC = `customers allocated by installed kVA share of ${customersServed()} customers served (no per-transformer customer count exists)`;

  if (cim_mrid) {
    try {
      const t = await traceSection(cim_mrid);
      if (t.found) {
        const transformers = t.sectionEquipment.filter((e) => e.cim_class === 'PowerTransformer');
        return {
          method: 'cim-trace', feeder: feeder || null,
          transformers: transformers.length, kva_total: null, customers_estimate: null,
          basis: `CIM topology trace from ${cim_mrid}: ${t.sectionEquipment.length} devices in section, bounded by ${t.boundarySwitches.length} switches. `
            + 'Switch open/closed state is unknown; CIM data has no kVA or customer counts, so no customer estimate.',
        };
      }
    } catch { /* fall through to feeder method */ }
  }

  const list = feeder ? byFeeder.get(feeder) : null;
  if (!list) {
    return {
      method: 'none', feeder: feeder || null, transformers: 0, kva_total: 0, customers_estimate: null,
      basis: feeder ? `feeder '${feeder}' not found in the network model - no prediction` : 'no feeder identified for this trip - no prediction',
    };
  }
  const kva = list.reduce((s, d) => s + kvaOf(d), 0);
  return {
    method: 'feeder', feeder,
    transformers: list.length, kva_total: kva, customers_estimate: allocateCustomers(kva),
    basis: `feeder-level: all ${list.length} distribution transformers on ${feeder} (switching state unknown, so this is the whole feeder); ${BASIS_ALLOC}`,
  };
}
