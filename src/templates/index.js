/**
 * Outreach copy.
 *
 * Carried over from job-outreach-cli's templates.py — same voice, same
 * structure, same unsubscribe footer — with four changes:
 *
 *   1. The role is named. The original never mentioned which job the
 *      person was writing about, which is the strongest signal
 *      available: a hiring manager who owns the req cares that you
 *      applied to it. Multiple open roles at one company are listed in
 *      a single email rather than generating one email per role.
 *   2. Corrected details. The original said "5+ years" and signed off
 *      "Vipul Chikara"; the profile of record says 7+ years and
 *      Bhupesh Chikara. A factual error in a first impression is worse
 *      than a plain sentence.
 *   3. The duplicated Deloitte paragraph is gone.
 *   4. Tier-specific framing. What a hiring manager needs to read is
 *      not what a recruiter needs to read.
 *
 * Every template takes substitutions explicitly. Nothing is inferred
 * or embellished: the claims here all trace to the resume profile.
 */

import { config } from '../config.js';
import { fitParagraph, fitText, fitHtml } from './fit.js';
import { quotableReqId } from '../roles/reqid.js';

/** Sender facts, from the resume profile of record. */
export const SENDER = {
  name: 'Bhupesh Chikara',
  title: 'Backend & Platform Engineer',
  yearsExperience: '7+',
  email: 'bhupeshchikara@gmail.com',
  website: 'https://builtbychikara.dev',
  portfolio: 'https://builtbychikara.dev/projects',
  linkedin: 'https://linkedin.com/in/bchikara/',
  github: 'https://github.com/bchikara',
};

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** First name for a greeting, or a neutral fallback. */
export function firstName(fullName) {
  const first = String(fullName ?? '').trim().split(/\s+/)[0];
  // Avoid "Hi Dr." or "Hi The" — better to open without a name than
  // with a wrong one.
  if (!first || first.length < 2 || /^(the|dr|mr|ms|mrs|prof)\.?$/i.test(first)) return null;
  return first;
}

/**
 * Lines naming each role, with the board link and the employer's own
 * requisition id.
 *
 * The req id is the employer's, parsed from the posting URL — it is
 * what a hiring manager can look up in their ATS. The application
 * tool's internal id is deliberately never shown: it means nothing to
 * a recipient. A long opaque token (some boards use uuids) is omitted
 * rather than pasted, since it reads as machine-generated.
 */
export function roleLines(roles) {
  return roles
    .filter((r) => r.title)
    .map((r) => {
      const req = quotableReqId(r.req_id);
      return { title: r.title, url: r.url ?? null, reqId: req };
    });
}

/** "the Senior Backend Engineer role" / "two open roles: A and B". */
function describeRoles(roles) {
  const titles = [...new Set(roles.map((r) => r.title).filter(Boolean))];
  if (titles.length === 0) return null;
  if (titles.length === 1) return `the ${titles[0]} role`;
  if (titles.length === 2) return `the ${titles[0]} and ${titles[1]} roles`;
  return `${titles.length} open roles including ${titles[0]} and ${titles[1]}`;
}

// ---------------------------------------------------------------
// LinkedIn invitation note
// ---------------------------------------------------------------

/**
 * Connection note, hard-capped at LinkedIn's 300 characters.
 *
 * Short by necessity, which is a virtue here: the note only has to
 * earn a connection, not make the whole case. Tier changes the ask —
 * a hiring manager is asked about their team, a recruiter about the
 * pipeline.
 */
