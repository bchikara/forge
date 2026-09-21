# Forge

Job-application outreach automation. Finds the people behind a job posting,
reaches out on LinkedIn first and by email second, and refuses to contact
anyone twice.

Runs alongside [tsenta](https://tsenta.com) (which submits the applications)
as an MCP server, so both can be driven from one agent session.

```
tsenta applies to a job
        ↓
forge_track_role        record posting, parse the employer's requisition id
        ↓
forge_find_contacts     LinkedIn search → email resolution
        ↓
forge_send_invites      connection requests, hiring managers first
        ↓
forge_send_emails       fallback for people an invite cannot reach
```

## Why invitations before email

A LinkedIn invitation needs no email address, cannot bounce, puts no sender
reputation at risk, and lands in-app rather than in a spam folder. Email is
the fallback, not the backbone.

## Setup

Requires Node 20+, Python 3.10+, a [Unipile](https://www.unipile.com) account
with LinkedIn connected, and Gmail (or any SMTP) for the email channel.

```bash
npm install
cp .env.example .env     # then fill it in — see the comments in that file
npm run db:init
```

`.env` holds live credentials and is gitignored. Nothing in this repo reads
credentials from anywhere else, except that the mailer will reuse an existing
`~/.outreach-cli/config.yaml` if one is present, rather than duplicating SMTP
secrets into a second file.

Run as an MCP server:

```bash
npm run mcp
```

Register it with your agent client pointing at `src/mcp/server.js` over stdio.

## Tools

| Tool | Does |
|---|---|
| `forge_search_filter` | The filter to pass to tsenta, plus already-seen job ids |
| `forge_status` | Quotas used, bounce rate, acceptance rate, row counts |
| `forge_track_role` | Record a posting; extracts the employer's req id from the URL |
| `forge_find_contacts` | LinkedIn search → email resolution, until the target is met |
| `forge_preview` | Render what would be sent, without sending |
| `forge_send_emails` | Send email (rehearses unless `live: true`) |
| `forge_send_invites` | Send connection requests (rehearses unless `live: true`) |
| `forge_suppress` | Add an address or whole domain to the suppression list |
| `forge_list_companies` | Tracked companies with counts |

## Safety

Everything defaults to rehearsal. `FORGE_DRY_RUN=true` is the shipped default
and every send path checks it; a call has to pass `live: true` explicitly.

Guards enforced on every send, not once per run:

- **Duplicates** — a unique index on `(contact_id, sequence_step)` for email
  and on `contact_id` for invitations makes a repeat send impossible, so a
  crashed run resumes without re-contacting anyone.
- **Suppression** — by address or by whole domain, checked independently of
  the contacts table so an opt-out survives a row being deleted and
  re-discovered.
- **Bounces** — a hard bounce marks the address permanently; a bounce rate
  above `FORGE_MAX_BOUNCE_RATE` aborts the run.
- **Caps** — per company, per tier, per day, and per rolling week. Caps are a
  lifetime budget per company, not a per-step allowance.
- **Acceptance rate** — LinkedIn reduces invite capacity for accounts whose
  invitations are widely ignored, so the pipeline throttles itself below
  `FORGE_MIN_ACCEPTANCE_RATE` rather than waiting to be throttled.
- **Send window** — business hours, weekdays, with randomized delays between
  messages.

Every outbound email carries an unsubscribe line.

`FORGE_POSTAL_ADDRESS` adds a physical address to the footer. CAN-SPAM
requires one on commercial email, and unsolicited outreach to strangers
generally qualifies, so leaving it empty means the mail is not compliant. A
mailbox service costs a few dollars a month and avoids publishing a home
address. Nothing in the code blocks sending without it — the footer just
omits the line.

## Job search filter

`forge_search_filter` returns the arguments for tsenta's
`get-job-recommendations`. It matters more than it sounds: unfiltered, that feed
returned 17 of 20 postings in countries this operator cannot work in. Filtered
to `country:US` it returned 19 of 20 usable, six of them explicitly sponsoring
visas.

The window is `7d`. A 24h window sounds right for a daily run, but the 24h US
software-engineering pool measured 33 postings with `hasMore: false` — the whole
pool, not a page limit — so a 50/day target cannot be met from fresh listings.
The 7d window returns 100+ across pages with match scores holding in the
mid-70s. `excludeJobIds` keeps the wider window from re-surfacing the same
postings each morning.

`FORGE_MIN_MATCH_SCORE` is the floor worth spending a credit on. Below roughly
60 the feed turns into adjacent roles — Salesforce architects, hourly contract
listings — so when the feed cannot fill the daily target, leave it short rather
than lowering the floor.

### Topping up

`forge_search_filter` returns `remainingToday`, not a fixed batch size: the
daily target minus what has already been applied to. A morning run frequently
falls short — the feed runs dry, an ATS refuses, a screening question holds one
back — so a second run after lunch fills the remainder instead of applying
another full batch on top.

## Volume

Defaults in `.env.example` are set for one operator's measured limits, not as
recommendations:

| | Default | Note |
|---|---|---|
| Email | 300/day, 100/hour | Gmail's published ceiling is 500/day, and bounces count |
| Invitations | 280/week, 45/day | LinkedIn's own guidance is lower; it enforces server-side regardless |

Volume per company is what triggers gateway blocks and account restrictions —
not volume overall. Ten well-chosen recipients at one employer outperform
sixty, and a follow-up a week later reads as persistence where ten
simultaneous messages read as spam. The per-company caps exist for that
reason; raising them is the fastest way to get a domain blocked.

## Contact sources

**LinkedIn candidates** come from Unipile's search API (`src/adapters/unipile.js`).

**Email addresses** come from jobright, with a fallback that derives an
address from a pattern observed in already-confirmed addresses at the same
company (`src/adapters/resolver.js`). Roughly a quarter of lookups return
nothing, so the resolver keeps working through candidates until it has enough
rather than resolving a fixed list once.

Addresses are scored, and a corporate address whose domain does not match the
target company is dropped below the send floor — that pattern means a
previous employer, and mailing it is a guaranteed bounce.

Two other sources exist and are not the primary path:

- `src/scraper/import_csv.py` — imports Sales Navigator / Apollo /
  PhantomBuster exports.
- `src/scraper/xray.py` — Google X-ray search. **Needs a SerpAPI key.** Every
  free backend blocks automated queries: DuckDuckGo returns a bot
  interstitial, Bing and Google return pages with no results. Measured, not
  assumed.

## Caveats

- **jobright** is reached through an undocumented endpoint authenticated by a
  browser session. It breaks when they ship changes, and the session cookie
  expires and needs replacing.
- **Unipile** works by reverse-engineering LinkedIn. Search and invitation
  volume counts against the connected account and can get it restricted. Use
  an account you can afford to lose.
- Cold outreach to people who did not opt in is regulated. CAN-SPAM applies in
  the US; GDPR applies to recipients in the EU, where an inferred business
  address is still personal data. Know which applies to you before running
  this at volume.

## Layout

```
src/
  config.js            caps, pacing, jitter, circuit breakers
  db/                  SQLite schema and access — all dedupe lives here
  adapters/
    unipile.js         LinkedIn search + invitations
    jobright.js        email resolution
    resolver.js        backfill until target, pattern fallback
  invites/sender.js    invitations, weekly/daily quota, acceptance tracking
  mailer/
    credentials.js     SMTP credential loading
    sender.js          sending, pooling, rate limiting
  templates/
    index.js           email and invitation copy
    fit.js             JD-to-experience matching
  roles/reqid.js       requisition id extraction per ATS
  mcp/server.js        MCP tool surface
  scraper/             CSV import, X-ray search
```
