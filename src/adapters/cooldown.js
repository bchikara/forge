/**
 * Provider cooldowns.
 *
 * jobright's lookup allowance resets roughly an hour after it is hit.
 * Without recording that, every run rediscovers the limit by spending a
 * request on it, and a run starting inside the window burns one lookup
 * per company learning what the previous run already knew.
 *
 * So the moment a quota error arrives, the reset time is written down
 * and later callers check it before making a request at all.
 */

import { db } from '../db/index.js';

export function startCooldown(provider, ms, reason = null) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  const existing = db().prepare('SELECT hits FROM provider_cooldown WHERE provider = ?').get(provider);

  db()
    .prepare(
      `INSERT INTO provider_cooldown (provider, reason, until, hit_at, hits)
       VALUES (?, ?, datetime('now', ?), datetime('now'), ?)
       ON CONFLICT(provider) DO UPDATE SET
         reason = excluded.reason,
         until  = excluded.until,
         hit_at = excluded.hit_at,
         hits   = provider_cooldown.hits + 1`
    )
    .run(provider, reason, `+${seconds} seconds`, (existing?.hits ?? 0) + 1);

  return cooldownStatus(provider);
}

/**
 * Seconds until a provider is usable, or 0 if it is usable now.
 *
 * An expired row is deleted rather than left behind, so status reads
 * as a simple "is there a cooldown" rather than needing every caller
 * to compare timestamps.
 */
export function cooldownRemaining(provider) {
  const row = db().prepare('SELECT * FROM provider_cooldown WHERE provider = ?').get(provider);
  if (!row) return 0;

  const left = db()
    .prepare(`SELECT CAST(strftime('%s', ?) - strftime('%s','now') AS INTEGER) AS s`)
    .get(row.until).s;

  if (left <= 0) {
    db().prepare('DELETE FROM provider_cooldown WHERE provider = ?').run(provider);
    return 0;
  }
  return left;
}

export function isCoolingDown(provider) {
  return cooldownRemaining(provider) > 0;
}

export function cooldownStatus(provider) {
  const left = cooldownRemaining(provider);
  if (left === 0) return { provider, coolingDown: false };
  const row = db().prepare('SELECT * FROM provider_cooldown WHERE provider = ?').get(provider);
  return {
    provider,
    coolingDown: true,
    secondsRemaining: left,
    minutesRemaining: Math.ceil(left / 60),
    until: row.until,
    reason: row.reason,
    hits: row.hits,
  };
}

/** Clear a cooldown early — for when the operator knows it has reset. */
export function clearCooldown(provider) {
  const res = db().prepare('DELETE FROM provider_cooldown WHERE provider = ?').run(provider);
  return { cleared: res.changes > 0 };
}
