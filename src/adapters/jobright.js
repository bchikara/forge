/**
 * jobright.ai contact resolution.
 *
 * Wraps the internal /swan/email/linkedin-to-email route, which is
 * authenticated by a browser SESSION_ID rather than an API key. That
 * has consequences the rest of the codebase should not have to know
 * about, so they are handled here:
 *
 *   - The session expires. A 401/403 surfaces as SessionExpiredError
 *     so the caller can stop the run and ask for a fresh cookie
 *     instead of hammering a dead endpoint.
 *   - The route is undocumented and may change shape without notice,
 *     so the response is parsed defensively across several plausible
 *     field names rather than one assumed schema.
 *   - It is not a bulk API. Requests are serialized and paced, and a
 *     429 backs off hard rather than retrying tightly.
 *
 * Everything above is why this lives behind `resolveEmail()`: swapping
 * in a real provider later means reimplementing one function.
 */

import { config } from '../config.js';
import { startCooldown, cooldownRemaining, cooldownStatus } from './cooldown.js';

export class SessionExpiredError extends Error {
  constructor(status) {
    super(
      `jobright session rejected (HTTP ${status}). The SESSION_ID cookie has expired — ` +
        `log in at jobright.ai, copy a fresh cookie into JOBRIGHT_SESSION_COOKIE, and re-run.`
    );
    this.name = 'SessionExpiredError';
    this.status = status;
  }
}

export class RateLimitedError extends Error {
  constructor(retryAfterMs) {
    super(`jobright rate limited the request; backing off ${Math.round(retryAfterMs / 1000)}s`);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

const BASE = 'https://jobright.ai';

/**
 * Headers mirroring the browser request. The session cookie is the
 * only part that authenticates; the rest keeps the request shaped like
 * what the endpoint expects.
 */
function headers(referer) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'x-client-type': 'web',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    ...(referer ? { referer } : { referer: `${BASE}/jobs` }),
    cookie: config.jobright.sessionCookie,
  };
}

/** Normalize a LinkedIn profile URL so the cache key is stable. */
export function normalizeLinkedInUrl(url) {
  if (!url) return null;
  const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return null;
  return `https://www.linkedin.com/in/${m[1].toLowerCase()}/`;
}

/**
 * Pull an address out of whatever shape the endpoint returns.
 *
 * The route is undocumented, so rather than assume one schema this
 * walks the likely locations and falls back to a recursive scan. A
 * silent shape change then degrades to "no result" instead of a crash.
 */
function extractEmail(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // Observed shape: { success, errorCode, errorMsg, result: ["a@b.com"] }
  // `result` is an array of plain address strings, empty when jobright
  // holds nothing for that profile. An empty array is a normal miss.
  if (Array.isArray(payload.result)) {
    const first = payload.result.find(
      (v) => typeof v === 'string' && v.includes('@')
    ) ?? (typeof payload.result[0] === 'object' ? payload.result[0]?.email : null);
    if (typeof first === 'string' && first.includes('@')) return first.trim().toLowerCase();
    return null;
  }

  const direct =
    payload.email ??
    payload.data?.email ??
    payload.result?.email ??
    payload.data?.emailAddress ??
    payload.emailAddress;

  if (typeof direct === 'string' && direct.includes('@')) return direct.trim().toLowerCase();

  // Some variants return a list of candidates.
  const list = payload.emails ?? payload.data?.emails ?? payload.result?.emails;
  if (Array.isArray(list) && list.length > 0) {
    const first = typeof list[0] === 'string' ? list[0] : list[0]?.email;
    if (typeof first === 'string' && first.includes('@')) return first.trim().toLowerCase();
  }

  // Last resort: find the first string that looks like an address.
  let found = null;
  const seen = new Set();
  const walk = (node) => {
    if (found || node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const v of Object.values(node)) {
      if (found) return;
      if (typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        found = v.trim().toLowerCase();
        return;
      }
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(payload);
  return found;
}

/**
 * Confidence for an address from this source.
 *
 * jobright does not publish a score, so this reads whatever signal is
 * present and otherwise assigns a deliberately middling default. It
 * matters because config.contacts.minConfidence gates sending: an
 * address we cannot vouch for should not silently clear the floor.
 */
function extractConfidence(payload, email) {
  if (!email) return 0;

  const raw =
    payload?.confidence ??
    payload?.data?.confidence ??
    payload?.score ??
    payload?.data?.score;

  if (typeof raw === 'number') return raw > 1 ? raw / 100 : raw;

  const status = String(
    payload?.status ?? payload?.data?.status ?? payload?.verification ?? ''
  ).toLowerCase();

  if (status.includes('verified') || status.includes('valid')) return 0.9;
  if (status.includes('guess') || status.includes('pattern') || status.includes('risky')) return 0.5;

  // Unlabeled result: treat as usable but not verified. Sits just above
  // the 0.7 floor deliberately — see note in config.
  return 0.75;
}

/**
 * Down-rank an address whose domain does not match the target company.
 *
 * jobright returns no verification status and its data goes stale: a
 * lookup on a profile whose owner changed jobs can return the previous
 * employer's address. Mailing that is a guaranteed bounce, and bounces
 * are what damage sender reputation.
 *
 * When the address domain matches the company we are targeting, that
 * is corroboration and the score goes up. When it clearly belongs to a
 * different company, the score drops below the send floor so it is
 * stored for reference but never mailed. Free webmail is left at the
 * base score: a personal address is not evidence either way.
 */
const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'live.com',
]);

