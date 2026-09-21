#!/usr/bin/env node
import { migrate, db } from '../src/db/index.js';
import { config } from '../src/config.js';

migrate();

const tables = db()
  .prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`
  )
  .all()
  .map((r) => r.name);

console.log(`\n\x1b[38;2;255;102;0m▍\x1b[0m Forge database ready`);
console.log(`  ${config.dbPath}\n`);
console.log(`  tables: ${tables.join(', ')}\n`);
console.log(`  dry run: ${config.safety.dryRun ? '\x1b[38;2;255;102;0mON\x1b[0m (nothing will send)' : 'OFF — live sending'}`);
console.log(`  daily cap: ${config.mail.pacing.dailyCap}`);
console.log(`  per company: ${config.contacts.maxPerCompany}\n`);
