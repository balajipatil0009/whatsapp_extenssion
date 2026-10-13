const enabledEl = document.getElementById('enabled');
const groupsEl = document.getElementById('replyToGroups');
const replyTextEl = document.getElementById('replyText');
const statusEl = document.getElementById('status');
const logsLink = document.getElementById('openLogs');

const DEFAULTS = {
  enabled: false,
  replyText: 'Thanks for your message! I will get back to you soon.',
  replyToGroups: false,
  minRetryMs: 3000,
};

async function pingWhatsAppTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*', active: true, currentWindow: true });
    const tab = tabs[0] || (await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }))[0];
    if (!tab) return { ok: false, reason: 'no-tab' };
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'wa2:ping' });
    return resp ?? { ok: false, reason: 'no-response' };
  } catch {
    return { ok: false, reason: 'no-response' };
  }
}

function renderStatus(state, enabled) {
  if (!state.ok && state.reason === 'no-tab') {
    statusEl.textContent = 'WhatsApp Web not open';
    statusEl.className = 'status warn';
  } else if (!state.ok) {
    statusEl.textContent = state.reason === 'main-world-not-responding' ? 'WhatsApp not ready — see Logs' : 'Page not ready — see Logs';
    statusEl.className = 'status warn';
  } else if (state.mainReady) {
    statusEl.textContent = "Listening ✓ (wa-js 'chat.new_message')";
    statusEl.className = 'status ok';
  } else {
    statusEl.textContent = 'Waiting for WhatsApp to connect…';
    statusEl.className = 'status warn';
  }
  logsLink.textContent = '📋 Open diagnostic logs';
}

async function saveSettings() {
  const settings = {
    enabled: enabledEl.checked,
    replyToGroups: groupsEl.checked,
    replyText: replyTextEl.value.trim() || DEFAULTS.replyText,
  };
  await chrome.storage.sync.set(settings);
}

enabledEl.addEventListener('change', saveSettings);
groupsEl.addEventListener('change', saveSettings);
replyTextEl.addEventListener('blur', saveSettings);
logsLink.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('logs/logs.html') });
});

(async () => {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  enabledEl.checked = settings.enabled;
  groupsEl.checked = settings.replyToGroups;
  replyTextEl.value = settings.replyText;
  const state = await pingWhatsAppTab();
  renderStatus(state, settings.enabled);
})();