export function adjustForCompany(confidence, email, companyDomain) {
  if (!email || !companyDomain) return confidence;

  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (!emailDomain) return confidence;
  if (FREEMAIL.has(emailDomain)) return confidence;

  const target = String(companyDomain).toLowerCase().replace(/^www\./, '');
  const root = (d) => d.split('.').slice(-2).join('.');

  if (emailDomain === target || root(emailDomain) === root(target)) {
    return Math.min(1, confidence + 0.15);
  }

  // Corporate address at a different company: almost certainly a
  // previous employer. Park it below the floor.
  return Math.min(confidence, 0.4);
}

/**
 * jobright signals its own quota exhaustion rather than using 429.
 *
 * Observed: errorCode 43003 with "reach email connection limit" and
 * "Reached risk control limit", returned under a 403 and also under a
 * 200 with success:false. Treating that as an expired session was wrong
 * twice over — it sent the operator to refresh a cookie that was fine,
 * and it aborted the whole run as fatal when the correct response is to
 * back off and resume.
 */
const QUOTA_CODES = new Set([43003]);
const QUOTA_TEXT = /connection limit|risk control|rate limit|too many request|quota/i;

function looksLikeQuota(body) {
  if (!body) return false;
  if (typeof body === 'object') {
    if (QUOTA_CODES.has(body.errorCode)) return true;
    return QUOTA_TEXT.test(`${body.errorMsg ?? ''} ${body.result ?? ''}`);
  }
  return QUOTA_TEXT.test(String(body));
}

