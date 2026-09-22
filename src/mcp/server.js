#!/usr/bin/env node
/**
 * Forge MCP server.
 *
 * Exposes the outreach pipeline as tools so it can be driven from an
 * agent session alongside tsenta: tsenta applies to jobs, Forge finds
 * the people at those companies and reaches out.
 *
 * Two deliberate constraints:
 *
 *   - Discovery and preview tools are separate from sending tools.
 *     Finding contacts and rendering a message are read-only and safe
 *     to call freely; actually sending is not, so it is its own call
 *     with its own explicit arguments.
 *   - Sending respects config.safety.dryRun unless a call passes
 *     `live: true`. The default is rehearsal, so an agent that calls
 *     forge_send_emails without thinking about it does not mail
 *     anyone.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { config } from '../config.js';
import {
  db,
  migrate,
  upsertCompany,
  upsertRole,
  upsertContact,
  sendableContacts,
  openRoles,
  suppress,
  quotaUsedToday,
  recentBounceRate,
  startRun,
  finishRun,
} from '../db/index.js';
import { findCandidates, listAccounts } from '../adapters/unipile.js';
import { resolveUntilTarget } from '../adapters/resolver.js';
import { extractReqId } from '../roles/reqid.js';
import { buildEmail, inviteNote } from '../templates/index.js';
import { Sender } from '../mailer/sender.js';
import {
  InviteSender,
  inviteQuotaUsed,
  acceptanceRate,
  reconcileInvites,
} from '../invites/sender.js';
import { listSentInvitations } from '../adapters/unipile.js';
import {
  importApplications,
  rolesNeedingJd,
  saveJd,
  companiesNeedingContacts,
} from '../tsenta/import.js';
import { findInviteTargets } from '../adapters/ladder.js';
import { stats as queueStats, deadLetter, revive, reclaimExpired } from '../queue/index.js';
import { cooldownStatus, clearCooldown } from '../adapters/cooldown.js';
import { searchStreak } from '../adapters/unipile.js';
import { status as lockStatus } from '../lock/index.js';
import { sendDailyReport, sendFailureAlert, gather, attentionItems } from '../report/index.js';

migrate();

const server = new Server(
  { name: 'forge', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

const text = (obj) => ({
  content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }],
});

// ---------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------

const TOOLS = [
  {
    name: 'forge_status',
    description:
      'Pipeline status: send and invite quotas used, bounce rate, acceptance rate, ' +
      'row counts, and whether dry run is active. Read-only. Call this first to see ' +
      'whether sending is currently possible.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'forge_track_role',
    description:
      'Record a job posting that has been applied to. Extracts the employer requisition ' +
      'id from the URL and creates the company if new. Call once per application, then ' +
      'use forge_find_contacts for that company.',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Employer name' },
        title: { type: 'string', description: 'Job title as posted' },
        url: { type: 'string', description: 'Posting URL on the job board' },
        domain: { type: 'string', description: 'Company email domain, e.g. salesforce.com' },
        jdText: { type: 'string', description: 'Full job description text — drives the fit paragraph' },
        location: { type: 'string' },
        seniority: { type: 'string' },
        tsentaAppId: { type: 'string', description: 'tsenta application id, for cross-reference only' },
      },
      required: ['company', 'title', 'url'],
    },
  },
  {
    name: 'forge_find_contacts',
    description:
      'Find people at a company via LinkedIn search, then resolve email addresses for ' +
      'them. Stores candidates with tier (hiring_manager / recruiter / leader / peer), ' +
      'provider id for invitations, and email confidence. Keeps searching until the ' +
      'target number of addresses is found or candidates run out.',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string' },
        target: { type: 'number', description: 'How many usable addresses to find (default: per-company cap)' },
        perTier: { type: 'number', description: 'Candidates to pull per tier before resolving (default 12)' },
        tiers: {
          type: 'array',
          items: { type: 'string', enum: ['hiring_manager', 'recruiter', 'leader', 'peer'] },
        },
      },
      required: ['company'],
    },
  },
  {
    name: 'forge_preview',
    description:
      'Render the email and LinkedIn invitation note that would be sent to each eligible ' +
      'contact at a company, without sending anything. Read-only. Use this to check copy ' +
      'before any live send.',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string' },
        limit: { type: 'number', description: 'How many to render (default 3)' },
      },
      required: ['company'],
    },
  },
  {
    name: 'forge_send_emails',
    description:
      'Send outreach email to eligible contacts at a company. Rehearses by default: ' +
      'pass live=true to actually send. Respects daily cap, hourly window, send-time ' +
      'window, bounce circuit breaker, suppression list, and per-company and per-tier ' +
      'caps. Never sends the same person the same sequence step twice.',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string' },
        live: { type: 'boolean', description: 'true actually sends; omit or false rehearses' },
        limit: { type: 'number' },
        sequenceStep: { type: 'number', description: '1 = first touch, 2 = follow-up' },
      },
      required: ['company'],
    },
  },
  {
    name: 'forge_send_invites',
    description:
      'Send LinkedIn connection invitations to contacts at a company. Rehearses by ' +
      'default: pass live=true to actually send. Enforces weekly and daily invite ' +
      'quotas, per-company cap, and throttles itself if acceptance rate falls below the ' +
      'configured floor. Invites are the preferred channel — no address needed and ' +
      'nothing bounces.',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string' },
        live: { type: 'boolean' },
        limit: { type: 'number' },
      },
      required: ['company'],
    },
  },
  {
    name: 'forge_reconcile_invites',
    description:
      'Check which sent LinkedIn invitations have been accepted, and update the ' +
      'acceptance rate. Call this once per daily run before sending invitations: ' +
      'LinkedIn reduces invite capacity for accounts whose requests are widely ' +
      'ignored, and without this the rate stays null so the pipeline can never ' +
      'throttle itself before LinkedIn does. Only invitations older than ' +
      'minAgeMinutes are judged, since a fresh one may not be indexed yet.',
    inputSchema: {
      type: 'object',
      properties: {
        minAgeMinutes: {
          type: 'number',
          description: 'Ignore invitations newer than this (default 30)',
        },
      },
    },
  },
  {
    name: 'forge_suppress',
    description:
      'Add an address or a whole domain (as "@example.com") to the suppression list. ' +
      'Checked before every send and survives contact rows being deleted and ' +
      're-discovered. Use this the moment someone asks not to be contacted.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'Email address, or @domain.com for a whole company' },
        reason: { type: 'string' },
      },
      required: ['value'],
    },
  },
  {
    name: 'forge_search_filter',
    description:
      'The arguments to pass to tsenta get-job-recommendations, plus the ids of ' +
      'jobs already tracked so they are not re-surfaced. Call this first in a daily ' +
      'run: without a location filter the feed is mostly onsite roles in countries ' +
      'the operator cannot work in. Also returns minMatchScore — the score below ' +
      'which a posting is not worth a credit.',
    inputSchema: {
      type: 'object',
      properties: {
        datePosted: {
          type: 'string',
          description: 'Override the configured window (6h, 24h, 7d, 30d, all)',
        },
      },
    },
  },
  {
    name: 'forge_import_applications',
    description:
      'Import submitted applications from tsenta. Pass the array that tsenta\'s ' +
      'list-applications returns. Creates companies and roles, parses the employer ' +
      'requisition id from each posting URL, recovers company names that were scraped ' +
      'wrong, and queues each role for job-description fetching. Skipped applications ' +
      'are excluded — outreach must not claim an application that never reached the ' +
      'employer. Idempotent: safe to re-run.',
    inputSchema: {
      type: 'object',
      properties: {
        applications: {
          type: 'array',
          description: 'Rows from tsenta list-applications (or the whole response object)',
          items: { type: 'object' },
        },
      },
      required: ['applications'],
    },
  },
  {
    name: 'forge_roles_needing_jd',
    description:
      'List roles whose job description text is missing. Call tsenta ' +
      'fetch-job-description for each, then pass the text back via forge_save_jd. ' +
      'The fit paragraph in outreach depends on this text, so a role without it gets ' +
      'a generic email.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },
  {
    name: 'forge_save_jd',
    description:
      'Store job description text for a role, fetched from tsenta. Rejects text under ' +
      '200 characters, which is almost always an error page rather than a posting.',
    inputSchema: {
      type: 'object',
      properties: {
        roleId: { type: 'number' },
        jdText: { type: 'string' },
      },
      required: ['roleId', 'jdText'],
    },
  },
  {
    name: 'forge_next_companies',
    description:
      'Companies with a submitted application and no contacts found yet, newest first. ' +
      'This is the work list for contact discovery.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },
  {
    name: 'forge_find_invite_target',
    description:
      'Find the best person to invite at a company, walking a fallback ladder: ' +
      'engineering manager, then engineering lead or director, then technical ' +
      'recruiter, then VP/CTO, then senior engineer. Stops at the first rung with ' +
      'someone verifiably at that company. Use when invitations are the priority and ' +
      'one strong contact per company matters more than breadth.',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string' },
        want: { type: 'number', description: 'How many targets (default 1)' },
      },
      required: ['company'],
    },
  },
  {
    name: 'forge_queue',
    description:
      'Queue state: counts by stage and state, what is due now, and the dead letter. ' +
      'Also reclaims expired leases from workers that died mid-task. Read-only apart ' +
      'from that reclaim.',
    inputSchema: {
      type: 'object',
      properties: {
        deadLimit: { type: 'number' },
        reclaim: { type: 'boolean', description: 'true also returns expired leases to pending' },
      },
    },
  },
  {
    name: 'forge_revive_task',
    description:
      'Return a dead-lettered task to the queue after fixing whatever blocked it. ' +
      'Resets its attempt count.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'number' } },
      required: ['taskId'],
    },
  },
  {
    name: 'forge_send_report',
    description:
      'Email the daily status report: counts, what needs attention, dead letter, ' +
      'quotas and health. Call after a run completes. Pass kind="failure" with an ' +
      'error message to send a failure alert instead — a crashed run never reaches ' +
      'the daily report, and silence looks like a quiet day.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['daily', 'failure'] },
        to: { type: 'string' },
        force: { type: 'boolean', description: 'Resend even if today\'s report already went' },
        stage: { type: 'string', description: 'For kind=failure: which stage died' },
        error: { type: 'string', description: 'For kind=failure: the error message' },
      },
    },
  },
  {
    name: 'forge_list_companies',
    description:
      'List tracked companies with role, contact, send and invite counts. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function findCompany(name) {
  const { slugify } = { slugify: (s) => s };
  const row = db()
    .prepare('SELECT * FROM companies WHERE name = ? COLLATE NOCASE')
    .get(name);
  if (row) return row;
  // Fall back to slug matching so "Salesforce, Inc." finds "Salesforce".
  return db()
    .prepare('SELECT * FROM companies WHERE slug = ?')
    .get(String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
}

// ---------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      case 'forge_status': {
        const d = db();
        const counts = {};
        for (const t of ['companies', 'roles', 'contacts', 'sends', 'invites']) {
          counts[t] = d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
        }
        const bounce = recentBounceRate();
        const accept = acceptanceRate();
        const iq = inviteQuotaUsed();

        return text({
          dryRunDefault: config.safety.dryRun,
          // A pass already running, or a provider still cooling down,
          // both mean "do not start sending" — surfacing them here
          // saves a caller discovering it one request at a time.
          runLock: lockStatus(),
          providers: {
            jobright: cooldownStatus('jobright'),
            unipile: cooldownStatus('unipile'),
            // LinkedIn search reports its own exhaustion as empty
            // results rather than an error, so the streak of empty
            // searches is the only signal — worth showing before a
            // caller concludes a company simply has nobody.
            unipileSearch: {
              ...cooldownStatus('unipile-search'),
              ...searchStreak(),
            },
          },
          email: {
            sentToday: quotaUsedToday(),
            dailyCap: config.mail.pacing.dailyCap,
            perHourCap: config.mail.pacing.perHourCap,
            bounceRate: bounce.rate,
            bounceSample: bounce.sample,
            circuitBreakerAt: config.mail.circuitBreaker.maxBounceRate,
          },
          invites: {
            week: iq.week,
            sentThisWeek: iq.weekSent,
            weeklyCap: config.unipile.invites.weeklyCap,
            sentToday: iq.daySent,
            dailyCap: config.unipile.invites.dailyCap,
            acceptanceRate: accept.rate,
            acceptanceSample: accept.sample,
            throttleBelow: config.unipile.invites.minAcceptanceRate,
          },
          counts,
        });
      }

      case 'forge_track_role': {
        const { reqId, ats } = extractReqId(args.url);
        const company = upsertCompany({ name: args.company, domain: args.domain ?? null });
        const role = upsertRole({
          companyId: company.id,
          title: args.title,
          url: args.url,
          location: args.location ?? null,
          seniority: args.seniority ?? null,
          atsType: ats,
          jdText: args.jdText ?? null,
        });
        db()
          .prepare(
            `UPDATE roles SET req_id = COALESCE(?, req_id),
                              tsenta_app_id = COALESCE(?, tsenta_app_id),
                              applied_at = COALESCE(applied_at, datetime('now'))
              WHERE id = ?`
          )
          .run(reqId, args.tsentaAppId ?? null, role.id);

        return text({
          companyId: company.id,
          roleId: role.id,
          reqId,
          ats,
          note: reqId
            ? `Requisition id ${reqId} will be quoted in outreach.`
            : 'No requisition id found in the URL; outreach will link the posting without one.',
        });
      }

      case 'forge_find_contacts': {
        const runId = startRun('resolve');
        try {
          const company = upsertCompany({ name: args.company });
          const candidates = await findCandidates(args.company, {
            perTier: args.perTier ?? 12,
            tiers: args.tiers ?? ['hiring_manager', 'recruiter', 'leader'],
          });

          const known = db()
            .prepare('SELECT full_name, email FROM contacts WHERE company_id = ? AND email IS NOT NULL')
            .all(company.id);

          const result = await resolveUntilTarget(candidates, {
            target: args.target ?? config.contacts.maxPerCompany,
            companyDomain: company.domain,
            knownContacts: known,
          });

          for (const f of result.found) {
            upsertContact({
              companyId: company.id,
              fullName: f.fullName,
              title: f.title,
              tier: f.tier ?? 'other',
              linkedinUrl: f.linkedinUrl,
              providerId: f.providerId ?? null,
              email: f.email,
              emailSource: f.source,
              emailConfidence: f.confidence,
            });
          }
          // Candidates without an address are still worth storing: an
          // invitation needs no email, only a provider id.
          for (const a of result.attempts) {
            if (a.outcome === 'miss' && a.linkedinUrl) {
              upsertContact({
                companyId: company.id,
                fullName: a.fullName,
                title: a.title,
                tier: a.tier ?? 'other',
                linkedinUrl: a.linkedinUrl,
                providerId: a.providerId ?? null,
              });
            }
          }

          const stats = {
            candidatesSearched: candidates.length,
            emailsFound: result.found.length,
            shortfall: result.shortfall,
            patternDetected: result.pattern,
            storedWithoutEmail: result.attempts.filter((a) => a.outcome === 'miss').length,
          };
          finishRun(runId, { stats });
          return text({ companyId: company.id, ...stats });
        } catch (err) {
          finishRun(runId, { status: 'error', error: err.message });
          throw err;
        }
      }

      case 'forge_preview': {
        const company = findCompany(args.company);
        if (!company) return text({ error: `no tracked company named "${args.company}"` });

        const roles = openRoles(company.id);
        const contacts = sendableContacts(company.id, 1).slice(0, args.limit ?? 3);

        return text({
          company: company.name,
          roles: roles.map((r) => ({ title: r.title, reqId: r.req_id, url: r.url })),
          previews: contacts.map((c) => {
            const email = buildEmail({ contact: c, company, roles });
            return {
              to: c.email,
              name: c.full_name,
              tier: c.tier,
              confidence: c.email_confidence,
              subject: email.subject,
              body: email.body,
              inviteNote: c.provider_id ? inviteNote({ contact: c, company, roles }) : null,
            };
          }),
        });
      }

      case 'forge_send_emails': {
        const company = findCompany(args.company);
        if (!company) return text({ error: `no tracked company named "${args.company}"` });

        const live = args.live === true;
        const roles = openRoles(company.id);
        const step = args.sequenceStep ?? 1;
        const contacts = sendableContacts(company.id, step).slice(
          0,
          args.limit ?? config.contacts.maxPerCompany
        );

        if (contacts.length === 0) {
          return text({ sent: 0, note: 'no eligible contacts — all sent, capped, or filtered' });
        }

        const runId = startRun('send');
        const sender = new Sender({ dryRun: !live });
        const messages = contacts.map((c) => ({
          contact: c,
          companyId: company.id,
          roleIds: roles.map((r) => r.id),
          sequenceStep: step,
          ...buildEmail({ contact: c, company, roles }),
        }));

        const results = await sender.sendBatch(messages);
        sender.close();

        const summary = results.reduce((acc, r) => {
          acc[r.status] = (acc[r.status] ?? 0) + 1;
          return acc;
        }, {});
        finishRun(runId, { stats: summary });

        return text({
          live,
          company: company.name,
          summary,
          details: results.map((r) => ({ status: r.status, to: r.to, reason: r.reason, error: r.error })),
        });
      }

      case 'forge_send_invites': {
        const company = findCompany(args.company);
        if (!company) return text({ error: `no tracked company named "${args.company}"` });

        const live = args.live === true;
        const roles = openRoles(company.id);

        // Invitations need a provider id, not an email — so this pulls
        // from all contacts rather than the email-eligible set.
        const contacts = db()
          .prepare(
            `SELECT * FROM contacts
              WHERE company_id = ?
                AND provider_id IS NOT NULL
                AND opted_out_at IS NULL
                AND NOT EXISTS (
                      SELECT 1 FROM invites i
                       WHERE i.contact_id = contacts.id AND i.is_dry_run = 0
                    )
              ORDER BY CASE tier
                         WHEN 'hiring_manager' THEN 1
                         WHEN 'recruiter' THEN 2
                         WHEN 'leader' THEN 3
                         ELSE 4 END`
          )
          .all(company.id)
          .slice(0, args.limit ?? config.unipile.invites.maxPerCompany);

        if (contacts.length === 0) {
          return text({
            sent: 0,
            note: 'no invitable contacts — none have a provider id, or all already invited',
          });
        }

        const runId = startRun('invite');
        const inviter = new InviteSender({ dryRun: !live });
        const results = await inviter.inviteBatch(
          contacts.map((c) => ({ contact: c, company, roles }))
        );

        const summary = results.reduce((acc, r) => {
          acc[r.status] = (acc[r.status] ?? 0) + 1;
          return acc;
        }, {});
        finishRun(runId, { stats: summary });

        return text({
          live,
          company: company.name,
          summary,
          quota: inviteQuotaUsed(),
          details: results.map((r) => ({ status: r.status, to: r.to, reason: r.reason, error: r.error })),
        });
      }

      case 'forge_reconcile_invites': {
        const res = await reconcileInvites({
          listSent: () => listSentInvitations({ limit: 100 }),
          minAgeMinutes: args.minAgeMinutes ?? 30,
        });
        const rate = acceptanceRate();
        return text({
          ...res,
          acceptanceRate: rate.rate,
          acceptanceSample: rate.sample,
          throttleFloor: config.unipile.invites.minAcceptanceRate,
          throttled:
            rate.rate !== null &&
            rate.sample >= config.unipile.invites.minInvitesBeforeCheck &&
            rate.rate < config.unipile.invites.minAcceptanceRate,
        });
      }

      case 'forge_suppress': {
        suppress(args.value, args.reason ?? null);
        // Also mark any matching contact, so selection skips them even
        // before the suppression check runs.
        db()
          .prepare(`UPDATE contacts SET opted_out_at = datetime('now') WHERE email = ?`)
          .run(String(args.value).toLowerCase());
        return text({ suppressed: args.value, reason: args.reason ?? null });
      }

      case 'forge_search_filter': {
        const s = config.search;
        // Jobs already tracked here. tsenta filters out anything
        // already applied to on its own, so this mainly covers roles
        // seen and passed over — relevant once the window widens past
        // a single day.
        const seen = db()
          .prepare(`SELECT tsenta_app_id FROM roles WHERE tsenta_app_id IS NOT NULL`)
          .all()
          .map((r) => r.tsenta_app_id);

        // How many applications are still owed today. The morning run
        // frequently cannot fill the target — the feed runs short, an
        // ATS refuses, a screening question holds one back — so an
        // afternoon run tops up the shortfall instead of applying a
        // second full batch.
        const appliedToday = db()
          .prepare(
            `SELECT COUNT(*) n FROM roles
              WHERE applied_at >= date('now', 'localtime')`
          )
          .get().n;

        const remaining = Math.max(0, s.dailyApplicationTarget - appliedToday);

        return text({
          recommendationArgs: {
            locations: s.locations,
            jobTypes: s.jobTypes,
            roleFamilies: s.roleFamilies,
            datePosted: args.datePosted ?? s.datePosted,
            // Over-fetch relative to the remaining budget: postings
            // below the score floor get discarded, so asking for
            // exactly `remaining` yields fewer than that.
            limit: Math.min(50, Math.max(20, remaining * 2)),
            ...(seen.length ? { excludeJobIds: seen } : {}),
          },
          minMatchScore: s.minMatchScore,
          dailyTarget: s.dailyApplicationTarget,
          appliedToday,
          remainingToday: remaining,
          guidance:
            remaining === 0
              ? `Today's target of ${s.dailyApplicationTarget} is already met (${appliedToday} applied). Nothing to apply to — move on to outreach.`
              : `Apply to up to ${remaining} more postings today (${appliedToday} of ${s.dailyApplicationTarget} done), ` +
                `at or above matchScore ${s.minMatchScore}. Page through results if the first page runs short — ` +
                `the 7d pool has 100+ postings. If the feed still cannot fill the target, leave it short rather ` +
                `than dropping the score floor: below ${s.minMatchScore} the results are adjacent roles, not backend engineering.`,
        });
      }

      case 'forge_import_applications': {
        const res = importApplications(args.applications);
        return text({
          ...res,
          note:
            res.suspectNames.length > 0
              ? `${res.suspectNames.length} company name(s) looked like scraped JD text and were ` +
                `recovered from the website domain — check them before sending.`
              : undefined,
          nextStep:
            res.queued > 0
              ? 'Call forge_roles_needing_jd, fetch each JD via tsenta, then forge_save_jd.'
              : 'Nothing new queued.',
        });
      }

      case 'forge_roles_needing_jd': {
        const rows = rolesNeedingJd({ limit: args.limit ?? 50 });
        return text({
          count: rows.length,
          roles: rows,
          note:
            rows.length > 0
              ? 'For each: tsenta fetch-job-description with the url, then forge_save_jd with roleId + jdText.'
              : 'All roles have job description text.',
        });
      }

      case 'forge_save_jd': {
        return text(saveJd(args.roleId, args.jdText));
      }

      case 'forge_next_companies': {
        const rows = companiesNeedingContacts({ limit: args.limit ?? 50 });
        return text({ count: rows.length, companies: rows });
      }

      case 'forge_find_invite_target': {
        const company = upsertCompany({ name: args.company });
        // Pass the domain: for a short company name the matcher needs
        // corroboration beyond the name appearing in a headline, and
        // the domain stem is the strongest signal available.
        const res = await findInviteTargets(args.company, {
          want: args.want ?? 1,
          companyDomain: company.domain,
        });

        // Store what was found, so the invite stage can use it and the
        // report can show which rung this company reached.
        for (const t of res.targets) {
          upsertContact({
            companyId: company.id,
            fullName: t.fullName,
            title: t.title,
            tier: t.tier,
            rung: t.rung,
            linkedinUrl: t.linkedinUrl,
            providerId: t.providerId,
          });
        }

        return text({
          company: args.company,
          reachedRung: res.reachedRung,
          exhausted: res.exhausted,
          rungsTried: res.rungsTried,
          targets: res.targets.map((t) => ({
            name: t.fullName,
            title: t.title,
            rung: t.rung,
            rungLabel: t.rungLabel,
            linkedinUrl: t.linkedinUrl,
          })),
          note: res.exhausted
            ? 'No verified contact at any rung — this company needs a manual look.'
            : undefined,
        });
      }

      case 'forge_queue': {
        const reclaimed = args.reclaim ? reclaimExpired() : { reclaimed: 0 };
        return text({
          ...queueStats(),
          reclaimed: reclaimed.reclaimed,
          dead: deadLetter({ limit: args.deadLimit ?? 20 }),
        });
      }

      case 'forge_revive_task': {
        return text(revive(args.taskId));
      }

      case 'forge_send_report': {
        if (args.kind === 'failure') {
          const res = await sendFailureAlert({
            stage: args.stage ?? 'unknown',
            error: new Error(args.error ?? 'unspecified failure'),
            to: args.to,
          });
          return text(res);
        }
        const res = await sendDailyReport({ to: args.to, force: args.force === true });
        // Include the summary so the caller sees what was reported
        // without opening the email.
        const s = gather();
        return text({ ...res, attention: attentionItems(s), counts: { roles: s.roles, invites: s.invites, emails: s.emails } });
      }

      case 'forge_list_companies': {
        const rows = db()
          .prepare(
            `SELECT c.id, c.name, c.domain, c.suppressed_at,
                    (SELECT COUNT(*) FROM roles    r WHERE r.company_id = c.id) AS roles,
                    (SELECT COUNT(*) FROM contacts k WHERE k.company_id = c.id) AS contacts,
                    (SELECT COUNT(*) FROM contacts k WHERE k.company_id = c.id AND k.email IS NOT NULL) AS withEmail,
                    (SELECT COUNT(*) FROM sends   s WHERE s.company_id = c.id AND s.is_dry_run = 0) AS sent,
                    (SELECT COUNT(*) FROM invites i WHERE i.company_id = c.id AND i.is_dry_run = 0) AS invited
               FROM companies c
              ORDER BY c.updated_at DESC
              LIMIT ?`
          )
          .all(args.limit ?? 50);
        return text(rows);
      }

      default:
        return text({ error: `unknown tool: ${name}` });
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `${err.name ?? 'Error'}: ${err.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr so it does not corrupt the stdio protocol stream.
  process.stderr.write(
    `forge mcp ready — dryRun default ${config.safety.dryRun}, ` +
      `email cap ${config.mail.pacing.dailyCap}/day, ` +
      `invites ${config.unipile.invites.weeklyCap}/week\n`
  );
}

main().catch((err) => {
  process.stderr.write(`forge mcp failed: ${err.message}\n`);
  process.exit(1);
});
