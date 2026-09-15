import { getLoopClient } from './supabase.js';
import { log, warn } from '../log.js';

// Prompt loader for the `gap_check` slot (Juju's loader, adapted).
//
// Contract query:
//   select prompt_text, model, version from prompts
//   where slot_id = $1 and is_active = true limit 1
//
// In-memory Map cache with a 60 s TTL, so editing the prompt in the admin app
// propagates within about a minute with no redeploy. On a fetch error, serve
// the stale cache if there is one and throw only when there is nothing to
// serve: a run that used last minute's prompt is a run; a run with no prompt
// at all is not. The loader never writes to `prompts`.
//
// `version` rides along so every candidate row records which prompt produced
// it. Activating a new version silently rewrites the meaning of every earlier
// row, and a confidence trend read across an unrecorded prompt swap is two
// populations read as one. It is a TEXT column: never coerce it to a number,
// and never invent '1.0.0' for a row that stores null.

const DEFAULT_TTL_MS = 60_000;

// "The database could not answer" and "the database answered: there is no
// active prompt" are different failures and only the first one deserves the
// stale cache. Someone deactivating a row is a deliberate act, and serving the
// old text from cache forever would quietly override them.
class NoActivePromptError extends Error {}

export function createPromptLoader({ client, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS }) {
  const cache = new Map(); // slotId -> { text, model, version, fetchedAt }

  async function getActivePrompt(slotId) {
    const cached = cache.get(slotId);
    if (cached && now() - cached.fetchedAt < ttlMs) {
      return { text: cached.text, model: cached.model, version: cached.version };
    }

    try {
      const { data, error } = await client
        .from('prompts')
        .select('prompt_text, model, version')
        .eq('slot_id', slotId)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!data) throw new NoActivePromptError(`No active prompt for slot_id='${slotId}'`);

      const entry = {
        text: data.prompt_text,
        model: data.model,
        version: data.version ?? null,
        fetchedAt: now(),
      };
      cache.set(slotId, entry);
      log(
        'prompts',
        `fetched '${slotId}' (${entry.text.length} chars, model=${entry.model}, version=${entry.version ?? 'null'})`
      );
      return { text: entry.text, model: entry.model, version: entry.version };
    } catch (err) {
      if (err instanceof NoActivePromptError) {
        // Drop the entry too, so a fetch error on the next call cannot
        // resurrect a prompt that was deliberately deactivated.
        cache.delete(slotId);
        throw err;
      }
      if (cached) {
        warn('prompts', `fetch failed for '${slotId}', serving stale cache: ${err.message}`);
        return { text: cached.text, model: cached.model, version: cached.version };
      }
      throw err;
    }
  }

  return { getActivePrompt };
}

let defaultLoader = null;

export function getActivePrompt(slotId) {
  if (!defaultLoader) {
    defaultLoader = createPromptLoader({ client: getLoopClient() });
  }
  return defaultLoader.getActivePrompt(slotId);
}
