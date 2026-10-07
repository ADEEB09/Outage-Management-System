// OMS-01 planned outages: control-room calls. The API answers rule
// rejections as { code, message }; surface the message (and keep the code).
import { req } from './api.js';

const call = async (method, path, body) => {
  try {
    return await req(method, path, body);
  } catch (e) {
    throw Object.assign(new Error(e.data?.message || e.message), { code: e.data?.code, status: e.status });
  }
};

// Each confirmation attempt gets its own id; the server treats a repeat of the
// same id as the same confirmation.
export const newClientId = () => (crypto.randomUUID ? crypto.randomUUID() : `cr-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const plannedApi = {
  list: () => call('GET', '/planned-outages'),
  get: (id) => call('GET', `/planned-outages/${id}`),
  safetyLog: (id) => call('GET', `/planned-outages/${id}/safety-log`),
  create: (body) => call('POST', '/planned-outages', body),
  reschedule: (id, body) => call('PATCH', `/planned-outages/${id}`, body),
  draftFromTrace: (id, body) => call('POST', `/planned-outages/${id}/switching-plan/draft`, body),
  saveSteps: (id, steps) => call('PUT', `/planned-outages/${id}/switching-plan/steps`, { steps }),
  approve: (id) => call('POST', `/planned-outages/${id}/switching-plan/approve`),
  unapprove: (id) => call('POST', `/planned-outages/${id}/switching-plan/unapprove`),
  notify: (id) => call('POST', `/planned-outages/${id}/notify`),
  skipNotice: (id, reason) => call('POST', `/planned-outages/${id}/notify`, { skip: true, reason }),
  cancel: (id, reason) => call('POST', `/planned-outages/${id}/cancel`, { reason }),
  close: (id) => call('POST', `/planned-outages/${id}/close`),
  confirmStep: (stepId, body) => call('POST', `/switching-steps/${stepId}/confirm`, { clientConfirmationId: newClientId(), ...body }),
  issuePermit: (permitId, body) => call('POST', `/permits/${permitId}/issue`, body),
  refusePermit: (permitId, reason) => call('POST', `/permits/${permitId}/refuse`, { reason }),
  returnOnBehalf: (permitId, body) => call('POST', `/permits/${permitId}/return-on-behalf`, { clientRequestId: newClientId(), ...body }),
};
