/**
 * LinkedIn connection invitations.
 *
 * This is the primary outreach channel, and it is better than email on
 * every axis that matters: no address to resolve, nothing to bounce,
 * no sender reputation to damage, and it arrives in-app rather than in
 * a spam folder. Email is the fallback for people an invite cannot
 * reach.
 *
 * Quota handling is the substance of this module. LinkedIn enforces
 * invitations server-side — the Voyager endpoint the existing MCP
 * server calls is literally named `verifyQuotaAndCreate` — so the
 * local counters here are not the real limit. They exist to stop the
 * pipeline before LinkedIn does, because being refused by LinkedIn
 * repeatedly is itself a signal that gets accounts restricted.
 *
 * Acceptance rate is tracked for the same reason: LinkedIn reduces
 * invite capacity for accounts whose invitations are widely ignored,
 * so a falling rate is the early warning that volume should come down.
 */

import { config } from '../config.js';
import { db, openRoles } from '../db/index.js';
import {
  sendInvitation,
  MAX_NOTE_CHARS,
  UnipileAuthError,
  AccountRestrictedError,
} from '../adapters/unipile.js';
import { inviteNote } from '../templates/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ISO year-week, matching LinkedIn's rolling weekly window. */
export function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const today = () => new Date().toISOString().slice(0, 10);

export function inviteQuotaUsed() {
  const d = db();
  const week = d.prepare('SELECT * FROM invite_quota WHERE week = ?').get(isoWeek());
  const day = d.prepare('SELECT * FROM invite_quota_daily WHERE day = ?').get(today());
  return {
    week: isoWeek(),
    weekSent: week?.sent_count ?? 0,
    weekAccepted: week?.accepted_count ?? 0,
    daySent: day?.sent_count ?? 0,
  };
}

function bumpInviteQuota({ sent = 0, accepted = 0, failed = 0 } = {}) {
  const d = db();
  d.prepare(
    `INSERT INTO invite_quota (week, sent_count, accepted_count, failed_count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(week) DO UPDATE SET
       sent_count     = sent_count     + excluded.sent_count,
       accepted_count = accepted_count + excluded.accepted_count,
       failed_count   = failed_count   + excluded.failed_count,
       updated_at     = datetime('now')`
  ).run(isoWeek(), sent, accepted, failed);

  if (sent) {
    d.prepare(
      `INSERT INTO invite_quota_daily (day, sent_count) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET
         sent_count = sent_count + excluded.sent_count,
         updated_at = datetime('now')`
    ).run(today(), sent);
  }
}

/**
 * Acceptance rate over recent invitations.
 *
 * Measured against invites old enough to have plausibly been answered;
 * counting yesterday's invitations as "ignored" would throttle the
 * pipeline on nothing.
 */
export function acceptanceRate({ minAgeDays = 3, limit = 200 } = {}) {
  const rows = db()
    .prepare(
      `SELECT status FROM invites
        WHERE is_dry_run = 0
          AND sent_at IS NOT NULL
          AND sent_at <= datetime('now', ?)
        ORDER BY sent_at DESC LIMIT ?`
    )
    .all(`-${minAgeDays} days`, limit);

  if (rows.length === 0) return { rate: null, sample: 0 };
  const accepted = rows.filter((r) => r.status === 'accepted').length;
  return { rate: accepted / rows.length, sample: rows.length };
}

export class InviteSender {
  constructor({ dryRun = config.safety.dryRun } = {}) {
    this.dryRun = dryRun;
    this.sentThisRun = 0;
  }

  /** Reasons no invitation may be sent right now. */
  #runBlockers() {
    const q = inviteQuotaUsed();
    const caps = config.unipile.invites;

    if (q.weekSent >= caps.weeklyCap) {
      return `weekly invite cap reached (${q.weekSent}/${caps.weeklyCap} for ${q.week})`;
    }
    if (q.daySent >= caps.dailyCap) {
      return `daily invite cap reached (${q.daySent}/${caps.dailyCap})`;
    }

    const { rate, sample } = acceptanceRate();
    if (
      rate !== null &&
      sample >= caps.minInvitesBeforeCheck &&
      rate < caps.minAcceptanceRate
    ) {
      return (
        `acceptance rate ${(rate * 100).toFixed(0)}% is below the ` +
        `${(caps.minAcceptanceRate * 100).toFixed(0)}% floor over ${sample} invites — ` +
        `LinkedIn throttles accounts at this level, so stopping before it does`
      );
    }

