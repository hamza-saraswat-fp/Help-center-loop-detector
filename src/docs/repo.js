// Sparse, blob-filtered clone of the help docs repo. The repo is 1.4 GB
// (99.6% screenshots); this pulls only the ~2.7 MB of .mdx plus docs.json,
// a few MB in seconds, instead of a full checkout. See Context in the
// implementation plan.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { log } from '../log.js';

/**
 * child_process.execFile wrapped as a Promise with a timeout. Rejects on
 * non-zero exit or timeout.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{stdout: string}>}
 */
export function defaultExec(cmd, args, { cwd, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout: stdout ? stdout.toString() : '' });
    });
  });
}

/** Insert `x-access-token:<token>@` into a GitHub HTTPS URL. Never used
 * for logging — only to build the argv passed to git. */
function buildAuthUrl(repoUrl, token) {
  if (!token) return repoUrl;
  if (!repoUrl.startsWith('https://github.com/')) return repoUrl;
  return repoUrl.replace('https://', `https://x-access-token:${token}@`);
}

/**
 * Recursively collect relative `.mdx` file paths under `dir`.
 * @param {string} dir
 * @returns {string[]} sorted, forward-slash relative paths
 */
export function listMdxFiles(dir) {
  const results = [];

  function walk(currentDir, relBase) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
        results.push(relPath);
      }
    }
  }

  walk(dir, '');
  return results.sort();
}

/**
 * Clone-or-pull the docs repo into `dir` via a sparse, blob-filtered
 * checkout of just `.mdx` files and `docs.json`. Throws on any failure —
 * the run must abort without a usable clone rather than proceed on stale
 * or partial data.
 * @param {string} dir
 * @param {string} repoUrl
 * @param {{timeoutMs?: number, exec?: typeof defaultExec, token?: string}} [opts]
 * @returns {Promise<{dir: string, sha: string}>}
 */
export async function ensureDocsClone(
  dir,
  repoUrl,
  { timeoutMs = 60000, exec = defaultExec, token = '' } = {},
) {
  const authUrl = buildAuthUrl(repoUrl, token);
  const hasClone = fs.existsSync(path.join(dir, '.git'));

  if (!hasClone) {
    log('docs', `clone ${repoUrl} → ${dir}`);
    await exec(
      'git',
      ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--no-checkout', authUrl, dir],
      { timeoutMs },
    );
    await exec(
      'git',
      ['-C', dir, 'sparse-checkout', 'set', '--no-cone', '/*.mdx', '/*/**/*.mdx', '/docs.json'],
      { timeoutMs },
    );
    await exec('git', ['-C', dir, 'checkout'], { timeoutMs });
  } else {
    log('docs', `pull ${dir}`);
    await exec('git', ['-C', dir, 'pull', '--ff-only'], { timeoutMs });
  }

  const { stdout } = await exec('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeoutMs });
  const sha = stdout.trim();

  const fileCount = listMdxFiles(dir).length;
  log('docs', `head ${sha.slice(0, 7)} files=${fileCount}`);

  return { dir, sha };
}
