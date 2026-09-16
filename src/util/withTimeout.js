// One deadline helper, shared by every lane that talks to a client with no
// AbortSignal support (the Slack WebClient, the Mintlify MCP SDK). Global
// Constraints give each stage its own budget and no retries inside a run, so
// what this needs to do is exactly one thing: lose the race loudly.

/**
 * Race `promise` against a timeout. The timer is always cleared, whichever
 * side wins, so it never keeps the process alive past the work. Note that the
 * underlying call is not cancelled, only abandoned.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @returns {Promise<T>} rejects with `timed out after <timeoutMs>ms`
 */
export function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
