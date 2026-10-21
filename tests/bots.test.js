'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeText,
  findMatchingBot,
  findKeywordOwner,
  validateBot,
} = require('../lib/bots.js');

function bot(id, name, keywords, extra = {}) {
  return { id, name, reply: `${name} reply`, enabled: true, keywords, ...extra };
}

test('normalisation is case-insensitive and collapses whitespace', () => {
  assert.equal(normalizeText('  Hello   There \n'), 'hello there');
  assert.equal(normalizeText(null), '');
});

test('exact keywords match the whole message only', () => {
  const bots = [bot('b1', 'Hi', [{ text: 'hi', type: 'exact' }])];
  assert.equal(findMatchingBot(bots, 'hi').bot.id, 'b1');
  assert.equal(findMatchingBot(bots, ' HI ').bot.id, 'b1');
  assert.equal(findMatchingBot(bots, 'hi there'), null);
});

test('exact matching tolerates surrounding punctuation and invisible characters', () => {
  const bots = [bot('b1', 'Hi', [{ text: 'hi', type: 'exact' }])];
  for (const message of ['Hi!', '"Hi"', 'hi…', 'Hi. ', 'H\u200Bi']) {
    const match = findMatchingBot(bots, message);
    assert.ok(match, `expected a match for ${JSON.stringify(message)}`);
    assert.equal(match.matchType, 'exact');
  }
  assert.equal(findMatchingBot(bots, 'hi there'), null);
});

test('exact matching normalises Unicode composition', () => {
  const bots = [bot('b1', 'Cafe', [{ text: 'café', type: 'exact' }])];
  assert.ok(findMatchingBot(bots, 'cafe\u0301'), 'decomposed form should match precomposed keyword');
  assert.ok(findMatchingBot(bots, 'CAFÉ'));
});

test('contains keywords match anywhere in the message', () => {
  const bots = [bot('b1', 'Pricing', [{ text: 'price', type: 'contains' }])];
  const match = findMatchingBot(bots, 'Can you share the price list?');
  assert.equal(match.bot.id, 'b1');
  assert.equal(match.matchType, 'contains');
  assert.equal(match.keyword.text, 'price');
});

test('exact wins over contains even when the contains bot is listed first', () => {
  const bots = [
    bot('broad', 'Broad', [{ text: 'hello', type: 'contains' }]),
    bot('exact', 'Exact', [{ text: 'hello', type: 'exact' }]),
  ];
  assert.equal(findMatchingBot(bots, 'hello').bot.id, 'exact');
  assert.equal(findMatchingBot(bots, 'hello there').bot.id, 'broad');
});

test('only one bot ever matches, first in list wins inside a match type', () => {
  const bots = [
    bot('first', 'First', [{ text: 'deck', type: 'contains' }]),
    bot('second', 'Second', [{ text: 'launch deck', type: 'contains' }]),
  ];
  assert.equal(findMatchingBot(bots, 'send the launch deck').bot.id, 'first');
});

test('disabled bots and bots without a reply are ignored', () => {
  const bots = [
    bot('off', 'Off', [{ text: 'order', type: 'contains' }], { enabled: false }),
    bot('empty', 'Empty', [{ text: 'order', type: 'contains' }], { reply: '' }),
  ];
  assert.equal(findMatchingBot(bots, 'my order'), null);
});

test('empty messages and empty keyword lists never match', () => {
  const bots = [bot('b1', 'Hi', [{ text: 'hi', type: 'exact' }])];
  assert.equal(findMatchingBot(bots, ''), null);
  assert.equal(findMatchingBot(bots, '   '), null);
  assert.equal(findMatchingBot([bot('b2', 'None', [])], 'hi'), null);
});

test('keyword ownership is checked across every bot', () => {
  const bots = [
    bot('b1', 'One', [{ text: 'Hello', type: 'exact' }]),
    bot('b2', 'Two', [{ text: 'price', type: 'contains' }]),
  ];
  assert.equal(findKeywordOwner(bots, 'hello').id, 'b1');
  assert.equal(findKeywordOwner(bots, 'HELLO').id, 'b1');
  assert.equal(findKeywordOwner(bots, 'hello', 'b1'), null);
  assert.equal(findKeywordOwner(bots, 'nope'), null);
});

test('validation rejects duplicate keywords across bots and names the owner', () => {
  const bots = [bot('b1', 'Greeting', [{ text: 'hi', type: 'exact' }])];
  const result = validateBot(
    { name: 'Other', reply: 'hello', keywords: [{ text: ' HI ', type: 'contains' }] },
    bots,
    null
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('Greeting')));
});

test('validation allows editing a bot to keep its own keyword', () => {
  const bots = [bot('b1', 'Greeting', [{ text: 'hi', type: 'exact' }])];
  const result = validateBot(
    { name: 'Greeting', reply: 'hello', keywords: [{ text: 'hi', type: 'exact' }] },
    bots,
    'b1'
  );
  assert.equal(result.ok, true);
  assert.equal(result.bot.keywords[0].text, 'hi');
});

test('validation rejects repeated keywords inside one bot', () => {
  const result = validateBot(
    {
      name: 'Repeat',
      reply: 'x',
      keywords: [
        { text: 'Hi', type: 'exact' },
        { text: 'hi', type: 'contains' },
      ],
    },
    [],
    null
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('repeated')));
});

test('validation requires name, reply and at least one keyword', () => {
  const result = validateBot({ name: '', reply: '', keywords: [] }, [], null);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 3);
});

test('validation rejects duplicate bot names', () => {
  const bots = [bot('b1', 'Greeting', [{ text: 'hi', type: 'exact' }])];
  const result = validateBot(
    { name: ' greeting ', reply: 'x', keywords: [{ text: 'yo', type: 'exact' }] },
    bots,
    null
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('already exists')));
});

test('validation cleans keywords and grants a default type', () => {
  const result = validateBot(
    { name: 'Clean', reply: 'ok', keywords: [{ text: '  hello   world  ' }] },
    [],
    null
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.bot.keywords[0], { text: 'hello world', type: 'contains' });
});

test('validation preserves an explicit exact keyword type', () => {
  const result = validateBot(
    { name: 'Exact', reply: 'ok', keywords: [{ text: 'hello', type: 'exact' }] },
    [],
    null
  );
  assert.equal(result.ok, true);
  assert.equal(result.bot.keywords[0].type, 'exact');
});
