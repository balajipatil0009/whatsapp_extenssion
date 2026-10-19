'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSettings } = require('../lib/defaults.js');
const { evaluateIncoming, delayRangeFor, typingDurationFor } = require('../lib/policy.js');

const NOW = 1_700_000_000_000;
const baseSettings = () => normalizeSettings({ enabled: true, minRetryMs: 60_000, maxMessageAgeMs: 120_000, maxSendsPerHour: 40 });

function check(overrides = {}) {
  return evaluateIncoming({
    settings: baseSettings(),
    chat: { id: '9199@c.us', kind: 'contact', body: 'hello', fromMe: false },
    override: {},
    now: NOW,
    ageMs: 1000,
    lastReplyAt: 0,
    recentSends: [],
    seen: false,
    pending: false,
    ...overrides,
  });
}

test('replies to a direct message when enabled', () => {
  const d = check();
  assert.equal(d.action, 'reply');
  assert.equal(d.code, 'ok');
});

test('master switch off skips everything', () => {
  const d = check({ settings: normalizeSettings({ enabled: false }) });
  assert.equal(d.action, 'skip');
  assert.equal(d.code, 'disabled');
});

test('own outgoing messages are skipped', () => {
  const d = check({ chat: { id: '9199@c.us', kind: 'contact', body: 'hi', fromMe: true } });
  assert.equal(d.code, 'self');
});

test('groups are off by default and on when enabled', () => {
  const chat = { id: '1@g.us', kind: 'group', body: 'hi', fromMe: false };
  assert.equal(check({ chat }).code, 'type-group');
  const s = normalizeSettings({ enabled: true, replyToGroups: true });
  assert.equal(check({ chat, settings: s }).action, 'reply');
});

test('communities have their own toggle', () => {
  const chat = { id: '1@g.us', kind: 'community', body: 'hi', fromMe: false };
  assert.equal(check({ chat }).code, 'type-community');
  const s = normalizeSettings({ enabled: true, replyToGroups: true, replyToCommunities: false });
  assert.equal(check({ chat, settings: s }).code, 'type-community');
  const s2 = normalizeSettings({ enabled: true, replyToCommunities: true });
  assert.equal(check({ chat, settings: s2 }).action, 'reply');
});

test('channels are off unless enabled', () => {
  const chat = { id: '1@newsletter', kind: 'newsletter', body: 'hi', fromMe: false };
  assert.equal(check({ chat }).code, 'type-newsletter');
  const s = normalizeSettings({ enabled: true, replyToNewsletters: true });
  assert.equal(check({ chat, settings: s }).action, 'reply');
});

test('per-chat on overrides a disabled group category', () => {
  const chat = { id: '1@g.us', kind: 'group', body: 'hi', fromMe: false };
  const d = check({ chat, override: { reply: 'on' } });
  assert.equal(d.action, 'reply');
});

test('per-chat off overrides everything except the master switch', () => {
  const d = check({ override: { reply: 'off' } });
  assert.equal(d.code, 'chat-off');
});

test('duplicate messages are skipped', () => {
  assert.equal(check({ seen: true }).code, 'duplicate');
});

test('pending replies suppress a second reply in the same chat', () => {
  assert.equal(check({ pending: true }).code, 'pending');
});

test('per-chat cooldown is enforced', () => {
  assert.equal(check({ lastReplyAt: NOW - 10_000 }).code, 'cooldown');
  assert.equal(check({ lastReplyAt: NOW - 61_000 }).action, 'reply');
});

test('hourly send cap is enforced', () => {
  const recentSends = new Array(40).fill(NOW - 60_000);
  assert.equal(check({ recentSends }).code, 'rate-limit');
});

test('messages older than the freshness window are skipped', () => {
  assert.equal(check({ ageMs: 10 * 60_000 }).code, 'stale');
});

test('media-only messages are skipped', () => {
  const chat = { id: '9199@c.us', kind: 'contact', body: '', fromMe: false };
  assert.equal(check({ chat }).code, 'empty');
});

test('status updates and broadcast lists never get replies', () => {
  assert.equal(check({ chat: { id: 'status@broadcast', kind: 'status', body: 'x' } }).code, 'status');
  assert.equal(check({ chat: { id: '1@broadcast', kind: 'broadcast', body: 'x' } }).code, 'broadcast');
});

test('delayRangeFor honours per-chat overrides and swaps inverted ranges', () => {
  const s = baseSettings();
  assert.deepEqual(delayRangeFor(s, {}), { min: s.replyDelayMinMs, max: s.replyDelayMaxMs });
  assert.deepEqual(delayRangeFor(s, { delayMinMs: 500, delayMaxMs: 1500 }), { min: 500, max: 1500 });
  assert.deepEqual(delayRangeFor(s, { delayMinMs: 9000, delayMaxMs: 1000 }), { min: 9000, max: 9000 });
});

test('typing duration is proportional but clamped', () => {
  const s = baseSettings();
  assert.ok(typingDurationFor('hi', s) >= 1200);
  assert.ok(typingDurationFor('x'.repeat(500), s) <= 12_000);
  assert.ok(typingDurationFor('x'.repeat(100), s) > typingDurationFor('hi', s));
});
