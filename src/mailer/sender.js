/**
 * Email sender.
 *
 * Structure follows job-outreach-cli's emailer.py, which has been
 * running this workload against Gmail in production. The parts carried
 * over deliberately:
 *
 *   - SMTP connection pooling with a recycle every N messages. Holding
 *     one connection for hundreds of sends gets it dropped mid-run;
 *     opening one per send is slow and looks automated.
 *   - Sliding-window rate limiting (per hour) on top of a minimum
 *     inter-send delay, rather than a single fixed cap.
 *   - Jitter as a random 10-30% of the minimum delay, so no two gaps
 *     match and the send sequence has no detectable period.
 *
 * Everything writes through the database so a crashed run resumes
 * without re-sending: the unique index on (contact_id, sequence_step)
 * makes a duplicate structurally impossible, and the daily counter
 * survives a restart.
 */

import nodemailer from 'nodemailer';
import { config, nextDelayMs, inSendWindow } from '../config.js';
import { loadSmtpCredentials } from './credentials.js';
import {
  db,
  bumpQuota,
  quotaUsedToday,
  recentBounceRate,
  isSuppressed,
} from '../db/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sliding-window limiter.
 *
 * Ported from rate_limiter.py: timestamps of recent sends are kept in
 * a deque and pruned past the hour, so the hourly limit is a true
 * rolling window rather than a counter that resets on the hour.
 */
export class RateLimiter {
  constructor({ perHour, minDelayMs }) {
    this.perHour = perHour;
    this.minDelayMs = minDelayMs;
    this.timestamps = [];
    this.lastSend = null;
  }

  #prune(now) {
    const cutoff = now - 3_600_000;
    while (this.timestamps.length && this.timestamps[0] < cutoff) this.timestamps.shift();
  }

  /** How long to wait before the next send is permitted. */
  waitMs(now = Date.now()) {
    this.#prune(now);

    if (this.lastSend !== null) {
      const since = now - this.lastSend;
      if (since < this.minDelayMs) return this.minDelayMs - since;
    }

    if (this.timestamps.length >= this.perHour) {
      const oldest = this.timestamps[0];
      return 3_600_000 - (now - oldest) + 1000;
    }

    return 0;
  }

  record(now = Date.now()) {
    this.timestamps.push(now);
    this.lastSend = now;
    this.#prune(now);
  }
}

export class Sender {
  constructor({ credentials, dryRun = config.safety.dryRun } = {}) {
    this.creds = credentials ?? loadSmtpCredentials();
    this.dryRun = dryRun;
    this.transport = null;
    this.sentOnConnection = 0;
    this.sentThisRun = 0;
    this.limiter = new RateLimiter({
      perHour: config.mail.pacing.perHourCap,
      minDelayMs: config.mail.pacing.baseDelayMs,
    });
  }

  /**
   * Open or recycle the SMTP connection.
   *
   * Gmail drops long-lived connections, so the transport is rebuilt
   * every `maxPerConnection` messages rather than held for the run.
   */
  #transport() {
    const limit = config.mail.pacing.maxPerConnection;
    if (this.transport && this.sentOnConnection < limit) return this.transport;

    if (this.transport) {
      this.transport.close();
      this.transport = null;
      this.sentOnConnection = 0;
    }

    this.transport = nodemailer.createTransport({
      host: this.creds.host,
      port: this.creds.port,
      secure: this.creds.port === 465,
      auth: { user: this.creds.user, pass: this.creds.pass },
      pool: true,
      maxConnections: 1,
      maxMessages: limit,
    });

