#!/usr/bin/env node
// Render a prompt seed migration from the prompt text file.
//
//   node scripts/render-prompt-seed.js <slot> <version> <model> <description>
//
// The text file under prompts/ is the source of truth; the migration is
// generated from it and committed, so a code review sees the prompt as a diff
// of English rather than as a diff of one enormous SQL literal. Regenerate and
// re-commit after every edit to the text: test/prompt-seed.test.js fails if the
// committed SQL is not exactly what this script produces.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Dollar quoting, so the prompt needs no escaping at all. The tag must not
// appear in the text or the literal would end early and the rest would be
// parsed as SQL.
const TAG = '$p$';

function usage(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write('usage: render-prompt-seed.js <slot> <version> <model> <description>\n');
  process.exit(1);
}

const [slot, version, model, description] = process.argv.slice(2);
if (!slot || !version || !model || !description) {
  usage('render-prompt-seed.js: four arguments are required');
}

const fileName = `${slot}_v${version.replaceAll('.', '_')}.txt`;
const promptPath = fileURLToPath(new URL(`../prompts/${fileName}`, import.meta.url));

let text;
try {
  text = readFileSync(promptPath, 'utf8');
} catch (err) {
  usage(`render-prompt-seed.js: cannot read prompts/${fileName}: ${err.message}`);
}

if (text.includes(TAG)) {
  usage(`render-prompt-seed.js: prompts/${fileName} contains the dollar tag ${TAG}`);
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const sql = `-- IAI-660 - Seed the \`${slot}\` prompt v${version} (${description}).
--
-- WHY. The model that runs the check is chosen by the row in \`prompts\`, never
-- by code, and the rubric it follows is that row's text. Seeding it here is
-- what makes the check runnable and what makes a later prompt edit a versioned,
-- reviewable event instead of a silent change of meaning under every historical
-- candidate row.
--
-- Idempotent in the way that matters: save_prompt_version deactivates the
-- current active row for this slot and inserts a fresh active one. Re-running
-- it creates a duplicate (slot_id, version) and is rejected by the unique
-- constraint, which is the intended outcome; bump the version instead.
--
-- GENERATED from prompts/${fileName}, which is the source of truth. Do not edit
-- the prompt text below by hand. Edit the text file and regenerate, keeping the
-- number this file already has:
--   node scripts/render-prompt-seed.js ${slot} ${version} ${model} '${description}' > migrations/NNNN_seed_${slot}_v${version.replaceAll('.', '_')}.sql
--
-- DEPLOY ORDER: after 0001_loop_schema.sql, and before the first non-dry_run
-- run. Code order does not matter: the loader caches for 60 s, so activating a
-- version reaches a running service within a minute with no redeploy.
--
-- \`version\` is TEXT. It is the literal string '${version}', never a computed
-- max plus one.
--
-- Verify after applying (chars must be ${text.length}):
--   select slot_id, version, model, is_active, length(prompt_text) as chars
--     from prompts where slot_id = ${sqlString(slot)};

select save_prompt_version(
  ${sqlString(slot)},
  ${sqlString(version)},
  ${TAG}${text}${TAG},
  ${sqlString(model)},
  ${sqlString(description)}
);
`;

process.stdout.write(sql);
