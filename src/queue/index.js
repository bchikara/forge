/**
 * Task queue.
 *
 * The pipeline runs as a set of typed jobs rather than a script with
 * sequential loops. Each stage enqueues the next, so one company
 * failing does not block unrelated companies, and a crashed run
 * resumes from the database instead of from an agent's memory.
 *
 * Three properties matter here:
 *
 *   - Claims are leased. A worker that dies mid-task leaves its items
 *     claimable again once the lease expires, rather than stranded in
 *     a 'claimed' state that nothing ever clears.
 *   - Rate limits are not failures. A 429 pushes `run_after` out
 *     without consuming an attempt, so a busy day does not exhaust
 *     the retry budget for work that was never actually broken.
 *   - Permanent failures go dead immediately. A malformed URL will not
 *     parse on the third try either, and retrying it three times just
 *     delays the report that tells the operator about it.
 */

import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';

/** Ordered pipeline stages. Each enqueues the next on success. */
export const KINDS = [
  'import',         // tsenta application -> company + role rows
  'enrich_jd',      // fetch JD text, needed for the fit paragraph
  'find_contacts',  // ladder search + email resolution
  'invite',         // LinkedIn connection request
  'email',          // cold email
  'followup',       // sequence step 2
];

/** What each stage hands to next, and how hard to retry it. */
const STAGE = {
  import:        { next: 'enrich_jd',     maxAttempts: 2, priority: 10 },
  enrich_jd:     { next: 'find_contacts', maxAttempts: 3, priority: 20 },
  find_contacts: { next: 'invite',        maxAttempts: 3, priority: 30 },
  // Invitations are the preferred channel, so they run before email.
  invite:        { next: 'email',         maxAttempts: 2, priority: 40 },
  email:         { next: null,            maxAttempts: 2, priority: 50 },
  followup:      { next: null,            maxAttempts: 2, priority: 60 },
};

/**
 * Errors that will never succeed on retry.
 *
 * Distinguished from transient ones because retrying a permanent
 * failure wastes the attempt budget and delays the dead-letter entry
 * that tells the operator something needs a human.
 */
const PERMANENT = [
  /already applied/i,
  /couldn't find that job listing/i,
  /PROFILE_INCOMPLETE/i,
  /no such file/i,
  /not a linkedin profile/i,
  /invalid url/i,
  /note is \d+ chars/i,
  // The ladder walked every rung and found nobody verified at this
  // company. Searching again in a minute finds nobody again, so this
  // belongs in the dead letter where the operator can see it rather
  // than consuming the retry budget.
  /no verified contact/i,
  /ladder exhausted/i,
  /no invitable contacts/i,
];

/** Errors that mean "come back later", not "this is broken". */
const RATE_LIMITED = [/rate limit/i, /429/, /quota/i, /too many requests/i, /cap reached/i];

export function classifyError(message) {
  const m = String(message ?? '');
  if (PERMANENT.some((re) => re.test(m))) return 'permanent';
  if (RATE_LIMITED.some((re) => re.test(m))) return 'rate_limited';
  return 'transient';
}

/**
 * Add a task.
 *
 * `dedupeKey` makes enqueueing idempotent: re-running a stage cannot
 * create a second copy of work already queued or completed.
 */
export function enqueue({
  kind,
  payload = {},
  dedupeKey = null,
  companyId = null,
  roleId = null,
  runAfter = null,
  priority = null,
  maxAttempts = null,
}) {
  const stage = STAGE[kind] ?? {};
  try {
    const info = db()
      .prepare(
        `INSERT INTO tasks (kind, payload, dedupe_key, company_id, role_id,
                            run_after, priority, max_attempts)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?)`
      )
      .run(
        kind,
        JSON.stringify(payload),
        dedupeKey,
        companyId,
        roleId,
        runAfter,
        priority ?? stage.priority ?? 100,
        maxAttempts ?? stage.maxAttempts ?? 3
      );
    return { id: info.lastInsertRowid, queued: true };
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return { id: null, queued: false, reason: 'already queued' };
    }
    throw err;
  }
}

/**
 * Claim up to `limit` due tasks.
 *
 * The claim and the state change happen in one transaction so two
 * workers cannot take the same task. The lease is what makes a crashed
 * worker recoverable.
 */
export function claim({ kinds = null, limit = 1, leaseSeconds = 900, workerId = null } = {}) {
  const d = db();
  const worker = workerId ?? `w-${randomUUID().slice(0, 8)}`;

  const kindFilter = kinds?.length
    ? `AND kind IN (${kinds.map(() => '?').join(',')})`
    : '';

  const tx = d.transaction(() => {
    const rows = d
      .prepare(
        `SELECT * FROM tasks
          WHERE state = 'pending'
            AND run_after <= datetime('now')
            ${kindFilter}
          ORDER BY priority ASC, id ASC
          LIMIT ?`
      )
      .all(...(kinds ?? []), limit);

    const upd = d.prepare(
      `UPDATE tasks
          SET state = 'claimed',
              claimed_at = datetime('now'),
              claimed_by = ?,
              lease_until = datetime('now', ?),
              attempts = attempts + 1,
              updated_at = datetime('now')
        WHERE id = ? AND state = 'pending'`
    );

    const claimed = [];
    for (const r of rows) {
      const res = upd.run(worker, `+${leaseSeconds} seconds`, r.id);
      if (res.changes === 1) {
        claimed.push({ ...r, payload: JSON.parse(r.payload), attempts: r.attempts + 1 });
      }
    }
    return claimed;
  });

  return tx();
}

