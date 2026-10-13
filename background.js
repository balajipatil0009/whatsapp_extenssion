/* WA Auto Reply — background service worker (MV3)
 *
 * Central log store (ring buffer in chrome.storage.local — powers the Logs
 * page), live connection status, and toolbar badge.
 */

const MAX_LOGS = 2000;
const DEFAULT_SETTINGS = { enabled: false };

async function appendLog(entry) {
  try {
    const { logs = [] } = await chrome.storage.local.get({ logs: [] });
    logs.push({
      i: logs.length,
      t: Date.now(),
      level: entry.level || 'info',
      tag: entry.tag || 'bg',
      message: String(entry.message ?? ''),
    });
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    await chrome.storage.local.set({ logs });
  } catch (e) {
    console.warn('[WA2][bg] appendLog failed', e);
  }
}

function log(level, message) {
  console.log(`[WA2][bg] ${message}`);
  appendLog({ level, tag: 'bg', message });
}

// ---------------------------------------------------------------- status
async function updateStatus(enabledOverride) {
  // 'enabled' lives in chrome.storage.sync (popup writes there);
  // connection 'status' lives in chrome.storage.local (wa2:status handler).
  const [{ enabled }, { status }] = await Promise.all([
    chrome.storage.sync.get({ enabled: false }),
    chrome.storage.local.get({ status: {} }),
  ]);
  const waTabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });

  let text = '';
  let color = '#777';
  if (enabledOverride ?? enabled) {
    if (waTabs.length && status?.mainReady) {
      text = 'ON';
      color = '#25D366';
    } else if (waTabs.length) {
      text = 'WAIT';
      color = '#f5a623';
    } else {
      text = 'IDLE';
      color = '#777';
    }
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

// ---------------------------------------------------------------- listeners
chrome.runtime.onInstalled.addListener(async (details) => {
  log('info', `Extension ${details.reason === 'update' ? 'updated' : 'installed'} — v1.0.0`);
  chrome.storage.sync.get(DEFAULT_SETTINGS, ({ enabled }) => {
    if (typeof enabled !== 'boolean') chrome.storage.sync.set({ enabled: false });
  });
  await updateStatus();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'wa2:log') {
    appendLog(msg);
    return false;
  }
  if (msg?.type === 'wa2:status') {
    chrome.storage.local.set({ status: msg.detail || {} });
    log('info', `Status from tab ${sender?.tab?.id ?? '?'}: ${JSON.stringify(msg.detail)}`);
    updateStatus();
    return false;
  }
  if (msg?.type === 'wa2:sent') {
    log('info', `Reply sent: ${JSON.stringify(msg)}`);
    return false;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && 'enabled' in changes) updateStatus(changes.enabled.newValue);
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === 'complete' && tab.url?.startsWith('https://web.whatsapp.com')) {
    log('info', `WhatsApp Web tab loaded (tab ${tabId})`);
    await injectMainWorldFallback(tabId);
    await updateStatus();
  }
});

// ---------------------------------------------------------------- fallback injection
// Belt-and-suspenders: if manifest-declared MAIN-world injection failed for any
// reason (injection races, blocked evals, etc.), inject via scripting API.
// wa-main.js has a window.__WA2__ dedup guard, so double-injection is a no-op.
async function injectMainWorldFallback(tabId) {
  const t0 = Date.now();
  log('info', `Fallback: injecting MAIN-world scripts into tab ${tabId}…`);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['vendor/wppconnect-wa.js', 'content/wa-main.js'],
    });
    log('info', `Fallback injection done in ${Date.now() - t0}ms (${results?.length ?? '?'} results)`);
  } catch (e) {
    log('error', `Fallback injection FAILED: ${e?.message || e}`);
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (!tabs.length) {
    log('warn', 'All WhatsApp Web tabs closed — auto-reply cannot run until reopened');
    chrome.storage.local.set({ status: {} });
    await updateStatus();
  }
});

// Heartbeat: refresh badge even if the SW wakes silently.
setInterval(updateStatus, 30_000);