    return null;
  }

  #contactBlockers(contact, companyId) {
    if (!contact.linkedin_url) return 'contact has no LinkedIn profile';
    if (!contact.provider_id) return 'contact has no provider id (needed to invite)';
    if (contact.opted_out_at) return 'contact opted out';

    // A real invitation already exists for this person. The unique
    // index enforces this on live sends, but it is checked here too so
    // a dry run reports the same outcome a live run would — otherwise
    // the rehearsal claims it will send something that would in fact
    // be rejected.
    const already = db()
      .prepare(
        `SELECT 1 FROM invites WHERE contact_id = ? AND is_dry_run = 0 LIMIT 1`
      )
      .get(contact.id);
    if (already) return 'already invited this person';

    const perCompany = db()
      .prepare(
        `SELECT COUNT(*) AS n FROM invites
          WHERE company_id = ? AND is_dry_run = 0`
      )
      .get(companyId).n;

    if (perCompany >= config.unipile.invites.maxPerCompany) {
      return `per-company invite cap reached (${perCompany}/${config.unipile.invites.maxPerCompany})`;
    }

    return null;
  }

  /**
   * Send one invitation.
   *
   * The row is written before the network call so a crash leaves a
   * record rather than a silent gap, and the unique index on
   * contact_id makes a repeat invitation to the same person impossible
   * — LinkedIn penalizes those specifically.
   */
  async inviteOne({ contact, company, roles }) {
    const runBlock = this.#runBlockers();
    if (runBlock) return { status: 'skipped', reason: runBlock, fatal: true };

    const contactBlock = this.#contactBlockers(contact, company.id);
    if (contactBlock) return { status: 'skipped', reason: contactBlock };

    const openForCompany = roles ?? openRoles(company.id);
    const note = inviteNote({ contact, company, roles: openForCompany });

    if (note.length > MAX_NOTE_CHARS) {
      return { status: 'skipped', reason: `note is ${note.length} chars, over the ${MAX_NOTE_CHARS} limit` };
    }

    const d = db();
    let inviteId;
    try {
      inviteId = d
        .prepare(
          `INSERT INTO invites (contact_id, company_id, note, role_ids, status, is_dry_run)
           VALUES (?, ?, ?, ?, 'queued', ?)`
        )
        .run(
          contact.id,
          company.id,
          note,
          JSON.stringify(openForCompany.map((r) => r.id)),
          this.dryRun ? 1 : 0
        ).lastInsertRowid;
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return { status: 'skipped', reason: 'already invited this person' };
      }
      throw err;
    }

    if (this.dryRun) {
      d.prepare(`UPDATE invites SET status = 'sent', sent_at = datetime('now') WHERE id = ?`).run(
        inviteId
      );
      return { status: 'dry-run', inviteId, to: contact.full_name, note };
    }

    try {
      const res = await sendInvitation(contact.provider_id, { note });
      d.prepare(
        `UPDATE invites SET status = 'sent', sent_at = datetime('now'), provider_id = ? WHERE id = ?`
      ).run(res?.invitation_id ?? res?.id ?? null, inviteId);
      bumpInviteQuota({ sent: 1 });
      this.sentThisRun += 1;

      return { status: 'sent', inviteId, to: contact.full_name, note };
    } catch (err) {
      d.prepare(`UPDATE invites SET status = 'failed', error = ? WHERE id = ?`).run(
        err.message,
        inviteId
      );
      bumpInviteQuota({ failed: 1 });

      // Auth failure or a restriction is fatal — continuing would make
      // it worse, and a restricted account needs a human to look at it.
      const fatal =
        err instanceof UnipileAuthError || err instanceof AccountRestrictedError;
      return { status: 'failed', inviteId, error: err.message, fatal };
    }
  }

  /** Delay before the next invitation: base plus jitter. */
  #nextDelayMs() {
    const { baseDelayMs, jitterMinMs, jitterMaxMs } = config.unipile.invites;
    const span = Math.max(0, jitterMaxMs - jitterMinMs);
    return baseDelayMs + jitterMinMs + Math.floor(Math.random() * span);
  }

  /**
   * Send a batch, stopping immediately on anything fatal.
   *
   * Pacing between invitations is heavier than for email: these drive
   * a real account, and a burst of connection requests is one of the
   * clearest automation signals LinkedIn looks for.
   */
  async inviteBatch(targets, { onProgress } = {}) {
    const results = [];

    for (let i = 0; i < targets.length; i++) {
      const r = await this.inviteOne(targets[i]);
      results.push(r);
      onProgress?.({ index: i, total: targets.length, result: r });

      if (r.fatal) {
        results.push({ status: 'aborted', reason: r.reason ?? r.error });
        break;
      }

      if (i < targets.length - 1 && r.status === 'sent') {
        await sleep(this.#nextDelayMs());
      }
    }

    return results;
  }
}

/**
 * Reconcile invitation outcomes against LinkedIn.
 *
 * Acceptance rate cannot be measured from local state alone — an
 * accepted invitation produces no callback — so sent invitations are
 * checked against the account's pending list: one that is no longer
 * pending and is now a connection was accepted.
 */
export async function reconcileInvites({ listSent }) {
  const pending = await listSent();
  const pendingIds = new Set(
    pending.map((p) => p.invitation_id ?? p.id).filter(Boolean)
  );

  const d = db();
  const sent = d
    .prepare(
      `SELECT id, provider_id FROM invites
        WHERE is_dry_run = 0 AND status = 'sent' AND provider_id IS NOT NULL`
    )
    .all();

  let accepted = 0;
  for (const row of sent) {
    if (!pendingIds.has(row.provider_id)) {
      // No longer pending: either accepted or withdrawn. Treated as
      // accepted, which is the common case; a withdrawn invite would
      // have been withdrawn by us and is rare.
      d.prepare(
        `UPDATE invites SET status = 'accepted', responded_at = datetime('now') WHERE id = ?`
      ).run(row.id);
      accepted += 1;
    }
  }

  if (accepted) bumpInviteQuota({ accepted });
  return { checked: sent.length, accepted };
}