export function inviteNote({ contact, company, roles = [] }) {
  const name = firstName(contact.full_name);
  const hi = name ? `Hi ${name}` : 'Hello';
  const roleText = describeRoles(roles);

  const asks = {
    hiring_manager: roleText
      ? `I applied to ${roleText} at ${company.name} and would love to connect with someone on the team.`
      : `I'm exploring backend and platform roles at ${company.name} and would love to connect.`,
    recruiter: roleText
      ? `I applied to ${roleText} at ${company.name} — would be glad to connect and share more context.`
      : `I'm interested in engineering roles at ${company.name} and would be glad to connect.`,
    leader: roleText
      ? `I applied to ${roleText} at ${company.name}. Would be great to connect.`
      : `I admire what ${company.name} is building and would be great to connect.`,
    peer: `I applied to ${roleText ?? `a role at ${company.name}`} and would love to connect with engineers on the team.`,
  };

  const ask = asks[contact.tier] ?? asks.leader;
  const sig = `${SENDER.yearsExperience} yrs backend/platform (Node, Python, AI systems).`;

  let note = `${hi} — ${ask} ${sig}`;

  // Trim to LinkedIn's limit at a sentence boundary rather than
  // mid-word, so a truncated note still reads as written.
  const MAX = 300;
  if (note.length > MAX) {
    note = `${hi} — ${ask}`;
    if (note.length > MAX) {
      const cut = note.slice(0, MAX - 1);
      const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' — '));
      note = lastStop > 60 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
    }
  }

  return note;
}

// ---------------------------------------------------------------
// Email
// ---------------------------------------------------------------

export function emailSubject({ company, roles = [] }) {
  const titles = [...new Set(roles.map((r) => r.title).filter(Boolean))];
  if (titles.length === 1) return `${titles[0]} — application from ${SENDER.name}`;
  if (titles.length > 1) return `Engineering roles at ${company.name} — ${SENDER.name}`;
  return `Opportunity to connect — ${company.name}`;
}

/**
 * Plain-text body.
 *
 * Sent alongside the HTML part. Some clients show it, and spam filters
 * weight a message with no text alternative more harshly.
 */
