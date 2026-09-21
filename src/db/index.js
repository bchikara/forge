import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db;

export function db() {
  if (_db) return _db;

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db().exec(sql);
}

/**
 * Normalize a company name into a dedupe key.
 *
 * Job boards spell the same employer many ways, and some scraped names
 * are sentence fragments from the JD body rather than the company
 * ("probabilistic systems and tradeoffs (quality vs"). Collapsing to a
 * slug keeps those from creating duplicate company rows.
 */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[,.]/g, ' ')
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|technology|labs|holdings|group|plc|gmbh|sa|ag|pvt|private|limited)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function upsertCompany({ name, domain = null, linkedinUrl = null }) {
  const slug = slugify(name);
  const d = db();

  const existing = d.prepare('SELECT * FROM companies WHERE slug = ?').get(slug);
  if (existing) {
    // Fill in fields we learned since first seeing this company, but
    // never overwrite a known value with null.
    d.prepare(
      `UPDATE companies
          SET domain       = COALESCE(?, domain),
              linkedin_url = COALESCE(?, linkedin_url),
              updated_at   = datetime('now')
        WHERE id = ?`
    ).run(domain, linkedinUrl, existing.id);
    return d.prepare('SELECT * FROM companies WHERE id = ?').get(existing.id);
  }

  const info = d
    .prepare(
      `INSERT INTO companies (name, slug, domain, linkedin_url, max_contacts)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(name, slug, domain, linkedinUrl, config.contacts.maxPerCompany);

  return d.prepare('SELECT * FROM companies WHERE id = ?').get(info.lastInsertRowid);
}

export function upsertRole({
  companyId,
  title,
  url,
  location = null,
  seniority = null,
  atsType = null,
  jdText = null,
}) {
  const d = db();
  const existing = d.prepare('SELECT * FROM roles WHERE url = ?').get(url);
  if (existing) return existing;

  const info = d
    .prepare(
      `INSERT INTO roles (company_id, title, url, location, seniority, ats_type, jd_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(companyId, title, url, location, seniority, atsType, jdText);

  return d.prepare('SELECT * FROM roles WHERE id = ?').get(info.lastInsertRowid);
}

export function upsertContact({
  companyId,
  fullName = null,
  title = null,
  tier = 'other',
  rung = null,
  linkedinUrl = null,
  providerId = null,
  email = null,
  emailSource = null,
  emailConfidence = null,
}) {
  const d = db();

  // Match on email first, then LinkedIn URL — either identifies the
  // same person, and two discovery paths must not create two rows.
  const existing =
    (email && d.prepare('SELECT * FROM contacts WHERE email = ?').get(email)) ||
    (linkedinUrl &&
      d.prepare('SELECT * FROM contacts WHERE linkedin_url = ?').get(linkedinUrl));

  if (existing) {
    d.prepare(
      `UPDATE contacts
          SET full_name        = COALESCE(?, full_name),
              title            = COALESCE(?, title),
              email            = COALESCE(?, email),
              email_source     = COALESCE(?, email_source),
              email_confidence = COALESCE(?, email_confidence),
              linkedin_url     = COALESCE(?, linkedin_url),
              provider_id      = COALESCE(?, provider_id),
              rung             = COALESCE(?, rung),
              updated_at       = datetime('now')
        WHERE id = ?`
    ).run(fullName, title, email, emailSource, emailConfidence, linkedinUrl, providerId, rung, existing.id);
    return d.prepare('SELECT * FROM contacts WHERE id = ?').get(existing.id);
  }

  const info = d
    .prepare(
      `INSERT INTO contacts
         (company_id, full_name, title, tier, rung, linkedin_url, provider_id, email, email_source, email_confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(companyId, fullName, title, tier, rung, linkedinUrl, providerId, email, emailSource, emailConfidence);

  return d.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid);
}

/** True when an address is on the suppression list, by address or domain. */
export function isSuppressed(email) {
  if (!email) return true;
  const d = db();
  const domain = '@' + String(email).split('@')[1];
  const hit = d
    .prepare('SELECT 1 FROM suppressions WHERE value = ? OR value = ? LIMIT 1')
    .get(email.toLowerCase(), domain.toLowerCase());
  return Boolean(hit);
}

export function suppress(value, reason = null) {
  const kind = value.startsWith('@') ? 'domain' : 'email';
  db()
    .prepare(
      `INSERT INTO suppressions (value, kind, reason) VALUES (?, ?, ?)
       ON CONFLICT(value) DO NOTHING`
    )
    .run(value.toLowerCase(), kind, reason);
}

/**
 * Contacts eligible for a first send at this company.
 *
 * Applies, in order: opt-out and bounce state, the suppression list,
 * the confidence floor, the per-tier caps, and the per-company ceiling.
 * A contact already sent to at this step is excluded by the sends
 * table's unique index, but filtered here too so the caller sees an
 * accurate count.
 */
export function sendableContacts(companyId, step = 1) {
  const d = db();
  const company = d.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  if (!company || company.suppressed_at) return [];

  const rows = d
    .prepare(
      `SELECT c.* FROM contacts c
        WHERE c.company_id = ?
          AND c.email IS NOT NULL
          AND c.bounced_at IS NULL
          AND c.opted_out_at IS NULL
          AND c.email_confidence >= ?
          AND NOT EXISTS (
                SELECT 1 FROM sends s
                 WHERE s.contact_id = c.id
                   AND s.sequence_step = ?
                   AND s.is_dry_run = 0
              )
        ORDER BY c.email_confidence DESC`
    )
    .all(companyId, config.contacts.minConfidence, step);

  const eligible = rows.filter((r) => !isSuppressed(r.email));

  // Caps are a lifetime budget per company, not a per-step allowance.
  // Seed the counters with everyone already contacted here, otherwise
  // each sequence step re-spends the full ceiling on the next batch of
  // people and the company receives far more mail than configured.
  const contacted = d
    .prepare(
      `SELECT DISTINCT c.id, c.tier
         FROM contacts c
         JOIN sends s ON s.contact_id = c.id AND s.is_dry_run = 0
        WHERE c.company_id = ?`
    )
    .all(companyId);

  const perTier = {};
  for (const row of contacted) {
    perTier[row.tier] = (perTier[row.tier] ?? 0) + 1;
  }

  const picked = [];
  const ceiling = company.max_contacts ?? config.contacts.maxPerCompany;
  let usedSlots = contacted.length;

  for (const r of eligible) {
    if (usedSlots >= ceiling) break;
    const cap = config.contacts.tierCaps[r.tier] ?? ceiling;
    perTier[r.tier] = perTier[r.tier] ?? 0;
    if (perTier[r.tier] >= cap) continue;
    perTier[r.tier] += 1;
    usedSlots += 1;
    picked.push(r);
  }

  return picked;
}

/** Open roles at a company, for consolidating into one email. */
export function openRoles(companyId) {
  return db()
    .prepare(
      `SELECT * FROM roles
        WHERE company_id = ? AND is_open = 1
        ORDER BY COALESCE(applied_at, discovered_at) DESC`
    )
    .all(companyId);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function quotaUsedToday() {
  const row = db().prepare('SELECT * FROM send_quota WHERE day = ?').get(today());
  return row?.sent_count ?? 0;
}

export function bumpQuota({ sent = 0, failed = 0 } = {}) {
  db()
    .prepare(
      `INSERT INTO send_quota (day, sent_count, failed_count)
       VALUES (?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         sent_count   = sent_count   + excluded.sent_count,
         failed_count = failed_count + excluded.failed_count,
         updated_at   = datetime('now')`
    )
    .run(today(), sent, failed);
}

/**
 * Recent bounce rate, used as a circuit breaker.
 *
 * A bounce spike means the address source is wrong; continuing to send
 * damages sender reputation far more than stopping does.
 */
export function recentBounceRate(limit = 200) {
  const rows = db()
    .prepare(
      `SELECT status FROM sends
        WHERE is_dry_run = 0 AND sent_at IS NOT NULL
        ORDER BY sent_at DESC LIMIT ?`
    )
    .all(limit);

  if (rows.length === 0) return { rate: 0, sample: 0 };
  const bounced = rows.filter((r) => r.status === 'bounced').length;
  return { rate: bounced / rows.length, sample: rows.length };
}

export function startRun(kind) {
  const info = db().prepare('INSERT INTO runs (kind) VALUES (?)').run(kind);
  return info.lastInsertRowid;
}

export function finishRun(id, { status = 'ok', stats = null, error = null } = {}) {
  db()
    .prepare(
      `UPDATE runs SET status = ?, stats = ?, error = ?, finished_at = datetime('now')
        WHERE id = ?`
    )
    .run(status, stats ? JSON.stringify(stats) : null, error, id);
}
