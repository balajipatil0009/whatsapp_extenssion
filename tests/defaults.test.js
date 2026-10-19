'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSettings, chatKindFromId, chatKindFromChat, DEFAULT_SETTINGS } = require('../lib/defaults.js');

test('legacy gemini engine migrates to ai + gemini enabled', () => {
  const s = normalizeSettings({ aiMode: 'gemini', enabled: false });
  assert.equal(s.replyMode, 'ai');
  assert.equal(s.enabledProviders.gemini, true);
  assert.equal(s.enabled, false);
});

test('legacy fixed engine migrates to fixed', () => {
  assert.equal(normalizeSettings({ aiMode: 'fixed' }).replyMode, 'fixed');
});

test('selecting a provider enables it', () => {
  const s = normalizeSettings({ replyMode: 'ai', aiProvider: 'deepseek', enabledProviders: { gemini: false, deepseek: false } });
  assert.equal(s.enabledProviders.deepseek, true);
});

test('unknown provider falls back to auto', () => {
  const s = normalizeSettings({ aiProvider: 'nope' });
  assert.equal(s.aiProvider, 'auto');
});

test('delay range is clamped so max >= min', () => {
  const s = normalizeSettings({ replyDelayMinMs: 9000, replyDelayMaxMs: 1000 });
  assert.equal(s.replyDelayMinMs, 9000);
  assert.equal(s.replyDelayMaxMs, 9000);
});

test('numeric settings are clamped into safe bounds', () => {
  const s = normalizeSettings({ maxSendsPerHour: 9999, typingCps: -5, recentTurns: 100 });
  assert.equal(s.maxSendsPerHour, 500);
  assert.equal(s.typingCps, 1);
  assert.equal(s.recentTurns, 20);
});

test('defaults are sane', () => {
  const s = normalizeSettings({});
  assert.equal(s.enabled, false);
  assert.equal(s.replyMode, 'fixed');
  assert.equal(s.replyToContacts, true);
  assert.equal(s.replyToGroups, false);
  assert.equal(s.replyToCommunities, false);
  assert.equal(s.contextMode, 'hybrid');
  assert.equal(s.enabledProviders.gemini, true);
  assert.equal(s.replyDelayMinMs, DEFAULT_SETTINGS.replyDelayMinMs);
});

test('bot mode survives normalisation', () => {
  const s = normalizeSettings({ replyMode: 'bot' });
  assert.equal(s.replyMode, 'bot');
});

test('an unknown reply mode falls back to fixed', () => {
  assert.equal(normalizeSettings({ replyMode: 'telepathy' }).replyMode, 'fixed');
});

test('chat kinds come from JID suffixes', () => {
  assert.equal(chatKindFromId('919999999999@c.us'), 'contact');
  assert.equal(chatKindFromId('120363000000000000@g.us'), 'group');
  assert.equal(chatKindFromId('120363000000000000@newsletter'), 'newsletter');
  assert.equal(chatKindFromId('status@broadcast'), 'status');
  assert.equal(chatKindFromId('919999999999@broadcast'), 'broadcast');
  assert.equal(chatKindFromId(''), 'unknown');
});

test('communities are detected from the chat model', () => {
  const parent = { id: '1@g.us', isParentGroup: true, groupMetadata: { groupType: 'COMMUNITY' } };
  assert.equal(chatKindFromChat(parent, '1@g.us'), 'community');

  const subgroup = { id: '2@g.us', groupMetadata: { groupType: 'DEFAULT', parentGroup: '1@g.us' } };
  assert.equal(chatKindFromChat(subgroup, '2@g.us'), 'community');

  const group = { id: '3@g.us', groupMetadata: { groupType: 'DEFAULT' } };
  assert.equal(chatKindFromChat(group, '3@g.us'), 'group');

  assert.equal(chatKindFromChat({}, '9199@c.us'), 'contact');
});

test('chatKindFromChat tolerates models that throw', () => {
  const broken = {
    get isParentGroup() {
      throw new Error('nope');
    },
  };
  assert.equal(chatKindFromChat(broken, '4@g.us'), 'group');
});
