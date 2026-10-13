/* WA Auto Reply — ISOLATED bridge script
 *
 * The MAIN world script (with WPP) cannot use chrome.* APIs, this bridge
 * connects it to the extension: settings in, logs/status/pings out.
 *
 * main → here:  CustomEvent 'wa2-log' / 'wa2-status'
 * here → main:  CustomEvent 'wa2-settings', 'wa2-bridge-request'
 */

(() => {
  'use strict';

  const sendLog = (level, message) =>
    chrome.runtime.sendMessage({ type: 'wa2:log', level, tag: 'bridge', message }).catch(() => {});

  // ------------------------------------------------------- settings push
  const DEFAULT_SETTINGS = {
    enabled: false,
    replyText: 'Thanks for your message! I will get back to you soon.',
    replyToGroups: false,
    minRetryMs: 3000,
  };

  async function pushSettings() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      const settings = { ...DEFAULT_SETTINGS, ...stored };
      window.dispatchEvent(new CustomEvent('wa2-settings', { detail: settings }));
      sendLog('info', `Settings pushed to page: enabled=${settings.enabled}`);
    } catch (err) {
      sendLog('error', `Failed to push settings: ${err?.message || err}`);
    }
  }

  // Re-push on request from the MAIN world (covers race where the bridge
  // pushed settings before wa-main's listener was registered).
  window.addEventListener('wa2-request-settings', () => {
    sendLog('info', 'MAIN world requested settings — pushing');
    pushSettings();
  });

  // Keep trying until we see the MAIN world ack a status push — injection
  // order between worlds is not guaranteed. Capped at 20 tries (60 s) so we
  // don't flood the log buffer if the MAIN world never injects.
  let settingsAcked = false;
  let settingsTries = 0;
  window.addEventListener('wa2-status', () => { settingsAcked = true; });
  const settingsRetry = setInterval(() => {
    if (settingsAcked) {
      clearInterval(settingsRetry);
      return;
    }
    if (++settingsTries >= 20) {
      clearInterval(settingsRetry);
      sendLog('error', 'MAIN world never acked settings after 60s — wa-main.js likely did not inject (check background Fallback lines)');
      return;
    }
    pushSettings();
  }, 3000);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.enabled || changes.replyText || changes.replyToGroups || changes.minRetryMs)) {
      pushSettings();
    }
  });

  // ------------------------------------------------------- log/status relay
  window.addEventListener('wa2-log', (e) => {
    const d = e.detail || {};
    chrome.runtime.sendMessage({ type: 'wa2:log', level: d.level || 'info', tag: d.tag || 'main', message: d.message || '' }).catch(() => {});
  });

  window.addEventListener('wa2-status', (e) => {
    chrome.runtime.sendMessage({ type: 'wa2:status', detail: e.detail }).catch(() => {});
  });

  // ------------------------------------------------------- ping forwarding
  let lastStatus = null;
  window.addEventListener('wa2-status', (e) => {
    lastStatus = e.detail;
  });

  const pendingPings = new Map();
  window.addEventListener('wa2-bridge-response', (e) => {
    const { reqId, result } = e.detail || {};
    const resolve = pendingPings.get(reqId);
    if (resolve) {
      pendingPings.delete(reqId);
      resolve(result);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'wa2:ping') {
      const reqId = Math.random().toString(36).slice(2);
      pendingPings.set(reqId, sendResponse);
      // If WPP never boots, resolve with last known (or null) status.
      setTimeout(() => {
        if (pendingPings.has(reqId)) {
          pendingPings.delete(reqId);
          sendResponse(lastStatus || { ok: false, reason: 'main-world-not-responding' });
        }
      }, 800);
      window.dispatchEvent(new CustomEvent('wa2-bridge-request', { detail: { reqId, type: 'ping' } }));
      return true; // async sendResponse
    }
    return false;
  });

  sendLog('info', 'Bridge installed — relaying settings/logs/status');
  pushSettings();
})();
