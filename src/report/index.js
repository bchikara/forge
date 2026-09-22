/**
 * Daily status report, emailed after a run completes.
 *
 * The report is built around what needs the operator's attention, not
 * around what went well. Counts confirm the run happened; the "needs
 * you" section is the reason to open it. A skipped application that
 * needs a screening question answered, an expiring session cookie, or
 * an acceptance rate approaching the throttle floor are all things
 * that silently stop the pipeline if nobody looks.
 *
 * A separate failure alert is sent when a run dies, because a crashed
 * run sends no daily report — and silence is indistinguishable from
 * "nothing happened today".
 */

import { config } from '../config.js';
import { db, quotaUsedToday, recentBounceRate } from '../db/index.js';
import { inviteQuotaUsed, acceptanceRate } from '../invites/sender.js';
import { stats as queueStats, deadLetter } from '../queue/index.js';
import { loadSmtpCredentials } from '../mailer/credentials.js';
import nodemailer from 'nodemailer';

const today = () => new Date().toISOString().slice(0, 10);

/** Everything the report needs, in one pass over the database. */
export function gather({ day = today() } = {}) {
  const d = db();
  const since = `${day} 00:00:00`;

  const one = (sql, ...p) => d.prepare(sql).get(...p);

  const emails = one(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'sent')    AS sent,
       COUNT(*) FILTER (WHERE status = 'bounced') AS bounced,
       COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
       COUNT(*) FILTER (WHERE status = 'replied') AS replied
     FROM sends WHERE is_dry_run = 0 AND sent_at >= ?`,
    since
  );

  const invites = one(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'sent')     AS sent,
       COUNT(*) FILTER (WHERE status = 'accepted') AS accepted,
       COUNT(*) FILTER (WHERE status = 'failed')   AS failed
     FROM invites WHERE is_dry_run = 0 AND sent_at >= ?`,
    since
  );

  const roles = one(
    `SELECT COUNT(*) AS tracked FROM roles WHERE applied_at >= ?`,
    since
  );

  const contacts = one(
    `SELECT COUNT(*) AS found,
            COUNT(*) FILTER (WHERE email IS NOT NULL) AS withEmail
       FROM contacts WHERE created_at >= ?`,
    since
  );

  // Which rung of the ladder companies actually reached. A pipeline
  // mostly reaching 'senior_peer' is finding nobody who can hire.
  const rungs = d
    .prepare(
      `SELECT COALESCE(rung, 'unknown') AS rung, COUNT(*) n
         FROM contacts WHERE created_at >= ? GROUP BY rung ORDER BY n DESC`
    )
    .all(since);

  // Every invitation sent, with its profile link. The operator asked
  // for these because an invitation is the start of a conversation they
  // may want to continue by hand — and unlike an email, there is no
  // sent-items folder to look it up in.
  const invitesSent = d
    .prepare(
      `SELECT k.full_name, k.title, k.linkedin_url, k.rung, k.tier,
              co.name AS company, i.status, i.sent_at, i.note
         FROM invites i
         JOIN contacts k  ON k.id = i.contact_id
         JOIN companies co ON co.id = i.company_id
        WHERE i.is_dry_run = 0 AND i.sent_at >= ?
        ORDER BY co.name, k.full_name`
    )
    .all(since);

  const bounce = recentBounceRate();
  const accept = acceptanceRate();
  const iq = inviteQuotaUsed();

  return {
    day,
    roles: roles.tracked,
    contacts,
    emails,
    invites,
    rungs,
    invitesSent,
    queue: queueStats(),
    dead: deadLetter({ limit: 15 }),
    health: {
      bounceRate: bounce.rate,
      bounceSample: bounce.sample,
      bounceThreshold: config.mail.circuitBreaker.maxBounceRate,
      acceptanceRate: accept.rate,
      acceptanceSample: accept.sample,
      acceptanceFloor: config.unipile.invites.minAcceptanceRate,
    },
    quota: {
      emailToday: quotaUsedToday(),
      emailCap: config.mail.pacing.dailyCap,
      inviteWeek: iq.weekSent,
      inviteWeekCap: config.unipile.invites.weeklyCap,
      inviteToday: iq.daySent,
      inviteDayCap: config.unipile.invites.dailyCap,
    },
  };
}

