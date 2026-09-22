/**
 * Unipile LinkedIn adapter — candidate discovery and connection invites.
 *
 * Two jobs:
 *
 *   1. Search returns LinkedIn profile URLs for people at a target
 *      company. Unipile itself returns no email addresses — its search
 *      response carries name, headline, location and profile_url only —
 *      so those URLs feed jobright (see resolver.js) to get addresses.
 *
 *   2. Connection invitations. This is the better channel: no address
 *      needed, nothing to bounce, no sender reputation to damage, and
 *      it lands in-app rather than in a spam folder. Email is the
 *      fallback for people an invite cannot reach.
 *
 * Unipile drives a real LinkedIn account by reverse-engineering the
 * site, so every request here counts against that account's limits.
 * Searches are serialized and paced, pagination stops at a ceiling
 * rather than draining every page, and invites are gated on both a
 * weekly and a daily quota held in SQLite.
 */

import { config } from '../config.js';

const TIER_PATTERNS = [
  [
    'hiring_manager',
    [
      'engineering manager',
      'software engineering manager',
      'director of engineering',
      'head of engineering',
      'engineering lead',
      'dev manager',
    ],
  ],
  [
    'recruiter',
    [
      'technical recruiter',
      'technical sourcer',
      'talent acquisition',
      'recruiting',
      'recruiter',
      'sourcer',
      'talent partner',
    ],
  ],
  [
    'leader',
    [
      'vp of engineering',
      'vp engineering',
      'vice president of engineering',
      'chief technology officer',
      'cto',
      'head of talent',
      'director of talent',
      'senior director',
    ],
  ],
  [
    'peer',
    [
      'senior software engineer',
      'staff software engineer',
      'principal engineer',
      'senior engineer',
      'staff engineer',
    ],
  ],
];

// Headline signals that a profile is a poor target regardless of title.
const NEGATIVE_SIGNALS = ['former', 'ex-', 'retired', 'open to work', 'seeking', 'student'];

export class UnipileError extends Error {
  constructor(status, body) {
    super(`unipile HTTP ${status}: ${String(body).slice(0, 300)}`);
    this.name = 'UnipileError';
    this.status = status;
  }
}

export class UnipileAuthError extends Error {
  constructor(status) {
    super(
      `unipile rejected the API key (HTTP ${status}). Check UNIPILE_API_KEY in .env, ` +
        `and that the connected LinkedIn account is still authorized.`
    );
    this.name = 'UnipileAuthError';
    this.status = status;
  }
}

/**
 * LinkedIn has restricted the account.
 *
 * Distinct from a rate limit: this is not something to wait out and
 * retry. The run stops and the operator has to intervene.
 */
export class AccountRestrictedError extends Error {
  constructor(detail) {
    super(
      `LinkedIn appears to have restricted the connected account: ${detail}. ` +
        `Stop automated invites and check the account in a browser before resuming.`
    );
    this.name = 'AccountRestrictedError';
  }
}

