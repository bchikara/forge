#!/usr/bin/env node
/**
 * Fill job descriptions that tsenta's scraper cannot reach.
 *
 * tsenta handles static boards and errors on Workday and Oracle Cloud,
 * which render client side — 29 of the 32 roles missing text. This
 * drives the Patchright fetcher for those and writes the result back.
 *
 * Roles whose posting has closed are marked rather than retried
 * forever: a closed requisition is a fact about the world, not a
 * transient failure, and outreach should stop referencing it.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FETCHER = path.join(ROOT, 'src', 'scraper', 'spa_jd.py');

const ORANGE = '\x1b[38;2;255;102;0m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// Only the ATSes tsenta cannot render. Anything else it already handles,
// and going around it would be slower for no gain.
const SPA_ATS = new Set(['workday', 'oraclecloud', 'brassring']);

const limit = Number(process.argv[2]) || 50;

const roles = db()
  .prepare(
    `SELECT r.id, r.url, r.title, r.ats_type, c.name AS company
       FROM roles r JOIN companies c ON c.id = r.company_id
      WHERE length(COALESCE(r.jd_text, '')) < 200
        AND r.is_open = 1
      ORDER BY r.applied_at DESC
      LIMIT ?`
  )
  .all(limit)
  .filter((r) => SPA_ATS.has(r.ats_type ?? '') || !r.ats_type);

console.log(`${ORANGE}▍${RESET} ${roles.length} roles to fetch\n`);

let saved = 0;
let expired = 0;
let failed = 0;

for (const [i, role] of roles.entries()) {
  const label = `${String(i + 1).padStart(2)}/${roles.length} ${role.company.slice(0, 22).padEnd(22)}`;

  const res = spawnSync('python3', [FETCHER, role.url, '--timeout', '45000'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  let out;
  try {
    out = JSON.parse(res.stdout.trim().split('\n').pop());
  } catch {
    failed += 1;
    console.log(`${label} ${DIM}unparseable output${RESET}`);
    continue;
  }

  if (out.status === 'success') {
    db().prepare('UPDATE roles SET jd_text = ? WHERE id = ?').run(out.jobDescription, role.id);
    saved += 1;
    console.log(`${label} ${ORANGE}saved${RESET} ${out.chars} chars`);
  } else if (out.status === 'expired') {
    // Close it rather than leaving it to be retried every run and to
    // appear in outreach as a live opening.
    db().prepare('UPDATE roles SET is_open = 0 WHERE id = ?').run(role.id);
    expired += 1;
    console.log(`${label} ${DIM}closed — marked not open${RESET}`);
  } else {
    failed += 1;
    console.log(`${label} ${DIM}failed: ${(out.error ?? '').slice(0, 60)}${RESET}`);
  }
}

const total = db().prepare('SELECT COUNT(*) n FROM roles').get().n;
const withJd = db()
  .prepare(`SELECT COUNT(*) n FROM roles WHERE length(COALESCE(jd_text,'')) >= 200`)
  .get().n;

console.log(
  `\n${ORANGE}▍${RESET} saved ${saved} · closed ${expired} · failed ${failed}` +
    `\n  coverage ${withJd}/${total} (${Math.round((withJd / total) * 100)}%)`
);