/**
 * Items that need a human.
 *
 * Deliberately conservative: a warning that fires every day stops
 * being read. Each entry here should be actionable.
 */
export function attentionItems(s) {
  const out = [];

  if (s.dead.length > 0) {
    out.push({
      severity: 'high',
      title: `${s.dead.length} task${s.dead.length === 1 ? '' : 's'} dead-lettered`,
      detail: 'These will not retry on their own. Review and revive or discard.',
    });
  }

  if (
    s.health.bounceRate !== null &&
    s.health.bounceSample >= 20 &&
    s.health.bounceRate > s.health.bounceThreshold * 0.6
  ) {
    out.push({
      severity: s.health.bounceRate > s.health.bounceThreshold ? 'high' : 'medium',
      title: `Bounce rate ${(s.health.bounceRate * 100).toFixed(1)}%`,
      detail:
        `The circuit breaker aborts runs above ${(s.health.bounceThreshold * 100).toFixed(0)}%. ` +
        `High bounces mean the address source is wrong, and they damage sender reputation.`,
    });
  }

  if (
    s.health.acceptanceRate !== null &&
    s.health.acceptanceSample >= config.unipile.invites.minInvitesBeforeCheck &&
    s.health.acceptanceRate < s.health.acceptanceFloor * 1.2
  ) {
    out.push({
      severity: s.health.acceptanceRate < s.health.acceptanceFloor ? 'high' : 'medium',
      title: `Invite acceptance ${(s.health.acceptanceRate * 100).toFixed(0)}%`,
      detail:
        `Invitations stop below ${(s.health.acceptanceFloor * 100).toFixed(0)}%. ` +
        `LinkedIn reduces invite capacity for accounts whose requests are widely ignored.`,
    });
  }

  // Reaching mostly peers means the ladder is not finding decision
  // makers, which is a targeting problem rather than a volume one.
  const peer = s.rungs.find((r) => r.rung === 'senior_peer')?.n ?? 0;
  const totalRungs = s.rungs.reduce((a, r) => a + r.n, 0);
  if (totalRungs >= 10 && peer / totalRungs > 0.4) {
    out.push({
      severity: 'medium',
      title: `${Math.round((peer / totalRungs) * 100)}% of contacts are peers, not hiring managers`,
      detail:
        'The ladder is falling through to senior engineers. Either the companies are small, ' +
        'or the engineering-manager search is not matching their titles.',
    });
  }

  if (s.quota.inviteWeek >= s.quota.inviteWeekCap * 0.9) {
    out.push({
      severity: 'low',
      title: `Invite quota ${s.quota.inviteWeek}/${s.quota.inviteWeekCap} this week`,
      detail: 'Invitations will pause until the weekly window rolls over.',
    });
  }

  const stuck = s.queue.byState?.pending ?? 0;
  if (stuck > 100) {
    out.push({
      severity: 'medium',
      title: `${stuck} tasks still pending`,
      detail: 'The queue is not draining as fast as work arrives. Rate limits, or a stalled worker.',
    });
  }

  return out;
}

