/**
 * Invitation target selection with fallback.
 *
 * The engineering manager who owns a requisition is the highest-value
 * connection: they decide who gets interviewed. But not every company
 * has someone with that title — small companies have a founding
 * engineer or a CTO doing the hiring, large ones bury managers under
 * titles like "Group Product Engineering Lead", and some simply have
 * no public profiles matching.
 *
 * So instead of searching one title and giving up, this walks a
 * preference ladder: try the closest thing to an engineering manager,
 * and on a miss step outward to the next-best person who could still
 * move an application forward. A company always gets someone, and the
 * choice is recorded so it is visible which rung was reached.
 *
 * The ladder is ordered by decision authority over a specific req,
 * not by seniority. A VP of Engineering outranks an engineering
 * manager on an org chart but is further from the hiring decision on
 * one posting, so they sit lower here.
 */

import { searchPeople, UnipileAuthError, AccountRestrictedError } from './unipile.js';

/**
 * Rungs, best first.
 *
 * `queries` are tried in order within a rung — the first that returns
 * a usable candidate wins, so the most specific phrasing goes first.
 * `titleTest` re-checks the returned headline, because LinkedIn search
 * is fuzzy and will happily return a software engineer for an
 * "engineering manager" query.
 */
export const LADDER = [
  {
    rung: 'engineering_manager',
    tier: 'hiring_manager',
    label: 'engineering manager',
    queries: ['engineering manager', 'software engineering manager', 'senior engineering manager'],
    titleTest: /engineering manager|software.{0,15}manager|eng manager/i,
  },
  {
    rung: 'engineering_lead',
    tier: 'hiring_manager',
    label: 'engineering lead / director',
    queries: ['director of engineering', 'head of engineering', 'engineering lead'],
    titleTest: /director of engineering|head of engineering|engineering lead|tech lead|team lead/i,
  },
  {
    rung: 'technical_recruiter',
    tier: 'recruiter',
    label: 'technical recruiter',
    queries: ['technical recruiter', 'technical sourcer', 'talent acquisition engineering'],
    titleTest: /recruit|sourcer|talent acquisition|talent partner/i,
  },
  {
    rung: 'engineering_leadership',
    tier: 'leader',
    label: 'VP engineering / CTO',
    // Small companies often have no manager layer at all — the CTO or a
    // founding engineer is doing the hiring directly.
    queries: ['vp of engineering', 'cto', 'head of technology', 'founding engineer'],
    titleTest: /vp.{0,5}engineering|vice president.{0,15}engineering|cto|chief technology|head of technology|founding engineer/i,
  },
  {
    rung: 'senior_peer',
    tier: 'peer',
    label: 'senior engineer',
    // Last resort. A peer cannot hire, but they can refer, and a
    // referral from an engineer on the team carries real weight.
    queries: ['staff software engineer', 'principal engineer', 'senior software engineer'],
    titleTest: /staff engineer|staff software engineer|principal engineer|senior software engineer|senior engineer/i,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether a candidate is worth inviting.
 *
 * Requires a provider id (the invitation API needs LinkedIn's internal
 * member id, not the public slug) and a headline that actually matches
 * the rung being searched.
 */
function usable(candidate, rung, company) {
  if (!candidate.providerId) return false;
  if (!candidate.title) return false;
  if (!rung.titleTest.test(candidate.title)) return false;

  // The headline must actually name the company. LinkedIn search is
  // keyword-based, not scoped: a query for "Cartesia engineering
  // manager" happily returns an engineering leader who has never
  // worked there. Inviting them wastes a scarce invitation and reads
  // as obviously automated, which is worse than reaching nobody.
  const headline = candidate.title.toLowerCase();
  const target = company.toLowerCase();
  if (!headline.includes(target)) return false;

  // "Ex-Cartesia" and "former ... at Cartesia" contain the name but
  // describe someone who has left.
  if (/\b(ex|former|previously)\b[\s-]*$|(\bex[- ])/i.test(headline.slice(0, headline.indexOf(target) + target.length))) {
    return false;
  }

  return true;
}

/**
 * Find invitation targets at one company, walking the ladder until
 * `want` candidates are found or the ladder is exhausted.
 *
 * Returns { targets, rungsTried, exhausted }. Each target carries the
 * rung it came from, so a caller can see whether a company yielded an
 * engineering manager or fell through to a peer — useful for judging
 * outreach quality later.
 *
 * Stops as soon as it has enough. A company with a real engineering
 * manager costs one search; only companies without one pay for the
 * walk down.
 */
export async function findInviteTargets(
  company,
  { want = 1, minScore = 0.5, onProgress } = {}
) {
  const targets = [];
  const rungsTried = [];
  const seen = new Set();

  for (const rung of LADDER) {
    if (targets.length >= want) break;

    let foundInRung = 0;

    for (const q of rung.queries) {
      if (targets.length >= want) break;

      let batch = [];
      try {
        batch = await searchPeople(company, {
          keywords: `${company} ${q}`,
          // Over-fetch: the title test rejects a good share of what
          // search returns, so asking for exactly `want` yields fewer.
          limit: Math.max(6, want * 4),
          maxPages: 1,
        });
      } catch (err) {
        // A dead credential or a restricted account fails every
        // subsequent query the same way — surface it rather than
        // walking the whole ladder into the same error.
        if (err instanceof UnipileAuthError || err instanceof AccountRestrictedError) throw err;
        onProgress?.({ company, rung: rung.rung, query: q, error: err.message });
        continue;
      }

      for (const c of batch) {
        if (targets.length >= want) break;
        if (seen.has(c.linkedinUrl)) continue;
        if (c.score < minScore) continue;
        if (!usable(c, rung, company)) continue;

        seen.add(c.linkedinUrl);
        targets.push({ ...c, rung: rung.rung, rungLabel: rung.label, tier: rung.tier });
        foundInRung += 1;
      }

      // Pace between queries: this drives a real LinkedIn account.
      await sleep(2000 + Math.random() * 2500);
    }

    rungsTried.push({ rung: rung.rung, label: rung.label, found: foundInRung });
    onProgress?.({ company, rung: rung.rung, label: rung.label, found: foundInRung, total: targets.length });

    if (foundInRung === 0) {
      // Nothing at this rung — step outward. This is the case the
      // ladder exists for: a company with no engineering manager.
      continue;
    }
  }

  return {
    targets,
    rungsTried,
    exhausted: targets.length < want,
    // The rung that actually supplied the first target, which is the
    // honest answer to "did we reach a hiring manager at this company".
    reachedRung: targets[0]?.rung ?? null,
  };
}

/**
 * Email targets at a company.
 *
 * Email has far more headroom than invitations, so it goes broader:
 * everyone on the ladder above peers is worth an email, since an
 * address costs nothing to try beyond the send itself.
 */
export async function findEmailTargets(company, { want = 8, onProgress } = {}) {
  const out = [];
  const seen = new Set();

  // Peers are excluded: they cannot act on an application, and email
  // volume is better spent on people who can.
  for (const rung of LADDER.filter((r) => r.tier !== 'peer')) {
    if (out.length >= want) break;

    try {
      const batch = await searchPeople(company, {
        keywords: `${company} ${rung.queries[0]}`,
        limit: Math.max(8, want),
        maxPages: 1,
      });

      for (const c of batch) {
        if (out.length >= want) break;
        if (seen.has(c.linkedinUrl)) continue;
        if (!usable({ ...c, providerId: c.providerId ?? 'n/a' }, rung, company)) continue;
        seen.add(c.linkedinUrl);
        out.push({ ...c, rung: rung.rung, tier: rung.tier });
      }

      onProgress?.({ company, rung: rung.rung, total: out.length });
    } catch (err) {
      if (err instanceof UnipileAuthError || err instanceof AccountRestrictedError) throw err;
      onProgress?.({ company, rung: rung.rung, error: err.message });
    }

    await sleep(2500 + Math.random() * 2500);
  }

  return out;
}
