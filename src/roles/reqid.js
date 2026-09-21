/**
 * Requisition id extraction from a posting URL.
 *
 * Outreach quotes the employer's own req id, not the application
 * tool's internal id: a hiring manager can paste "JR360326" into their
 * ATS and find the posting, whereas a tsenta application uuid means
 * nothing to them.
 *
 * Patterns below are taken from the ATS hosts actually seen in this
 * account's applications — Workday, Greenhouse, Ashby, Gem, Oracle
 * Cloud, SmartRecruiters, Lever, Paylocity, JazzHR, CareerPlug,
 * Workable, Teamtailor, Recruitee — rather than guessed. Each is
 * anchored so a match is the id and not an incidental number in the
 * slug.
 */

/**
 * Ordered matchers. First hit wins, so more specific hosts come before
 * generic fallbacks.
 */
const PATTERNS = [
  // Workday: .../job/location/title_JR360326  or  _R-552378
  { ats: 'workday', re: /_((?:JR|R)-?\d{4,})(?:\/|\?|$)/i },

  // Greenhouse: /jobs/8198219, or ?gh_jid=5429313008
  { ats: 'greenhouse', re: /[?&]gh_jid=(\d{5,})/i },
  { ats: 'greenhouse', re: /greenhouse\.io\/[^/]+\/jobs\/(\d{5,})/i },
  { ats: 'greenhouse', re: /job-boards[^/]*\.greenhouse\.io\/[^/]+\/jobs\/(\d{5,})/i },

  // Oracle Cloud: /job/27044
  { ats: 'oraclecloud', re: /oraclecloud\.com\/.*\/job\/(\d{3,})/i },

  // SmartRecruiters: /744000150494699-senior-manager-...
  { ats: 'smartrecruiters', re: /smartrecruiters\.com\/[^/]+\/(\d{9,})/i },

  // Ashby: a uuid path segment
  { ats: 'ashby', re: /ashbyhq\.com\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i },

  // Lever: uuid
  { ats: 'lever', re: /lever\.co\/[^/]+\/([0-9a-f-]{20,})/i },

  // Paylocity: /Details/4519810/
  { ats: 'paylocity', re: /recruiting\/jobs\/Details\/(\d{5,})/i },

  // Workable: /j/6099F3857A
  { ats: 'workable', re: /workable\.com\/(?:[^/]+\/)?j\/([A-Z0-9]{8,})/i },

  // JazzHR: /apply/RG6Bb3LYZx/
  { ats: 'jazzhr', re: /applytojob\.com\/apply\/([A-Za-z0-9]{8,})/i },

  // CareerPlug: /jobs/3603684/
  { ats: 'careerplug', re: /careerplug\.com\/jobs\/(\d{5,})/i },

  // Teamtailor: /jobs/8392132-ai-engineer
  { ats: 'teamtailor', re: /teamtailor\.com\/jobs\/(\d{5,})/i },

  // Gem: base64-ish opaque token
  { ats: 'gem', re: /jobs\.gem\.com\/[^/]+\/([A-Za-z0-9_-]{16,})/i },

  // Recruitee / generic slug-based boards have no numeric id; handled
  // by the fallback below.
];

// Last resort: a long digit run in the final path segment. Deliberately
// conservative — a short number is usually pagination or a slug word,
// and quoting a wrong req id is worse than quoting none.
const FALLBACK = /\/(\d{6,})(?:\/|\?|$)/;

/**
 * Pull the requisition id out of a posting URL.
 *
 * Returns { reqId, ats } with reqId null when nothing confident is
 * found — callers should omit the id rather than guess.
 */
export function extractReqId(url) {
  if (!url) return { reqId: null, ats: null };
  const s = String(url);

  for (const { ats, re } of PATTERNS) {
    const m = s.match(re);
    if (m?.[1]) {
      // Workday ids are conventionally written uppercase; opaque
      // tokens keep their original case.
      const raw = m[1];
      const reqId = ats === 'workday' ? raw.toUpperCase() : raw;
      return { reqId, ats };
    }
  }

  const f = s.match(FALLBACK);
  if (f?.[1]) return { reqId: f[1], ats: null };

  return { reqId: null, ats: null };
}

/**
 * How to refer to a posting in outreach.
 *
 * Prefers a short, quotable id. Long opaque tokens (Ashby/Gem uuids)
 * are omitted from copy — pasting a 36-character uuid into an email
 * reads as machine-generated and helps nobody.
 */
export function quotableReqId(reqId) {
  if (!reqId) return null;
  if (reqId.length > 14) return null;
  return reqId;
}
