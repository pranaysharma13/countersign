// Shared write helpers used by both v1 (logic.ts) and v2 (logic_v2.ts) reducer bodies.
import { JOB_KINDS } from './constants';
import { audit, json, type Call } from './request';

export function setItemState(c: Call, id: string, state: string, note = '') {
  const wi = c.ctx.db.work_item.id.find(id);
  if (!wi) return;
  const after = { ...wi, state, updated_at: c.ctx.timestamp };
  c.ctx.db.work_item.id.update(after);
  audit(c, 'work_item', id, { state: wi.state }, { state }, note);
}

export function insertJob(c: Call, id: string, kind: string, payload: unknown) {
  const row = {
    id, kind, assignee_role: JOB_KINDS[kind].assignee, payload_json: json(payload), status: 'queued',
    requested_by: c.sender_hex, claimed_by: '', result_json: '', error: '',
    created_at: c.ctx.timestamp, updated_at: c.ctx.timestamp,
    attempts: 0, next_attempt_at_iso: '', lease_expires_at_iso: '',
  };
  c.ctx.db.job.insert(row);
  audit(c, 'job', id, null, row);
}
