import { execFileSync } from 'node:child_process';

/**
 * What the process needs from its host before a run can succeed: a Node
 * version the Supabase client accepts and a git binary for the docs clone.
 * Pure apart from the injected probe, so it is testable; the caller logs it.
 * @param {{nodeVersion?: string, probeGit?: () => string}} [deps]
 * @returns {{node: string, nodeOk: boolean, git: string|null}}
 */
export function preflight({ nodeVersion = process.version, probeGit = defaultProbeGit } = {}) {
  const major = Number(String(nodeVersion).replace(/^v/, '').split('.')[0]);
  let git = null;
  try {
    git = probeGit();
  } catch {
    git = null;
  }
  return { node: nodeVersion, nodeOk: Number.isFinite(major) && major >= 22, git };
}

function defaultProbeGit() {
  return execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
}

/** One line for the top of every run log. */
export function formatPreflight(p) {
  return `node ${p.node}${p.nodeOk ? '' : ' (below 22)'} git ${p.git ?? 'MISSING'}`;
}
