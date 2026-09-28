import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPlaceholderQuestion, loadPlaceholderPrompts, normalizePrompt } from '../src/prefilter/placeholder.js';

const PROMPTS = ['how should i respond to this', 'draft the case wrap up'];

test('a known prompt matches whatever its case, punctuation or leading tag', () => {
  for (const text of [
    'How should I respond to this?',
    'how should i respond to this',
    '  HOW SHOULD I RESPOND TO THIS ?!  ',
    '[conversation context attached] How should I respond to this?',
    '[conversation context attached] [pulled] How should I respond to this?',
    'Draft the case wrap-up',
    'Draft the case wrap up.',
  ]) {
    assert.equal(isPlaceholderQuestion(text, PROMPTS), true, text);
  }
});

test('a real question that starts with, or contains, a prompt is not a placeholder', () => {
  for (const text of [
    'How should I respond to this customer asking for a refund on a cancelled job?',
    'How should I respond to this? They want to know if purchase orders show on the portal.',
    'Draft the case wrap-up for a duplicate timesheet entry',
    'The rep asked: how should I respond to this',
  ]) {
    assert.equal(isPlaceholderQuestion(text, PROMPTS), false, text);
  }
});

test('one or two content words is a real question, however short', () => {
  // All three reached the check and turned out to be real gaps.
  for (const text of ['Android', 'what does classic mean?', 'why do "-1" on invoices?']) {
    assert.equal(isPlaceholderQuestion(text, PROMPTS), false, text);
  }
});

test('the summary that replaces a placeholder is a real question', () => {
  const summary =
    '**Summary:** The user asked how to add a custom shortcut button for photos directly to a job screen. ' +
    'The assistant found no documentation covering this feature request.';
  assert.equal(isPlaceholderQuestion(summary, PROMPTS), false);
});

test('no content words at all is a placeholder', () => {
  // Every one of these fingerprints to the same empty term list, so they
  // would all collapse into a single candidate per category.
  for (const text of ['How do I do this?', 'what is it', '??', '', null, undefined, '[conversation context attached]']) {
    assert.equal(isPlaceholderQuestion(text, PROMPTS), true, JSON.stringify(text));
  }
});

test('normalizePrompt reduces both sides of the comparison to the same form', () => {
  assert.equal(normalizePrompt('[tag] Draft the  case   Wrap-Up!'), 'draft the case wrap up');
  assert.equal(normalizePrompt('A question [with a tag in the middle]'), 'a question with a tag in the middle');
});

test('loadPlaceholderPrompts loads the seed prompts, already normalized', () => {
  const prompts = loadPlaceholderPrompts();
  assert.ok(prompts.includes('how should i respond to this'));
  assert.ok(prompts.includes('draft the case wrap up'));
  for (const prompt of prompts) assert.equal(prompt, normalizePrompt(prompt));
});

test('with no list given, the config file is the list', () => {
  assert.equal(isPlaceholderQuestion('How should I respond to this?'), true);
  assert.equal(isPlaceholderQuestion('Does Tap to Pay work on iPads?'), false);
});
