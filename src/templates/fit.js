/**
 * "Why I'm a fit" paragraph.
 *
 * The weakest thing a cold email can do is assert a fit in the
 * abstract ("I'm passionate about solving complex challenges"). What
 * earns a reply is a specific overlap the reader can check: the JD
 * asks for X, and here is where the sender has done X.
 *
 * So this matches the job description against a fixed inventory of
 * evidence drawn from the resume profile. Every claim below traces to
 * something on the resume — nothing is invented, and a JD requirement
 * with no matching evidence produces no sentence rather than a vague
 * one. If nothing matches, the caller gets null and the email falls
 * back to the general background paragraph.
 */

/**
 * Evidence inventory.
 *
 * Each entry pairs JD signals with a concrete claim. `claim` is written
 * to slot into "..., I've <claim>." and must stay factual: these are
 * assertions made to a hiring manager who may check them in interview.
 */
const EVIDENCE = [
  {
    key: 'agent_framework',
    signals: [
      'agent framework', 'agent runtime', 'agentic', 'ai agent', 'agent platform',
      'multi-step', 'orchestrat', 'tool calling', 'function calling', 'skills ecosystem',
    ],
    claim:
      'designed an agent framework that hosts specialized capabilities and orchestrates multi-step subtasks, with versioned skill contracts other teams build on',
    weight: 3,
  },
  {
    key: 'eval_infra',
    signals: [
      'evaluation infrastructure', 'eval', 'non deterministic', 'non-deterministic',
      'regression', 'agent quality', 'llm evaluation', 'observability',
    ],
    claim:
      'built evaluation infrastructure for non-deterministic output — tracing every request end to end and scoring new versions against known-good examples before release, so regressions get caught rather than shipped',
    weight: 3,
  },
  {
    key: 'retrieval',
    signals: [
      'semantic search', 'retrieval', 'rag', 'vector', 'embedding', 'hybrid search',
      'structured quer', 'catalog', 'reranking',
    ],
    claim:
      'built hybrid retrieval that combines lexical and semantic matching with reranking, which surfaced the right passage on queries plain keyword search kept missing',
    weight: 2,
  },
  {
    key: 'api_design',
    signals: [
      'api design', 'versioning', 'composab', 'platform', 'many teams', 'contract',
      'sdk', 'public api', 'internal platform',
    ],
    claim:
      'migrated purpose-built automation into composable, versioned APIs that other teams built on top of',
    weight: 2,
  },
  {
    key: 'distributed_scale',
    signals: [
      'distributed', 'large scale', 'high scale', 'scalab', 'billions', 'high throughput',
      'microservice', 'event-driven', 'event driven',
    ],
    claim:
      'run Node.js and Python services behind core payment workflows on a platform handling billions of requests at 99.99% uptime',
    weight: 3,
  },
  {
    key: 'fintech_compliance',
    signals: [
      'financial', 'fintech', 'payment', 'banking', 'compliance', 'audit', 'regulated',
      'pci', 'transaction', 'stablecoin', 'ledger',
    ],
    claim:
      'spent three years on payments systems at Deloitte for PayPal, where transaction safety, audit trails and compliance were design constraints from the first review rather than afterthoughts',
    weight: 3,
  },
  {
    key: 'ai_dev_tools',
    signals: [
      'claude code', 'github copilot', 'cursor', 'codex', 'ai-first', 'ai first',
      'ai-assisted', 'ai assisted', 'prompt engineering', 'ai tools',
    ],
    claim:
      'worked AI-first day to day with Claude Code, Copilot and Cursor across the lifecycle, writing the structured prompts, system context and guardrails that keep agent behaviour predictable',
    weight: 2,
  },
  {
    key: 'reliability',
    signals: [
      'reliability', 'resilien', 'uptime', 'sre', 'incident', 'backpressure',
      'rate limit', 'idempot', 'circuit breaker', 'retry',
    ],
    claim:
      'kept systems dependable under load with backpressure, idempotency and retry handling, so failures degraded one feature instead of taking a service down',
    weight: 2,
  },
  {
    key: 'founding_zero_to_one',
    signals: [
      'founding', 'zero to one', '0 to 1', 'first engineer', 'early stage', 'greenfield',
      'from scratch', 'ambigu', 'startup',
    ],
    claim:
      'shipped a company’s first customer-facing product as its first engineer, taking an unclear business problem to production from an empty repository',
    weight: 2,
  },
  {
    key: 'mentorship_leadership',
    signals: [
      'mentor', 'lead', 'coach', 'design review', 'tech lead', 'manage', 'people',
      'hiring', 'team growth',
    ],
    claim:
      'led technically across a distributed team, mentoring engineers and running design reviews, and set the review and release standards later hires inherited',
    weight: 1,
  },
];