    return this.transport;
  }

  async verify() {
    if (this.dryRun) return { ok: true, dryRun: true };
    try {
      await this.#transport().verify();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Reasons a send must not happen.
   *
   * Checked before every message rather than once per run: the daily
   * cap and bounce rate both move while a run is in progress.
   */
  #blockers(contact) {
    const used = quotaUsedToday();
    if (used >= config.mail.pacing.dailyCap) {
      return `daily cap reached (${used}/${config.mail.pacing.dailyCap})`;
    }

    if (!inSendWindow()) {
      const w = config.mail.pacing.sendWindow;
      return `outside send window (${w.startHour}:00-${w.endHour}:00, weekends ${w.skipWeekends ? 'off' : 'on'})`;
    }

    const { rate, sample } = recentBounceRate();
    const cb = config.mail.circuitBreaker;
    if (sample >= cb.minSendsBeforeCheck && rate > cb.maxBounceRate) {
      return `bounce rate ${(rate * 100).toFixed(1)}% over ${(cb.maxBounceRate * 100).toFixed(0)}% threshold — stopping to protect sender reputation`;
    }

    if (!contact.email) return 'contact has no email address';
    if (contact.bounced_at) return 'address previously bounced';
    if (contact.opted_out_at) return 'contact opted out';
    if (isSuppressed(contact.email)) return 'address is suppressed';

    return null;
  }

  /**
   * Whether a real send already covers this contact and step.
   *
   * The unique index enforces this on live sends, but it is checked
   * here too so a rehearsal reports what a live run would actually do.
   * Without it, a dry run claims it will send messages the database
   * would reject, which makes the rehearsal useless for judging how
   * much mail a batch will really produce.
   */
  #alreadySent(contactId, sequenceStep) {
    return Boolean(
      db()
        .prepare(
          `SELECT 1 FROM sends
            WHERE contact_id = ? AND sequence_step = ? AND is_dry_run = 0
            LIMIT 1`
        )
        .get(contactId, sequenceStep)
    );
  }

  /**
   * Send one message and record it.
   *
   * The database row is written before the network call so a crash
   * mid-send leaves evidence rather than a silent gap; status is
   * updated to 'sent' or 'failed' afterwards.
   */
  async sendOne({ contact, companyId, subject, body, html, roleIds = [], sequenceStep = 1 }) {
    const blocker = this.#blockers(contact);
    if (blocker) return { status: 'skipped', reason: blocker };

    if (this.#alreadySent(contact.id, sequenceStep)) {
      return { status: 'skipped', reason: 'already sent at this sequence step' };
    }

    const d = db();
    const insert = d.prepare(
      `INSERT INTO sends (contact_id, company_id, sequence_step, subject, body, role_ids, status, is_dry_run)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`
    );

    let sendId;
    try {
      sendId = insert.run(
        contact.id,
        companyId,
        sequenceStep,
        subject,
        body,
        JSON.stringify(roleIds),
        this.dryRun ? 1 : 0
      ).lastInsertRowid;
    } catch (err) {
      // The unique index rejected it: this person already received
      // this step. That is the dedupe working, not a failure.
      if (String(err.message).includes('UNIQUE')) {
        return { status: 'skipped', reason: 'already sent at this sequence step' };
      }
      throw err;
    }

    if (this.dryRun) {
      d.prepare(`UPDATE sends SET status = 'sent', sent_at = datetime('now') WHERE id = ?`).run(sendId);
      return { status: 'dry-run', sendId, to: contact.email, subject };
    }

    // Respect the rolling window before touching the network.
    const wait = this.limiter.waitMs();
    if (wait > 0) await sleep(wait);

    try {
      const info = await this.#transport().sendMail({
        from: this.creds.fromName
          ? `"${this.creds.fromName}" <${this.creds.fromEmail}>`
          : this.creds.fromEmail,
        to: contact.email,
        replyTo: config.mail.replyTo || undefined,
        subject,
        text: body,
        ...(html ? { html } : {}),
      });

      this.limiter.record();
      this.sentOnConnection += 1;
      this.sentThisRun += 1;

      d.prepare(
        `UPDATE sends SET status = 'sent', sent_at = datetime('now'), provider_msg_id = ? WHERE id = ?`
      ).run(info.messageId ?? null, sendId);
      bumpQuota({ sent: 1 });

      return { status: 'sent', sendId, to: contact.email, messageId: info.messageId };
    } catch (err) {
      d.prepare(`UPDATE sends SET status = 'failed', error = ? WHERE id = ?`).run(
        err.message,
        sendId
      );
      bumpQuota({ failed: 1 });

      // A hard bounce means the address is wrong; mark it so it is
      // never retried and does not keep costing reputation.
      if (/550|553|no such user|does not exist|recipient rejected/i.test(err.message)) {
        d.prepare(`UPDATE contacts SET bounced_at = datetime('now') WHERE id = ?`).run(contact.id);
        d.prepare(`UPDATE sends SET status = 'bounced' WHERE id = ?`).run(sendId);
      }

      return { status: 'failed', sendId, to: contact.email, error: err.message };
    }
  }

  /**
   * Send a batch, pacing between messages.
   *
   * Stops early on a blocker that applies to the whole run (daily cap,
   * circuit breaker) rather than attempting every remaining message
   * and logging the same skip repeatedly.
   */
  async sendBatch(messages, { onProgress } = {}) {
    const results = [];

    for (let i = 0; i < messages.length; i++) {
      const r = await this.sendOne(messages[i]);
      results.push(r);
      onProgress?.({ index: i, total: messages.length, result: r });

      if (
        r.status === 'skipped' &&
        /daily cap|bounce rate|send window/.test(r.reason ?? '')
      ) {
        results.push({ status: 'aborted', reason: r.reason });
        break;
      }

      if (i < messages.length - 1 && r.status === 'sent') {
        await sleep(nextDelayMs(this.sentThisRun));
      }
    }

    return results;
  }

  close() {
    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }
  }
}
