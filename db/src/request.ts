// The request pattern every mutating reducer uses (CONTRACT §1):
//   1. duplicate request_id -> no-op
//   2. role check -> on denial, audit row + request_result, return normally
//   3. body validates and does the work; it returns ok / invalid / denied
// Expected failures never throw: a throw would roll back the denial's audit row.
import type { Identity } from 'spacetimedb';
import type { Ctx } from './schema';
import type { Role } from './constants';

export type Outcome = 'ok' | 'duplicate' | 'denied' | 'invalid';
export interface Result { outcome: Outcome; message: string }

export interface Call {
  ctx: Ctx;
  sender: Identity;
  sender_hex: string;
  role: Role;
  reducer: string;
  request_id: string;
}

export const ok = (message = ''): Result => ({ outcome: 'ok', message });
export const invalid = (message: string): Result => ({ outcome: 'invalid', message });

export function roleOf(ctx: Ctx, sender: Identity): Role {
  const a = ctx.db.actor.identity.find(sender);
  return a ? (a.role as Role) : 'public';
}

export function json(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

export function audit(
  c: Call, entity_type: string, entity_id: string,
  before: unknown, after: unknown, reason = '', outcome: 'ok' | 'denied' = 'ok',
) {
  c.ctx.db.audit_log.insert({
    id: 0n,
    at: c.ctx.timestamp,
    request_id: c.request_id,
    actor_role: c.role,
    actor_identity: c.sender_hex,
    action: c.reducer,
    entity_type,
    entity_id,
    outcome,
    reason,
    before_json: before == null ? '' : json(before),
    after_json: after == null ? '' : json(after),
  });
}

/** Write the denial to the audit log and return a denied result. */
export function deny(c: Call, reason: string, entity_type = '', entity_id = ''): Result {
  audit(c, entity_type, entity_id, null, null, reason, 'denied');
  return { outcome: 'denied', message: reason };
}

/**
 * Run one mutating reducer through the request pattern.
 * `allowed` is the list of roles that may call it ('*' = anyone, including public).
 */
export function handle(
  ctx: Ctx, sender: Identity, reducer: string, request_id: string,
  allowed: readonly string[], body: (c: Call) => Result,
): Result {
  if (!request_id) return { outcome: 'invalid', message: 'request_id is required' };
  if (ctx.db.request_result.request_id.find(request_id)) {
    return { outcome: 'duplicate', message: 'request_id already processed' };
  }
  const c: Call = { ctx, sender, sender_hex: sender.toHexString(), role: roleOf(ctx, sender), reducer, request_id };

  let r: Result;
  if (!allowed.includes('*') && !allowed.includes(c.role)) {
    r = deny(c, `role '${c.role}' may not call ${reducer}`);
  } else {
    r = body(c);
  }
  ctx.db.request_result.insert({
    request_id, reducer, caller_role: c.role, outcome: r.outcome, message: r.message, created_at: ctx.timestamp,
  });
  return r;
}

export const oneOf = (v: string, list: readonly string[], field: string): string | null =>
  list.includes(v) ? null : `${field} must be one of: ${list.join(', ')} (got '${v}')`;

export const iso = (c: Call) => c.ctx.timestamp.toISOString();