/** Tokens that indicate a stack match worth naming explicitly. */
const STACK = {
  'Node.js': ['node.js', 'nodejs', 'node '],
  TypeScript: ['typescript'],
  Python: ['python'],
  PostgreSQL: ['postgres', 'postgresql'],
  Redis: ['redis'],
  Kubernetes: ['kubernetes', 'k8s'],
  AWS: ['aws', 'amazon web services'],
  GCP: ['gcp', 'google cloud'],
  GraphQL: ['graphql'],
  Java: ['java '],
};

/**
 * Rank evidence by how strongly the JD asks for it.
 *
 * Signals are counted rather than merely detected: a JD that mentions
 * evaluation four times is asking for it more loudly than one that
 * mentions it once, and the strongest two or three matches are what
 * belong in a short email.
 */
export function matchEvidence(jdText, { max = 3 } = {}) {
  if (!jdText) return [];
  const low = String(jdText).toLowerCase();

  const scored = EVIDENCE.map((e) => {
    let hits = 0;
    for (const sig of e.signals) {
      // Count occurrences, not just presence.
      let idx = low.indexOf(sig);
      while (idx !== -1) {
        hits += 1;
        idx = low.indexOf(sig, idx + sig.length);
      }
    }
    return { ...e, hits, score: hits * e.weight };
  })
    .filter((e) => e.hits > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, max);
}

/** Stack overlap between the JD and the profile. */
export function matchStack(jdText, { max = 4 } = {}) {
  if (!jdText) return [];
  const low = String(jdText).toLowerCase();
  const out = [];
  for (const [label, tokens] of Object.entries(STACK)) {
    if (tokens.some((t) => low.includes(t))) out.push(label);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Compose the fit paragraph.
 *
 * Returns null when the JD yields no matches — better to send the
 * general background paragraph than a fit claim with nothing behind
 * it. `variant` shapes the framing: a recruiter is being asked to pass
 * a profile along, a hiring manager to consider a candidate for their
 * own team.
 */
export function fitParagraph({ jdText, roleTitle, variant = 'hiring_manager' }) {
  const evidence = matchEvidence(jdText);
  if (evidence.length === 0) return null;

  const stack = matchStack(jdText);

  const opener =
    {
      hiring_manager: roleTitle
        ? `The reason I think this one is worth your time: the ${roleTitle} description lines up closely with what I have actually built.`
        : 'The reason I think this one is worth your time: the description lines up closely with what I have actually built.',
      recruiter:
        'In case it helps you place me against the requirements, the overlap is fairly direct:',
      leader:
        'Briefly, on why I think there is a fit:',
      peer: 'For context on where I would slot in:',
    }[variant] ?? 'On why I think there is a fit:';

  // Claims as a list rather than a run-on sentence: a reader skimming
  // on a phone should be able to take in three items at a glance.
  const claims = evidence.map((e) => e.claim);

  const stackLine =
    stack.length > 1
      ? `Day-to-day stack overlap is close too — ${stack.slice(0, -1).join(', ')} and ${stack[stack.length - 1]}.`
      : stack.length === 1
        ? `Day-to-day stack overlap is close too, ${stack[0]} in particular.`
        : null;

  return { opener, claims, stackLine, matched: evidence.map((e) => e.key) };
}

/** Plain-text rendering. */
export function fitText(fit) {
  if (!fit) return null;
  const bullets = fit.claims.map((c) => `  - I've ${c}.`).join('\n');
  return [fit.opener, '', bullets, fit.stackLine ? `\n${fit.stackLine}` : '']
    .filter(Boolean)
    .join('\n');
}

/** HTML rendering. */
export function fitHtml(fit, esc) {
  if (!fit) return '';
  const items = fit.claims.map((c) => `    <li>I&rsquo;ve ${esc(c)}.</li>`).join('\n');
  return `  <p>${esc(fit.opener)}</p>
  <ul style="margin:0 0 16px 0;padding-left:20px;">
${items}
  </ul>
${fit.stackLine ? `  <p>${esc(fit.stackLine)}</p>` : ''}`;
}