function baseUrl() {
  const u = config.unipile.baseUrl;
  if (!u) throw new Error('UNIPILE_BASE_URL is not set — add it to .env');
  return u.replace(/\/+$/, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Consecutive searches that returned nothing.
 *
 * When LinkedIn's search allowance runs out, Unipile does not report an
 * error: it returns an empty result set, exactly as it would for a
 * company with no matching people. A single zero is therefore
 * meaningless, but a run of them is not — a real search that scanned
 * two dozen candidates a minute ago does not suddenly find nobody
 * anywhere.
 *
 * Last night a run only caught this because an agent probed a company
 * it knew had findable staff and still got zero. That judgement belongs
 * in the code rather than in whoever happens to be watching.
 */
let consecutiveEmpty = 0;

/**
 * How many empty searches in a row before the allowance is assumed
 * spent. Three is deliberate: one or two companies genuinely having
 * nobody at a given rung is ordinary, three in a row is not.
 */
const EMPTY_STREAK_LIMIT = 3;

export class SearchExhaustedError extends Error {
  constructor(streak) {
    super(
      `LinkedIn search returned nothing ${streak} times in a row. The search ` +
        `allowance is almost certainly spent — Unipile reports this as an empty ` +
        `result rather than an error, so it is indistinguishable from a company ` +
        `with no matching people until it repeats. Invitations to contacts ` +
        `already found still work; new discovery does not.`
    );
    this.name = 'SearchExhaustedError';
    this.streak = streak;
  }
}

/** Reset after any search that actually returned people. */
export function resetSearchStreak() {
  consecutiveEmpty = 0;
}

export function searchStreak() {
  return { consecutiveEmpty, limit: EMPTY_STREAK_LIMIT };
}

async function call(path, { method = 'GET', body, signal } = {}) {
  if (!config.unipile.apiKey) {
    throw new Error('UNIPILE_API_KEY is not set — add it to .env');
  }

  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'X-API-KEY': config.unipile.apiKey,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (res.status === 401 || res.status === 403) throw new UnipileAuthError(res.status);

  if (res.status === 429) {
    const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    const err = new UnipileError(429, 'rate limited');
    err.retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 300_000;
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // LinkedIn-side restriction surfaces as an upstream error rather
    // than a clean status code, so it is detected by content.
    if (/restrict|checkpoint|challenge|unusual activity/i.test(text)) {
      throw new AccountRestrictedError(text.slice(0, 200));
    }
    throw new UnipileError(res.status, text);
  }

  return res.json();
}

/** List connected accounts — also the cheapest credential check. */
export async function listAccounts() {
  const d = await call('/api/v1/accounts');
  return d.items ?? (Array.isArray(d) ? d : []);
}

export function classifyTier(headline) {
  const low = (headline ?? '').toLowerCase();
  for (const [tier, patterns] of TIER_PATTERNS) {
    if (patterns.some((p) => low.includes(p))) return tier;
  }
  return 'other';
}

/**
 * Score a result for fit.
 *
 * Ordering matters because each candidate costs a jobright lookup and
 * the resolver stops once it has enough addresses, so the best-matching
 * people should be tried first rather than whoever the search ranked.
 */
export function scoreResult(item, company) {
  const headline = (item.headline ?? '').toLowerCase();
  const blob = `${headline} ${(item.name ?? '').toLowerCase()}`;
  const notes = [];
  let score = 0.5;

  if (company && headline.includes(company.toLowerCase())) {
    score += 0.25;
  } else {
    notes.push('company not in headline');
    score -= 0.05;
  }

  const tier = classifyTier(item.headline);
  if (tier !== 'other') score += 0.15;
  else notes.push('title did not match a known tier');

  for (const neg of NEGATIVE_SIGNALS) {
    if (blob.includes(neg)) {
      score -= 0.35;
      notes.push(`negative signal: ${neg}`);
      break;
    }
  }

  // A closer connection is likelier to accept and likelier to read.
  if (item.network_distance === 'DISTANCE_1') score += 0.1;
  else if (item.network_distance === 'DISTANCE_2') score += 0.05;

  return { score: Math.max(0, Math.min(1, score)), tier, notes };
}

function normalizeProfileUrl(url) {
  const m = String(url ?? '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? `https://www.linkedin.com/in/${m[1].toLowerCase()}/` : null;
}

/**
 * Search LinkedIn for people, following pagination until `limit`
 * candidates are collected.
 *
 * Returns candidates in the shape resolver.js expects:
 * { fullName, title, tier, linkedinUrl, providerId, score }.
 */
export async function searchPeople(
  company,
  { keywords, limit = 30, accountId = config.unipile.accountId, maxPages = 4, onProgress } = {}
) {
  if (!accountId) throw new Error('UNIPILE_ACCOUNT_ID is not set — add it to .env');

  const out = [];
  const seen = new Set();
  let cursor = null;
  let page = 0;

  while (out.length < limit && page < maxPages) {
    const body = {
      api: 'classic',
      category: 'people',
      keywords: keywords ?? company,
      ...(cursor ? { cursor } : {}),
    };

    let data;
    try {
      data = await call(`/api/v1/linkedin/search?account_id=${encodeURIComponent(accountId)}`, {
        method: 'POST',
        body,
      });
    } catch (err) {
      if (err.status === 429 && err.retryAfterMs) {
        await sleep(err.retryAfterMs);
        continue;
      }
      throw err;
    }

    const items = data.items ?? [];
    if (items.length === 0) {
      // Only the first page of a search counts toward the streak: a
      // later page coming back empty just means the result set ended.
      if (page === 0 && out.length === 0) {
        consecutiveEmpty += 1;
        if (consecutiveEmpty >= EMPTY_STREAK_LIMIT) {
          throw new SearchExhaustedError(consecutiveEmpty);
        }
      }
      break;
    }

    // A search that returned people proves the allowance is intact.
    consecutiveEmpty = 0;

    for (const item of items) {
      const url = normalizeProfileUrl(item.public_profile_url ?? item.profile_url);
      if (!url || seen.has(url)) continue;
      seen.add(url);

      const { score, tier, notes } = scoreResult(item, company);
      out.push({
        fullName: item.name ?? null,
        title: item.headline ?? null,
        tier,
        linkedinUrl: url,
        // Needed to send an invitation — LinkedIn's internal id, not
        // the public slug.
        providerId: item.id ?? null,
        score: Number(score.toFixed(3)),
        networkDistance: item.network_distance ?? null,
        location: item.location ?? null,
        source: 'unipile',
        notes,
      });

      if (out.length >= limit) break;
    }

    page += 1;
    onProgress?.({ page, collected: out.length, limit });

    cursor = data.cursor ?? null;
    if (!cursor) break;

    // Pace pagination: this drives a real account and bursts are what
    // get accounts flagged.
    await sleep(2500 + Math.random() * 3000);
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Collect candidates across tiers.
 *
 * Querying per tier rather than once broadly guarantees each tier has
 * candidates, so the per-tier caps downstream have something to draw
 * on instead of filling with whichever role is most common.
 */
export async function findCandidates(
  company,
  { perTier = 12, tiers = ['hiring_manager', 'recruiter', 'leader'], onProgress } = {}
) {
  const queries = {
    hiring_manager: `${company} engineering manager`,
    recruiter: `${company} technical recruiter`,
    leader: `${company} vp engineering`,
    peer: `${company} senior software engineer`,
  };

  const all = [];
  const seen = new Set();

  for (const tier of tiers) {
    let batch = [];
    try {
      batch = await searchPeople(company, {
        keywords: queries[tier] ?? `${company} ${tier}`,
        limit: perTier,
      });
    } catch (err) {
      // Auth failures and restrictions are fatal for the whole run;
      // a single tier failing otherwise is not.
      if (err instanceof UnipileAuthError || err instanceof AccountRestrictedError) throw err;
      onProgress?.({ tier, error: err.message });
      continue;
    }

    for (const c of batch) {
      if (seen.has(c.linkedinUrl)) continue;
      seen.add(c.linkedinUrl);
      all.push(c);
    }

    onProgress?.({ tier, found: batch.length, total: all.length });
    await sleep(3000 + Math.random() * 3000);
  }

  all.sort((a, b) => b.score - a.score);
  return all;
}

// ---------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------

/** LinkedIn truncates invitation notes beyond this. */
export const MAX_NOTE_CHARS = 300;

/**
 * Send a connection invitation.
 *
 * Quota enforcement lives in the caller (invites.js) because it needs
 * database state; this function performs one send and reports what
 * happened. A note longer than LinkedIn allows is rejected here rather
 * than silently truncated mid-sentence.
 */
export async function sendInvitation(
  providerId,
  { note, accountId = config.unipile.accountId } = {}
) {
  if (!accountId) throw new Error('UNIPILE_ACCOUNT_ID is not set — add it to .env');
  if (!providerId) throw new Error('sendInvitation requires a provider id');

  if (note && note.length > MAX_NOTE_CHARS) {
    throw new Error(
      `invitation note is ${note.length} chars; LinkedIn allows ${MAX_NOTE_CHARS}`
    );
  }

  const body = {
    account_id: accountId,
    provider_id: providerId,
    ...(note ? { message: note } : {}),
  };

  return call('/api/v1/users/invite', { method: 'POST', body });
}

/**
 * Invitations already sent from this account, with their status.
 *
 * Used to reconcile acceptance rate: LinkedIn throttles accounts whose
 * invitations are widely ignored, so a falling acceptance rate is the
 * early warning that volume needs to come down.
 */
export async function listSentInvitations({ accountId = config.unipile.accountId, limit = 100 } = {}) {
  const d = await call(
    `/api/v1/users/invite/sent?account_id=${encodeURIComponent(accountId)}&limit=${limit}`
  );
  return d.items ?? (Array.isArray(d) ? d : []);
}

/** Fetch one profile, for enriching a candidate before outreach. */
export async function getProfile(identifier, { accountId = config.unipile.accountId } = {}) {
  return call(
    `/api/v1/users/${encodeURIComponent(identifier)}?account_id=${encodeURIComponent(accountId)}`
  );
}