const esc = (x) =>
  String(x ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(0)}%`);

export function renderText(s) {
  const att = attentionItems(s);
  const L = [];

  L.push(`Forge daily — ${s.day}`, '');
  L.push(`Applications tracked   ${s.roles}`);
  L.push(`Contacts found         ${s.contacts.found} (${s.contacts.withEmail} with email)`);
  L.push(`Invitations sent       ${s.invites.sent}   accepted ${s.invites.accepted}`);
  L.push(`Emails sent            ${s.emails.sent}   bounced ${s.emails.bounced}   replied ${s.emails.replied}`);
  L.push('');

  if (att.length) {
    L.push('NEEDS YOU');
    for (const a of att) {
      L.push(`  [${a.severity}] ${a.title}`);
      L.push(`      ${a.detail}`);
    }
    L.push('');
  } else {
    L.push('Nothing needs your attention.', '');
  }

  if (s.dead.length) {
    L.push('DEAD LETTER');
    for (const t of s.dead) {
      L.push(`  #${t.id} ${t.kind} · ${t.company ?? '—'} · ${(t.last_error ?? '').slice(0, 70)}`);
    }
    L.push('');
  }

  L.push('LADDER REACHED');
  for (const r of s.rungs) L.push(`  ${String(r.rung).padEnd(22)} ${r.n}`);
  L.push('');

  L.push('QUOTA');
  L.push(`  email    ${s.quota.emailToday}/${s.quota.emailCap} today`);
  L.push(`  invites  ${s.quota.inviteToday}/${s.quota.inviteDayCap} today · ${s.quota.inviteWeek}/${s.quota.inviteWeekCap} week`);
  L.push('');

  L.push('HEALTH');
  L.push(`  bounce rate      ${pct(s.health.bounceRate)} (over ${s.health.bounceSample}) · aborts above ${pct(s.health.bounceThreshold)}`);
  L.push(`  invite accepts   ${pct(s.health.acceptanceRate)} (over ${s.health.acceptanceSample}) · pauses below ${pct(s.health.acceptanceFloor)}`);
  L.push('');

  L.push('QUEUE');
  L.push(`  ${JSON.stringify(s.queue.byState)}  due now ${s.queue.dueNow}`);

  if (s.invitesSent?.length) {
    L.push('', 'LINKEDIN INVITATIONS SENT');
    let lastCompany = null;
    for (const inv of s.invitesSent) {
      if (inv.company !== lastCompany) {
        L.push('', `  ${inv.company}`);
        lastCompany = inv.company;
      }
      L.push(`    ${inv.full_name ?? '(name unknown)'}${inv.status === 'accepted' ? '  [accepted]' : ''}`);
      if (inv.title) L.push(`      ${inv.title.slice(0, 80)}`);
      L.push(`      ${inv.linkedin_url ?? '(no profile url)'}`);
    }
  }

  return L.join('\n');
}

