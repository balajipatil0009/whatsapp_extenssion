/* WA Auto Reply — compact popup. Full control lives in the dashboard. */
(() => {
  'use strict';

  const { normalizeSettings } = window.WA2;
  const $ = (id) => document.getElementById(id);
  let settings = normalizeSettings({});

  function render() {
    $('enabled').checked = settings.enabled;
    $('replyText').value = settings.replyText;
    $('replyToContacts').checked = settings.replyToContacts;
    $('replyToGroups').checked = settings.replyToGroups;
    $('replyToCommunities').checked = settings.replyToCommunities;
    $('replyToNewsletters').checked = settings.replyToNewsletters;

    const mode = settings.replyMode;
    document.querySelectorAll('#modeSwitch button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    $('fixedBox').hidden = mode !== 'fixed';
    $('botBox').hidden = mode !== 'bot';
    $('aiBox').hidden = mode !== 'ai';

    $('delayLine').textContent = `${(settings.replyDelayMinMs / 1000).toFixed(0)}–${(settings.replyDelayMaxMs / 1000).toFixed(0)}s delay`;
    $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  }

  async function refreshBots() {
    const { bots = [] } = await chrome.storage.local.get({ bots: [] });
    const list = Array.isArray(bots) ? bots : [];
    const enabled = list.filter((b) => b.enabled !== false).length;
    $('botSummary').textContent = list.length
      ? `${enabled} of ${list.length} bot${list.length === 1 ? '' : 's'} enabled. One bot answers each message; keywords are configured in the dashboard.`
      : 'No bots yet. Create your first keyword bot in the dashboard.';
  }

  async function save(patch) {
    settings = normalizeSettings({ ...settings, ...patch });
    await chrome.storage.sync.set(settings);
    render();
    refreshStatus();
  }

  async function refreshStatus() {
    const statusEl = $('status');
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    } catch {
      tabs = [];
    }
    if (!tabs.length) {
      statusEl.textContent = settings.enabled ? 'WhatsApp Web not open' : 'Off · WhatsApp Web not open';
      statusEl.className = 'status warn';
    } else {
      try {
        const res = await chrome.tabs.sendMessage(tabs[0].id, { type: 'wa2:ping' });
        if (res && res.mainReady) {
          statusEl.textContent = settings.enabled ? 'Listening ✓' : 'Off · connected';
          statusEl.className = settings.enabled ? 'status ok' : 'status';
        } else if (res && res.reason === 'main-world-not-responding') {
          statusEl.textContent = 'Reload WhatsApp Web tab';
          statusEl.className = 'status bad';
        } else {
          statusEl.textContent = 'Connecting…';
          statusEl.className = 'status warn';
        }
      } catch {
        statusEl.textContent = 'Reload WhatsApp Web tab';
        statusEl.className = 'status bad';
      }
    }
  }

  async function refreshQueue() {
    const { queue = { items: [] } } = await chrome.storage.local.get({ queue: { items: [] } });
    const n = (queue.items || []).length;
    $('queueLine').textContent = `Queue: ${n} pending`;
  }

  function openDashboard(tab) {
    chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard/dashboard.html#${tab}`) });
  }

  // ---------------------------------------------------------------- events
  $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  $('replyToContacts').addEventListener('change', (e) => save({ replyToContacts: e.target.checked }));
  $('replyToGroups').addEventListener('change', (e) => save({ replyToGroups: e.target.checked }));
  $('replyToCommunities').addEventListener('change', (e) => save({ replyToCommunities: e.target.checked }));
  $('replyToNewsletters').addEventListener('change', (e) => save({ replyToNewsletters: e.target.checked }));

  $('modeSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn || btn.disabled) return;
    save({ replyMode: btn.dataset.mode });
  });

  let textTimer = null;
  $('replyText').addEventListener('input', (e) => {
    clearTimeout(textTimer);
    const value = e.target.value;
    textTimer = setTimeout(() => save({ replyText: value }), 450);
  });

  $('openDashboard').addEventListener('click', () => {
    const tab = settings.replyMode === 'bot' ? 'bot' : settings.replyMode === 'ai' ? 'ai' : 'common';
    openDashboard(tab);
  });
  $('openBots').addEventListener('click', () => openDashboard('bot'));
  $('openLogs').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('logs/logs.html') });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      chrome.storage.sync.get(null).then((raw) => {
        settings = normalizeSettings(raw);
        render();
      });
    }
    if (area === 'local' && changes.queue) refreshQueue();
    if (area === 'local' && changes.bots) refreshBots();
  });

  // ---------------------------------------------------------------- init
  (async () => {
    const raw = await chrome.storage.sync.get(null);
    settings = normalizeSettings(raw);
    render();
    await Promise.all([refreshStatus(), refreshQueue(), refreshBots()]);
    setInterval(() => {
      refreshStatus();
      refreshQueue();
    }, 5000);
  })();
})();
