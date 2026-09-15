// The one place that calls a model, via OpenRouter. Global Constraints:
// OpenRouter only, `usage: { include: true }` so cost rides along on the
// response, model name always comes from the active prompt row (never
// hardcoded here), and a per-stage AbortController timeout (90s) with no
// retries inside a run.

import OpenAI from 'openai';

import { openrouterApiKey } from '../config/env.js';
import { addLlmCall } from '../trace.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_TIMEOUT_MS = 90_000;

function defaultClientFactory({ apiKey }) {
  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/hamza-saraswat-fp/Help-center-loop-detector',
      'X-Title': 'Help Center Loop',
    },
  });
}

/**
 * @param {{apiKey: string, clientFactory?: (args: {apiKey: string}) => object, now?: () => Date}} deps
 * @returns {(args: {stage: string, model: string, system: string, user: string,
 *   maxTokens?: number, timeoutMs?: number, temperature?: number}) => Promise<{text: string, usage: object, model: string}>}
 */
export function createModelCaller({ apiKey, clientFactory = defaultClientFactory, now = () => new Date() } = {}) {
  void now; // reserved for future use (e.g. attaching a timestamp to the call record)
  // Built lazily, on first use, rather than here: constructing the module-level
  // `callModel` below must not require a real OPENROUTER_API_KEY at import
  // time (env validation can be skipped in tests, leaving apiKey undefined),
  // and nothing before the first actual call needs a client to exist.
  let client = null;

  return async function callModel({
    stage,
    model,
    system,
    user,
    maxTokens = DEFAULT_MAX_TOKENS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    temperature = 0,
  }) {
    if (!client) client = clientFactory({ apiKey });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let completion;
      try {
        completion = await client.chat.completions.create(
          {
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            max_tokens: maxTokens,
            temperature,
            usage: { include: true },
          },
          { signal: controller.signal },
        );
      } catch (err) {
        if (controller.signal.aborted) {
          const timeoutErr = new Error(`model call to '${model}' timed out after ${timeoutMs}ms`);
          timeoutErr.name = 'ModelTimeout';
          throw timeoutErr;
        }
        throw err;
      }

      const usage = completion.usage ?? null;
      addLlmCall({ stage, model, usage });

      return {
        text: completion.choices?.[0]?.message?.content ?? '',
        usage,
        model,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export const callModel = createModelCaller({ apiKey: openrouterApiKey });
