// Force synchronous stdout/stderr writes so Railway actually sees our logs.
// Without this, Node block-buffers stdout when it's piped, and short log
// bursts near the end of a cron run can sit invisible for minutes.
if (process.stdout._handle?.setBlocking) process.stdout._handle.setBlocking(true);
if (process.stderr._handle?.setBlocking) process.stderr._handle.setBlocking(true);

import { parseArgs } from './args.js';
import { run } from './run.js';
import { log, error } from './log.js';
import { redactSecrets } from './util/redact.js';

// A stray rejection in a settle-adjacent path would otherwise kill the
// process with Node's own warning and no `[lane]` line, which is the one
// thing a Railway log reader greps for. Both handlers record the failure and
// mark the run failed; neither re-throws.
function fatal(what, reason) {
  error('index', `${what}: ${redactSecrets(String(reason?.stack ?? reason?.message ?? reason))}`);
  process.exitCode = 1;
}

process.on('unhandledRejection', (reason) => fatal('unhandled rejection', reason));
process.on('uncaughtException', (err) => fatal('uncaught exception', err));

const args = parseArgs(process.argv.slice(2));

run(args)
  .then((result) => {
    log('index', 'run complete', result.stats);
    process.exitCode = result.exitCode;
  })
  .catch((err) => {
    error('index', 'run failed', { message: redactSecrets(String(err?.message ?? err)) });
    process.exitCode = 1;
  })
  .finally(() => {
    // Explicit, after the last log line: a keep-alive undici socket (Supabase,
    // OpenRouter, GitHub) can hold a cron process open long past the work, and
    // Railway bills the wall clock. stdout and stderr are blocking (top of
    // this file), so everything logged above has already been written.
    process.exit(process.exitCode ?? 0);
  });
