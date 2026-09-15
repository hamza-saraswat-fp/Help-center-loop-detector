// Pure CLI flag parsing, kept separate from src/index.js so it can be
// unit-tested without touching src/config/env.js (which validates the real
// process.env on import).
//
// Supported flags:
//   --dry-run            boolean
//   --source=<name>      repeatable, and/or a comma list; collected into an array
//   --since=<ISO>         raw string, caller parses/validates
//   --limit=<int>         parsed with parseInt
//   --skip-poll           boolean

export function parseArgs(argv) {
  const args = {
    dryRun: false,
    source: [],
    since: null,
    limit: null,
    skipPoll: false,
  };

  for (const raw of argv) {
    if (raw === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (raw === '--skip-poll') {
      args.skipPoll = true;
      continue;
    }

    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const flag = raw.slice(0, eq);
    const value = raw.slice(eq + 1);

    if (flag === '--source') {
      args.source.push(
        ...value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
      continue;
    }
    if (flag === '--since') {
      args.since = value;
      continue;
    }
    if (flag === '--limit') {
      args.limit = Number.parseInt(value, 10);
      continue;
    }
  }

  return args;
}
