/* WA Auto Reply — background service worker (MV3)
 *
 * Orchestrator. The WhatsApp page can only talk to WhatsApp; the provider tabs
 * can only talk to their own site. Everything between them happens here:
 *
 *   incoming event ──► policy ──► conversation memory ──► AI provider (pooled,
 *                     │                                   round-robin, 1 job per tab)
 *                     └──► reply task ──► WhatsApp tab (page queue adds the
 *                                        human delay, typing presence and send)
 *
 * Also: diagnostic log ring buffer, badge, conversation registry, per-chat
 * overrides, summaries, and the dashboard API.
 */

importScripts('lib/defaults.js', 'lib/bots.js', 'lib/context.js', 'lib/policy.js');

const {
  PROVIDERS,
  PROVIDER_IDS,
  normalizeSettings,
  chatKindFromId,
  uid,
  truncate,
} = self.WA2;
const { buildPrompt, sanitizeReply, makeExtractiveSummary } = self.WA2;
const { evaluateIncoming, delayRangeFor } = self.WA2;
const { findMatchingBot } = self.WA2Bots;

const VERSION = '2.1.0';
const MAX_LOGS = 1500;
const LOG_MAX = 700;
const CONV_CAP = 250;
const TURNS_CAP = 40;
const SEEN_CAP = 800;
const AI_QUEUE_CAP = 6;
const PENDING_TTL_MS = 5 * 60_000;

const WA_MATCH = 'https://web.whatsapp.com/*';

// ============================================================= diagnostic log
let logBuffer = [];
let logTimer = null;
let logFlushChain = null;

