import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const num = (v, d) => (v === undefined || v === '' ? d : Number.parseFloat(v));
const bool = (v, d) => (v === undefined || v === '' ? d : v === 'true' || v === '1');

export const config = {
  root: ROOT,
  dbPath: process.env.FORGE_DB_PATH ?? path.join(ROOT, 'data', 'forge.db'),

  // ---------------------------------------------------------------
  // Job discovery
  // ---------------------------------------------------------------
  search: {
    // US-only per the brief. Remote counts as US-remote, not global.
    countries: ['US'],
    // Senior/Staff IC and engineering management.
    seniority: ['senior', 'staff', 'principal', 'em', 'manager'],
    maxCompaniesPerRun: int(process.env.FORGE_MAX_COMPANIES_PER_RUN, 35),
  },

  // ---------------------------------------------------------------
  // Contact resolution
  // ---------------------------------------------------------------
  contacts: {
    // Per-company ceiling across all tiers. Deliberately far below a
    // blast: a handful of well-chosen recipients outperforms dozens,
    // and volume per company is what triggers gateway blocks.
    maxPerCompany: int(process.env.FORGE_MAX_CONTACTS_PER_COMPANY, 10),
    // Tier mix within that ceiling.
    tierCaps: {
      hiring_manager: int(process.env.FORGE_CAP_HM, 4),
      recruiter: int(process.env.FORGE_CAP_RECRUITER, 3),
      leader: int(process.env.FORGE_CAP_LEADER, 3),
    },
    // Addresses below this confidence are stored but never sent to.
    // Pattern-guessed addresses typically score under 0.6; sending to
    // them bounces, and bounces are what wreck sender reputation.
    minConfidence: num(process.env.FORGE_MIN_EMAIL_CONFIDENCE, 0.7),
  },

  // ---------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------
  mail: {
    transport: process.env.FORGE_MAIL_TRANSPORT ?? 'gmail',
    from: {
      name: process.env.FORGE_FROM_NAME ?? '',
      address: process.env.GMAIL_USER ?? '',
    },
    replyTo: process.env.FORGE_REPLY_TO ?? process.env.GMAIL_USER ?? '',

    gmail: {
      user: process.env.GMAIL_USER ?? '',
      // Google App Password (16 chars, generated at
      // myaccount.google.com/apppasswords with 2FA on). Never the
      // account password.
      appPassword: process.env.GMAIL_APP_PASSWORD ?? '',
    },

    smtp: {
      host: process.env.SMTP_HOST ?? '',
      port: int(process.env.SMTP_PORT, 587),
      user: process.env.SMTP_USER ?? '',
      pass: process.env.SMTP_PASS ?? '',
    },

    // -------------------------------------------------------------
    // Pacing
    // -------------------------------------------------------------
    // These values come from job-outreach-cli, which has been running
    // this workload in production against Gmail. They are measured,
    // not theoretical, so they are the defaults rather than the more
    // conservative figures a first-principles guess would produce.
    //
    //   daily_limit        200
    //   emails_per_hour    100
    //   min_delay_seconds  2.0, plus 10-30% random jitter
    //
    // The jitter model is also taken from there: a small randomized
    // fraction of the minimum delay, applied on top of sliding-window
    // limits. It defeats pattern detection on send timing. It does not
    // prevent reputation-based blocks, which come from low reply rates
    // and spam reports and are only fixed by better targeting.
    pacing: {
      // 300/day, set by the operator. Above job-outreach-cli's proven
      // 200 and above Gmail's 500/day published ceiling once bounces
      // and retries are counted, so watch the bounce rate here: the
      // circuit breaker below is what catches it going wrong.
      dailyCap: int(process.env.FORGE_DAILY_SEND_CAP, 300),
      perHourCap: int(process.env.FORGE_PER_HOUR_CAP, 100),
      // Floor between sends; the jitter band is a fraction of this.
      baseDelayMs: int(process.env.FORGE_BASE_DELAY_MS, 2_000),
      jitterMinPct: num(process.env.FORGE_JITTER_MIN_PCT, 0.1),
      jitterMaxPct: num(process.env.FORGE_JITTER_MAX_PCT, 0.3),
      // Occasionally pause longer, so the overall pattern is not a
      // uniform distribution either.
      longPauseEvery: int(process.env.FORGE_LONG_PAUSE_EVERY, 25),
      longPauseMs: int(process.env.FORGE_LONG_PAUSE_MS, 120_000),
      // SMTP connections are recycled rather than held open for a
      // whole run — job-outreach-cli reconnects every 20 messages.
      maxPerConnection: int(process.env.FORGE_MAX_PER_CONNECTION, 20),
      // Ramp for a new sending identity. Starting at full volume on a
      // cold mailbox is the fastest way to get blocked.
      warmup: {
        enabled: bool(process.env.FORGE_WARMUP_ENABLED, true),
        startCap: int(process.env.FORGE_WARMUP_START_CAP, 15),
        incrementPerDay: int(process.env.FORGE_WARMUP_INCREMENT, 10),
      },
      // Send only during waking hours in the recipient's general
      // timezone; 3am delivery reads as automated.
      sendWindow: {
        startHour: int(process.env.FORGE_SEND_START_HOUR, 8),
        endHour: int(process.env.FORGE_SEND_END_HOUR, 18),
        skipWeekends: bool(process.env.FORGE_SKIP_WEEKENDS, true),
      },
    },

    // Stop the run entirely if bounces spike — the signal that
    // addresses are bad and continuing will damage the sender.
    circuitBreaker: {
      maxBounceRate: num(process.env.FORGE_MAX_BOUNCE_RATE, 0.08),
      minSendsBeforeCheck: int(process.env.FORGE_MIN_SENDS_BEFORE_CHECK, 20),
    },
  },

  // ---------------------------------------------------------------
  // Sequencing
  // ---------------------------------------------------------------
  // Reaching more people at one company is done over time, not all at
  // once: a follow-up that references the first note reads as
  // persistence; ten simultaneous emails read as spam.
  sequence: {
    maxSteps: int(process.env.FORGE_MAX_SEQUENCE_STEPS, 2),
    followUpAfterDays: int(process.env.FORGE_FOLLOWUP_DAYS, 7),
    // Never follow up with someone who replied.
    stopOnReply: true,
  },

  // ---------------------------------------------------------------
  // Adapters
  // ---------------------------------------------------------------
  unipile: {
    baseUrl: process.env.UNIPILE_BASE_URL ?? '',
    apiKey: process.env.UNIPILE_API_KEY ?? '',
    accountId: process.env.UNIPILE_ACCOUNT_ID ?? '',

    // -------------------------------------------------------------
    // Invitation quotas
    // -------------------------------------------------------------
    // LinkedIn enforces invitations on a rolling weekly window and
    // throttles accounts whose invites are widely ignored. The weekly
    // figure below is the operator's measured number for this account,
    // not LinkedIn's published guidance — treat a drop in acceptance
    // rate as the signal to lower it.
    invites: {
      weeklyCap: int(process.env.FORGE_INVITE_WEEKLY_CAP, 280),
      // Spread the weekly budget instead of bursting it.
      dailyCap: int(process.env.FORGE_INVITE_DAILY_CAP, 45),
      baseDelayMs: int(process.env.FORGE_INVITE_BASE_DELAY_MS, 90_000),
      jitterMinMs: int(process.env.FORGE_INVITE_JITTER_MIN_MS, 30_000),
      jitterMaxMs: int(process.env.FORGE_INVITE_JITTER_MAX_MS, 240_000),
      // LinkedIn cuts invite capacity when acceptance falls too low.
      // Below this, the pipeline throttles itself rather than waiting
      // to be throttled.
      minAcceptanceRate: num(process.env.FORGE_MIN_ACCEPTANCE_RATE, 0.3),
      minInvitesBeforeCheck: int(process.env.FORGE_MIN_INVITES_BEFORE_CHECK, 40),
      maxPerCompany: int(process.env.FORGE_INVITE_MAX_PER_COMPANY, 10),
    },
  },

  jobright: {
    baseUrl: process.env.JOBRIGHT_BASE_URL ?? '',
    apiKey: process.env.JOBRIGHT_API_KEY ?? '',
    // Reverse-engineered endpoints break on the vendor's next deploy.
    // Kept behind an adapter so swapping the source is a small change.
    sessionCookie: process.env.JOBRIGHT_SESSION_COOKIE ?? '',
    timeoutMs: int(process.env.JOBRIGHT_TIMEOUT_MS, 15_000),
  },

  // ---------------------------------------------------------------
  // Safety
  // ---------------------------------------------------------------
  safety: {
    // Nothing sends until this is explicitly turned off. Every code
    // path defaults to rehearsal.
    dryRun: bool(process.env.FORGE_DRY_RUN, true),
    // Required by CAN-SPAM and the reason replies stay possible.
    unsubscribeText:
      process.env.FORGE_UNSUBSCRIBE_TEXT ??
      'If you would rather not hear from me, reply with "no thanks" and I will not follow up.',
    // CAN-SPAM requires a valid physical postal address on commercial
    // email, and unsolicited outreach to strangers generally counts as
    // commercial. Left empty here by the operator's choice, which
    // trades compliance for not publishing a home address; a mailbox
    // service is the usual way to have both. Nothing blocks sending
    // when this is empty — the footer simply omits it.
    senderPostalAddress: process.env.FORGE_POSTAL_ADDRESS ?? '',
  },

  // ---------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------
  // The daily report goes to the operator after a run completes; a
  // failure alert is sent separately, because a crashed run never
  // reaches the reporting step and silence looks like a quiet day.
  report: {
    to: process.env.FORGE_REPORT_TO ?? '',
    enabled: bool(process.env.FORGE_REPORT_ENABLED, true),
  },

  brand: {
    orange: '#FF6600',
    ink: '#0A0A0A',
    paper: '#FFFFFF',
  },
};