export function renderHtml(s) {
  const att = attentionItems(s);
  const colors = { high: '#c62828', medium: '#FF6600', low: '#888' };

  const tile = (label, value, sub) => `
    <td style="padding:14px 18px;background:#fafafa;border-left:3px solid #FF6600;">
      <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#777;">${esc(label)}</div>
      <div style="font-size:26px;font-weight:600;color:#0A0A0A;line-height:1.2;">${esc(value)}</div>
      ${sub ? `<div style="font-size:12px;color:#777;">${esc(sub)}</div>` : ''}
    </td>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#fff;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#0A0A0A;">
<div style="max-width:640px;margin:0 auto;">

  <div style="border-bottom:2px solid #0A0A0A;padding-bottom:10px;margin-bottom:20px;">
    <span style="color:#FF6600;font-weight:700;">▍</span>
    <span style="font-size:19px;font-weight:600;">Forge daily</span>
    <span style="float:right;color:#777;font-size:13px;padding-top:4px;">${esc(s.day)}</span>
  </div>

  <table cellspacing="8" cellpadding="0" style="width:100%;border-collapse:separate;">
    <tr>
      ${tile('Applications', s.roles, 'tracked today')}
      ${tile('Invitations', s.invites.sent, `${s.invites.accepted} accepted`)}
    </tr>
    <tr>
      ${tile('Emails', s.emails.sent, `${s.emails.bounced} bounced`)}
      ${tile('Contacts', s.contacts.found, `${s.contacts.withEmail} with email`)}
    </tr>
  </table>

  ${
    att.length
      ? `<h3 style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#777;margin:28px 0 10px;">Needs you</h3>
    ${att
      .map(
        (a) => `<div style="margin:0 0 12px;padding:12px 16px;border-left:3px solid ${colors[a.severity]};background:#fcfcfc;">
        <div style="font-weight:600;">${esc(a.title)}</div>
        <div style="font-size:13px;color:#555;margin-top:3px;">${esc(a.detail)}</div>
      </div>`
      )
      .join('\n')}`
      : `<p style="margin:28px 0;padding:12px 16px;background:#f6f6f6;color:#555;">Nothing needs your attention.</p>`
  }

  ${
    s.dead.length
      ? `<h3 style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#777;margin:28px 0 10px;">Dead letter</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      ${s.dead
        .map(
          (t) => `<tr style="border-bottom:1px solid #eee;">
          <td style="padding:7px 8px 7px 0;color:#777;">#${t.id}</td>
          <td style="padding:7px 8px;font-weight:500;">${esc(t.kind)}</td>
          <td style="padding:7px 8px;">${esc(t.company ?? '—')}</td>
          <td style="padding:7px 0;color:#c62828;">${esc((t.last_error ?? '').slice(0, 60))}</td>
        </tr>`
        )
        .join('\n')}
    </table>`
      : ''
  }

  <h3 style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#777;margin:28px 0 10px;">Ladder reached</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    ${s.rungs
      .map(
        (r) => `<tr style="border-bottom:1px solid #eee;">
        <td style="padding:7px 0;">${esc(r.rung)}</td>
        <td style="padding:7px 0;text-align:right;font-weight:600;">${r.n}</td>
      </tr>`
      )
      .join('\n')}
  </table>

  <h3 style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#777;margin:28px 0 10px;">Quota &amp; health</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <tr style="border-bottom:1px solid #eee;"><td style="padding:7px 0;">Email today</td>
      <td style="padding:7px 0;text-align:right;">${s.quota.emailToday} / ${s.quota.emailCap}</td></tr>
    <tr style="border-bottom:1px solid #eee;"><td style="padding:7px 0;">Invites this week</td>
      <td style="padding:7px 0;text-align:right;">${s.quota.inviteWeek} / ${s.quota.inviteWeekCap}</td></tr>
    <tr style="border-bottom:1px solid #eee;"><td style="padding:7px 0;">Bounce rate</td>
      <td style="padding:7px 0;text-align:right;">${pct(s.health.bounceRate)} <span style="color:#777;">(aborts above ${pct(s.health.bounceThreshold)})</span></td></tr>
    <tr><td style="padding:7px 0;">Invite acceptance</td>
      <td style="padding:7px 0;text-align:right;">${pct(s.health.acceptanceRate)} <span style="color:#777;">(pauses below ${pct(s.health.acceptanceFloor)})</span></td></tr>
  </table>

  ${
    s.invitesSent?.length
      ? `<h3 style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#777;margin:28px 0 10px;">
      LinkedIn invitations sent (${s.invitesSent.length})
    </h3>
    <div style="font-size:13px;">
      ${(() => {
        // Grouped by company, because that is how the day's work was
        // organised and how it will be followed up.
        const byCompany = new Map();
        for (const inv of s.invitesSent) {
          if (!byCompany.has(inv.company)) byCompany.set(inv.company, []);
          byCompany.get(inv.company).push(inv);
        }
        return [...byCompany.entries()]
          .map(
            ([company, list]) => `<div style="margin:0 0 14px;padding:10px 14px;border-left:3px solid #FF6600;background:#fafafa;">
            <div style="font-weight:600;margin-bottom:6px;">${esc(company)}</div>
            ${list
              .map(
                (inv) => `<div style="margin:6px 0 10px;">
                <div>
                  ${
                    inv.linkedin_url
                      ? `<a href="${esc(inv.linkedin_url)}" target="_blank">${esc(inv.full_name ?? 'profile')}</a>`
                      : esc(inv.full_name ?? '(name unknown)')
                  }
                  ${inv.status === 'accepted' ? '<span style="color:#2e7d32;font-size:11px;"> accepted</span>' : ''}
                  ${inv.rung ? `<span style="color:#999;font-size:11px;"> · ${esc(inv.rung)}</span>` : ''}
                </div>
                ${inv.title ? `<div style="color:#666;font-size:12px;">${esc(inv.title.slice(0, 90))}</div>` : ''}
              </div>`
              )
              .join('\n')}
          </div>`
          )
          .join('\n');
      })()}
    </div>`
      : ''
  }

  <p style="margin-top:28px;font-size:12px;color:#999;border-top:1px solid #eee;padding-top:12px;">
    Queue: ${esc(JSON.stringify(s.queue.byState))} · ${s.queue.dueNow} due now
  </p>

</div></body></html>`;
}

/**
 * Send a report.
 *
 * Gmail's importance marker cannot be set by a sender — it is Gmail's
 * own classifier. The headers below surface priority in clients that
 * honour them; to reliably pin this in Gmail, add a filter on the
 * subject prefix and choose "always mark as important".
 */
