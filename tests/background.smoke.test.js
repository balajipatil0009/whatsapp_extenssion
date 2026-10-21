'use strict';

/* Smoke-test the service worker without Chrome.
 *
 * Stubs just enough of the extension APIs to drive the message protocol and
 * assert that policy → delivery → conversation memory works end to end.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const store = { sync: {}, local: {} };
const changeListeners = [];
const sent = [];
const tabs = [{ id: 1, url: 'https://web.whatsapp.com/' }];
const badge = { text: '', color: '', title: '' };
let failPings = false;

function fire(area, obj) {
  const changes = {};
  for (const key of Object.keys(obj)) changes[key] = { oldValue: store[area][key], newValue: obj[key] };
  for (const fn of changeListeners) fn(changes, area);
}

function area(name) {
  return {
    async get(defaults) {
      if (defaults === null || defaults === undefined) return { ...store[name] };
      if (typeof defaults === 'string') return { [defaults]: store[name][defaults] };
      const out = {};
      for (const [k, v] of Object.entries(defaults)) out[k] = store[name][k] === undefined ? v : store[name][k];
      return out;
    },
    async set(obj) {
      Object.assign(store[name], obj);
      fire(name, obj);
    },
    async remove(key) {
      const keys = Array.isArray(key) ? key : [key];
      const changes = {};
      for (const k of keys) {
        changes[k] = undefined;
        delete store[name][k];
      }
      fire(name, changes);
    },
  };
}

function patternToRegex(pattern) {
  return new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}

function urlMatches(pattern, url) {
  if (Array.isArray(pattern)) return pattern.some((p) => urlMatches(p, url));
  return typeof pattern === 'string' ? patternToRegex(pattern).test(url) : true;
}

global.self = globalThis;
global.importScripts = (...files) => {
  for (const file of files) {
    const mod = require(path.join(ROOT, file));
    if (file.endsWith('lib/bots.js')) globalThis.WA2Bots = mod;
    else globalThis.WA2 = Object.assign(globalThis.WA2 || {}, mod);
  }
};

global.chrome = {
  storage: {
    sync: area('sync'),
    local: area('local'),
    onChanged: { addListener: (fn) => changeListeners.push(fn) },
  },
  runtime: {
    lastError: null,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: {
      addListener(fn) {
        global.__wa2Listener = fn;
      },
    },
  },
  tabs: {
    query: async ({ url } = {}) => tabs.filter((t) => urlMatches(url, t.url)),
    sendMessage: async (tabId, message) => {
      sent.push({ tabId, message });
      if (message?.type === 'wa2:ping') {
        if (failPings) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { ok: true, mainReady: true };
      }
      return { ok: true };
    },
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
    update: async () => ({}),
    create: async () => ({}),
  },
  action: {
    setBadgeText: async ({ text }) => {
      badge.text = text;
    },
    setBadgeBackgroundColor: async ({ color }) => {
      badge.color = color;
    },
    setTitle: async ({ title }) => {
      badge.title = title;
    },
  },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  scripting: { executeScript: async () => [] },
};

require(path.join(ROOT, 'background.js'));

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function ask(message, sender = { tab: { id: 1 } }) {
  return new Promise((resolve) => {
    const keep = global.__wa2Listener(message, sender, resolve);
    assert.equal(keep, true, 'listener must keep the response channel open');
  });
}

function repliesFor(chatId) {
  return sent.filter((s) => s.message?.type === 'wa2:reply' && s.message.chatId === chatId);
}

function incoming(chatId, msgId, extra = {}) {
  return {
    type: 'wa2:incoming',
    event: {
      chatId,
      msgId,
      body: 'hello there',
      fromMe: false,
      kind: 'contact',
      chatName: 'Test Contact',
      ts: Date.now(),
      type: 'chat',
      ...extra,
    },
  };
}

async function reset(settings, overrides = {}) {
  for (const key of Object.keys(store.local)) delete store.local[key];
  for (const key of Object.keys(store.sync)) delete store.sync[key];
  Object.assign(store.sync, {
    enabled: true,
    replyMode: 'fixed',
    replyText: 'Auto hello',
    replyToContacts: true,
    replyToGroups: false,
    replyToCommunities: false,
    minRetryMs: 0,
    maxMessageAgeMs: 120_000,
    maxSendsPerHour: 100,
    ...settings,
  });
  fire('sync', store.sync);
  store.local.overrides = overrides;
  await tick(10);
}

test('fixed reply is delivered and conversation memory is recorded', async () => {
  await reset({ replyText: 'Auto hello' });
  await ask(incoming('111@c.us', 'm1'));
  await tick(60);

  const replies = repliesFor('111@c.us');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].message.text, 'Auto hello');
  assert.ok(replies[0].message.delayMinMs >= 0);
  assert.ok(replies[0].message.delayMaxMs >= replies[0].message.delayMinMs);

  const { taskId } = replies[0].message;
  await ask({ type: 'wa2:sent', taskId, chatId: '111@c.us', text: 'Auto hello', ok: true, via: 'fixed' });
  await tick(60);

  const conv = store.local.convs['111@c.us'];
  assert.ok(conv, 'conversation should be stored');
  assert.equal(conv.incomingCount, 1);
  assert.equal(conv.replyCount, 1);
  assert.equal(conv.turns.length, 2);
  assert.equal(conv.turns[0].role, 'them');
  assert.equal(conv.turns[1].role, 'me');
  assert.ok(conv.lastReplyAt > 0);
});

test('the same WhatsApp message id is never answered twice', async () => {
  await reset({});
  await ask(incoming('222@c.us', 'dup1'));
  await tick(50);
  await ask(incoming('222@c.us', 'dup1'));
  await tick(50);
  assert.equal(repliesFor('222@c.us').length, 1);
});

test('two duplicate events arriving together produce one reply', async () => {
  await reset({});
  await Promise.all([
    ask(incoming('999@c.us', 'race1')),
    ask(incoming('999@c.us', 'race1')),
  ]);
  await tick(80);
  assert.equal(repliesFor('999@c.us').length, 1);
});

test('group messages are recorded but not answered by default', async () => {
  await reset({ replyToGroups: false });
  await ask(incoming('333@g.us', 'g1', { kind: 'group', chatName: 'Team' }));
  await tick(60);
  assert.equal(repliesFor('333@g.us').length, 0);
  assert.equal(store.local.convs['333@g.us'].kind, 'group');
});

test('a per-chat off override wins over the global default', async () => {
  await reset({}, { '444@c.us': { reply: 'off' } });
  await ask(incoming('444@c.us', 'o1'));
  await tick(60);
  assert.equal(repliesFor('444@c.us').length, 0);
});

test('a per-chat on override answers a group when groups are off', async () => {
  await reset({ replyToGroups: false }, { '555@g.us': { reply: 'on' } });
  await ask(incoming('555@g.us', 'g2', { kind: 'group' }));
  await tick(60);
  assert.equal(repliesFor('555@g.us').length, 1);
});

test('AI mode falls back to the fixed reply when no provider tab is open', async () => {
  await reset({
    replyMode: 'ai',
    aiFallbackToFixed: true,
    replyText: 'Fallback text',
    enabledProviders: { gemini: true, chatgpt: false, deepseek: false, kimi: false },
  });
  await ask(incoming('666@c.us', 'a1'));
  await tick(120);
  const replies = repliesFor('666@c.us');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].message.text, 'Fallback text');
  assert.equal(replies[0].message.via, 'fallback');
});

test('bot mode replies with the single matching bot', async () => {
  await reset({ replyMode: 'bot' });
  store.local.bots = [
    {
      id: 'b1',
      name: 'Greeting',
      enabled: true,
      reply: 'Bot hello',
      keywords: [{ text: 'hello', type: 'exact' }],
    },
    {
      id: 'b2',
      name: 'Broad',
      enabled: true,
      reply: 'Broad reply',
      keywords: [{ text: 'hel', type: 'contains' }],
    },
  ];
  await ask(incoming('bbb@c.us', 'bot1', { body: 'hello' }));
  await tick(60);
  const replies = repliesFor('bbb@c.us');
  assert.equal(replies.length, 1, 'only one bot may answer');
  assert.equal(replies[0].message.text, 'Bot hello');
  assert.equal(replies[0].message.via, 'bot:Greeting');
});

test('bot exact match tolerates surrounding punctuation', async () => {
  await reset({ replyMode: 'bot' });
  store.local.bots = [
    { id: 'b1', name: 'Greeting', enabled: true, reply: 'Exact hello', keywords: [{ text: 'hello', type: 'exact' }] },
  ];
  await ask(incoming('fff@c.us', 'bot5', { body: 'Hello!' }));
  await tick(60);
  const replies = repliesFor('fff@c.us');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].message.text, 'Exact hello');
});

test('bot exact match does not fire on extra words', async () => {
  await reset({ replyMode: 'bot' });
  store.local.bots = [
    { id: 'b1', name: 'Greeting', enabled: true, reply: 'Exact hello', keywords: [{ text: 'hello', type: 'exact' }] },
  ];
  await ask(incoming('ggg@c.us', 'bot6', { body: 'hello there' }));
  await tick(60);
  assert.equal(repliesFor('ggg@c.us').length, 0);
});

test('bot mode stays silent when nothing matches', async () => {
  await reset({ replyMode: 'bot' });
  store.local.bots = [
    { id: 'b1', name: 'Greeting', enabled: true, reply: 'Bot hello', keywords: [{ text: 'hello', type: 'exact' }] },
  ];
  await ask(incoming('ccc@c.us', 'bot2', { body: 'unrelated message' }));
  await tick(60);
  assert.equal(repliesFor('ccc@c.us').length, 0);
});

test('disabled bots do not answer', async () => {
  await reset({ replyMode: 'bot' });
  store.local.bots = [
    { id: 'b1', name: 'Off', enabled: false, reply: 'nope', keywords: [{ text: 'hello', type: 'exact' }] },
  ];
  await ask(incoming('eee@c.us', 'bot4', { body: 'hello' }));
  await tick(60);
  assert.equal(repliesFor('eee@c.us').length, 0);
});

test('stale history-sync messages are ignored', async () => {
  await reset({});
  await ask(incoming('777@c.us', 'old1', { ts: Date.now() - 10 * 60_000 }));
  await tick(60);
  assert.equal(repliesFor('777@c.us').length, 0);
});

test('media-only messages are ignored', async () => {
  await reset({});
  await ask(incoming('888@c.us', 'media1', { body: '' }));
  await tick(60);
  assert.equal(repliesFor('888@c.us').length, 0);
});

test('dashboard state reports providers and queue length', async () => {
  const state = await ask({ type: 'wa2:dashboard:state' });
  assert.equal(state.ok, true);
  assert.equal(state.providers.length, 4);
  assert.ok(state.providers.some((p) => p.id === 'gemini'));
  assert.ok(Number.isFinite(state.aiQueue));
});

test('toolbar badge follows a live bridge probe', async () => {
  failPings = false;
  await chrome.storage.sync.set({ enabled: true });
  await tick(120);
  assert.equal(badge.text, 'ON');

  failPings = true;
  await chrome.storage.sync.set({ enabled: true });
  await tick(120);
  assert.equal(badge.text, '!');
  assert.match(badge.title, /reload/i);
  failPings = false;
});
