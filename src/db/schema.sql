-- Forge: outreach state, dedupe, and send caps.
-- Every write path goes through here. The unique constraints are the
-- safety net: they make double-sending structurally impossible rather
-- than dependent on application logic remembering to check.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------
-- Companies
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  -- Normalized key for dedupe: lowercased, suffixes stripped
  -- ("Salesforce, Inc." and "Salesforce" collapse to "salesforce").
  slug              TEXT    NOT NULL UNIQUE,
  domain            TEXT,
  linkedin_url      TEXT,
  -- Per-company send ceiling. Defaults to the global cap but can be
  -- lowered for a company that asked to be left alone.
  max_contacts      INTEGER,
  -- Set when we never want to mail this company again (bounce storm,
  -- explicit request, or a posting that says don't contact employees).
  suppressed_at     TEXT,
  suppressed_reason TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_companies_slug ON companies(slug);

-- ---------------------------------------------------------------
-- Roles (job postings)
-- ---------------------------------------------------------------
-- One row per posting. Multiple roles at one company get consolidated
-- into a single email per contact, so this table is read as a group.
CREATE TABLE IF NOT EXISTS roles (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title             TEXT    NOT NULL,
  url               TEXT    NOT NULL UNIQUE,
  location          TEXT,
  seniority         TEXT,           -- senior | staff | em | other
  ats_type          TEXT,
  jd_text           TEXT,
  -- The employer's own requisition id, parsed from the posting URL
  -- (e.g. Workday "JR360326", Greenhouse "8198219"). This is what a
  -- hiring manager or recruiter can actually look up in their ATS, so
  -- it is what outreach quotes. Distinct from tsenta_app_id, which is
  -- internal to the application tool and meaningless to the employer.
  req_id            TEXT,
  -- tsenta's application id, once applied. Links outreach to the
  -- application record; never shown to a recipient.
  tsenta_app_id     TEXT,
  applied_at        TEXT,
  -- Whether this role is still worth mentioning in outreach.
  is_open           INTEGER NOT NULL DEFAULT 1,
  discovered_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_roles_company  ON roles(company_id);
CREATE INDEX IF NOT EXISTS idx_roles_open     ON roles(is_open, company_id);

-- ---------------------------------------------------------------
-- Contacts
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  full_name         TEXT,
  title             TEXT,
  -- hiring_manager | recruiter | leader | other. Drives template choice
  -- and the per-tier caps in config.
  tier              TEXT    NOT NULL DEFAULT 'other',
  -- Which rung of the fallback ladder supplied this contact. An
  -- engineering manager is the target; 'senior_peer' means the company
  -- had nobody closer to the hiring decision. Recorded so outreach
  -- quality per company is visible after the fact.
  rung              TEXT,
  linkedin_url      TEXT    UNIQUE,
  -- LinkedIn's internal member id, required to send an invitation.
  -- The public slug in linkedin_url is not accepted by the invite API.
  provider_id       TEXT,
  email             TEXT,
  -- Where the address came from: jobright | pattern | manual | posting.
  email_source      TEXT,
  -- 0..1. Pattern-guessed addresses land low; config sets the floor
  -- below which we don't send at all.
  email_confidence  REAL,
  -- Set once an address hard-bounces, so it is never retried.
  bounced_at        TEXT,
  -- Set on an unsubscribe request. Checked before every send.
  opted_out_at      TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- A given address appears at most once, so two discovery paths finding
-- the same person cannot produce two sends.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email
  ON contacts(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_sendable
  ON contacts(company_id, tier)
  WHERE email IS NOT NULL AND bounced_at IS NULL AND opted_out_at IS NULL;

-- ---------------------------------------------------------------
-- Sends
-- ---------------------------------------------------------------
-- Append-only log of every outbound message. Also the dedupe source:
-- one row per (contact, sequence_step) makes a repeat send impossible.
CREATE TABLE IF NOT EXISTS sends (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id        INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- 1 = first touch, 2 = follow-up, 3 = final. Sequencing over blasting.
  sequence_step     INTEGER NOT NULL DEFAULT 1,
  subject           TEXT    NOT NULL,
  body              TEXT    NOT NULL,
  -- JSON array of role ids mentioned, so a follow-up can reference
  -- exactly what the first email said.
  role_ids          TEXT,
  -- queued | sent | failed | bounced | replied | skipped
  status            TEXT    NOT NULL DEFAULT 'queued',
  -- Set on dry runs so a rehearsal never looks like a real send.
  is_dry_run        INTEGER NOT NULL DEFAULT 0,
  provider_msg_id   TEXT,
  error             TEXT,
  queued_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  sent_at           TEXT,
  replied_at        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sends_contact_step
  ON sends(contact_id, sequence_step) WHERE is_dry_run = 0;
CREATE INDEX IF NOT EXISTS idx_sends_company_day
  ON sends(company_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_sends_status ON sends(status);
CREATE INDEX IF NOT EXISTS idx_sends_followup
  ON sends(status, sequence_step, sent_at) WHERE is_dry_run = 0;

-- ---------------------------------------------------------------
-- Suppression list
-- ---------------------------------------------------------------
-- Checked before every send, independent of the contacts table, so an
-- opt-out survives a contact row being deleted and re-discovered.
CREATE TABLE IF NOT EXISTS suppressions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Either a full address or a bare domain ("@example.com" form).
  value             TEXT    NOT NULL UNIQUE,
  kind              TEXT    NOT NULL DEFAULT 'email',  -- email | domain
  reason            TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------
-- Daily send counters
-- ---------------------------------------------------------------
-- Gmail enforces a rolling 24h quota. This table is the local view of
-- it, so a crashed run cannot forget how much it already sent today.
CREATE TABLE IF NOT EXISTS send_quota (
  day               TEXT    PRIMARY KEY,   -- YYYY-MM-DD, local time
  sent_count        INTEGER NOT NULL DEFAULT 0,
  failed_count      INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------
-- Run log
-- ---------------------------------------------------------------
-- One row per pipeline invocation, for debugging cron runs after
-- the fact.
CREATE TABLE IF NOT EXISTS runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT    NOT NULL,   -- discover | resolve | send | followup
  status            TEXT    NOT NULL DEFAULT 'running',
  stats             TEXT,               -- JSON
  error             TEXT,
  started_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at       TEXT
);

-- ---------------------------------------------------------------
-- LinkedIn invitations
-- ---------------------------------------------------------------
-- Connection requests sent through Unipile. Tracked separately from
-- email because the channel has its own quota, its own failure modes,
-- and a far better response rate — it is the primary channel, with
-- email as the fallback when an invite is not possible.
CREATE TABLE IF NOT EXISTS invites (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id        INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- The note sent with the invitation. LinkedIn caps these at 300
  -- characters, enforced before send.
  note              TEXT,
  role_ids          TEXT,
  -- queued | sent | accepted | ignored | withdrawn | failed
  status            TEXT    NOT NULL DEFAULT 'queued',
  provider_id       TEXT,
  error             TEXT,
  is_dry_run        INTEGER NOT NULL DEFAULT 0,
  queued_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  sent_at           TEXT,
  responded_at      TEXT
);

-- One real invitation per person, ever. LinkedIn penalizes repeat
-- invites to the same profile, so this is enforced structurally.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_contact
  ON invites(contact_id) WHERE is_dry_run = 0;
CREATE INDEX IF NOT EXISTS idx_invites_sent   ON invites(sent_at);
CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status);

-- Rolling weekly invitation counter.
--
-- LinkedIn enforces invites on a rolling weekly window, so the counter
-- is keyed by ISO week rather than calendar month. Acceptance rate is
-- tracked alongside: LinkedIn throttles accounts whose invites are
-- widely ignored, so a falling rate is the early warning that volume
-- needs to come down.
CREATE TABLE IF NOT EXISTS invite_quota (
  week              TEXT    PRIMARY KEY,   -- ISO year-week, e.g. 2026-W38
  sent_count        INTEGER NOT NULL DEFAULT 0,
  accepted_count    INTEGER NOT NULL DEFAULT 0,
  failed_count      INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Per-day counter, so a weekly budget is spread rather than burst.
CREATE TABLE IF NOT EXISTS invite_quota_daily (
  day               TEXT    PRIMARY KEY,   -- YYYY-MM-DD
  sent_count        INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------
-- Task queue
-- ---------------------------------------------------------------
-- The pipeline is data-driven rather than a script with sequential
-- loops: each stage enqueues the next, so one company failing does not
-- block unrelated companies, and a crashed run resumes from here
-- instead of from an agent's memory.
--
-- Rate limits make this necessary rather than merely tidy. Forty
-- invitations a day against fifty companies means outreach inherently
-- spills across days; a queue models that, a loop does not.
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- apply | import | enrich_jd | find_contacts | invite | email | followup
  kind          TEXT    NOT NULL,
  payload       TEXT    NOT NULL DEFAULT '{}',   -- JSON
  -- pending | claimed | done | dead
  state         TEXT    NOT NULL DEFAULT 'pending',
  priority      INTEGER NOT NULL DEFAULT 100,    -- lower runs first
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  -- Not claimable before this time. Backoff and rate-limit deferral
  -- both work by pushing this out rather than by sleeping.
  run_after     TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Claims are leased, not flagged: a worker that dies leaves its
  -- items claimable again once the lease expires, rather than stuck.
  claimed_at    TEXT,
  claimed_by    TEXT,
  lease_until   TEXT,
  last_error    TEXT,
  -- Unique per logical unit of work, so the same job is never enqueued
  -- twice even if a stage runs again.
  dedupe_key    TEXT,
  company_id    INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  role_id       INTEGER REFERENCES roles(id) ON DELETE CASCADE,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_dedupe
  ON tasks(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_claimable
  ON tasks(state, run_after, priority) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_tasks_kind  ON tasks(kind, state);
CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(state, lease_until) WHERE state = 'claimed';

-- Daily report log, so a report is not sent twice for the same day and
-- the previous run's numbers are available for comparison.
CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  day           TEXT    NOT NULL,
  kind          TEXT    NOT NULL DEFAULT 'daily',  -- daily | failure
  stats         TEXT,                              -- JSON snapshot
  sent_at       TEXT,
  error         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_day_kind
  ON reports(day, kind) WHERE kind = 'daily';

-- ---------------------------------------------------------------
-- External provider cooldowns
-- ---------------------------------------------------------------
-- jobright caps email lookups and reports it as errorCode 43003. The
-- allowance resets about an hour later, so the useful thing to record
-- is when it becomes usable again — otherwise every run rediscovers
-- the limit by spending a request on it, and a run that starts inside
-- the window wastes one lookup per company learning what the previous
-- run already knew.
CREATE TABLE IF NOT EXISTS provider_cooldown (
  provider    TEXT PRIMARY KEY,        -- jobright | unipile
  reason      TEXT,
  until       TEXT NOT NULL,
  hit_at      TEXT NOT NULL DEFAULT (datetime('now')),
  hits        INTEGER NOT NULL DEFAULT 1
);
