/* WA Auto Reply — MAIN world script (runs in the WhatsApp Web page itself)
 *
 * Uses WhatsApp's own API exposed by wa-js (@wppconnect/wa-js, vendor/wppconnect-wa.js):
 *   - WPP.chat.on('chat.new_message')  → real incoming-message events
 *   - WPP.chat.sendTextMessage()       → protocol-level sending
 *
 * This script has no access to chrome.* APIs, so it talks to the ISOLATED
 * bridge (content/wa-bridge.js) via window CustomEvents:
 *   bridge → main:  'wa2-settings'             (detail: settings object)
 *                   'wa2-bridge-request'       (detail: { reqId, type })
 *   main → bridge:  'wa2-log'                  (detail: { level, tag, message })
 *                   'wa2-status'               (detail: { mainReady, engine, ... })
 *                   'wa2-bridge-response'      (detail: { reqId, result })
 *                   'wa2-request-settings'     (main asks bridge to re-send settings)
 */

(() => {
  'use strict';

  // Dedup guard — the background also injects these files as a fallback,
  // so bail out if we already ran once in this page.
  if (window.__WA2__) return;
  window.__WA2__ = true;

  // -------------------------------------------------------------- logging
  function log(level, tag, message) {
    const line = `[WA2][${tag}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    window.dispatchEvent(
      new CustomEvent('wa2-log', { detail: { level, tag, message: String(message) } })
    );
  }

  // Surface page crashes into the log channel too.
  window.addEventListener('error', (e) => log('error', 'page', `Uncaught: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) =>
    log('error', 'page', `Unhandled rejection: ${e.reason}`)
  );

  // -------------------------------------------------------------- settings
  const DEFAULT_SETTINGS = {
    enabled: false,
    replyText: 'Thanks for your message! I will get back to you soon.',
    replyToGroups: false,
    minRetryMs: 3000,
  };
  let settings = { ...DEFAULT_SETTINGS };

  window.addEventListener('wa2-settings', (e) => {
    settings = { ...DEFAULT_SETTINGS, ...e.detail };
    log('info', 'main', `Settings received: enabled=${settings.enabled}`);
    pushStatus();
  });

  // Ask the bridge to (re)push settings — covers the case where the bridge
  // pushed settings *before* this listener was registered.
  window.dispatchEvent(new CustomEvent('wa2-request-settings'));

  // -------------------------------------------------------------- state
  let wppReady = false;
  let hookInstalled = false;
  const sentIds = new Set();
  const lastReplyAt = new Map();

  function pushStatus() {
    window.dispatchEvent(
      new CustomEvent('wa2-status', {
        detail: {
          mainReady: wppReady,
          engine: 'wa-js',
          enabled: settings.enabled,
          hookInstalled,
          wppVersion: window.WPP?.version || null,
        },
      })
    );
  }

  // -------------------------------------------------------------- WPP setup
  /**
   * Poll for window.WPP forever, logging a heartbeat every 10 s so the Logs
   * page always shows whether/much wait we've been through.
   */
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
          log('warn', 'main', `Still waiting for window.WPP… ${waited.toFixed(0)}s (wa-js may not have booted against this WhatsApp Web version)`);
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
      log('info', 'main', `wa-js loaded (WPP version: ${WPP.version || 'unknown'})`);

      // Hook messages IMMEDIATELY — don't gate subscription on conn.main_ready.
      // The event may fire before we subscribe; the reply path guards on readiness.
      installHook(WPP);

      // Wait for main readiness via BOTH the event and a 2s poll — the event
      // can be missed, and isMainReady() flips true slightly later.
      let ready = false;
      try { ready = WPP.isMainReady?.() || WPP.isFullReady?.() || false; } catch (e) {
        log('warn', 'main', `isMainReady() threw: ${e?.message || e}`);
      }
      if (ready) {
        markMainReady();
      } else {
        log('info', 'main', 'Waiting for WhatsApp main connection (event + 2s polling)…');
        WPP.on?.('conn.main_ready', () => markMainReady());
        waitForMainReady(WPP);
      }
    } catch (err) {
      log('error', 'main', `Boot failed: ${err?.message || err}`);
      pushStatus();
    }
  }

  function installHook(WPP) {
    if (hookInstalled) return;
    hookInstalled = true;
    // Some wa-js builds expose WPP.chat.on; others use global WPP.on.
    const on = WPP.chat?.on?.bind(WPP.chat) || WPP.on.bind(WPP);
    on('chat.new_message', (msg) => {
      try {
        handleNewMessage(msg).catch((e) =>
          log('error', 'reply', `Handler error: ${e?.message || e}`)
        );
      } catch (e) {
        log('error', 'reply', `Event dispatch error: ${e?.message || e}`);
      }
    });
    log('info', 'main', "Subscribed to 'chat.new_message' events (pre or post main_ready)");
    pushStatus();
  }

  function markMainReady() {
    if (wppReady) return;
    wppReady = true;
    log('info', 'main', 'WhatsApp main connection ready ✔');
    pushStatus();
  }

  function waitForMainReady(WPP) {
    let tries = 0;
    const iv = setInterval(() => {
      tries += 1;
      if (wppReady) { clearInterval(iv); return; }
      let ready = false;
      try { ready = WPP.isMainReady?.() || WPP.isFullReady?.() || false; } catch (e) {
        ready = false;
      }
      if (ready) { clearInterval(iv); markMainReady(); return; }
      // Heartbeat every ~16 s so the Logs page shows we're alive and how long.
      if (tries % 8 === 0) {
        log('info', 'main', `heartbeat: main_ready still false after ${tries * 2}s (isMainReady=${ready})`);
        pushStatus();
      }
    }, 2000);
  }

  // -------------------------------------------------------------- reply logic
  /** Normalize WhatsApp ids (WID objects, Chat models, strings) to 'user@c.us' strings. */
  function serializedValue(v) {
    if (!v) return null;
    if (typeof v === 'string') return v.includes('@') ? v : null;
    if (typeof v === 'object') {
      if (typeof v._serialized === 'string' && v._serialized.includes('@')) return v._serialized;
      if (v.user != null && typeof v.server === 'string') return `${v.user}@${v.server}`;
      return serializedValue(v.id);
    }
    return null;
  }

  /** Resolve which chat a message belongs to — wa-js models differ from what the docs suggest. */
  function getChatId(msg) {
    for (const cand of [msg?.chatId, msg?.chatWid, msg?.chat, msg?.chat?.id, msg?.from, msg?.from?.id]) {
      const s = serializedValue(cand);
      if (s) return s;
    }
    return null;
  }

  function msgIdOf(msg) {
    return serializedValue(msg?.id) || (msg?.t != null ? String(msg.t) : String(Date.now()));
  }

  function safeDump(v) {
    try { return JSON.stringify(v ?? null); } catch { return '[unserializable]'; }
  }

  async function handleNewMessage(msg) {
    const chatId = getChatId(msg);
    const bodyText = msg?.body || msg?.text || '';
    log(
      'info',
      'incoming',
      `Message from ${serializedValue(msg?.from) || '?'} chat=${chatId || 'UNRESOLVED'} self=${msg?.self} group=${(chatId || '').endsWith('@g.us')}: "${cut(bodyText)}"`
    );

    if (!chatId) {
      log('error', 'reply', `Could not resolve chat id from event — NOT replying. msg keys=[${msg ? Object.keys(msg).join(',') : 'null'}] id=${safeDump(msg?.id)} chat=${safeDump(msg?.chat)} from=${safeDump(msg?.from)}`);
      return;
    }

    if (!settings.enabled) {
      log('info', 'reply', 'Auto-reply is OFF — skipping');
      return;
    }
    if (!wppReady) {
      log('warn', 'reply', 'WPP not ready yet — skipping');
      return;
    }
    // Skip our own outgoing messages (self is 'out' or includes out flag).
    if (msg?.self && String(msg.self).includes('out')) {
      log('info', 'reply', 'Own outgoing message — skipping');
      return;
    }
    // Skip groups unless allowed.
    const isGroup = chatId.endsWith('@g.us');
    if (isGroup && !settings.replyToGroups) {
      log('info', 'reply', 'Group message — skipping (groups are off in settings)');
      return;
    }
    const msgKey = `${chatId}:${msgIdOf(msg)}`;
    if (sentIds.has(msgKey)) {
      log('info', 'reply', `Already replied to ${msgKey} — skipping dup`);
      return;
    }
    const now = Date.now();
    const last = lastReplyAt.get(chatId) || 0;
    if (now - last < settings.minRetryMs) {
      log('info', 'reply', `Cooldown active for ${chatId} — skipping`);
      sentIds.add(msgKey);
      return;
    }
    sentIds.add(msgKey);
    lastReplyAt.set(chatId, now);

    // Small human-like jitter before sending.
    const delay = Math.floor(Math.random() * 800) + 400; // 400–1200 ms
    log('info', 'send', `Sending reply in ${delay}ms → ${chatId}`);
    await new Promise((r) => setTimeout(r, delay));

    try {
      const result = await window.WPP.chat.sendTextMessage(chatId, settings.replyText);
      log('info', 'send', `Reply sent ✔ → ${chatId} (send result: ${safeDump(result?.id) || 'ok'})`);
    } catch (err) {
      log('error', 'send', `Send failed → ${chatId}: ${err?.message || err}`);
      // Allow a retry on a future message from the same chat.
      sentIds.delete(msgKey);
      lastReplyAt.delete(chatId);
      throw err;
    }
  }

  function cut(text) {
    const t = String(text || '');
    return t.length > 60 ? t.slice(0, 60) + '…' : t;
  }

  // -------------------------------------------------------------- ping handler
  window.addEventListener('wa2-bridge-request', (e) => {
    const { reqId, type } = e.detail || {};
    if (type === 'ping') {
      window.dispatchEvent(
        new CustomEvent('wa2-bridge-response', {
          detail: {
            reqId,
            result: {
              ok: wppReady,
              engine: 'wa-js',
              mainReady: wppReady,
              hookInstalled,
              enabled: settings.enabled,
              wppVersion: window.WPP?.version || null,
              whatsappUrl: location.href.startsWith('https://web.whatsapp.com'),
            },
          },
        })
      );
    }
  });

  pushStatus();
  boot();
})();