async function send({ subject, text, html, to }) {
  const creds = loadSmtpCredentials();
  const transport = nodemailer.createTransport({
    host: creds.host,
    port: creds.port,
    secure: creds.port === 465,
    auth: { user: creds.user, pass: creds.pass },
  });

  try {
    const info = await transport.sendMail({
      from: creds.fromName ? `"${creds.fromName}" <${creds.fromEmail}>` : creds.fromEmail,
      to: to ?? config.report.to ?? creds.fromEmail,
      subject,
      text,
      html,
      headers: {
        'X-Priority': '1',
        'X-MSMail-Priority': 'High',
        Importance: 'high',
      },
    });
    return { ok: true, messageId: info.messageId };
  } finally {
    transport.close();
  }
}

/** Daily summary. Recorded so it is not sent twice for the same day. */
export async function sendDailyReport({ to, day = today(), force = false } = {}) {
  const d = db();
  const existing = d
    .prepare(`SELECT * FROM reports WHERE day = ? AND kind = 'daily'`)
    .get(day);

  if (existing?.sent_at && !force) {
    return { ok: false, reason: 'already sent today', sentAt: existing.sent_at };
  }

  const s = gather({ day });
  const att = attentionItems(s);
  const flag = att.some((a) => a.severity === 'high') ? ' [action needed]' : '';
  const subject = `Forge daily ${day}${flag} — ${s.invites.sent} invites, ${s.emails.sent} emails`;

  try {
    const res = await send({ subject, text: renderText(s), html: renderHtml(s), to });
    // SQLite cannot target a partial unique index from ON CONFLICT, so
    // the update-or-insert is explicit.
    const prior = d.prepare(`SELECT id FROM reports WHERE day = ? AND kind = 'daily'`).get(day);
    if (prior) {
      d.prepare(
        `UPDATE reports SET stats = ?, sent_at = datetime('now'), error = NULL WHERE id = ?`
      ).run(JSON.stringify(s), prior.id);
    } else {
      d.prepare(
        `INSERT INTO reports (day, kind, stats, sent_at) VALUES (?, 'daily', ?, datetime('now'))`
      ).run(day, JSON.stringify(s));
    }
    return { ok: true, subject, ...res };
  } catch (err) {
    d.prepare(`INSERT INTO reports (day, kind, error) VALUES (?, 'daily', ?)`).run(day, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Failure alert, sent when a run dies.
 *
 * Separate from the daily report because a crashed run never reaches
 * the reporting step — without this, a failure looks exactly like a
 * quiet day.
 */
export async function sendFailureAlert({ stage, error, context = {}, to } = {}) {
  const day = today();
  const subject = `Forge FAILED at ${stage} — ${day}`;

  const body = [
    `Forge run failed.`,
    '',
    `Stage   ${stage}`,
    `Time    ${new Date().toISOString()}`,
    `Error   ${error?.message ?? error}`,
    '',
    Object.keys(context).length ? `Context\n${JSON.stringify(context, null, 2)}` : '',
    '',
    'The queue keeps its state, so re-running resumes from where this stopped.',
    'Dead-lettered tasks need a decision — see the daily report.',
    '',
    error?.stack ? `Stack\n${error.stack}` : '',
  ].join('\n');

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,Arial,sans-serif;padding:24px;">
    <div style="border-left:4px solid #c62828;padding:14px 18px;background:#fff5f5;">
      <div style="font-size:18px;font-weight:600;color:#c62828;">Forge run failed</div>
      <div style="margin-top:8px;font-size:14px;">Stage <strong>${esc(stage)}</strong></div>
    </div>
    <pre style="background:#fafafa;padding:14px;font-size:12px;overflow:auto;border-left:3px solid #FF6600;">${esc(error?.message ?? error)}</pre>
    ${Object.keys(context).length ? `<pre style="background:#fafafa;padding:14px;font-size:12px;">${esc(JSON.stringify(context, null, 2))}</pre>` : ''}
    <p style="font-size:13px;color:#555;">The queue keeps its state, so re-running resumes from where this stopped.</p>
  </body></html>`;

  try {
    const res = await send({ subject, text: body, html, to });
    db()
      .prepare(`INSERT INTO reports (day, kind, stats, sent_at) VALUES (?, 'failure', ?, datetime('now'))`)
      .run(day, JSON.stringify({ stage, error: String(error?.message ?? error) }));
    return { ok: true, ...res };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