/**
 * Randomized delay before the next send.
 *
 * Uniform-random within the configured band, with a periodic longer
 * pause so the aggregate timing pattern is not itself regular.
 */
export function nextDelayMs(sendsSoFar) {
  const { baseDelayMs, jitterMinPct, jitterMaxPct, longPauseEvery, longPauseMs } =
    config.mail.pacing;

  if (longPauseEvery > 0 && sendsSoFar > 0 && sendsSoFar % longPauseEvery === 0) {
    // Jitter the long pause too, so even the pauses are not uniform.
    return longPauseMs + Math.floor(Math.random() * longPauseMs * 0.4);
  }

  // Proven model from job-outreach-cli: the minimum delay plus a random
  // 10-30% of it, so no two intervals match and the sequence has no
  // detectable period.
  const jitterPct = jitterMinPct + Math.random() * Math.max(0, jitterMaxPct - jitterMinPct);
  return Math.round(baseDelayMs * (1 + jitterPct));
}

/**
 * Today's send ceiling, accounting for warmup ramp.
 *
 * `dayIndex` is days elapsed since sending started on this identity.
 */
export function dailyCapFor(dayIndex) {
  const { dailyCap, warmup } = config.mail.pacing;
  if (!warmup.enabled) return dailyCap;
  const ramped = warmup.startCap + warmup.incrementPerDay * Math.max(0, dayIndex);
  return Math.min(dailyCap, ramped);
}

/** Whether the current moment falls inside the allowed send window. */
export function inSendWindow(now = new Date()) {
  const { startHour, endHour, skipWeekends } = config.mail.pacing.sendWindow;
  const day = now.getDay();
  if (skipWeekends && (day === 0 || day === 6)) return false;
  const h = now.getHours();
  return h >= startHour && h < endHour;
}
