/* WA Auto Reply — MAIN world script (runs inside the WhatsApp Web page)
 *
 * Responsibilities:
 *   - subscribe to WPP.chat 'chat.new_message' and normalise the event
 *   - resolve chat metadata (name, group / community / channel)
 *   - hand the event to the background orchestrator through the bridge
 *   - run the outbound queue: human delay, read receipt, "typing…" presence,
 *     serialized sends, retries, and ack reporting
 *
 * It has no chrome.* access; the ISOLATED bridge relays CustomEvents.
 */

(() => {
  'use strict';

  if (window.__WA2__) return;
  window.__WA2__ = true;

  // -------------------------------------------------------------- logging
  function log(level, tag, message) {
    const line = `[WA2][${tag}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
    send('wa2-log', { level, tag, message: String(message) });
  }

  function send(name, payload) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(payload) }));
    } catch (e) {
      console.warn('[WA2] dispatch failed', name, e);
    }
  }

  function parseDetail(detail) {
    if (typeof detail !== 'string') return detail || {};
    try {
      return JSON.parse(detail);
    } catch {
      return {};
    }
  }

  window.addEventListener('error', (e) => log('error', 'page', `Uncaught: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => log('error', 'page', `Unhandled rejection: ${e.reason}`));

  // -------------------------------------------------------------- settings
  const DEFAULT_SETTINGS = {
    enabled: false,
    replyMode: 'fixed',
    typingSimulation: true,
    typingCps: 14,
    markSeen: true,
    minGapBetweenSendsMs: 2000,
  };
  let settings = { ...DEFAULT_SETTINGS };
  let bridgeSeen = false;

  window.addEventListener('wa2-settings', (e) => {
    bridgeSeen = true;
    const detail = parseDetail(e.detail);
    const wasEnabled = settings.enabled;
    settings = { ...DEFAULT_SETTINGS, ...(detail || {}) };
    // Turning the master switch off should not still send a queued reply.
    if (wasEnabled && !settings.enabled) cancelQueued(null);
    pushStatus();
  });

  // Bridge may have pushed settings before this listener existed.
  window.dispatchEvent(new CustomEvent('wa2-request-settings'));

  // -------------------------------------------------------------- state
  let wppReady = false;
  let hookInstalled = false;
  const metaCache = new Map(); // chatId -> { meta, at }
  const queuedTasks = new Set();
  const seenIncoming = new Set();
  let lastSendAt = 0;

  function pushStatus() {
    send('wa2-status', {
      mainReady: wppReady,
      engine: 'wa-js',
      enabled: settings.enabled,
      hookInstalled,
      wppVersion: window.WPP?.version || null,
      queueCount: queue.filter((q) => q.status === 'pending' || q.status === 'sending').length,
      replyMode: settings.replyMode,
      bridgeSeen,
    });
  }

  // -------------------------------------------------------------- WPP boot
  function waitForWpp() {
    return new Promise((resolve) => {
      const started = Date.now();
      let lastBeat = 0;
      const iv = setInterval(() => {
        if (window.WPP) {
          clearInterval(iv);
          resolve(window.WPP);
          return;
        }
        const waited = (Date.now() - started) / 1000;
        if (waited - lastBeat >= 10) {
          lastBeat = waited;
          log('warn', 'main', `Still waiting for window.WPP… ${waited.toFixed(0)}s (wa-js may not support this WhatsApp Web build)`);
          pushStatus();
        }
      }, 1000);
    });
  }

  async function boot() {
    log('info', 'main', 'Main-world script starting');
    pushStatus();
    try {
      const WPP = await waitForWpp();
      log('info', 'main', `wa-js loaded (WPP v${WPP.version || '?'})`);
      installHook(WPP);

      let ready = false;
      try {
        ready = WPP.isMainReady?.() || WPP.isFullReady?.() || false;
      } catch (e) {
        log('warn', 'main', `isMainReady() threw: ${e?.message || e}`);
      }
      if (ready) markMainReady();
      else {
        log('info', 'main', 'Waiting for WhatsApp main connection (event + 2s polling)…');
        WPP.on?.('conn.main_ready', () => markMainReady());
        pollMainReady(WPP);
      }
    } catch (err) {
      log('error', 'main', `Boot failed: ${err?.message || err}`);
      pushStatus();
    }
  }

  function installHook(WPP) {
    if (hookInstalled) return;
    hookInstalled = true;
    const on = WPP.chat?.on?.bind(WPP.chat) || WPP.on.bind(WPP);
    on('chat.new_message', (msg) => {
      handleNewMessage(msg).catch((e) => log('error', 'incoming', `Handler error: ${e?.message || e}`));
    });
    log('info', 'main', "Subscribed to 'chat.new_message'");
    pushStatus();
  }

  function markMainReady() {
    if (wppReady) return;
    wppReady = true;
    log('info', 'main', 'WhatsApp main connection ready ✔');
    pushStatus();
  }

  function pollMainReady(WPP) {
    let tries = 0;
    const iv = setInterval(() => {
      tries += 1;
      if (wppReady) {
        clearInterval(iv);
        return;
      }
      let ready = false;
      try {
        ready = WPP.isMainReady?.() || WPP.isFullReady?.() || false;
      } catch {
        ready = false;
      }
      if (ready) {
        clearInterval(iv);
        markMainReady();
        return;
      }
      if (tries % 8 === 0) {
        log('info', 'main', `heartbeat: main_ready still false after ${tries * 2}s`);
        pushStatus();
      }
    }, 2000);
  }

  // -------------------------------------------------------------- message ids
  function serializedValue(v) {
    if (!v) return null;
    if (typeof v === 'string') return v.includes('@') ? v : null;
    if (typeof v === 'number') return null;
    if (typeof v === 'object') {
      if (typeof v._serialized === 'string' && v._serialized.includes('@')) return v._serialized;
      if (v.user != null && typeof v.server === 'string') return `${v.user}@${v.server}`;
      if (v.id) return serializedValue(v.id);
    }
    return null;
  }

  function getChatId(msg) {
    for (const cand of [msg?.chatId, msg?.chatWid, msg?.chat?.id, msg?.chat, msg?.from, msg?.from?.id]) {
      const s = serializedValue(cand);
      if (s) return s;
    }
    return null;
  }

  function msgIdOf(msg) {
    const serialized = serializedValue(msg?.id);
    if (serialized) {
      // wa-js serialises MsgKey as "<fromMe>_<chat>_<messageId>". Keep only the
      // stable message id so the same event with/without _serialized maps to a
      // single dedupe key (a mismatch here used to allow a second reply).
      const tail = serialized.match(/_([^_]+)$/);
      return tail ? tail[1] : serialized;
    }
    if (msg?.id && msg.id.id) return String(msg.id.id);
    if (msg?.t != null) return `t${msg.t}`;
    return `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function isFromMe(msg) {
    if (!msg) return false;
    if (msg.id && msg.id.fromMe === true) return true;
    if (msg.fromMe === true) return true;
    const self = msg.self;
    return self === 'out' || self === true || self === 1 || String(self || '').includes('out');
  }

  const IGNORED_TYPES = new Set([
    'e2e_notification',
    'notification',
    'notification_template',
    'gp2',
    'protocol',
    'revoked',
    'call_log',
    'ciphertext',
    'order',
  ]);

  // -------------------------------------------------------------- chat metadata
  function fallbackKind(chatId) {
    if (chatId === 'status@broadcast' || (chatId.endsWith('@broadcast') && chatId.includes('status'))) return 'status';
    if (chatId.endsWith('@g.us')) return 'group';
    if (chatId.endsWith('@newsletter')) return 'newsletter';
    if (chatId.endsWith('@broadcast')) return 'broadcast';
    return chatId ? 'contact' : 'unknown';
  }

  function kindFromModel(model, chatId) {
    const base = fallbackKind(chatId);
    if (base !== 'group' || !model) return base;
    try {
      const gm = model.groupMetadata || null;
      return model.isParentGroup === true || (gm && (gm.groupType === 'COMMUNITY' || gm.parentGroup))
        ? 'community'
        : 'group';
    } catch {
      return base;
    }
  }

  async function lookupChat(chatId) {
    const cached = metaCache.get(chatId);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.meta;
    let kind = fallbackKind(chatId);
    let name = '';
    try {
      if (typeof window.WPP?.chat?.get === 'function') {
        const model = await Promise.resolve(window.WPP.chat.get(chatId));
        if (model) {
          name = model.name || model.formattedTitle || model.pushname || '';
          kind = kindFromModel(model, chatId);
        }
      }
    } catch (e) {
      log('warn', 'conv', `chat.get(${chatId}) failed: ${e?.message || e}`);
    }
    const meta = { id: chatId, name, kind };
    metaCache.set(chatId, { meta, at: Date.now() });
    if (metaCache.size > 300) metaCache.delete(metaCache.keys().next().value);
    return meta;
  }

  // -------------------------------------------------------------- incoming
  async function handleNewMessage(msg) {
    const chatId = getChatId(msg);
    const body = String(msg?.body || msg?.caption || '');
    const type = String(msg?.type || 'chat');
    if (!chatId) {
      log('error', 'incoming', `Could not resolve a chat id (keys: ${msg ? Object.keys(msg).join(',') : 'null'})`);
      return;
    }
    if (IGNORED_TYPES.has(type)) return;

    // De-duplicate at the page too: wa-js can emit the same message more than
    // once (reconnect/ack transitions) and two AI jobs would both answer it.
    const msgId = msgIdOf(msg);
    const dedupeKey = `${chatId}|${msgId}`;
    if (seenIncoming.has(dedupeKey)) {
      log('info', 'incoming', `Duplicate event for ${dedupeKey} — ignored`);
      return;
    }
    seenIncoming.add(dedupeKey);
    if (seenIncoming.size > 500) seenIncoming.delete(seenIncoming.values().next().value);

    const meta = await lookupChat(chatId);
    const event = {
      chatId,
      msgId,
      body,
      fromMe: isFromMe(msg),
      kind: meta.kind,
      chatName: meta.name || msg?.notifyName || '',
      notifyName: msg?.notifyName || msg?.sender?.pushname || '',
      ts: msg?.t ? msg.t * 1000 : Date.now(),
      type,
    };

    log(
      'info',
      'incoming',
      `${event.fromMe ? 'OUT' : 'IN'} ${event.chatId} [${event.kind}] ${event.chatName || ''}: "${cut(body, 70)}"`
    );
    send('wa2-incoming', { event });
    pushStatus();
  }

  function cut(text, max) {
    const t = String(text || '');
    return t.length > max ? t.slice(0, max) + '…' : t;
  }

  // -------------------------------------------------------------- outbound queue
  // { taskId, chatId, chatName, text, dueAt, status, attempts, typing, markSeen, provider, via }
  const queue = [];
  let pumping = false;
  let pumpTimer = null;
  let queueStateTimer = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  const randomBetween = (a, b) => Math.min(a, b) + Math.random() * Math.abs(b - a);

  function typingDurationFor(text) {
    const cps = Math.max(1, Number(settings.typingCps) || 14);
    const raw = (String(text || '').length / cps) * 1000;
    return Math.round(Math.min(12_000, Math.max(1_200, raw)));
  }

  function enqueueReply(detail) {
    if (!detail || !detail.taskId || !detail.chatId || !detail.text) {
      log('warn', 'queue', `Ignored malformed reply task: ${JSON.stringify(detail || {}).slice(0, 200)}`);
      return;
    }
    if (queuedTasks.has(detail.taskId)) return;
    queuedTasks.add(detail.taskId);
    if (queuedTasks.size > 500) queuedTasks.delete(queuedTasks.values().next().value);

    const min = Number(detail.delayMinMs);
    const max = Number(detail.delayMaxMs);
    const lo = Number.isFinite(min) ? Math.max(0, min) : 2000;
    const hi = Number.isFinite(max) ? Math.max(lo, max) : 7000;
    const delay = Math.round(randomBetween(lo, hi));

    const item = {
      taskId: detail.taskId,
      chatId: detail.chatId,
      chatName: detail.chatName || '',
      text: String(detail.text),
      dueAt: Date.now() + delay,
      enqueuedAt: Date.now(),
      status: 'pending',
      attempts: 0,
      typing: detail.typing !== false,
      markSeen: detail.markSeen !== false,
      provider: detail.provider || null,
      via: detail.via || 'fixed',
    };
    queue.push(item);
    log(
      'info',
      'queue',
      `+ ${item.taskId} → ${item.chatName || item.chatId} in ${(delay / 1000).toFixed(1)}s ` +
        `(${queue.length} pending, ${item.provider || item.via})`
    );
    pushStatus();
    updateQueueState();
    schedulePump();
  }

  function schedulePump() {
    if (pumpTimer) {
      clearTimeout(pumpTimer);
      pumpTimer = null;
    }
    if (pumping || !queue.length) return;
    const pending = queue.filter((q) => q.status === 'pending');
    if (!pending.length) return;
    const next = pending.reduce((a, b) => (a.dueAt <= b.dueAt ? a : b));
    const wait = Math.max(0, next.dueAt - Date.now());
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pump();
    }, Math.min(wait, 2_147_000_000));
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const now = Date.now();
        const idx = queue.findIndex((q) => q.status === 'pending' && q.dueAt <= now);
        if (idx === -1) break;
        const item = queue[idx];
        item.status = 'sending';
        updateQueueState();
        await sendItem(item);
        // A failed send resets the item to 'pending' for one retry — keep it.
        if (item.status !== 'sending') {
          updateQueueState();
          pushStatus();
          schedulePump();
          continue;
        }
        const at = queue.indexOf(item);
        if (at !== -1) queue.splice(at, 1);
        updateQueueState();
        pushStatus();
        schedulePump();
      }
    } catch (e) {
      log('error', 'queue', `Pump crashed: ${e?.message || e}`);
    } finally {
      pumping = false;
      schedulePump();
    }
  }

  async function markSeen(chatId) {
    try {
      if (typeof window.WPP?.chat?.markIsRead === 'function') {
        await window.WPP.chat.markIsRead(chatId);
        log('info', 'presence', `Marked read: ${chatId}`);
      }
    } catch (e) {
      log('warn', 'presence', `markIsRead failed for ${chatId}: ${e?.message || e}`);
    }
  }

  async function startTyping(chatId, durationMs) {
    try {
      if (typeof window.WPP?.chat?.markIsComposing === 'function') {
        await window.WPP.chat.markIsComposing(chatId, durationMs);
        return true;
      }
    } catch (e) {
      log('warn', 'presence', `typing failed for ${chatId}: ${e?.message || e}`);
    }
    return false;
  }

  async function stopTyping(chatId) {
    try {
      if (typeof window.WPP?.chat?.markIsPaused === 'function') {
        await window.WPP.chat.markIsPaused(chatId);
      }
    } catch {
      /* presence is cosmetic */
    }
  }

  async function sendItem(item) {
    const started = Date.now();
    item.attempts += 1;

    // Respect the global minimum gap between any two sends.
    const gap = Math.max(0, Number(settings.minGapBetweenSendsMs) || 0);
    const waitForGap = lastSendAt + gap - Date.now();
    if (waitForGap > 0) await sleep(waitForGap);

    // The configured delay is done at this point. Read → typing → send.
    const waited = item.enqueuedAt ? Date.now() - item.enqueuedAt : 0;
    log('info', 'queue', `Delay complete after ${waited}ms → ${item.chatId}: marking read, then typing`);

    if (item.markSeen && settings.markSeen) await markSeen(item.chatId);

    if (item.typing && settings.typingSimulation) {
      const typingMs = typingDurationFor(item.text);
      const ok = await startTyping(item.chatId, typingMs + 1000);
      if (ok) log('info', 'presence', `Typing… ${typingMs}ms → ${item.chatId}`);
      else log('warn', 'presence', `Typing presence unavailable for ${item.chatId}; waiting ${typingMs}ms anyway`);
      // Presence is cosmetic — always keep the human pacing even if the API
      // refuses to show "typing…".
      await sleep(typingMs);
      if (ok) await stopTyping(item.chatId);
    }

    // A short, human "hit send" hesitation.
    await sleep(randomBetween(250, 900));

    try {
      // wa-js marks the chat read by default; honour our setting explicitly.
      const result = await window.WPP.chat.sendTextMessage(item.chatId, item.text, {
        markIsRead: !!settings.markSeen,
      });
      lastSendAt = Date.now();
      const id = serializedValue(result?.id) || 'ok';
      log('info', 'send', `✔ ${item.chatId} in ${Date.now() - started}ms (msg ${id})`);
      send('wa2-sent', {
        taskId: item.taskId,
        chatId: item.chatId,
        chatName: item.chatName,
        text: item.text,
        ok: true,
        provider: item.provider,
        via: item.via,
        latencyMs: Date.now() - started,
      });
    } catch (err) {
      const message = err?.message || String(err);
      if (item.attempts < 2) {
        log('warn', 'send', `Send failed (${message}) — retrying once`);
        await sleep(2000);
        item.dueAt = Date.now();
        item.status = 'pending';
        pushStatus();
        updateQueueState();
        schedulePump();
        return;
      }
      log('error', 'send', `✖ ${item.chatId}: ${message}`);
      lastSendAt = Date.now();
      send('wa2-sent', {
        taskId: item.taskId,
        chatId: item.chatId,
        text: item.text,
        ok: false,
        error: message,
        provider: item.provider,
        via: item.via,
      });
    }
  }

  function cancelQueued(chatId) {
    let removed = 0;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].status === 'pending' && (!chatId || queue[i].chatId === chatId)) {
        queue.splice(i, 1);
        removed += 1;
      }
    }
    log('info', 'queue', `Cancelled ${removed} queued reply(ies)${chatId ? ` for ${chatId}` : ''}`);
    updateQueueState();
    pushStatus();
    schedulePump();
  }

  function queueSnapshot() {
    return {
      items: queue
        .filter((q) => q.status === 'pending' || q.status === 'sending')
        .map((q) => ({
          taskId: q.taskId,
          chatId: q.chatId,
          chatName: q.chatName,
          text: q.text,
          dueAt: q.dueAt,
          status: q.status,
          attempts: q.attempts,
        })),
      active: queue.find((q) => q.status === 'sending')?.taskId || null,
    };
  }

  function updateQueueState() {
    if (queueStateTimer) return;
    queueStateTimer = setTimeout(() => {
      queueStateTimer = null;
      send('wa2-queue-state', { state: queueSnapshot() });
    }, 300);
  }

  // -------------------------------------------------------------- bridge events
  window.addEventListener('wa2-reply', (e) => {
    enqueueReply(parseDetail(e.detail));
  });

  window.addEventListener('wa2-cancel', (e) => {
    const d = parseDetail(e.detail);
    cancelQueued(d.chatId || null);
  });

  window.addEventListener('wa2-bridge-request', (e) => {
    const { reqId, type } = e.detail || {};
    if (type !== 'ping') return;
    window.dispatchEvent(
      new CustomEvent('wa2-bridge-response', {
        detail: JSON.stringify({
          reqId,
          result: {
            ok: wppReady,
            engine: 'wa-js',
            mainReady: wppReady,
            hookInstalled,
            enabled: settings.enabled,
            wppVersion: window.WPP?.version || null,
            queueCount: queue.length,
          },
        }),
      })
    );
  });

  // -------------------------------------------------------------- start
  pushStatus();
  updateQueueState();
  boot();
})();
