import { EventEmitter } from 'node:events';
import { Kafka, logLevel } from 'kafkajs';

// Event bus with a Kafka-shaped interface (SDP §3; INT-001). Topics mirror
// the CIM tree, e.g. oms.incident.created, scada.alarm.raised, crew.job.updated.
//
// Two drivers behind the same publish/subscribe/onAny/init API, chosen by
// EVENT_BUS_DRIVER:
//   - "memory" (default): in-process EventEmitter — zero external deps, what
//     the whole app has been running on since the prototype. Good for a
//     laptop that isn't running the Kafka container.
//   - "kafka": real KafkaJS producer/consumer against the brokers in
//     KAFKA_BROKERS. This is the actual Phase-1-tail swap-in — same topic
//     names, same call sites, nothing else in the app needs to change.
export const TOPICS = {
  INCIDENT_CREATED: 'oms.incident.created',
  INCIDENT_UPDATED: 'oms.incident.updated',
  ALARM_RAISED: 'scada.alarm.raised',
  ALARM_ACKED: 'scada.alarm.acked',
  CALL_RECEIVED: 'tcs.call.received',
  CREW_UPDATED: 'crew.updated',
  JOB_UPDATED: 'crew.job.updated',
  INDICES_UPDATED: 'oms.indices.updated',
  MESSAGE_POSTED: 'oms.message.posted',
    ERT_CHANGED: 'oms.incident.ert_changed',
};
const ALL_TOPICS = Object.values(TOPICS);

class MemoryBus {
  constructor() { this._e = new EventEmitter(); this._e.setMaxListeners(0); }
  async init() { /* nothing to connect */ }
  publish(topic, payload) {
    this._e.emit(topic, payload);
    this._e.emit('*', { topic, payload });
  }
  subscribe(topic, handler) { this._e.on(topic, handler); return () => this._e.off(topic, handler); }
  onAny(handler) { this._e.on('*', handler); }
  async close() {}
}

class KafkaBus {
  constructor(brokers) {
    this._kafka = new Kafka({ clientId: 'oms-backend', brokers, logLevel: logLevel.NOTHING });
    this._producer = this._kafka.producer();
    this._consumer = this._kafka.consumer({ groupId: 'oms-backend' });
    this._local = new EventEmitter(); // fan-out to in-process subscribers once a message round-trips through Kafka
    this._local.setMaxListeners(0);
  }

  async init() {
    await this._producer.connect();
    await this._consumer.connect();
    const admin = this._kafka.admin();
    await admin.connect();
    const existing = await admin.listTopics();
    const missing = ALL_TOPICS.filter((t) => !existing.includes(t));
    if (missing.length) await admin.createTopics({ topics: missing.map((topic) => ({ topic, numPartitions: 1 })) });
    await admin.disconnect();

    await this._consumer.subscribe({ topics: ALL_TOPICS, fromBeginning: false });
    await this._consumer.run({
      eachMessage: async ({ topic, message }) => {
        const payload = message.value ? JSON.parse(message.value.toString()) : null;
        this._local.emit(topic, payload);
        this._local.emit('*', { topic, payload });
      },
    });
    console.log('[bus] Kafka driver connected');
  }

  publish(topic, payload) {
    // Fire-and-forget from the caller's point of view, matching the memory
    // bus's synchronous-looking API; errors are logged, not thrown, so a
    // blip on the broker doesn't take down the request that triggered it.
    this._producer.send({ topic, messages: [{ value: JSON.stringify(payload) }] })
      .catch((err) => console.error(`[bus] publish failed (${topic}):`, err.message));
  }
  subscribe(topic, handler) { this._local.on(topic, handler); return () => this._local.off(topic, handler); }
  onAny(handler) { this._local.on('*', handler); }
  async close() { await this._producer.disconnect(); await this._consumer.disconnect(); }
}

const driver = (process.env.EVENT_BUS_DRIVER || 'memory').toLowerCase();
let impl;
if (driver === 'kafka') {
  const brokers = (process.env.KAFKA_BROKERS || 'localhost:19092').split(',').map((s) => s.trim());
  impl = new KafkaBus(brokers);
} else {
  impl = new MemoryBus();
}

export const bus = impl;

// Call once at boot (see index.js). Kept separate from module load because
// connecting to Kafka is async and index.js already awaits migrate()/seed()
// in the same style before starting the HTTP server.
export async function initBus() {
  try {
    await bus.init();
  } catch (err) {
    console.error(`[bus] failed to initialize "${driver}" driver:`, err.message);
    if (driver === 'kafka') {
      console.warn('[bus] falling back to in-memory driver for this run — fix KAFKA_BROKERS or set EVENT_BUS_DRIVER=memory to silence this warning');
      // Swap the exported bus's behaviour onto a fresh memory bus so every
      // module that already imported { bus } gets working behaviour without
      // needing to re-import anything.
      const fallback = new MemoryBus();
      await fallback.init();
      Object.setPrototypeOf(bus, Object.getPrototypeOf(fallback));
      Object.assign(bus, fallback);
    }
  }
}