function log(level, tag, message) {
  const line = `[WA2][${tag}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
  enqueueLog(level, tag, message);
}

function enqueueLog(level, tag, message) {
  logBuffer.push({
    t: Date.now(),
    level: ['info', 'warn', 'error'].includes(level) ? level : 'info',
    tag: String(tag || 'bg').slice(0, 24),
    message: truncate(String(message == null ? '' : message), LOG_MAX),
  });
  if (logBuffer.length >= 60) scheduleLogFlush(0);
  else scheduleLogFlush(700);
}

function scheduleLogFlush(ms) {
  if (logTimer) return;
  logTimer = setTimeout(() => {
    logTimer = null;
    flushLogs();
  }, ms);
}

function flushLogs() {
  if (logFlushChain) return logFlushChain;
  const batch = logBuffer.splice(0);
  if (!batch.length) return Promise.resolve();
  logFlushChain = (async () => {
    const { logs = [], logSeq = 0 } = await chrome.storage.local.get({ logs: [], logSeq: 0 });
    const ring = Array.isArray(logs) ? logs : [];
    let seq = Number(logSeq) || 0;
    for (const e of batch) ring.push({ ...e, i: ++seq });
    if (ring.length > MAX_LOGS) ring.splice(0, ring.length - MAX_LOGS);
    await chrome.storage.local.set({ logs: ring, logSeq: seq });
  })()
    .catch((e) => {
      // Put the batch back so a transient storage error does not lose evidence.
      logBuffer = batch.concat(logBuffer);
      console.warn('[WA2][bg] log flush failed', e);
    })
    .finally(() => {
      logFlushChain = null;
    });
  return logFlushChain;
}

// =================================================================== settings
let settingsCache = null;

async function getSettings(force = false) {
  if (!settingsCache || force) {
    settingsCache = normalizeSettings(await chrome.storage.sync.get(null));
  }
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    settingsCache = null;
    if ('enabled' in changes) refreshBadge();
  }
});

// ==================================================================== badge
async function refreshBadge() {
  try {
    const settings = await getSettings();
    const { status = {} } = await chrome.storage.local.get({ status: {} });
    const tabs = await chrome.tabs.query({ url: WA_MATCH });
    let text = '';
    let color = '#777';
    if (settings.enabled) {
      if (tabs.length && status.mainReady) {
        text = 'ON';
        color = '#25D366';
      } else if (tabs.length) {
        text = 'WAIT';
        color = '#f5a623';
      } else {
        text = 'IDLE';
      }
    }
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) {
    console.warn('[WA2][bg] badge', e);
  }
}

// ============================================================ local store io
// Conversation + override writes are serialized through a promise chain so two
// incoming messages cannot clobber each other's read-modify-write.
let convChain = Promise.resolve();

function withConvs(fn) {
  const run = convChain.then(async () => {
    const { convs = {} } = await chrome.storage.local.get({ convs: {} });
    const result = await fn(convs);
    trimConvs(convs);
    await chrome.storage.local.set({ convs });
    return result;
  });
  convChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function trimConvs(convs) {
  const entries = Object.entries(convs);
  if (entries.length <= CONV_CAP) return;
  entries.sort((a, b) => (b[1].lastMessageAt || 0) - (a[1].lastMessageAt || 0));
  for (const [id] of entries.slice(CONV_CAP)) delete convs[id];
}

async function getOverride(chatId) {
  const { overrides = {} } = await chrome.storage.local.get({ overrides: {} });
  return overrides[chatId] || {};
}

async function getBots() {
  const { bots = [] } = await chrome.storage.local.get({ bots: [] });
  return Array.isArray(bots) ? bots : [];
}

// In-memory dedupe of processed messages (bounded).
const seen = new Map();
function seenKey(chatId, msgId) {
  return `${chatId}|${msgId || ''}`;
}
function wasSeen(key) {
  const at = seen.get(key);
  if (!at) return false;
  if (Date.now() - at > 6 * 3600_000) {
    seen.delete(key);
    return false;
  }
  return true;
}
function markSeen(key) {
  seen.set(key, Date.now());
  if (seen.size > SEEN_CAP) seen.delete(seen.keys().next().value);
}

// Replies that are generating/queued but not sent yet, keyed by chatId.
const pending = new Map();
const recentDeliveries = new Map(); // chatId -> { taskId, text, at }
const DELIVERY_DEDUPE_MS = 15_000;
function pendingFor(chatId) {
  const p = pending.get(chatId);
  if (!p) return null;
  if (Date.now() - p.at > PENDING_TTL_MS) {
    pending.delete(chatId);
    return null;
  }
  return p;
}

// Global send-rate history (persisted lightly so a SW restart does not reset it).
let sendTimes = [];
let sendTimesLoaded = false;
async function ensureSendTimes() {
  if (sendTimesLoaded) return;
  const { sendTimes: stored = [] } = await chrome.storage.local.get({ sendTimes: [] });
  sendTimes = Array.isArray(stored) ? stored.filter((t) => Number.isFinite(t)) : [];
  sendTimesLoaded = true;
}
async function recordSendTime() {
  const now = Date.now();
  sendTimes.push(now);
  sendTimes = sendTimes.filter((t) => t > now - 2 * 3600_000).slice(-300);
  await chrome.storage.local.set({ sendTimes });
}

// ============================================================== provider pool
const providerBusy = new Set(); // providerId -> one in-flight job at a time
const providerActiveChat = new Map(); // providerId -> chatId currently in its tab
const providerStats = Object.fromEntries(
  PROVIDER_IDS.map((id) => [id, { ok: 0, fail: 0, lastError: null, lastAt: 0 }])
);

let rrIndex = 0;

async function findProviderTabs() {
  const out = {};
  await Promise.all(
    PROVIDERS.map(async (p) => {
      try {
        const tabs = await chrome.tabs.query({ url: p.matches });
        out[p.id] = tabs[0]?.id ?? null;
      } catch {
        out[p.id] = null;
      }
    })
  );
  return out;
}

/** Providers with a job persisted from before a service-worker restart. */
async function providersWithLiveJobs() {
  const { aiInflight = {} } = await chrome.storage.local.get({ aiInflight: {} });
  const cutoff = Date.now() - 3 * 60_000; // longer than the AI timeout, short enough not to wedge a tab
  const live = new Set();
  for (const entry of Object.values(aiInflight)) {
    if (entry && entry.providerId && entry.createdAt > cutoff) live.add(entry.providerId);
  }
  return live;
}

/**
 * Pick a provider for a conversation. An explicitly assigned provider wins;
 * otherwise enabled providers rotate, skipping tabs that are closed or busy.
 */
async function chooseProvider(settings, conv, override) {
  const tabs = await findProviderTabs();
  const liveJobs = await providersWithLiveJobs();
  const explicit = (override && override.provider) || conv.provider || settings.aiProvider;
  const enabled = PROVIDER_IDS.filter((id) => settings.enabledProviders[id]);
  const order = [];
  if (explicit && explicit !== 'auto') order.push(explicit);
  for (let i = 0; i < enabled.length; i++) order.push(enabled[(rrIndex + i) % enabled.length]);

  const tried = new Set();
  for (const id of order) {
    if (tried.has(id)) continue;
    tried.add(id);
    if (!settings.enabledProviders[id]) continue;
    if (!tabs[id]) continue;
    if (providerBusy.has(id) || liveJobs.has(id)) continue;
    if (explicit === 'auto' || id !== explicit) {
      rrIndex = (PROVIDER_IDS.indexOf(id) + 1) % PROVIDER_IDS.length;
    }
    return { id, tabId: tabs[id] };
  }

  const anyOpen = enabled.some((id) => tabs[id]);
  return { id: null, allBusy: anyOpen, tabs };
}

// ================================================================ AI inflight
// Persisted so a service-worker restart can still deliver a late provider
// response to the right WhatsApp tab.
let inflightChain = Promise.resolve();

function withInflight(fn) {
  const run = inflightChain.then(async () => {
    const { aiInflight = {} } = await chrome.storage.local.get({ aiInflight: {} });
    const result = await fn(aiInflight);
    const cutoff = Date.now() - 15 * 60_000;
    for (const [id, e] of Object.entries(aiInflight)) {
      if (!e || e.createdAt < cutoff) delete aiInflight[id];
    }
    await chrome.storage.local.set({ aiInflight });
    return result;
  });
  inflightChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function putInflight(entry) {
  return withInflight((m) => {
    m[entry.reqId] = entry;
  });
}

function takeInflight(reqId) {
  return withInflight((m) => {
    const entry = m[reqId] || null;
    if (entry) delete m[reqId];
    return entry;
  });
}

// ================================================================ conversations
async function recordIncoming(ev, kind) {
  return withConvs((convs) => {
    const now = Date.now();
    let c = convs[ev.chatId];
    if (!c) {
      c = convs[ev.chatId] = {
        id: ev.chatId,
        name: '',
        kind,
        turns: [],
        createdAt: now,
        incomingCount: 0,
        replyCount: 0,
        turnCount: 0,
        summary: '',
        summaryTurnCount: 0,
        contextTurns: 0,
        provider: null,
        lastReplyAt: 0,
      };
    }
    c.name = ev.chatName || ev.notifyName || c.name || ev.chatId;
    c.kind = kind;
    c.lastMessageAt = ev.ts || now;
    c.lastIncomingAt = now;
    c.lastPreview = truncate(ev.body || '', 140);
    c.incomingCount = (c.incomingCount || 0) + 1;
    c.turnCount = (c.turnCount || 0) + 1;
    if (ev.body) {
      c.turns.push({ role: 'them', text: truncate(ev.body, 2000), ts: ev.ts || now });
      if (c.turns.length > TURNS_CAP) c.turns.splice(0, c.turns.length - TURNS_CAP);
    }
    return { ...c, turns: c.turns.slice() };
  });
}

async function recordOutgoing({ chatId, text, provider, via }) {
  return withConvs((convs) => {
    const c = convs[chatId];
    if (!c) return null;
    c.replyCount = (c.replyCount || 0) + 1;
    c.turnCount = (c.turnCount || 0) + 1;
    c.lastReplyAt = Date.now();
    c.lastPreview = truncate(text || '', 140);
    c.lastVia = via || 'fixed';
    if (provider) {
      // contextTurns is advanced in onProviderResponse (it knows which provider
      // and whether its chat memory was fresh); do not double-count here.
      c.provider = provider;
    }
    c.turns.push({ role: 'me', text: truncate(text || '', 2000), ts: Date.now() });
    if (c.turns.length > TURNS_CAP) c.turns.splice(0, c.turns.length - TURNS_CAP);
    return { ...c };
  });
}

/** Rebuild the cheap extractive summary when the threshold is crossed. */
async function maybeUpdateSummary(chatId, settings) {
  if (!settings || settings.summaryMode === 'off') return;
  await withConvs((convs) => {
    const c = convs[chatId];
    if (!c) return;
    const turnsSince = (c.turnCount || 0) - (c.summaryTurnCount || 0);
    if (c.summary && turnsSince < settings.summaryEveryTurns) return;
    const summary = makeExtractiveSummary(c);
    if (!summary) return;
    c.summary = summary;
    c.summaryTurnCount = c.turnCount || 0;
    c.summaryUpdatedAt = Date.now();
    c.summarySource = 'extractive';
  });
}

// =================================================================== delivery
function buildDelivery(settings, override) {
  const range = delayRangeFor(settings, override);
  return {
    delayMinMs: range.min,
    delayMaxMs: range.max,
    typing: settings.typingSimulation,
    markSeen: settings.markSeen,
  };
}

async function deliverReply(tabId, payload) {
  // Final duplicate guard for AI text: two tasks for the same duplicate event
  // (or a scraper that returned the same text twice) must not produce two
  // bubbles. Fixed/bot replies are deterministic, so they are left alone.
  const isAiDelivery = payload.via === 'ai' || payload.via === 'fallback';
  const previous = recentDeliveries.get(payload.chatId);
  if (
    isAiDelivery &&
    previous &&
    payload.taskId &&
    previous.taskId !== payload.taskId &&
    previous.text === payload.text &&
    Date.now() - previous.at < DELIVERY_DEDUPE_MS
  ) {
    log(
      'warn',
      'queue',
      `Suppressed duplicate AI delivery to ${payload.chatId} (identical text within ${DELIVERY_DEDUPE_MS / 1000}s)`
    );
    return false;
  }
  if (isAiDelivery) {
    recentDeliveries.set(payload.chatId, { taskId: payload.taskId, text: payload.text, at: Date.now() });
    if (recentDeliveries.size > 200) recentDeliveries.delete(recentDeliveries.keys().next().value);
  }

  const message = {
    type: 'wa2:reply',
    taskId: payload.taskId,
    chatId: payload.chatId,
    chatName: payload.chatName || '',
    text: payload.text,
    delayMinMs: payload.delayMinMs,
    delayMaxMs: payload.delayMaxMs,
    typing: payload.typing,
    markSeen: payload.markSeen,
    provider: payload.providerId || payload.provider || null,
    via: payload.via || 'fixed',
  };
  if (!tabId) {
    pending.delete(payload.chatId);
    log('error', 'queue', 'No WhatsApp tab id — reply dropped');
    return false;
  }
  try {
    await chrome.tabs.sendMessage(tabId, message);
    log(
      'info',
      'queue',
      `Queued ${message.taskId} → ${payload.chatId} via ${message.provider || message.via} ` +
        `(delay ${message.delayMinMs}-${message.delayMaxMs}ms)`
    );
    return true;
  } catch (e) {
    const p = pending.get(payload.chatId);
    pending.delete(payload.chatId);
    if (p) {
      await withConvs((convs) => {
        const c = convs[payload.chatId];
        if (c) c.lastReplyAt = p.prevLastReplyAt || 0;
      });
    }
    log('error', 'queue', `Could not reach WhatsApp tab ${tabId}: ${e?.message || e}`);
    return false;
  }
}

// ======================================================================= AI
const aiQueue = [];

function enqueueAi(payload) {
  if (aiQueue.length >= AI_QUEUE_CAP) {
    const dropped = aiQueue.shift();
    pending.delete(dropped.ev.chatId);
    log('warn', 'ai', `AI queue full — dropped ${dropped.taskId} (${dropped.ev.chatId})`);
  }
  aiQueue.push(payload);
  log('info', 'ai', `Queued ${payload.taskId} for a free provider (${aiQueue.length} waiting)`);
}

function pumpAiQueue() {
  if (!aiQueue.length) return;
  (async () => {
    let guard = 0;
    while (aiQueue.length && guard++ < AI_QUEUE_CAP) {
      const p = aiQueue[0];
      const age = Date.now() - (p.createdAt || Date.now());
      if (age > (p.settings.aiTimeoutMs || 90_000)) {
        aiQueue.shift();
        pending.delete(p.ev.chatId);
        log('warn', 'ai', `${p.taskId} waited ${Math.round(age / 1000)}s for a provider — dropped`);
        continue;
      }
      const pick = await chooseProvider(p.settings, p.conv, p.override);
      if (!pick.id) break;
      aiQueue.shift();
      await dispatchAi({ ...p, providerId: pick.id, providerTabId: pick.tabId });
    }
  })().catch((e) => log('error', 'ai', `Queue pump failed: ${e?.message || e}`));
}

function contextModeFor(settings, conv, providerId, activeChatId) {
  if (settings.contextMode === 'full') return 'full';
  if (settings.contextMode === 'delta') return 'delta';
  const memoryFresh = conv.provider === providerId && activeChatId === conv.id;
  const anchor = Math.max(1, settings.anchorEveryTurns);
  const turns = Number(conv.contextTurns) || 0;
  if (!memoryFresh) return 'full';
  return turns > 0 && turns % anchor === 0 ? 'full' : 'delta';
}

async function dispatchAi(p) {
  const { settings, conv, ev, delivery, waTabId, taskId, providerId, providerTabId } = p;
  const activeChat = providerActiveChat.get(providerId) || null;
  const mode = contextModeFor(settings, conv, providerId, activeChat);
  const summary = mode === 'full' ? conv.summary || '' : '';
  const reqId = uid('req');
  const prompt = buildPrompt({
    settings,
    conv,
    chat: { id: ev.chatId, name: ev.chatName || conv.name, kind: ev.kind || conv.kind },
    message: ev.body,
    mode,
    summary,
    ownerName: settings.ownerName || 'me',
    turnId: reqId,
  });

  const entry = {
    reqId,
    kind: 'reply',
    providerId,
    providerTabId,
    chatId: ev.chatId,
    chatName: ev.chatName || conv.name,
    waTabId,
    taskId,
    delayMinMs: delivery.delayMinMs,
    delayMaxMs: delivery.delayMaxMs,
    typing: delivery.typing,
    markSeen: delivery.markSeen,
    createdAt: Date.now(),
    mode,
    summary,
    prevProvider: conv.provider || null,
    prevContextTurns: Number(conv.contextTurns) || 0,
    fallbackText: settings.replyText,
    fallbackEnabled: settings.aiFallbackToFixed,
    aiTimeoutMs: settings.aiTimeoutMs,
  };

  await putInflight(entry);
  providerBusy.add(providerId);
  providerActiveChat.set(providerId, ev.chatId);
  log(
    'info',
    'ai',
    `${providerId} ← ${taskId} for ${ev.chatId} (${mode} prompt, ~${prompt.tokens} tokens)`
  );

  try {
    const resp = await chrome.tabs.sendMessage(providerTabId, {
      type: 'wa2:ai-request',
      reqId,
      prompt: prompt.text,
      contextMode: mode,
    });
    if (!resp || resp.accepted !== true) {
      throw new Error(resp?.error || 'provider did not accept the request');
    }
  } catch (e) {
    await failAi(entry, `dispatch failed: ${e?.message || e}`);
    return;
  }

  // Best-effort watchdog. A service-worker restart clears this timer, but the
  // page has its own timeout and cleanupInflight() releases stale jobs.
  setTimeout(
    () => {
      if (providerBusy.has(providerId)) failAi(entry, 'provider timed out');
    },
    (settings.aiTimeoutMs || 90_000) + 15_000
  );
}

async function failAi(entry, reason) {
  providerBusy.delete(entry.providerId);
  const stats = providerStats[entry.providerId];
  if (stats) {
    stats.fail += 1;
    stats.lastError = String(reason);
    stats.lastAt = Date.now();
  }
  const e = await takeInflight(entry.reqId);
  if (!e) return;
  log('error', 'ai', `${entry.providerId} failed ${entry.reqId}: ${reason}`);
  if (e.kind === 'summary') {
    pumpAiQueue();
    return;
  }
  if (e.fallbackEnabled) {
    await deliverReply(e.waTabId, { ...e, text: e.fallbackText, via: 'fallback' });
  } else {
    pending.delete(e.chatId);
    log('warn', 'ai', `Fallback disabled — no reply sent for ${e.chatId}`);
  }
  pumpAiQueue();
}

async function startAi(payload) {
  const { settings, conv, ev, override } = payload;
  const pick = await chooseProvider(settings, conv, override);
  if (!pick.id) {
    if (pick.allBusy) {
      enqueueAi({ ...payload, createdAt: Date.now() });
      return;
    }
    log(
      'warn',
      'ai',
      `No provider tab open for ${ev.chatId} (${JSON.stringify(pick.tabs)}) — ` +
        (settings.aiFallbackToFixed ? 'using the fixed reply' : 'no reply (fallback disabled)')
    );
    if (settings.aiFallbackToFixed) {
      await deliverReply(payload.waTabId, {
        ...payload.delivery,
        taskId: payload.taskId,
        chatId: ev.chatId,
        chatName: ev.chatName,
        text: settings.replyText,
        via: 'fallback',
      });
    } else {
      pending.delete(ev.chatId);
      await withConvs((convs) => {
        const c = convs[ev.chatId];
        if (c) c.lastReplyAt = conv.lastReplyAt || 0;
      });
    }
    return;
  }
  await dispatchAi({ ...payload, providerId: pick.id, providerTabId: pick.tabId, createdAt: Date.now() });
}

async function onProviderResponse(msg) {
  const entry = await takeInflight(msg.reqId);
  const providerId = msg.providerId || entry?.providerId || null;
  if (providerId) providerBusy.delete(providerId);

  if (!entry) {
    log('warn', 'ai', `Late or unknown provider response ${msg.reqId} — ignored`);
    pumpAiQueue();
    return;
  }

  const stats = providerStats[providerId || entry.providerId];
  if (stats) stats.lastAt = Date.now();

  if (entry.kind === 'summary') {
    const summary = sanitizeReply(msg.text);
    if (msg.ok && summary) {
      await withConvs((convs) => {
        const c = convs[entry.chatId];
        if (!c) return;
        c.summary = summary.slice(0, 700);
        c.summaryTurnCount = c.turnCount || 0;
        c.summaryUpdatedAt = Date.now();
        c.summarySource = 'ai';
      });
      log('info', 'summary', `AI summary for ${entry.chatId}: ${summary.length} chars`);
    } else {
      log('warn', 'summary', `AI summary failed for ${entry.chatId}: ${msg.error || 'empty'}`);
    }
    pumpAiQueue();
    return;
  }

  if (!msg.ok) {
    await failAi(entry, msg.error || 'provider returned an error');
    return;
  }

  const text = sanitizeReply(msg.text);
  if (!text) {
    await failAi(entry, 'empty response');
    return;
  }

  if (stats) stats.ok += 1;
  await withConvs((convs) => {
    const c = convs[entry.chatId];
    if (!c) return;
    c.provider = entry.providerId;
    c.contextTurns =
      entry.prevProvider === entry.providerId ? (Number(entry.prevContextTurns) || 0) + 1 : 1;
    c.contextUpdatedAt = Date.now();
  });
  log('info', 'ai', `${entry.providerId} → ${entry.chatId}: ${text.length} chars (${entry.mode})`);
  if (entry.kind === 'manual') {
    await chrome.storage.local.remove('manualPrompt');
  }
  await deliverReply(entry.waTabId, { ...entry, text, via: 'ai' });
  pumpAiQueue();
}

// ============================================================== incoming flow
async function handleIncoming(payload, sender) {
  const ev = payload && payload.event;
  const waTabId = sender?.tab?.id;
  if (!ev || !ev.chatId || !ev.msgId || !waTabId) {
    log('warn', 'incoming', 'Ignored malformed incoming event from the page');
    return;
  }

  // Claim the message BEFORE any await. Two duplicate events arriving at the
  // same time used to both pass this check (settings lookup yielded first), so
  // both scheduled a reply.
  const key = seenKey(ev.chatId, ev.msgId);
  if (wasSeen(key)) return;
  markSeen(key);

  const settings = await getSettings();
  const override = await getOverride(ev.chatId);
  const kind = override.kind || ev.kind || chatKindFromId(ev.chatId);
  await ensureSendTimes();

  const conv = await recordIncoming(ev, kind);
  await maybeUpdateSummary(ev.chatId, settings);

  const ageMs = ev.ts ? Math.max(0, Date.now() - ev.ts) : null;
  const decision = evaluateIncoming({
    settings,
    chat: { id: ev.chatId, kind, body: ev.body, fromMe: !!ev.fromMe },
    override,
    now: Date.now(),
    ageMs,
    lastReplyAt: conv.lastReplyAt,
    recentSends: sendTimes,
    seen: false,
    pending: !!pendingFor(ev.chatId),
  });

  log(
    'info',
    'policy',
    `${decision.action.toUpperCase()} ${ev.chatId} (${ev.chatName || '?'}) — ${decision.code}: ${decision.reason}`
  );
  if (decision.action !== 'reply') return;

  // Bot mode: resolve the single matching bot before claiming the chat, so a
  // message that no bot matches does not burn the cooldown.
  let botMatch = null;
  if (settings.replyMode === 'bot') {
    botMatch = findMatchingBot(await getBots(), ev.body);
    if (botMatch) {
      log(
        'info',
        'bot',
        `"${truncate(botMatch.keyword.text, 40)}" (${botMatch.matchType}) → bot "${botMatch.bot.name}" for ${ev.chatId}`
      );
    } else {
      log('info', 'bot', `No bot matched "${truncate(ev.body, 60)}" for ${ev.chatId} — no reply`);
      return;
    }
  }

  const taskId = uid('task');
  const delivery = buildDelivery(settings, override);
  pending.set(ev.chatId, {
    taskId,
    at: Date.now(),
    prevLastReplyAt: conv.lastReplyAt || 0,
  });
  await withConvs((convs) => {
    const c = convs[ev.chatId];
    if (c) c.lastReplyAt = Date.now();
  });

  const base = {
    settings,
    conv,
    ev: { ...ev, kind },
    override,
    delivery,
    waTabId,
    taskId,
    createdAt: Date.now(),
  };

  if (settings.replyMode === 'ai') {
    if (settings.aiManual) {
      await prepareManualPrompt(base);
      return;
    }
    await startAi(base);
    return;
  }

  const text = botMatch ? botMatch.bot.reply : settings.replyText;
  const via = botMatch ? `bot:${botMatch.bot.name}` : 'fixed';
  await deliverReply(waTabId, {
    ...delivery,
    taskId,
    chatId: ev.chatId,
    chatName: ev.chatName,
    text,
    via,
  });
}

async function prepareManualPrompt(p) {
  const { settings, conv, ev, delivery, waTabId, taskId } = p;
  const reqId = uid('man');
  const prompt = buildPrompt({
    settings,
    conv,
    chat: { id: ev.chatId, name: ev.chatName || conv.name, kind: ev.kind },
    message: ev.body,
    mode: 'full',
    summary: conv.summary || '',
    ownerName: settings.ownerName || 'me',
    turnId: reqId,
  });
  const manual = {
    reqId,
    chatId: ev.chatId,
    chatName: ev.chatName || conv.name,
    waTabId,
    taskId,
    prompt: prompt.text,
    tokens: prompt.tokens,
    createdAt: Date.now(),
    providerId: conv.provider && conv.provider !== 'auto' ? conv.provider : null,
    delayMinMs: delivery.delayMinMs,
    delayMaxMs: delivery.delayMaxMs,
    typing: delivery.typing,
    markSeen: delivery.markSeen,
  };
  await chrome.storage.local.set({ manualPrompt: manual });
  log(
    'info',
    'ai',
    `Manual mode — prompt for ${ev.chatId} ready (${prompt.tokens} tokens). Open the dashboard to copy it, then Capture.`
  );
}

async function captureManualPrompt() {
  const { manualPrompt } = await chrome.storage.local.get({ manualPrompt: null });
  if (!manualPrompt) return { ok: false, error: 'no-prompt' };
  if (Date.now() - (manualPrompt.createdAt || 0) > 30 * 60_000) {
    return { ok: false, error: 'stale-prompt' };
  }
  const settings = await getSettings();
  const conv = { provider: manualPrompt.providerId || null, contextTurns: 0 };
  const pick = await chooseProvider(settings, conv, {});
  if (!pick.id) return { ok: false, error: 'no-provider' };

  providerBusy.add(pick.id);
  await putInflight({
    ...manualPrompt,
    kind: 'manual',
    providerId: pick.id,
    providerTabId: pick.tabId,
    fallbackEnabled: false,
    fallbackText: '',
    prevProvider: null,
    prevContextTurns: 0,
  });
  try {
    await chrome.tabs.sendMessage(pick.tabId, { type: 'wa2:ai-capture', reqId: manualPrompt.reqId });
    log('info', 'ai', `Capture requested from ${pick.id} for ${manualPrompt.chatId}`);
    return { ok: true, provider: pick.id };
  } catch (e) {
    providerBusy.delete(pick.id);
    await takeInflight(manualPrompt.reqId);
    return { ok: false, error: e?.message || String(e) };
  }
}

// =============================================================== summary API
async function summarizeNow(chatId, useAi) {
  const settings = await getSettings();
  let conv = null;
  await withConvs((convs) => {
    conv = convs[chatId] ? { ...convs[chatId] } : null;
  });
  if (!conv) return { ok: false, error: 'unknown-chat' };

  const extractive = makeExtractiveSummary(conv);
  await withConvs((convs) => {
    const c = convs[chatId];
    if (!c) return;
    c.summary = extractive;
    c.summaryTurnCount = c.turnCount || 0;
    c.summaryUpdatedAt = Date.now();
    c.summarySource = 'extractive';
  });

  if (!useAi || settings.summaryMode !== 'ai') return { ok: true, summary: extractive };

  // AI summaries only make sense inside the conversation that the provider tab
  // currently holds — summarising another chat would summarise the wrong text.
  const pick = await chooseProvider(settings, conv, {});
  if (!pick.id || providerActiveChat.get(pick.id) !== chatId) {
    return { ok: true, summary: extractive, ai: false, reason: 'provider-not-on-this-chat' };
  }

  const reqId = uid('sum');
  const recent = (conv.turns || []).slice(-16);
  const prompt =
    `[WA2-TURN:${reqId}]\n` +
    'Summarise the conversation below for future reference in at most 70 words. ' +
    'Keep names, decisions, commitments and unanswered questions. Output only the summary.\n\n' +
    recent.map((t) => `${t.role === 'me' ? 'Me' : 'Them'}: ${t.text}`).join('\n');
  await putInflight({
    reqId,
    kind: 'summary',
    providerId: pick.id,
    providerTabId: pick.tabId,
    chatId,
    waTabId: null,
    taskId: null,
    createdAt: Date.now(),
    fallbackEnabled: false,
  });
  providerBusy.add(pick.id);
  try {
    await chrome.tabs.sendMessage(pick.tabId, { type: 'wa2:ai-request', reqId, prompt, contextMode: 'summary' });
    setTimeout(async () => {
      if (!providerBusy.has(pick.id)) return;
      providerBusy.delete(pick.id);
      await takeInflight(reqId);
      log('warn', 'summary', `AI summary for ${chatId} timed out`);
    }, (settings.aiTimeoutMs || 90_000) + 15_000);
    return { ok: true, summary: extractive, ai: true, provider: pick.id };
  } catch (e) {
    providerBusy.delete(pick.id);
    await takeInflight(reqId);
    return { ok: true, summary: extractive, ai: false, error: e?.message || String(e) };
  }
}

// ============================================================== sent / status
async function onSent(msg) {
  const p = pending.get(msg.chatId);
  if (p && msg.taskId && p.taskId !== msg.taskId) {
    log('warn', 'queue', `Ack ${msg.taskId} does not match pending ${p.taskId} for ${msg.chatId}`);
  }
  pending.delete(msg.chatId);

  if (!msg.ok) {
    if (p) {
      await withConvs((convs) => {
        const c = convs[msg.chatId];
        if (c) c.lastReplyAt = p.prevLastReplyAt || 0;
      });
    }
    log('error', 'send', `Send failed → ${msg.chatId}: ${msg.error || 'unknown error'}`);
    return;
  }

  await recordOutgoing({
    chatId: msg.chatId,
    text: msg.text,
    provider: msg.provider,
    via: msg.via,
  });
  await recordSendTime();
  const settings = await getSettings();
  await maybeUpdateSummary(msg.chatId, settings);
  log(
    'info',
    'send',
    `Delivered → ${msg.chatId} via ${msg.provider || msg.via || 'fixed'} (${String(msg.text || '').length} chars)`
  );
}

async function onStatus(detail, sender) {
  await chrome.storage.local.set({ status: detail || {} });
  await refreshBadge();
  // Status is pushed on every queue change; only log material transitions.
  const key = JSON.stringify({
    m: detail?.mainReady,
    e: detail?.enabled,
    h: detail?.hookInstalled,
    q: detail?.queueCount,
    v: detail?.wppVersion,
  });
  if (key !== lastStatusKey) {
    lastStatusKey = key;
    log('info', 'status', `WhatsApp tab ${sender?.tab?.id ?? '?'}: ${JSON.stringify(detail)}`);
  }
}

let lastStatusKey = '';

async function onQueueState(state) {
  const items = Array.isArray(state?.items) ? state.items.slice(0, 30) : [];
  await chrome.storage.local.set({
    queue: {
      updatedAt: Date.now(),
      active: state?.active || null,
      items: items.map((it) => ({
        taskId: it.taskId,
        chatId: it.chatId,
        chatName: it.chatName || '',
        text: truncate(it.text || '', 120),
        dueAt: it.dueAt || 0,
        status: it.status || 'pending',
        attempts: it.attempts || 0,
      })),
    },
  });
}

// ================================================================ lifecycle
async function injectMainWorldFallback(tabId) {
  const t0 = Date.now();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['vendor/wppconnect-wa.js', 'content/wa-main.js'],
    });
    log('info', 'boot', `MAIN-world fallback injection into tab ${tabId} in ${Date.now() - t0}ms (${results?.length ?? '?'})`);
  } catch (e) {
    log('error', 'boot', `MAIN-world fallback injection FAILED: ${e?.message || e}`);
  }
}

async function cleanupInflight() {
  const now = Date.now();
  await withInflight((m) => {
    for (const [id, entry] of Object.entries(m)) {
      if (!entry || now - entry.createdAt > 10 * 60_000) {
        providerBusy.delete(entry?.providerId);
        pending.delete(entry?.chatId);
        delete m[id];
      }
    }
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  log('info', 'boot', `Extension ${details.reason} — v${VERSION}`);
  const stored = await chrome.storage.sync.get(null);
  if (!Object.keys(stored).length) {
    await chrome.storage.sync.set(normalizeSettings({}));
    log('info', 'boot', 'Initialised default settings');
  }
  await chrome.storage.local.get({ convs: {}, overrides: {} });
  chrome.alarms.create('wa2:heartbeat', { periodInMinutes: 1 });
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  log('info', 'boot', `Browser started — v${VERSION}`);
  chrome.alarms.create('wa2:heartbeat', { periodInMinutes: 1 });
  await cleanupInflight();
  await refreshBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'wa2:heartbeat') return;
  refreshBadge();
  cleanupInflight();
});

// ================================================================= messages
async function handleMessage(msg, sender) {
  switch (msg?.type) {
    case 'wa2:log':
      enqueueLog(msg.level, msg.tag || 'page', msg.message);
      return { ok: true };

    case 'wa2:incoming':
      handleIncoming(msg, sender).catch((e) => log('error', 'incoming', `Handler crashed: ${e?.message || e}`));
      return { ok: true };

    case 'wa2:status':
      await onStatus(msg.detail, sender);
      return { ok: true };

    case 'wa2:sent':
      await onSent(msg);
      return { ok: true };

    case 'wa2:queue-state':
      await onQueueState(msg.state);
      return { ok: true };

    case 'wa2:ai-response':
      await onProviderResponse(msg);
      return { ok: true };

    case 'wa2:ai-capture':
      return captureManualPrompt();

    // ---- dashboard API
    case 'wa2:dashboard:state': {
      const settings = await getSettings();
      const tabs = await findProviderTabs();
      return {
        ok: true,
        version: VERSION,
        providers: PROVIDER_IDS.map((id) => ({
          id,
          tabId: tabs[id] ?? null,
          busy: providerBusy.has(id),
          activeChat: providerActiveChat.get(id) || null,
          stats: providerStats[id],
          enabled: settings.enabledProviders[id],
        })),
        aiQueue: aiQueue.length,
        pendingChats: [...pending.keys()],
      };
    }

    case 'wa2:dashboard:summarize':
      return summarizeNow(msg.chatId, !!msg.useAi);

    case 'wa2:dashboard:capture':
      return captureManualPrompt();

    case 'wa2:dashboard:cancel-queue': {
      const tabs = await chrome.tabs.query({ url: WA_MATCH });
      await Promise.all(
        tabs.map((t) =>
          chrome.tabs
            .sendMessage(t.id, { type: 'wa2:cancel', chatId: msg.chatId || null })
            .catch(() => undefined)
        )
      );
      log('info', 'queue', `Cancel requested for ${msg.chatId || 'all chats'}`);
      return { ok: true };
    }

    case 'wa2:dashboard:clear-data': {
      await chrome.storage.local.set({ convs: {}, overrides: {} });
      log('warn', 'conv', 'Conversation history and per-chat overrides cleared by the dashboard');
      return { ok: true };
    }

    default:
      return { ok: false, error: 'unknown-message' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((e) => {
      log('error', 'bg', `Message ${msg?.type} failed: ${e?.message || e}`);
      sendResponse({ ok: false, error: e?.message || String(e) });
    });
  return true; // async response
});

// ==================================================================== tabs
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab?.url) return;
  if (tab.url.startsWith('https://web.whatsapp.com')) {
    log('info', 'boot', `WhatsApp Web tab loaded (tab ${tabId})`);
    await injectMainWorldFallback(tabId);
    await refreshBadge();
    return;
  }
  for (const p of PROVIDERS) {
    if (p.matches.some((m) => tab.url.startsWith(m.replace('*', '')))) {
      log('info', 'provider', `${p.label} tab ready (tab ${tabId})`);
      return;
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  // Fail any AI job whose provider tab just vanished instead of waiting for the timeout.
  const { aiInflight = {} } = await chrome.storage.local.get({ aiInflight: {} });
  for (const entry of Object.values(aiInflight)) {
    if (entry && entry.providerTabId === tabId) {
      await failAi(entry, 'provider tab closed');
    }
  }

  const tabs = await chrome.tabs.query({ url: WA_MATCH });
  if (!tabs.length) {
    log('warn', 'boot', 'All WhatsApp Web tabs closed — auto-reply is paused until reopened');
    await chrome.storage.local.set({ status: {} });
    await refreshBadge();
  }
});

// Keep the badge and stale state fresh even when nothing else wakes the worker.
refreshBadge();
cleanupInflight();
