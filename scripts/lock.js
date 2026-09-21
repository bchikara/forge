#!/usr/bin/env node
/**
 * Lock control for the shell runner.
 *
 * The runner cannot hold the lock from inside a node subprocess: that
 * process exits immediately, and a pid-matched release would then free
 * a lock the shell still needs. So the shell passes its own pid and
 * this script acts on its behalf.
 *
 *   lock.js acquire <holder> <pid>   exit 0 taken, 3 already held
 *   lock.js heartbeat <pid>
 *   lock.js release <pid>
 *   lock.js status
 */
import { acquire, release, heartbeat, status, LockBusyError } from '../src/lock/index.js';

const [cmd, a, b] = process.argv.slice(2);

try {
  switch (cmd) {
    case 'acquire': {
      const got = acquire(a ?? 'pass', { pid: Number(b) || process.pid });
      console.log(got.stole ? `ACQUIRED (reclaimed from ${got.previous})` : 'ACQUIRED');
      break;
    }
    case 'heartbeat':
      heartbeat({ pid: Number(a) || process.pid });
      break;
    case 'release':
      console.log(JSON.stringify(release({ pid: Number(a) || process.pid })));
      break;
    case 'status':
      console.log(JSON.stringify(status(), null, 2));
      break;
    default:
      console.error('usage: lock.js acquire <holder> <pid> | heartbeat <pid> | release <pid> | status');
      process.exit(64);
  }
} catch (err) {
  if (err instanceof LockBusyError) {
    console.log(`BUSY ${err.message}`);
    process.exit(3);
  }
  console.error(err.message);
  process.exit(1);
}
