import { createClient } from '@supabase/supabase-js';
import { supabaseUrl, supabaseServiceRoleKey } from '../config/env.js';

// The loop's own Supabase project. Service-role key, because every write here
// is server-side and there is no end user to scope rows to.
//
// Two entry points, for the same reason env.js has two: `createLoopClient`
// takes its credentials as an argument so a test or a script can build a
// client without touching module state, and `getLoopClient` builds the process
// singleton lazily. Lazily matters: creating it at import time would make
// importing any db module a hard dependency on a full, valid environment.

export function createLoopClient(config) {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

let singleton = null;

export function getLoopClient() {
  if (!singleton) {
    singleton = createLoopClient({ supabaseUrl, supabaseServiceRoleKey });
  }
  return singleton;
}
