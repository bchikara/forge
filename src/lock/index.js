/**
 * Single-run lock.
 *
 * Every pass reads and writes one SQLite database, and several of the
 * decisions they make are read-then-write: check the daily quota, then
 * send; look for eligible contacts, then mark them sent. Two passes
 * overlapping means both read the same "22 of 300 used" and both spend
 * the remainder, or one sends to a company whose contacts the other is
 * still resolving.
 *
 * The scheduled passes make this concrete rather than theoretical: a
 * discovery run that takes ninety minutes started at 12:30 is still
 * going when the 13:30 top-up fires.
 *
 * So one pipeline process runs at a time. A second arrival does not
 * queue or wait — it exits and says who holds the lock, because the
 * work is idempotent and the next scheduled pass will pick it up.
 *
 * The lock is a row in the database rather than a file: it is already
 * the thing being contended for, it is on a filesystem launchd can
 * reach, and a crashed holder is detectable because the row carries a
 * pid and a heartbeat.
 */

import { db } from '../db/index.js';

/** How long a lock survives without a heartbeat before it is stealable. */
const STALE_AFTER_SECONDS = 600;

function ensureTable() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS run_lock (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      holder       TEXT    NOT NULL,
      pid          INTEGER,
      acquired_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      heartbeat_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export class LockBusyError extends Error {
  constructor(holder) {
    super(
      `another pass is running: ${holder.holder} (pid ${holder.pid}), ` +
        `started ${holder.acquired_at}. Nothing was done — the work is ` +
        `idempotent, so the next scheduled pass will pick it up.`
    );
    this.name = 'LockBusyError';
    this.holder = holder;
  }
}

/**
 * Whether a lock holder is actually still alive.
 *
 * A pass killed mid-run leaves its row behind. Without this check the
 * pipeline would stay locked until someone noticed, so the heartbeat is
 * treated as a liveness signal and a same-machine pid is verified
 * directly.
 */
function isStale(row) {
  const ageSeconds = db()
    .prepare(`SELECT CAST(strftime('%s','now') - strftime('%s', ?) AS INTEGER) AS s`)
    .get(row.heartbeat_at).s;

  // The heartbeat is the authority, not the pid. The lock is taken on
  // behalf of a shell script by a short-lived node subprocess, so the
  // recorded pid belongs to a process this code cannot inspect — an
  // early version checked it with process.kill(pid, 0) and declared
  // every such holder dead one second after it acquired, which made the
  // lock free for the taking and defeated the point.
  //
  // A holder that stops beating for STALE_AFTER_SECONDS is treated as
  // gone. That is slower to notice a crash than a pid check would be,
  // but it never frees a lock that is genuinely held.
  return ageSeconds > STALE_AFTER_SECONDS;
}

/**
 * Take the lock, or throw LockBusyError.
 *
 * The check and the insert happen in one transaction, so two passes
 * starting in the same second cannot both succeed.
 */
export function acquire(holder = 'pass', { pid = process.pid } = {}) {
  ensureTable();
  const d = db();

  const tx = d.transaction(() => {
    const row = d.prepare('SELECT * FROM run_lock WHERE id = 1').get();

    if (row && !isStale(row)) throw new LockBusyError(row);

    if (row) {
      d.prepare(
        `UPDATE run_lock
            SET holder = ?, pid = ?, acquired_at = datetime('now'),
                heartbeat_at = datetime('now')
          WHERE id = 1`
      ).run(holder, pid);
      return { acquired: true, stole: true, previous: row.holder };
    }

    d.prepare(
      `INSERT INTO run_lock (id, holder, pid) VALUES (1, ?, ?)`
    ).run(holder, pid);
    return { acquired: true, stole: false };
  });

  return tx();
}

/** Prove the holder is still alive. Call periodically during long work. */
export function heartbeat({ pid = process.pid } = {}) {
  ensureTable();
  db()
    .prepare(
      `UPDATE run_lock SET heartbeat_at = datetime('now') WHERE id = 1 AND pid = ?`
    )
    .run(pid);
}

/**
 * Release the lock.
 *
 * `pid` lets a caller release a lock taken on behalf of another
 * process. The shell runner needs this: it acquires through a
 * short-lived node subprocess, so matching on the current process id
 * would never release anything. Passing the shell's own pid makes the
 * lock outlive the subprocess that took it.
 */
export function release({ pid = process.pid, force = false } = {}) {
  ensureTable();
  const res = force
    ? db().prepare('DELETE FROM run_lock WHERE id = 1').run()
    : db().prepare('DELETE FROM run_lock WHERE id = 1 AND pid = ?').run(pid);
  return { released: res.changes === 1 };
}

export function status() {
  ensureTable();
  const row = db().prepare('SELECT * FROM run_lock WHERE id = 1').get();
  if (!row) return { locked: false };
  return { locked: true, stale: isStale(row), ...row };
}

/**
 * Run `fn` holding the lock, releasing it however `fn` ends.
 *
 * A heartbeat runs on an interval so a long pass is not mistaken for a
 * crashed one, and it is unref'd so it cannot keep the process alive
 * after the work finishes.
 */
export async function withLock(holder, fn) {
  const got = acquire(holder);
  const beat = setInterval(heartbeat, 60_000);
  beat.unref?.();
  try {
    return await fn(got);
  } finally {
    clearInterval(beat);
    release();
  }
}