export function emailText({ contact, company, roles = [] }) {
  const name = firstName(contact.full_name);
  const roleText = describeRoles(roles);
  const appliedLine = roleText
    ? `I recently applied to ${roleText} at ${company.name}, and wanted to reach out directly.`
    : `I've been following ${company.name} and wanted to reach out directly.`;

  const tierLine =
    {
      hiring_manager:
        'If you own any of this hiring, I would welcome the chance to talk about what your team is working on.',
      recruiter:
        'If it would help, I am happy to walk through my background or point you to the work most relevant to the role.',
      leader:
        'If there is a fit anywhere on your engineering org, I would welcome a short conversation.',
      peer: 'If you have a few minutes, I would value hearing what engineering is actually like on your team.',
    }[contact.tier] ??
    'I would welcome a short conversation if there is a fit.';

  // Each role with its board link and requisition id, so the reader
  // can open the exact posting rather than search for it.
  const lines = roleLines(roles);
  const roleBlock = lines.length
    ? lines
        .map((l) =>
          [
            `  ${l.title}`,
            l.reqId ? `  Req ${l.reqId}` : null,
            l.url ? `  ${l.url}` : null,
          ]
            .filter(Boolean)
            .join('\n')
        )
        .join('\n\n')
    : null;

  // Concrete JD-to-experience overlap, when the JD supports it.
  const jd = roles.map((r) => r.jd_text).filter(Boolean).join('\n');
  const fit = fitParagraph({
    jdText: jd,
    roleTitle: lines.length === 1 ? lines[0].title : null,
    variant: contact.tier,
  });
  const fitBlock = fitText(fit);

  return [
    name ? `Hi ${name},` : 'Hello,',
    '',
    appliedLine,
    '',
    roleBlock,
    roleBlock ? '' : null,
    `I am a backend and platform engineer with ${SENDER.yearsExperience} years building the services and data pipelines products run on, in Node.js, TypeScript and Python. Three of those years were on financial-services systems at Deloitte for PayPal, where audit trails, transaction safety and uptime were design constraints rather than afterthoughts.`,
    '',
    fitBlock,
    fitBlock ? '' : null,
    tierLine,
    '',
    `Work samples: ${SENDER.portfolio}`,
    '',
    'Thanks for your time,',
    SENDER.name,
    SENDER.title,
    SENDER.email,
    SENDER.linkedin,
    '',
    '---',
    config.safety.unsubscribeText,
    config.safety.senderPostalAddress || '',
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** HTML body. Structure and styling follow the original template. */
export function emailHtml({ contact, company, roles = [] }) {
  const name = firstName(contact.full_name);
  const roleText = describeRoles(roles);

  const appliedLine = roleText
    ? `I recently applied to <strong>${esc(roleText)}</strong> at <strong>${esc(company.name)}</strong>, and wanted to reach out directly.`
    : `I've been following <strong>${esc(company.name)}</strong> and wanted to reach out directly.`;

  const tierLine =
    {
      hiring_manager:
        'If you own any of this hiring, I would welcome the chance to talk about what your team is working on.',
      recruiter:
        'If it would help, I am happy to walk through my background or point you to the work most relevant to the role.',
      leader:
        'If there is a fit anywhere on your engineering org, I would welcome a short conversation.',
      peer: 'If you have a few minutes, I would value hearing what engineering is actually like on your team.',
    }[contact.tier] ?? 'I would welcome a short conversation if there is a fit.';

  // Role cards: title, the employer's requisition id, and a direct
  // link to the posting on the board it was applied through.
  const lines = roleLines(roles);
  const roleBlock = lines.length
    ? `  <div style="margin:16px 0;padding:12px 16px;border-left:3px solid #FF6600;background:#fafafa;">
${lines
  .map(
    (l) => `    <div style="margin:6px 0;">
      <strong>${esc(l.title)}</strong>${l.reqId ? ` <span style="color:#666;font-size:0.9em;">&middot; Req ${esc(l.reqId)}</span>` : ''}
      ${l.url ? `<br><a href="${esc(l.url)}" target="_blank" style="font-size:0.9em;">View posting</a>` : ''}
    </div>`
  )
  .join('\n')}
  </div>`
    : '';

  const jd = roles.map((r) => r.jd_text).filter(Boolean).join('\n');
  const fit = fitParagraph({
    jdText: jd,
    roleTitle: lines.length === 1 ? lines[0].title : null,
    variant: contact.tier,
  });
  const fitBlock = fitHtml(fit, esc);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    a { color: #1a0dab; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body style="font-family:Arial,sans-serif;color:#333;font-size:16px;line-height:1.5;">
  <p>${name ? `Hi ${esc(name)},` : 'Hello,'}</p>

  <p>${appliedLine}</p>

${roleBlock}

  <p>
    I am a backend and platform engineer with <strong>${SENDER.yearsExperience} years</strong>
    building the services and data pipelines products run on, in Node.js, TypeScript and Python.
    Three of those years were on financial-services systems at <strong>Deloitte for PayPal</strong>,
    where audit trails, transaction safety and uptime were design constraints rather than
    afterthoughts.
  </p>

${fitBlock}

  <p>${tierLine}</p>

  <p>
    Work samples: <a href="${SENDER.portfolio}" target="_blank">builtbychikara.dev/projects</a>
  </p>

  <p style="margin-top:30px;">
    Thanks for your time,<br>
    ${esc(SENDER.name)}<br>
    ${esc(SENDER.title)}<br>
    <a href="mailto:${SENDER.email}">${SENDER.email}</a><br>
    <a href="${SENDER.linkedin}" target="_blank">LinkedIn</a>
  </p>

  <p style="font-size:0.85em;color:#999;margin-top:30px;">
    ${esc(config.safety.unsubscribeText)}
    ${config.safety.senderPostalAddress ? `<br>${esc(config.safety.senderPostalAddress)}` : ''}
  </p>
</body>
</html>`;
}

/** Everything needed for one send. */
export function buildEmail({ contact, company, roles = [] }) {
  return {
    subject: emailSubject({ company, roles }),
    body: emailText({ contact, company, roles }),
    html: emailHtml({ contact, company, roles }),
  };
}
