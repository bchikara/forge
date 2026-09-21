/**
 * tsenta -> Forge import.
 *
 * tsenta submits applications; Forge finds the people behind them. The
 * handoff is this module: it takes what tsenta's list-applications
 * returns and creates the company, role and queue entries Forge needs.
 *
 * Three things the raw tsenta payload does not give us, handled here:
 *
 *   - The employer's requisition id. Parsed from the posting URL,
 *     because tsenta's own application id means nothing to a recipient.
 *   - Job description text. list-applications omits it, and the fit
 *     paragraph is the strongest part of the outreach, so roles are
 *     queued for a separate JD fetch rather than sent without one.
 *   - Clean company names. Some rows carry a sentence fragment scraped
 *     from the JD body instead of the employer ("probabilistic systems
 *     and tradeoffs (quality vs"), which would otherwise create junk
 *     companies and address people as if that were their employer.
 */

import { upsertCompany, upsertRole, db } from '../db/index.js';
import { extractReqId } from '../roles/reqid.js';
import { enqueue } from '../queue/index.js';

/**
 * Whether a company name looks like a real employer.
 *
 * tsenta's scraper sometimes captures a clause from the job
 * description. Those names are unusable in outreach — greeting someone
 * as working at "probabilistic systems and tradeoffs (quality vs" is
 * worse than not writing at all — so they are flagged rather than
 * silently stored.
 */
export function looksLikeCompanyName(name) {
  const s = String(name ?? '').trim();
  if (!s) return false;
  // Real employer names are short.
  if (s.length > 45) return false;
  // Sentence fragments: unbalanced brackets, trailing conjunctions,
  // or more than five words.
  if (s.split(/\s+/).length > 5) return false;
  if ((s.match(/\(/g)?.length ?? 0) !== (s.match(/\)/g)?.length ?? 0)) return false;
  if (/\b(and|or|vs|with|the|for|to)\s*$/i.test(s)) return false;
  // A name identical to the job title is the scraper having failed.
  return true;
}

/**
 * Derive a usable company name and domain.
 *
 * Falls back to the website when the name is unusable, since a domain
 * is a reliable identifier even when the scraped name is not.
 */
function normalizeCompany(row) {
  const raw = row.companyName ?? '';
  const site = (row.companyWebsite ?? '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');

  if (looksLikeCompanyName(raw) && raw.toLowerCase() !== String(row.jobTitle ?? '').toLowerCase()) {
    return { name: raw, domain: site || null, suspect: false };
  }

  // Recover from the domain: "salesforce.com" -> "Salesforce".
  if (site) {
    const stem = site.split('.')[0];
    const recovered = stem.charAt(0).toUpperCase() + stem.slice(1);
    return { name: recovered, domain: site, suspect: true, original: raw };
  }

  return { name: raw || 'Unknown', domain: null, suspect: true, original: raw };
}

/**
 * Import tsenta applications.
 *
 * Only submitted applications are imported: a skipped one was never
 * seen by the employer, so outreach claiming "I applied" would be
 * false. Idempotent — roles are keyed by URL, and queue entries are
 * deduped, so re-running is safe.
 */
export function importApplications(applications, { queueNext = true } = {}) {
  const rows = Array.isArray(applications)
    ? applications
    : (applications?.applications ?? []);

  const result = {
    imported: 0,
    skippedNotSubmitted: 0,
    suspectNames: [],
    queued: 0,
    roles: [],
  };

  for (const row of rows) {
    const submitted =
      row.status === 'COMPLETED' || row.jobStatus === 'COMPLETED';

    if (!submitted) {
      // A skipped application is not a basis for outreach. Recorded in
      // the count so the report can show how many need attention.
      result.skippedNotSubmitted += 1;
      continue;
    }

    if (!row.url || !row.jobTitle) continue;

    const co = normalizeCompany(row);
    if (co.suspect) {
      result.suspectNames.push({ used: co.name, original: co.original, url: row.url });
    }

    const company = upsertCompany({ name: co.name, domain: co.domain });
    const { reqId, ats } = extractReqId(row.url);

    const role = upsertRole({
      companyId: company.id,
      title: row.jobTitle,
      url: row.url,
      location: Array.isArray(row.locations) ? row.locations.join(', ') || null : null,
      atsType: ats ?? row.atsType ?? null,
    });

    db()
      .prepare(
        `UPDATE roles
            SET req_id        = COALESCE(?, req_id),
                tsenta_app_id = COALESCE(?, tsenta_app_id),
                applied_at    = COALESCE(applied_at, ?, datetime('now'))
          WHERE id = ?`
      )
      .run(reqId, row.applicationId ?? null, row.updatedAt ?? null, role.id);

    result.imported += 1;
    result.roles.push({
      roleId: role.id,
      companyId: company.id,
      company: company.name,
      title: row.jobTitle,
      reqId,
      url: row.url,
      needsJd: true,
    });

    if (queueNext) {
      // JD text first: the fit paragraph depends on it, and contact
      // discovery is wasted effort if the email ends up generic.
      const q = enqueue({
        kind: 'enrich_jd',
        payload: { roleId: role.id, url: row.url, company: company.name },
        dedupeKey: `enrich_jd:role:${role.id}`,
        companyId: company.id,
        roleId: role.id,
      });
      if (q.queued) result.queued += 1;
    }
  }

  return result;
}

/** Roles still missing JD text, for the enrich stage. */
export function rolesNeedingJd({ limit = 50 } = {}) {
  return db()
    .prepare(
      `SELECT r.id AS roleId, r.url, r.title, c.name AS company, c.id AS companyId
         FROM roles r JOIN companies c ON c.id = r.company_id
        WHERE (r.jd_text IS NULL OR length(r.jd_text) < 200)
          AND r.is_open = 1
        ORDER BY r.applied_at DESC
        LIMIT ?`
    )
    .all(limit);
}

/**
 * Store fetched JD text.
 *
 * A JD shorter than a few hundred characters is almost always an error
 * page or a login wall rather than a real posting, and storing it would
 * make the fit matcher produce nothing while looking like it succeeded.
 */
export function saveJd(roleId, jdText) {
  const text = String(jdText ?? '').trim();
  if (text.length < 200) {
    return { ok: false, reason: `jd text too short (${text.length} chars) — likely not a real posting` };
  }

  db()
    .prepare(`UPDATE roles SET jd_text = ? WHERE id = ?`)
    .run(text, roleId);

  return { ok: true, chars: text.length };
}

/**
 * Companies with at least one submitted role and no contacts yet.
 *
 * This is what the discovery stage works through, ordered by most
 * recent application so fresh applications get outreach while they are
 * still recent.
 */
export function companiesNeedingContacts({ limit = 50 } = {}) {
  return db()
    .prepare(
      `SELECT c.id AS companyId, c.name, c.domain,
              COUNT(r.id) AS roles,
              MAX(r.applied_at) AS lastApplied
         FROM companies c
         JOIN roles r ON r.company_id = c.id AND r.applied_at IS NOT NULL
        WHERE c.suppressed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM contacts k WHERE k.company_id = c.id)
        GROUP BY c.id
        ORDER BY lastApplied DESC
        LIMIT ?`
    )
    .all(limit);
}