async function request(url, { referer, signal } = {}) {
  const res = await fetch(url, { headers: headers(referer), signal });

  if (res.status === 429) {
    const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    throw new RateLimitedError(Number.isFinite(retryAfter) ? retryAfter * 1000 : 120_000);
  }

  if (res.status === 401 || res.status === 403) {
    // A 403 is ambiguous here: it covers both a dead session and an
    // exhausted lookup quota, and only the body distinguishes them.
    const raw = await res.text().catch(() => '');
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* not JSON — fall through to the session reading */
    }
    if (looksLikeQuota(parsed ?? raw)) {
      // Write down when the allowance returns, so later callers skip
      // the request instead of rediscovering the limit by spending one.
      startCooldown('jobright', config.jobright.quotaBackoffMs, 'errorCode 43003 — lookup limit');
      throw new RateLimitedError(config.jobright.quotaBackoffMs);
    }
    throw new SessionExpiredError(res.status);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (looksLikeQuota(body)) {
      startCooldown('jobright', config.jobright.quotaBackoffMs, `HTTP ${res.status} — lookup limit`);
      throw new RateLimitedError(config.jobright.quotaBackoffMs);
    }
    throw new Error(`jobright HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    // An HTML response almost always means the session bounced us to a
    // login page with a 200.
    if (text.trimStart().startsWith('<')) throw new SessionExpiredError(res.status);
    throw new Error(`jobright returned non-JSON: ${text.slice(0, 200)}`);
  }

  // A 200 can still carry success:false with the quota error. Without
  // this the caller reads it as "no email on file" and moves on, so a
  // whole run silently resolves nothing while looking healthy.
  if (payload?.success === false) {
    if (looksLikeQuota(payload)) {
      startCooldown(
        'jobright',
        config.jobright.quotaBackoffMs,
        `errorCode ${payload.errorCode ?? '?'} — ${payload.errorMsg ?? 'lookup limit'}`
      );
      throw new RateLimitedError(config.jobright.quotaBackoffMs);
    }
    throw new Error(
      `jobright error ${payload.errorCode ?? '?'}: ${payload.errorMsg ?? payload.result ?? 'unknown'}`
    );
  }

  return payload;
}

/**
 * Resolve one LinkedIn profile URL to an email address.
 *
 * Returns { email, confidence, source, raw } or { email: null, ... }
 * when the lookup finds nothing. Throws only for session and transport
 * failures — a miss is a normal outcome, not an error.
 */
export async function resolveEmail(linkedinUrl, { referer, timeoutMs, companyDomain } = {}) {
  if (!config.jobright.sessionCookie) {
    throw new Error('JOBRIGHT_SESSION_COOKIE is not set — add it to .env');
  }

  // Fail fast while the allowance is spent. Making the request anyway
  // would return the same limit error and, on some paths, count against
  // the next window.
  const cooling = cooldownRemaining('jobright');
  if (cooling > 0) {
    const err = new RateLimitedError(cooling * 1000);
    err.cooldown = cooldownStatus('jobright');
    throw err;
  }

  const normalized = normalizeLinkedInUrl(linkedinUrl);
  if (!normalized) {
    return { email: null, confidence: 0, source: 'jobright', reason: 'not-a-linkedin-profile-url' };
  }

  const url = `${BASE}/swan/email/linkedin-to-email?url=${encodeURIComponent(normalized)}`;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs ?? config.jobright.timeoutMs);

  try {
    const payload = await request(url, { referer, signal: ac.signal });
    const email = extractEmail(payload);
    const base = extractConfidence(payload, email);
    return {
      email,
      confidence: adjustForCompany(base, email, companyDomain),
      source: 'jobright',
      linkedinUrl: normalized,
      raw: payload,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`jobright request timed out after ${timeoutMs ?? config.jobright.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Resolve a batch of profiles, one at a time.
 *
 * Deliberately serial with a randomized gap: this is a session-authed
 * web route, not a bulk API, and parallel bursts are what get sessions
 * throttled or closed. `onProgress` lets the caller report as it goes.
 */
export async function resolveMany(linkedinUrls, { referer, onProgress, minGapMs = 1500, maxGapMs = 4000 } = {}) {
  const results = [];

  for (let i = 0; i < linkedinUrls.length; i++) {
    const url = linkedinUrls[i];

    try {
      const r = await resolveEmail(url, { referer });
      results.push(r);
      onProgress?.({ index: i, total: linkedinUrls.length, url, result: r });
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err; // fatal: stop the run

      if (err instanceof RateLimitedError) {
        await sleep(err.retryAfterMs);
        i -= 1; // retry this one after backing off
        continue;
      }

      results.push({ email: null, confidence: 0, source: 'jobright', linkedinUrl: url, error: err.message });
      onProgress?.({ index: i, total: linkedinUrls.length, url, error: err.message });
    }

    if (i < linkedinUrls.length - 1) {
      await sleep(minGapMs + Math.random() * (maxGapMs - minGapMs));
    }
  }

  return results;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
