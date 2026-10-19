'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSettings } = require('../lib/defaults.js');
const {
  makeExtractiveSummary,
  buildPrompt,
  sanitizeReply,
  collapseExactDuplicate,
  estimateTokens,
} = require('../lib/context.js');

const T0 = 1_700_000_000_000;
const settings = normalizeSettings({});

function conv() {
  return {
    id: '9199@c.us',
    name: 'Priya',
    kind: 'contact',
    turns: [
      { role: 'them', text: 'Hey, are we still meeting tomorrow about the launch deck?', ts: T0 },
      { role: 'me', text: 'Yes, 5pm works for me.', ts: T0 + 60_000 },
      { role: 'them', text: 'Great. Can you send the deck before then?', ts: T0 + 120_000 },
    ],
  };
}

test('extractive summary names the contact, topics and open question', () => {
  const s = makeExtractiveSummary(conv());
  assert.match(s, /Priya/);
  assert.match(s, /Topics:/);
  assert.match(s, /deck/i);
  assert.match(s, /Can you send the deck/i);
  assert.ok(s.length < 700);
});

test('extractive summary is empty without incoming turns', () => {
  assert.equal(makeExtractiveSummary({ turns: [] }), '');
  assert.equal(makeExtractiveSummary(null), '');
});

test('delta prompt is much smaller than full and keeps the new message', () => {
  const c = conv();
  const delta = buildPrompt({
    settings,
    conv: c,
    chat: c,
    message: 'Can you also add the budget slide?',
    mode: 'delta',
    summary: '',
    ownerName: 'Aarav',
    turnId: 'r1',
  });
  const full = buildPrompt({
    settings,
    conv: c,
    chat: c,
    message: 'Can you also add the budget slide?',
    mode: 'full',
    summary: makeExtractiveSummary(c),
    ownerName: 'Aarav',
    turnId: 'r1',
  });

  assert.equal(delta.mode, 'delta');
  assert.equal(full.mode, 'full');
  assert.ok(delta.text.includes('[WA2-TURN:r1]'));
  assert.ok(delta.text.includes('budget slide'));
  assert.ok(delta.tokens < full.tokens, `expected delta ${delta.tokens} < full ${full.tokens}`);
  assert.ok(full.text.includes('[CONTEXT]'));
  assert.ok(full.text.includes('Conversation so far:'));
  assert.ok(full.text.includes('Me: Yes, 5pm works for me.'));
  assert.ok(full.text.includes('Aarav'));
});

test('full prompt omits an empty summary without leaving a stray header', () => {
  const c = conv();
  const full = buildPrompt({ settings, conv: c, chat: c, message: 'hi', mode: 'full', summary: '', turnId: 'x' });
  assert.ok(!full.text.includes('[CONTEXT]'));
});

test('provider chat memory is respected: no recent turns in delta', () => {
  const c = conv();
  const delta = buildPrompt({ settings, conv: c, chat: c, message: 'ok', mode: 'delta', summary: '', turnId: 'x' });
  assert.ok(!delta.text.includes('Conversation so far:'));
  assert.ok(!delta.text.includes('Yes, 5pm works for me.'));
});

test('custom prompt template keeps working with placeholders', () => {
  const s = normalizeSettings({ aiPrompt: 'Reply to {{message}} for {{name}} as {{owner}}. Summary: {{summary}}' });
  const c = conv();
  const out = buildPrompt({
    settings: s,
    conv: c,
    chat: c,
    message: 'ping',
    mode: 'full',
    summary: 'a summary',
    ownerName: 'Aarav',
    turnId: 't9',
  });
  assert.equal(out.mode, 'custom');
  assert.ok(out.text.includes('Reply to ping for Priya as Aarav. Summary: a summary'));
});

test('recent turns respect the recentTurns setting', () => {
  const s = normalizeSettings({ recentTurns: 1 });
  const c = conv();
  const full = buildPrompt({ settings: s, conv: c, chat: c, message: 'x', mode: 'full', summary: '', turnId: 'x' });
  assert.ok(full.text.includes('Great. Can you send the deck before then?'));
  assert.ok(!full.text.includes('Yes, 5pm works for me.'));
});

test('sanitizeReply removes markers, labels, fences and wrapping quotes', () => {
  assert.equal(sanitizeReply('[WA2-TURN:req_1]\nReply: "Hello there"'), 'Hello there');
  assert.equal(sanitizeReply('```\nSure thing!\n```'), 'Sure thing!');
  assert.equal(sanitizeReply('  “On my way”  '), 'On my way');
  assert.equal(sanitizeReply(''), '');
  assert.equal(sanitizeReply(null), '');
});

test('sanitizeReply caps very long output', () => {
  const out = sanitizeReply('x'.repeat(5000));
  assert.equal(out.length, 2000);
});

test('sanitizeReply collapses an exactly duplicated reply (nested provider nodes)', () => {
  const one =
    'Sure, that works for me. I will send the updated deck before the meeting tomorrow, and we can review the budget slide together.';
  assert.equal(sanitizeReply(`${one}\n${one}`), one);
  assert.equal(sanitizeReply(`“${one}\n${one}”`), one);
  assert.equal(sanitizeReply(`${one} ${one}`), one);
});

test('sanitizeReply keeps genuinely different paragraphs intact', () => {
  const two =
    'First paragraph with one idea and enough words to be realistic.\n' +
    'Second paragraph that says something completely different.';
  assert.equal(sanitizeReply(two), two);
});

test('short intentional repeats are not collapsed', () => {
  assert.equal(collapseExactDuplicate('ha\nha'), 'ha\nha');
  assert.equal(sanitizeReply('ha\nha'), 'ha\nha');
});

test('estimateTokens is roughly chars / 4', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('a'.repeat(400)), 100);
  assert.equal(estimateTokens(''), 0);
});
