/**
 * Contact resolution with backfill.
 *
 * jobright does not have an address for every profile — in testing it
 * returned nothing for roughly one in four. Resolving a fixed list of
 * candidates therefore leaves companies with too few contacts, or none
 * at all.
 *
 * This module treats candidates as a stream rather than a list: it
 * keeps resolving until it has the requested number of usable
 * addresses or runs out of people to try. When jobright misses, it
 * falls back to constructing an address from the company's observed
 * pattern — marked as such, and scored low so the caller can decide
 * whether a guess is worth sending to.
 */

import { resolveEmail, adjustForCompany, SessionExpiredError } from './jobright.js';
import { config } from '../config.js';

/**
 * Infer a company's address format from addresses already confirmed
 * for that company.
 *
 * With a known-good address like "snadella@microsoft.com" for Satya
 * Nadella, the pattern is first-initial + last. Applying that to other
 * names at the same company produces plausible addresses without
 * guessing blindly at eight permutations.
 */
export function inferPattern(knownContacts) {
  for (const c of knownContacts) {
    if (!c.email || !c.full_name) continue;
    const local = c.email.split('@')[0].toLowerCase();
    const parts = c.full_name.toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;

    const first = parts[0].replace(/[^a-z]/g, '');
    const last = parts[parts.length - 1].replace(/[^a-z]/g, '');
    if (!first || !last) continue;

    if (local === `${first}.${last}`) return 'first.last';
    if (local === `${first}${last}`) return 'firstlast';
    if (local === `${first[0]}${last}`) return 'flast';
    if (local === `${first}${last[0]}`) return 'firstl';
    if (local === `${first}_${last}`) return 'first_last';
    if (local === first) return 'first';
    if (local === `${last}.${first}`) return 'last.first';
  }
  return null;
}

/** Build an address for a name using a known company pattern. */
export function applyPattern(fullName, pattern, domain) {
  if (!fullName || !pattern || !domain) return null;
  const parts = fullName.toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;

  const first = parts[0].replace(/[^a-z]/g, '');
  const last = parts[parts.length - 1].replace(/[^a-z]/g, '');
  if (!first || !last) return null;

  const local = {
    'first.last': `${first}.${last}`,
    firstlast: `${first}${last}`,
    flast: `${first[0]}${last}`,
    firstl: `${first}${last[0]}`,
    first_last: `${first}_${last}`,
    first: first,
    'last.first': `${last}.${first}`,
  }[pattern];

  return local ? `${local}@${domain}` : null;
}

/**
 * Resolve candidates until `target` usable addresses are found.
 *
 * `candidates` is an ordered array of { fullName, title, tier,
 * linkedinUrl } — best-fit people first. The function walks it in
 * order and stops early once it has enough, so a company where the
 * first few profiles resolve costs only a few requests.
 *
 * Returns every attempt, including misses, so the caller can record
 * what was tried and avoid re-resolving the same profile tomorrow.
 */
export async function resolveUntilTarget(
  candidates,
  {
    target,
    companyDomain,
    referer,
    knownContacts = [],
    allowPatternFallback = true,
    onProgress,
  } = {}
) {
  const want = target ?? config.contacts.maxPerCompany;
  const found = [];
  const attempts = [];
  const floor = config.contacts.minConfidence;

  // Addresses already confirmed for this company teach us the format,
  // which makes the fallback a derivation rather than a guess.
  let pattern = inferPattern(knownContacts);

  for (const cand of candidates) {
    if (found.length >= want) break;

    let result = null;
    try {
      result = await resolveEmail(cand.linkedinUrl, { referer, companyDomain });
    } catch (err) {
      // A dead session is fatal for the whole run — stop rather than
      // grinding through every remaining candidate against a 403.
      if (err instanceof SessionExpiredError) throw err;
      result = { email: null, confidence: 0, source: 'jobright', error: err.message };
    }

    if (result.email && result.confidence >= floor) {
      const hit = { ...cand, ...result };
      found.push(hit);
      attempts.push({ ...hit, outcome: 'found' });
      onProgress?.({ candidate: cand, outcome: 'found', email: result.email, found: found.length, want });

      // First confirmed address for this company reveals the pattern.
      if (!pattern) {
        pattern = inferPattern([{ email: result.email, full_name: cand.fullName }]);
      }
      continue;
    }

    // jobright had nothing usable. If the company's format is known,
    // derive an address instead of dropping the candidate entirely.
    if (allowPatternFallback && pattern && companyDomain && cand.fullName) {
      const guessed = applyPattern(cand.fullName, pattern, companyDomain);
      if (guessed) {
        const guess = {
          ...cand,
          email: guessed,
          // Derived, not verified. Scored below the default floor on
          // purpose: a pattern match is a lead, and sending to
          // unverified addresses is what produces bounces.
          confidence: adjustForCompany(0.55, guessed, companyDomain),
          source: 'pattern',
          pattern,
        };
        attempts.push({ ...guess, outcome: 'pattern' });
        if (guess.confidence >= floor) found.push(guess);
        onProgress?.({ candidate: cand, outcome: 'pattern', email: guessed, found: found.length, want });
        continue;
      }
    }

    attempts.push({ ...cand, email: null, outcome: 'miss', reason: result.error ?? 'no-email-on-file' });
    onProgress?.({ candidate: cand, outcome: 'miss', found: found.length, want });
  }

  return {
    found,
    attempts,
    pattern,
    shortfall: Math.max(0, want - found.length),
    exhausted: found.length < want,
  };
}
