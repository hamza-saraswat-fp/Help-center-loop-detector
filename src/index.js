// Force synchronous stdout/stderr writes so Railway actually sees our logs.
// Without this, Node block-buffers stdout when it's piped, and short log
// bursts near the end of a cron run can sit invisible for minutes.
if (process.stdout._handle?.setBlocking) process.stdout._handle.setBlocking(true);
if (process.stderr._handle?.setBlocking) process.stderr._handle.setBlocking(true);

import { parseArgs } from './args.js';
import { run } from './run.js';
import { log, error } from './log.js';

const args = parseArgs(process.argv.slice(2));

run(args)
  .then((result) => {
    log('index', 'run complete', result.stats);
    process.exitCode = result.exitCode;
  })
  .catch((err) => {
    error('index', 'run failed', { message: err.message });
    process.exitCode = 1;
  });