/**
 * Mark a task done and enqueue whatever comes next.
 *
 * `nextPayload` lets a stage pass forward what it learned — the
 * company id it created, the contacts it found — so the next stage
 * does not have to re-derive it.
 */
export function complete(taskId, { nextPayload = null, skipNext = false } = {}) {
  const d = db();
  const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return { ok: false, reason: 'no such task' };

  d.prepare(
    `UPDATE tasks SET state = 'done', completed_at = datetime('now'),
                      updated_at = datetime('now'), lease_until = NULL
      WHERE id = ?`
  ).run(taskId);

  const next = STAGE[task.kind]?.next;
  if (skipNext || !next) return { ok: true, next: null };

  const payload = { ...JSON.parse(task.payload), ...(nextPayload ?? {}) };
  const q = enqueue({
    kind: next,
    payload,
    companyId: task.company_id,
    roleId: task.role_id,
    dedupeKey: task.role_id
      ? `${next}:role:${task.role_id}`
      : task.company_id
        ? `${next}:company:${task.company_id}`
        : null,
  });

  return { ok: true, next, nextTaskId: q.id, nextQueued: q.queued };
}

/**
 * Record a failure and decide what happens to the task.
 *
 * Backoff is exponential on attempt count, and a rate-limited task is
 * deferred without consuming an attempt — it was never broken, just
 * early.
 */
export function fail(taskId, error, { deferSeconds = null } = {}) {
  const d = db();
  const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return { ok: false, reason: 'no such task' };

  const message = String(error?.message ?? error ?? 'unknown error').slice(0, 500);
  const kind = classifyError(message);

  if (kind === 'rate_limited') {
    const wait = deferSeconds ?? 3600;
    d.prepare(
      `UPDATE tasks
          SET state = 'pending',
              attempts = MAX(0, attempts - 1),
              run_after = datetime('now', ?),
              last_error = ?, claimed_by = NULL, lease_until = NULL,
              updated_at = datetime('now')
        WHERE id = ?`
    ).run(`+${wait} seconds`, message, taskId);
    return { ok: true, outcome: 'deferred', retryInSeconds: wait };
  }

  if (kind === 'permanent' || task.attempts >= task.max_attempts) {
    d.prepare(
      `UPDATE tasks SET state = 'dead', last_error = ?, claimed_by = NULL,
                        lease_until = NULL, updated_at = datetime('now')
        WHERE id = ?`
    ).run(message, taskId);
    return { ok: true, outcome: 'dead', reason: kind };
  }

  // Transient: exponential backoff, 1m, 4m, 9m...
  const wait = deferSeconds ?? 60 * task.attempts * task.attempts;
  d.prepare(
    `UPDATE tasks
        SET state = 'pending', run_after = datetime('now', ?),
            last_error = ?, claimed_by = NULL, lease_until = NULL,
            updated_at = datetime('now')
      WHERE id = ?`
  ).run(`+${wait} seconds`, message, taskId);

  return { ok: true, outcome: 'retry', attempt: task.attempts, retryInSeconds: wait };
}

/**
 * Return expired leases to the pending pool.
 *
 * Called at the start of a run: anything a dead worker was holding
 * becomes available again, which is what makes the queue recoverable
 * rather than merely durable.
 */
export function reclaimExpired() {
  const res = db()
    .prepare(
      `UPDATE tasks
          SET state = 'pending', claimed_by = NULL, lease_until = NULL,
              last_error = COALESCE(last_error, 'lease expired — worker did not finish'),
              updated_at = datetime('now')
        WHERE state = 'claimed' AND lease_until < datetime('now')`
    )
    .run();
  return { reclaimed: res.changes };
}

export function stats() {
  const d = db();
  const byState = d
    .prepare(`SELECT state, COUNT(*) n FROM tasks GROUP BY state`)
    .all()
    .reduce((a, r) => ({ ...a, [r.state]: r.n }), {});

  const byKind = d
    .prepare(`SELECT kind, state, COUNT(*) n FROM tasks GROUP BY kind, state`)
    .all();

  const dueNow = d
    .prepare(
      `SELECT COUNT(*) n FROM tasks WHERE state = 'pending' AND run_after <= datetime('now')`
    )
    .get().n;

  return { byState, byKind, dueNow };
}

/** Dead-lettered tasks, for the report's "needs you" section. */
export function deadLetter({ limit = 50 } = {}) {
  return db()
    .prepare(
      `SELECT t.id, t.kind, t.attempts, t.last_error, t.updated_at,
              c.name AS company, r.title AS role
         FROM tasks t
         LEFT JOIN companies c ON c.id = t.company_id
         LEFT JOIN roles     r ON r.id = t.role_id
        WHERE t.state = 'dead'
        ORDER BY t.updated_at DESC
        LIMIT ?`
    )
    .all(limit);
}

/** Requeue a dead task after the underlying problem is fixed. */
export function revive(taskId) {
  const res = db()
    .prepare(
      `UPDATE tasks SET state = 'pending', attempts = 0, run_after = datetime('now'),
                        last_error = NULL, updated_at = datetime('now')
        WHERE id = ? AND state = 'dead'`
    )
    .run(taskId);
  return { revived: res.changes === 1 };
}
