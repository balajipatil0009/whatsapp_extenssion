/* WA Auto Reply — ISOLATED bridge script
 *
 * The MAIN world (wa-main.js) has WPP but no chrome.* ; the extension pages and
 * service worker have chrome.* but cannot touch the page. This bridge is the
 * only link. All structured payloads are JSON strings so nothing depends on
 * cross-world object wrapping.
 */

(() => {
  'use strict';

  // Reuse the shared defaults; lib/defaults.js runs just before this file.
  const lib = self.WA2 || {};
  const normalizeSettings = lib.normalizeSettings || ((s) => s || {});

  // Extension context guard — reloading the extension in chrome://extensions
  // kills chrome.runtime for content scripts still living in open tabs.
  let contextDead = false;
  function extAlive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }
  function failDead() {
    if (contextDead) return true;
    contextDead = true;
    console.warn(
      '[WA2] Extension context invalidated — reload the WhatsApp tab to reconnect. (Bridge going quiet.)'
    );
    return true;
  }
  function sendMsg(payload) {
    if (!extAlive()) return failDead();
    try {
      chrome.runtime.sendMessage(payload).catch((e) => {
        if (String(e?.message || e).includes('invalidated')) failDead();
      });
    } catch {
      failDead();
    }
    return false;
  }

  function parseDetail(detail) {
    if (typeof detail !== 'string') return detail || {};
    try {
      return JSON.parse(detail);
    } catch {
      return {};
    }
  }

  function dispatch(name, payload) {
    window.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(payload) }));
  }

  const sendLog = (level, message) => sendMsg({ type: 'wa2:log', level, tag: 'bridge', message });

  // ------------------------------------------------------- settings push
  async function pushSettings() {
    try {
      const stored = await chrome.storage.sync.get(null);
      const settings = normalizeSettings(stored);
      dispatch('wa2-settings', settings);
      sendLog('info', `Settings pushed: enabled=${settings.enabled}, engine=${settings.replyMode}`);
    } catch (err) {
      sendLog('error', `Failed to push settings: ${err?.message || err}`);
    }
  }

  window.addEventListener('wa2-request-settings', () => {
    sendLog('info', 'MAIN world requested settings — pushing');
    pushSettings();
  });

  // Retry until the MAIN world acks with a status push (injection order between
  // worlds is not guaranteed). Capped so a broken injection cannot spam.
  let settingsAcked = false;
  let settingsTries = 0;
  window.addEventListener('wa2-status', () => {
    settingsAcked = true;
  });
  const settingsRetry = setInterval(() => {
    if (settingsAcked || contextDead) {
      clearInterval(settingsRetry);
      return;
    }
    if (++settingsTries >= 20) {
      clearInterval(settingsRetry);
      sendLog('error', 'MAIN world never acked settings after 60s — wa-main.js probably did not inject (check Logs)');
      return;
    }
    pushSettings();
  }, 3000);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') pushSettings();
  });

  // ------------------------------------------------------- page → background
  window.addEventListener('wa2-log', (e) => {
    const d = parseDetail(e.detail);
    sendMsg({ type: 'wa2:log', level: d.level || 'info', tag: d.tag || 'main', message: d.message || '' });
  });

  window.addEventListener('wa2-status', (e) => {
    sendMsg({ type: 'wa2:status', detail: parseDetail(e.detail) });
  });

  window.addEventListener('wa2-incoming', (e) => {
    const d = parseDetail(e.detail);
    if (d && d.event) sendMsg({ type: 'wa2:incoming', event: d.event });
  });

  window.addEventListener('wa2-sent', (e) => {
    const d = parseDetail(e.detail);
    sendMsg({ type: 'wa2:sent', ...d });
  });

  window.addEventListener('wa2-queue-state', (e) => {
    const d = parseDetail(e.detail);
    sendMsg({ type: 'wa2:queue-state', state: d.state || {} });
  });

  // ------------------------------------------------------- background → page
  const pendingPings = new Map();
  let lastStatus = null;

  window.addEventListener('wa2-status', (e) => {
    lastStatus = parseDetail(e.detail);
  });

  window.addEventListener('wa2-bridge-response', (e) => {
    const d = parseDetail(e.detail);
    const resolve = pendingPings.get(d.reqId);
    if (resolve) {
      pendingPings.delete(d.reqId);
      resolve(d.result);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'wa2:reply' || msg?.type === 'wa2:cancel') {
      dispatch(msg.type === 'wa2:reply' ? 'wa2-reply' : 'wa2-cancel', msg);
      sendResponse?.({ ok: true });
      return false;
    }

    if (msg?.type === 'wa2:ai-response') {
      // Legacy manual-capture delivery path.
      dispatch('wa2-ai-response', msg);
      sendLog('info', `AI response ${msg.reqId} delivered to page (ok=${msg.ok})`);
      return false;
    }

    if (msg?.type === 'wa2:ping') {
      const reqId = Math.random().toString(36).slice(2);
      pendingPings.set(reqId, sendResponse);
      setTimeout(() => {
        if (pendingPings.has(reqId)) {
          pendingPings.delete(reqId);
          sendResponse(lastStatus || { ok: false, reason: 'main-world-not-responding' });
        }
      }, 900);
      window.dispatchEvent(new CustomEvent('wa2-bridge-request', { detail: { reqId, type: 'ping' } }));
      return true; // async response
    }

    return false;
  });

  sendLog('info', 'Bridge installed — relaying settings/logs/events');
  pushSettings();
})();
