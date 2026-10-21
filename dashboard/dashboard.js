/* WA Auto Reply — dashboard controller (vanilla JS, no build step) */

(() => {
  'use strict';

  const WA2 = window.WA2;
  const {
    PROVIDER_IDS,
    DEFAULT_SETTINGS,
    normalizeSettings,
  } = WA2;
  const { findMatchingBot, findKeywordOwner, validateBot, normalizeText } = window.WA2Bots;

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    settings: normalizeSettings({}),
    convs: {},
    overrides: {},
    bots: [],
    queue: { items: [], updatedAt: 0 },
    status: {},
    manualPrompt: null,
    runtime: {}, // providerId -> {tabId, busy, activeChat, stats}
    filter: 'all',
    search: '',
    activeChat: null,
    activeTab: 'conversations',
    commonSection: 'engine',
    editingBotId: null,
    draftKeywords: [],
  };

  // ------------------------------------------------------------------ utils
  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.round(s / 60) || 1}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  function dueIn(ts) {
    if (!ts) return '';
    const s = Math.round((ts - Date.now()) / 1000);
    return s <= 0 ? 'sending…' : `in ${s}s`;
  }

  let toastTimer = null;
  function toast(message, ms = 2600) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, ms);
  }

  // ------------------------------------------------------------------ load
  async function loadSettings() {
    const raw = await chrome.storage.sync.get(null);
    state.settings = normalizeSettings(raw);
  }

  async function loadLocal() {
    const d = await chrome.storage.local.get({
      convs: {},
      overrides: {},
      bots: [],
      queue: { items: [], updatedAt: 0 },
      status: {},
      manualPrompt: null,
    });
    state.convs = d.convs || {};
    state.overrides = d.overrides || {};
    state.bots = (Array.isArray(d.bots) ? d.bots : [])
      .filter((b) => b && typeof b === 'object')
      .map((b) => ({ ...b, keywords: Array.isArray(b.keywords) ? b.keywords : [] }));
    state.queue = d.queue || { items: [], updatedAt: 0 };
    state.status = d.status || {};
    state.manualPrompt = d.manualPrompt || null;
  }

  async function refreshRuntime() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'wa2:dashboard:state' });
      if (res && res.ok) {
        state.runtime = Object.fromEntries((res.providers || []).map((p) => [p.id, p]));
      }
    } catch {
      /* service worker asleep or reloading */
    }
  }

  // ------------------------------------------------------------------ settings
  async function saveSettings(patch) {
    const next = normalizeSettings({ ...state.settings, ...patch });
    state.settings = next;
    await chrome.storage.sync.set(next);
    applySettingsToInputs();
    renderMode();
    renderHints();
    renderConvs();
    if (state.activeChat && !isEditingSheet()) renderSheet(state.activeChat);
  }

  function applySettingsToInputs() {
    const s = state.settings;
    const set = (id, value, prop = 'value') => {
      const el = $(id);
      if (!el) return;
      if (document.activeElement === el && prop === 'value') return;
      el[prop] = value;
    };
    set('enabled', s.enabled, 'checked');
    set('replyText', s.replyText);
    set('replyToContacts', s.replyToContacts, 'checked');
    set('replyToGroups', s.replyToGroups, 'checked');
    set('replyToCommunities', s.replyToCommunities, 'checked');
    set('replyToNewsletters', s.replyToNewsletters, 'checked');
    set('typingSimulation', s.typingSimulation, 'checked');
    set('markSeen', s.markSeen, 'checked');
    set('delayMinSec', (s.replyDelayMinMs / 1000).toString());
    set('delayMaxSec', (s.replyDelayMaxMs / 1000).toString());
    set('gapSec', (s.minGapBetweenSendsMs / 1000).toString());
    set('cooldownSec', (s.minRetryMs / 1000).toString());
    set('staleSec', (s.maxMessageAgeMs / 1000).toString());
    set('maxSendsPerHour', String(s.maxSendsPerHour));
  }

  function bindSettings() {
    $('enabled').addEventListener('change', (e) => saveSettings({ enabled: e.target.checked }));
    $('replyToContacts').addEventListener('change', (e) => saveSettings({ replyToContacts: e.target.checked }));
    $('replyToGroups').addEventListener('change', (e) => saveSettings({ replyToGroups: e.target.checked }));
    $('replyToCommunities').addEventListener('change', (e) => saveSettings({ replyToCommunities: e.target.checked }));
    $('replyToNewsletters').addEventListener('change', (e) => saveSettings({ replyToNewsletters: e.target.checked }));
    $('typingSimulation').addEventListener('change', (e) => saveSettings({ typingSimulation: e.target.checked }));
    $('markSeen').addEventListener('change', (e) => saveSettings({ markSeen: e.target.checked }));

    const textSave = debounce((key, value) => saveSettings({ [key]: value }), 500);
    $('replyText').addEventListener('input', (e) => textSave('replyText', e.target.value));

    const bindSeconds = (id, key, min) =>
      $(id).addEventListener('change', (e) => {
        const n = Number(e.target.value);
        if (!Number.isFinite(n)) return;
        saveSettings({ [key]: Math.round(Math.max(min, n) * 1000) });
      });
    bindSeconds('delayMinSec', 'replyDelayMinMs', 0);
    bindSeconds('delayMaxSec', 'replyDelayMaxMs', 0);
    bindSeconds('gapSec', 'minGapBetweenSendsMs', 0);
    bindSeconds('cooldownSec', 'minRetryMs', 0);
    bindSeconds('staleSec', 'maxMessageAgeMs', 0);

    const bindInt = (id, key, min, max) =>
      $(id).addEventListener('change', (e) => {
        const n = Number(e.target.value);
        if (!Number.isFinite(n)) return;
        saveSettings({ [key]: Math.min(max, Math.max(min, Math.round(n))) });
      });
    bindInt('maxSendsPerHour', 'maxSendsPerHour', 1, 500);

    $('resetPacing').addEventListener('click', () => {
      saveSettings({
        replyDelayMinMs: DEFAULT_SETTINGS.replyDelayMinMs,
        replyDelayMaxMs: DEFAULT_SETTINGS.replyDelayMaxMs,
        typingSimulation: DEFAULT_SETTINGS.typingSimulation,
        markSeen: DEFAULT_SETTINGS.markSeen,
        maxSendsPerHour: DEFAULT_SETTINGS.maxSendsPerHour,
        minGapBetweenSendsMs: DEFAULT_SETTINGS.minGapBetweenSendsMs,
        minRetryMs: DEFAULT_SETTINGS.minRetryMs,
        maxMessageAgeMs: DEFAULT_SETTINGS.maxMessageAgeMs,
      });
      toast('Pacing reset to defaults');
    });

    $('modeSwitch').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-mode]');
      if (!btn || btn.disabled) return;
      await saveSettings({ replyMode: btn.dataset.mode });
      if (btn.dataset.mode === 'bot') setTab('bot');
    });
  }

  function renderMode() {
    const mode = state.settings.replyMode;
    document.querySelectorAll('#modeSwitch button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    $('fixedField').hidden = mode !== 'fixed';
    $('botHint').hidden = mode !== 'bot';
    const hints = {
      fixed: 'Every allowed chat receives the fixed reply above.',
      bot: 'Keyword bots answer. Messages that no bot matches stay unanswered.',
      ai: 'AI is active from an earlier version. Its configuration screen is coming soon; switch to Fixed or Bot to change engines.',
    };
    $('modeHint').textContent = hints[mode] || '';
  }

  function renderHints() {
    $('delayHint').textContent =
      `Order: wait ${(state.settings.replyDelayMinMs / 1000).toFixed(1)}–${(state.settings.replyDelayMaxMs / 1000).toFixed(1)}s ` +
      `→ mark read → show “typing…” for reply length ÷ ${state.settings.typingCps} cps (1.2–12s) → send. ` +
      `Total = wait + typing + a 0.25–0.9s hesitation.`;
    const enabledBots = state.bots.filter((b) => b.enabled !== false).length;
    $('botCount').textContent = state.bots.length ? `${enabledBots}/${state.bots.length} on` : 'none';
  }

  // ------------------------------------------------------------------ navigation
  function setTab(tabName) {
    const allowed = ['conversations', 'common', 'bot', 'ai'];
    const tab = allowed.includes(tabName) ? tabName : 'conversations';
    state.activeTab = tab;

    document.querySelectorAll('#mainTabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('[data-rail]').forEach((r) => {
      r.hidden = r.dataset.rail !== tab;
    });
    document.querySelectorAll('[data-pane]').forEach((p) => {
      p.hidden = p.dataset.pane !== tab;
    });

    if (tab === 'conversations') ensureConversationSelection();
    else if (tab === 'bot') ensureBotSelection();
    else if (tab === 'common') setCommonSection(state.commonSection);

    try {
      history.replaceState(null, '', `#${tab}`);
    } catch {
      /* file:// or restricted context */
    }
  }

  function setCommonSection(name) {
    const allowed = ['engine', 'recipients', 'pacing', 'queue'];
    const section = allowed.includes(name) ? name : 'engine';
    state.commonSection = section;
    document.querySelectorAll('[data-common]').forEach((card) => {
      card.hidden = card.dataset.common !== section;
    });
    document.querySelectorAll('#commonSections [data-section]').forEach((b) => {
      b.classList.toggle('active', b.dataset.section === section);
    });
  }

  function ensureConversationSelection() {
    if (state.activeChat && state.convs[state.activeChat]) {
      renderSheet(state.activeChat);
      return;
    }
    const first =
      visibleConvs()[0] ||
      Object.values(state.convs).sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))[0];
    if (first) {
      state.activeChat = first.id;
      renderSheet(first.id);
      renderConvs();
    } else {
      state.activeChat = null;
      renderConversationEmpty();
    }
  }

  function ensureBotSelection() {
    if (state.editingBotId && botById(state.editingBotId)) {
      renderBotList();
      renderBotEditorActions();
      return;
    }
    if (state.bots.length) startEditBot(state.bots[0].id, false);
    else resetBotEditor();
  }

  function bindTabs() {
    $('mainTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (btn) setTab(btn.dataset.tab);
    });
    $('commonSections').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-section]');
      if (btn) setCommonSection(btn.dataset.section);
    });
    document.addEventListener('click', (e) => {
      const goto = e.target.closest('[data-goto-tab]');
      if (goto) setTab(goto.dataset.gotoTab);
    });
  }

  // ------------------------------------------------------------------ bots
  function botById(id) {
    return state.bots.find((b) => b.id === id) || null;
  }

  function showBotError(message) {
    const el = $('botError');
    el.textContent = message;
    el.hidden = !message;
  }

  function hideBotError() {
    $('botError').hidden = true;
  }

  function renderKeywordDraft() {
    const list = $('botKeywords');
    if (!state.draftKeywords.length) {
      list.innerHTML = '<span class="muted" style="font-size:11.5px">No keywords yet — add at least one.</span>';
      return;
    }
    list.innerHTML = state.draftKeywords
      .map(
        (k, i) =>
          `<span class="kw-edit ${k.type === 'exact' ? 'exact' : ''}">${esc(k.text)}` +
          `<button type="button" class="kw-type" data-action="toggle-keyword-type" data-index="${i}" ` +
          `title="Switch to ${k.type === 'exact' ? 'contains' : 'exact'}">${esc(k.type)}</button>` +
          `<button type="button" class="kw-remove" data-action="remove-keyword" data-index="${i}" aria-label="Remove keyword">✕</button></span>`
      )
      .join('');
  }

  function resetBotEditor() {
    state.editingBotId = null;
    state.draftKeywords = [];
    $('botName').value = '';
    $('botReply').value = '';
    $('botKeywordInput').value = '';
    $('botKeywordType').value = 'contains';
    $('botEditorTitle').textContent = 'New bot';
    $('botEditorState').textContent = 'Draft';
    hideBotError();
    renderKeywordDraft();
    renderBotEditorActions();
    renderBotList();
  }

  function renderBotEditorActions() {
    const actions = $('botEditActions');
    if (!actions) return;
    const bot = state.editingBotId ? botById(state.editingBotId) : null;
    actions.hidden = !bot;
    if (!bot) return;
    const index = state.bots.findIndex((b) => b.id === state.editingBotId);
    $('botMoveUp').disabled = index <= 0;
    $('botMoveDown').disabled = index < 0 || index >= state.bots.length - 1;
  }

  function startNewBot() {
    resetBotEditor();
    $('botName').focus();
  }

  function startEditBot(id, focus = true) {
    const bot = botById(id);
    if (!bot) return;
    state.editingBotId = id;
    state.draftKeywords = (bot.keywords || []).map((k) => ({ text: k.text, type: k.type === 'exact' ? 'exact' : 'contains' }));
    $('botName').value = bot.name || '';
    $('botReply').value = bot.reply || '';
    $('botEditorTitle').textContent = 'Edit bot';
    $('botEditorState').textContent = 'Editing';
    hideBotError();
    renderKeywordDraft();
    renderBotEditorActions();
    renderBotList();
    if (focus) $('botName').focus();
  }

  function addKeyword() {
    const input = $('botKeywordInput');
    const text = input.value.replace(/\s+/g, ' ').trim();
    const type = $('botKeywordType').value === 'exact' ? 'exact' : 'contains';
    if (!text) {
      showBotError('Type a keyword first.');
      return;
    }
    const key = normalizeText(text);
    if (state.draftKeywords.some((k) => normalizeText(k.text) === key)) {
      showBotError('That keyword is already in this bot.');
      return;
    }
    const owner = findKeywordOwner(state.bots, text, state.editingBotId);
    if (owner) {
      showBotError(`That keyword is already used by the bot "${owner.name}". Keywords must be unique across bots.`);
      return;
    }
    state.draftKeywords.push({ text, type });
    input.value = '';
    hideBotError();
    renderKeywordDraft();
    input.focus();
  }

  function renderBotList() {
    const list = $('botList');
    if (!list) return;
    if (!state.bots.length) {
      list.innerHTML = '<div class="empty-bots">No bots yet. Create one to start replying by keyword.</div>';
      renderHints();
      return;
    }
    list.innerHTML = state.bots
      .map((b, index) => {
        const keywords = b.keywords || [];
        const exactCount = keywords.filter((k) => k.type === 'exact').length;
        return `<div class="rail-item bot-item ${b.id === state.editingBotId ? 'active' : ''} ${
          b.enabled === false ? 'off' : ''
        }" data-id="${esc(b.id)}">
          <input type="checkbox" class="switch" data-action="toggle-bot" title="Enable / disable bot" ${
            b.enabled === false ? '' : 'checked'
          } />
          <button type="button" class="rail-item-main" data-action="edit-bot">
            <span class="rail-item-name">${esc(b.name || b.id)}</span>
            <span class="rail-item-sub">${keywords.length} kw · ${exactCount} exact · #${index + 1}</span>
          </button>
        </div>`;
      })
      .join('');
    renderHints();
  }

  async function saveBots(bots) {
    await chrome.storage.local.set({ bots });
    state.bots = bots;
    renderBotList();
    renderKeywordDraft();
    renderHints();
  }

  async function saveBotDraft() {
    const wasEditing = !!state.editingBotId;
    const result = validateBot(
      {
        name: $('botName').value,
        reply: $('botReply').value,
        keywords: state.draftKeywords,
      },
      state.bots,
      state.editingBotId
    );
    if (!result.ok) {
      showBotError(result.errors.join(' '));
      return;
    }
    const now = Date.now();
    let bots;
    let savedId = state.editingBotId;
    if (wasEditing) {
      bots = state.bots.map((b) => (b.id === state.editingBotId ? { ...b, ...result.bot, updatedAt: now } : b));
    } else {
      savedId =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `bot_${now}_${Math.random().toString(36).slice(2, 7)}`;
      bots = [...state.bots, { id: savedId, ...result.bot, enabled: true, createdAt: now, updatedAt: now }];
    }
    await saveBots(bots);
    startEditBot(savedId, false);
    toast(wasEditing ? 'Bot updated' : 'Bot created');
  }

  async function deleteBot(id) {
    const bot = botById(id);
    if (!bot) return;
    if (!confirm(`Delete the bot "${bot.name}"?`)) return;
    const bots = state.bots.filter((b) => b.id !== id);
    await saveBots(bots);
    if (state.editingBotId === id) {
      if (state.bots.length) startEditBot(state.bots[0].id, false);
      else resetBotEditor();
    }
    toast('Bot deleted');
  }

  async function toggleBot(id, enabled) {
    const bots = state.bots.map((b) => (b.id === id ? { ...b, enabled, updatedAt: Date.now() } : b));
    await saveBots(bots);
  }

  async function moveBot(id, delta) {
    const index = state.bots.findIndex((b) => b.id === id);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= state.bots.length) return;
    const bots = state.bots.slice();
    [bots[index], bots[next]] = [bots[next], bots[index]];
    await saveBots(bots);
    startEditBot(id, false);
  }

  function testerBots() {
    const name = $('botName').value.trim();
    const reply = $('botReply').value.trim();
    const hasDraft = state.draftKeywords.length > 0 || name || reply;
    if (!hasDraft) return state.bots;
    const draft = {
      id: state.editingBotId || '__draft__',
      name: name || 'Draft bot',
      enabled: true,
      reply: reply || '(no reply set)',
      keywords: state.draftKeywords,
    };
    if (state.editingBotId) {
      return state.bots.map((b) => (b.id === state.editingBotId ? { ...b, ...draft } : b));
    }
    return [...state.bots, draft];
  }

  function testBot() {
    const text = $('botTestInput').value;
    const result = $('botTestResult');
    if (!text.trim()) {
      result.className = 'test-result bad';
      result.textContent = 'Type a message to test.';
      return;
    }
    const bots = testerBots();
    const match = findMatchingBot(bots, text);
    if (!match) {
      const normalized = normalizeText(text);
      const partialExact = new Set();
      for (const bot of bots) {
        for (const keyword of bot.keywords || []) {
          const key = normalizeText(keyword.text);
          if (keyword.type === 'exact' && key && key !== normalized && normalized.includes(key)) {
            partialExact.add(keyword.text);
          }
        }
      }
      result.className = 'test-result bad';
      result.textContent = partialExact.size
        ? `No exact match. ${[...partialExact].map((k) => `"${k}"`).join(', ')} appear in this message, but exact means the whole message must equal the keyword. Click the keyword's type in the editor to switch it to contains.`
        : 'No bot matches — no reply would be sent.';
      return;
    }
    const draftNote =
      match.bot.id === '__draft__' || match.bot.id === state.editingBotId ? ' (current editor)' : '';
    result.className = 'test-result ok';
    result.textContent =
      `Bot "${match.bot.name}"${draftNote} matches the ${match.matchType} keyword "${match.keyword.text}" ` +
      `→ "${match.bot.reply}"`;
  }

  function bindBots() {
    $('newBot').addEventListener('click', startNewBot);
    $('botMoveUp').addEventListener('click', () => {
      if (state.editingBotId) moveBot(state.editingBotId, -1);
    });
    $('botMoveDown').addEventListener('click', () => {
      if (state.editingBotId) moveBot(state.editingBotId, 1);
    });
    $('botDelete').addEventListener('click', () => {
      if (state.editingBotId) deleteBot(state.editingBotId);
    });
    $('botCancel').addEventListener('click', () => {
      resetBotEditor();
      toast('New bot draft');
    });
    $('botSave').addEventListener('click', saveBotDraft);
    $('botKeywordAdd').addEventListener('click', addKeyword);
    $('botKeywordInput').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      addKeyword();
    });
    $('botName').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      $('botReply').focus();
    });
    $('botTestBtn').addEventListener('click', testBot);
    $('botTestInput').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      testBot();
    });
    $('botKeywords').addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]');
      if (!action) return;
      const index = Number(action.dataset.index);
      if (!Number.isInteger(index)) return;
      if (action.dataset.action === 'remove-keyword') {
        state.draftKeywords.splice(index, 1);
        hideBotError();
        renderKeywordDraft();
        return;
      }
      if (action.dataset.action === 'toggle-keyword-type') {
        const keyword = state.draftKeywords[index];
        if (!keyword) return;
        keyword.type = keyword.type === 'exact' ? 'contains' : 'exact';
        hideBotError();
        renderKeywordDraft();
        toast(`"${keyword.text}" now uses ${keyword.type} — press Save bot`);
      }
    });
    $('botList').addEventListener('click', (e) => {
      const actionEl = e.target.closest('[data-action="edit-bot"]');
      if (!actionEl) return;
      const id = e.target.closest('[data-id]')?.dataset.id;
      if (id) startEditBot(id);
    });
    $('botList').addEventListener('change', (e) => {
      const input = e.target.closest('[data-action="toggle-bot"]');
      if (!input) return;
      const id = e.target.closest('[data-id]')?.dataset.id;
      if (id) toggleBot(id, input.checked);
    });
  }

  function renderBots() {
    renderBotList();
    renderBotEditorActions();
  }

  // ------------------------------------------------------------------ shared helpers
  function chatName(chatId) {
    if (!chatId) return '';
    return state.convs[chatId]?.name || chatId;
  }

  function isEditingSheet() {
    const el = document.activeElement;
    return !!(el && el.closest && el.closest('#sheetBody') && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
  }

  // ------------------------------------------------------------------ conversations
  function effectiveReply(conv) {
    const o = state.overrides[conv.id] || {};
    if (o.reply === 'on' || o.reply === 'off') return o.reply;
    const kind = o.kind || conv.kind;
    const key =
      kind === 'contact'
        ? 'replyToContacts'
        : kind === 'group'
          ? 'replyToGroups'
          : kind === 'community'
            ? 'replyToCommunities'
            : kind === 'newsletter'
              ? 'replyToNewsletters'
              : null;
    if (!key) return 'off';
    return state.settings[key] ? 'on' : 'off';
  }

  function visibleConvs() {
    const q = state.search.trim().toLowerCase();
    return Object.values(state.convs)
      .filter((c) => {
        const o = state.overrides[c.id] || {};
        const kind = o.kind || c.kind || 'contact';
        if (state.filter === 'off') {
          if (effectiveReply(c) !== 'off') return false;
        } else if (state.filter !== 'all' && kind !== state.filter) return false;
        if (q && !`${c.name || ''} ${c.id}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
  }

  function renderConvs() {
    const list = $('convList');
    const all = Object.values(state.convs);
    const rows = visibleConvs();
    $('convTotal').textContent = String(all.length);

    $('convEmpty').hidden = rows.length > 0;
    if (!rows.length) {
      const title = $('convEmpty').querySelector('p');
      if (title) title.textContent = all.length ? 'No chats match this filter' : 'No conversations yet';
    }
    list.innerHTML = rows
      .map((c) => {
        const o = state.overrides[c.id] || {};
        const kind = o.kind || c.kind || 'contact';
        const eff = effectiveReply(c);
        const title =
          o.reply === 'on' || o.reply === 'off'
            ? `Replies explicitly ${o.reply} for this chat`
            : `Replies inherit the default (${eff})`;
        return `
          <div class="conv ${c.id === state.activeChat ? 'active' : ''}" data-chat="${esc(c.id)}" data-action="details">
            <label class="conv-switch" data-action="toggle-chat" title="${title}">
              <input type="checkbox" class="switch" data-action="toggle-chat" data-chat="${esc(c.id)}" ${
                eff === 'on' ? 'checked' : ''
              } />
            </label>
            <div class="conv-main">
              <div class="conv-title">
                <span class="conv-name">${esc(c.name || c.id)}</span>
                <span class="badge ${esc(kind)}">${esc(kind)}</span>
              </div>
              <div class="conv-preview">${esc(c.lastPreview || 'No messages stored yet')}</div>
            </div>
            <span class="conv-time">${esc(ago(c.lastMessageAt))}</span>
          </div>`;
      })
      .join('');
  }

  async function saveOverride(chatId, patch) {
    const { overrides = {} } = await chrome.storage.local.get({ overrides: {} });
    const next = { ...(overrides[chatId] || {}), ...patch };
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === null || v === '' || v === 'inherit' || v === 'auto') delete next[k];
    }
    if (Object.keys(next).length) overrides[chatId] = next;
    else delete overrides[chatId];
    await chrome.storage.local.set({ overrides });
    state.overrides = overrides;
    renderConvs();
    if (state.activeChat === chatId && !isEditingSheet()) renderSheet(chatId);
  }

  const convList = $('convList');
  convList.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl || actionEl.dataset.action !== 'details') return;
    const chatId = actionEl.dataset.chat || actionEl.closest('[data-chat]')?.dataset.chat;
    if (chatId) openSheet(chatId);
  });

  convList.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-action="toggle-chat"]');
    if (!input) return;
    const chatId = input.dataset.chat;
    const next = input.checked ? 'on' : 'off';
    await saveOverride(chatId, { reply: next });
    if (next === 'off') await chrome.runtime.sendMessage({ type: 'wa2:dashboard:cancel-queue', chatId });
    toast(`${chatName(chatId)}: replies ${next}`);
  });

  $('search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderConvs();
  });
  $('convFilter').addEventListener('change', (e) => {
    state.filter = e.target.value;
    renderConvs();
  });

  // ------------------------------------------------------------------ queue
  function renderQueue() {
    const items = state.queue?.items || [];
    const list = $('queueList');
    if (!items.length) {
      list.innerHTML = '<div class="queue-empty">Nothing waiting — replies go out when their delay ends.</div>';
      $('queueHint').textContent = 'The queue lives in the WhatsApp tab; delays pause if that tab is closed.';
      return;
    }
    list.innerHTML = items
      .slice(0, 12)
      .map(
        (it) => `
        <div class="queue-item">
          <span class="q-name">${esc(it.chatName || chatName(it.chatId))}</span>
          <span class="muted">${esc((it.text || '').slice(0, 42))}${(it.text || '').length > 42 ? '…' : ''}</span>
          <span class="q-due">${esc(it.status === 'sending' ? 'sending…' : dueIn(it.dueAt))}</span>
        </div>`
      )
      .join('');
    $('queueHint').textContent = `${items.length} pending · updating live from the WhatsApp tab. ${
      state.queue.updatedAt ? `Last sync ${ago(state.queue.updatedAt)}.` : ''
    }`;
  }

  $('cancelAll').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'wa2:dashboard:cancel-queue' });
    toast('Cancel requested — the WhatsApp tab will drop pending replies');
    setTimeout(loadLocalAndRender, 400);
  });

  // ------------------------------------------------------------------ status
  async function renderConnection() {
    const pill = $('connPill');
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    } catch {
      tabs = [];
    }
    let text = '';
    let cls = '';
    if (!tabs.length) {
      text = 'WhatsApp closed';
      cls = 'bad';
    } else {
      try {
        const res = await chrome.tabs.sendMessage(tabs[0].id, { type: 'wa2:ping' });
        if (res && res.mainReady) {
          text = 'Listening';
          cls = 'ok';
        } else if (res && res.reason === 'main-world-not-responding') {
          text = 'Reload WhatsApp Web tab';
          cls = 'bad';
        } else {
          text = 'Connecting…';
          cls = 'warn';
        }
      } catch {
        text = 'Reload WhatsApp Web tab';
        cls = 'bad';
      }
    }
    if (!state.settings.enabled) {
      text += ' · off';
      cls = cls === 'bad' ? 'bad' : '';
    }
    pill.textContent = text;
    pill.className = `pill ${cls}`;
  }

  // ------------------------------------------------------- conversation detail
  function renderConversationEmpty() {
    $('convDetail').hidden = true;
    $('convDetailEmpty').hidden = false;
  }

  function openSheet(chatId) {
    state.activeChat = chatId;
    renderSheet(chatId);
    document.querySelectorAll('#convList .conv').forEach((el) => {
      el.classList.toggle('active', el.dataset.chat === chatId);
    });
  }

  function closeSheet() {
    state.activeChat = null;
    renderConversationEmpty();
    document.querySelectorAll('#convList .conv').forEach((el) => el.classList.remove('active'));
  }

  function renderSheet(chatId) {
    const conv = state.convs[chatId];
    if (!conv) {
      closeSheet();
      return;
    }
    $('convDetail').hidden = false;
    $('convDetailEmpty').hidden = true;
    const o = state.overrides[chatId] || {};
    const kind = o.kind || conv.kind || 'contact';
    const eff = effectiveReply(conv);
    $('sheetTitle').textContent = conv.name || chatId;
    $('sheetId').textContent = `${chatId} · ${kind}`;

    const settings = state.settings;
    const turns = (conv.turns || []).slice(-14);

    $('sheetBody').innerHTML = `
      <div class="detail-stats">
        <div class="detail-stat"><b>${conv.incomingCount || 0}</b><span>incoming</span></div>
        <div class="detail-stat"><b>${conv.replyCount || 0}</b><span>replies</span></div>
        <div class="detail-stat"><b>${conv.turnCount || 0}</b><span>turns stored</span></div>
      </div>

      <div class="two">
        <label class="field">
          <span class="label">Replies</span>
          <select data-action="sheet-reply">
            <option value="inherit" ${!o.reply ? 'selected' : ''}>Use default (${eff})</option>
            <option value="on" ${o.reply === 'on' ? 'selected' : ''}>Always reply</option>
            <option value="off" ${o.reply === 'off' ? 'selected' : ''}>Never reply</option>
          </select>
        </label>
        <label class="field">
          <span class="label">Chat type</span>
          <select data-action="sheet-kind">
            <option value="" ${!o.kind ? 'selected' : ''}>Auto detect (${esc(conv.kind || 'contact')})</option>
            <option value="contact" ${o.kind === 'contact' ? 'selected' : ''}>Direct</option>
            <option value="group" ${o.kind === 'group' ? 'selected' : ''}>Group</option>
            <option value="community" ${o.kind === 'community' ? 'selected' : ''}>Community</option>
            <option value="newsletter" ${o.kind === 'newsletter' ? 'selected' : ''}>Channel</option>
          </select>
        </label>
      </div>

      <div class="two">
        <label class="field">
          <span class="label">Delay min (s)</span>
          <input type="number" min="0" max="600" step="0.5" data-action="sheet-delay-min"
            value="${o.delayMinMs != null ? (o.delayMinMs / 1000).toString() : ''}" placeholder="default ${(settings.replyDelayMinMs / 1000).toFixed(1)}" />
        </label>
        <label class="field">
          <span class="label">Delay max (s)</span>
          <input type="number" min="0" max="600" step="0.5" data-action="sheet-delay-max"
            value="${o.delayMaxMs != null ? (o.delayMaxMs / 1000).toString() : ''}" placeholder="default ${(settings.replyDelayMaxMs / 1000).toFixed(1)}" />
        </label>
      </div>

      <div class="card-head" style="margin:16px 0 6px">
        <h3 style="margin:0;font-size:13px">Conversation summary</h3>
        <div class="btnrow" style="margin:0">
          <button class="btn tiny" type="button" data-action="sheet-summarize">Regenerate</button>
        </div>
      </div>
      <div class="summary-box ${conv.summary ? '' : 'empty'}">${esc(
        conv.summary || 'No summary yet — it is rebuilt automatically as the conversation grows.'
      )}</div>

      <h3 style="font-size:13px;margin:16px 0 4px">Recent turns</h3>
      <div>${turns.length ? turns.map((t) => `
        <div class="turn ${t.role === 'me' ? 'me' : ''}">
          <div class="turn-role">${t.role === 'me' ? 'You' : 'Them'}</div>
          <div class="turn-text">${esc(t.text)}</div>
        </div>`).join('') : '<p class="muted">Nothing stored yet.</p>'}</div>

      <div class="btnrow" style="margin-top:18px">
        <button class="btn" type="button" data-action="sheet-cancel">Cancel queued</button>
        <button class="btn" type="button" data-action="sheet-reset">Reset overrides</button>
      </div>
    `;
  }

  const sheetBody = $('sheetBody');
  sheetBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !state.activeChat) return;
    const chatId = state.activeChat;
    const action = btn.dataset.action;
    if (action === 'sheet-summarize') {
      btn.disabled = true;
      toast('Rebuilding summary…');
      await chrome.runtime.sendMessage({ type: 'wa2:dashboard:summarize', chatId });
      await loadLocal();
      renderConvs();
      renderSheet(chatId);
      toast('Summary rebuilt');
    }
    if (action === 'sheet-cancel') {
      await chrome.runtime.sendMessage({ type: 'wa2:dashboard:cancel-queue', chatId });
      toast('Cancel requested');
    }
    if (action === 'sheet-reset') {
      await saveOverride(chatId, {
        reply: 'inherit',
        kind: '',
        provider: 'auto',
        delayMinMs: null,
        delayMaxMs: null,
      });
      const { overrides = {} } = await chrome.storage.local.get({ overrides: {} });
      state.overrides = overrides;
      renderConvs();
      renderSheet(chatId);
      toast('Per-chat overrides cleared');
    }
  });

  sheetBody.addEventListener('change', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !state.activeChat) return;
    const chatId = state.activeChat;
    switch (el.dataset.action) {
      case 'sheet-reply':
        await saveOverride(chatId, { reply: el.value });
        if (el.value === 'off') await chrome.runtime.sendMessage({ type: 'wa2:dashboard:cancel-queue', chatId });
        toast(`Replies: ${el.value}`);
        break;
      case 'sheet-kind':
        await saveOverride(chatId, { kind: el.value });
        toast('Chat type updated');
        break;
      case 'sheet-delay-min':
      case 'sheet-delay-max': {
        const key = el.dataset.action === 'sheet-delay-min' ? 'delayMinMs' : 'delayMaxMs';
        if (el.value.trim() === '') {
          await saveOverride(chatId, { [key]: null });
        } else {
          const n = Number(el.value);
          if (Number.isFinite(n)) await saveOverride(chatId, { [key]: Math.round(Math.max(0, n) * 1000) });
        }
        break;
      }
      default:
        break;
    }
  });

  // ------------------------------------------------------------------ misc actions
  $('openWhatsApp').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    if (tabs.length) chrome.tabs.update(tabs[0].id, { active: true });
    else chrome.tabs.create({ url: 'https://web.whatsapp.com/' });
  });

  $('openLogs').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('logs/logs.html') }));

  $('openDashboardHelp').addEventListener('click', () => {
    toast('Fixed sends one reply to every allowed chat; Bot answers keyword matches. Per-chat switches always win. AI replies are coming soon.', 6500);
  });

  $('clearData').addEventListener('click', async () => {
    if (!confirm('Delete all stored conversations, turns, summaries and per-chat overrides?')) return;
    await chrome.runtime.sendMessage({ type: 'wa2:dashboard:clear-data' });
    await loadLocal();
    renderConvs();
    renderHints();
    if (state.activeChat) closeSheet();
    toast('Conversation data cleared');
  });

  // ------------------------------------------------------------------ live updates
  async function loadLocalAndRender() {
    const editingWas = state.editingBotId;
    await loadLocal();
    renderConvs();
    renderQueue();
    renderHints();
    renderConnection();
    if (state.activeTab === 'bot') {
      renderBotList();
      renderBotEditorActions();
    }
    if (editingWas && !state.bots.some((b) => b.id === editingWas)) resetBotEditor();
    if (state.activeChat && !isEditingSheet()) renderSheet(state.activeChat);
  }

  let reloadTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => {
        await loadSettings();
        applySettingsToInputs();
        renderMode();
        renderHints();
        renderConvs();
        renderConnection();
      }, 200);
      return;
    }
    if (area !== 'local') return;
    if (changes.convs || changes.overrides || changes.bots || changes.queue || changes.status || changes.manualPrompt) {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(loadLocalAndRender, 200);
    }
  });

  // Live "due in" labels without re-rendering the list.
  setInterval(renderQueue, 1000);
  setInterval(refreshRuntime, 15_000);
  window.addEventListener('focus', refreshRuntime);

  // ------------------------------------------------------------------ init
  (async function init() {
    await loadSettings();
    await loadLocal();
    bindSettings();
    bindTabs();
    bindBots();
    resetBotEditor();
    applySettingsToInputs();
    renderMode();
    renderHints();
    renderConvs();
    renderQueue();
    await renderConnection();

    const raw = await chrome.storage.sync.get(null);
    if (!Object.keys(raw).length) {
      await chrome.storage.sync.set(state.settings);
    }
    // If AI was the legacy engine and no provider is enabled, keep it usable.
    if (state.settings.replyMode === 'ai' && !PROVIDER_IDS.some((id) => state.settings.enabledProviders[id])) {
      await saveSettings({ enabledProviders: { ...state.settings.enabledProviders, gemini: true } });
    }
    await refreshRuntime();
    const fromHash = (location.hash || '').replace('#', '').trim();
    setTab(fromHash || 'conversations');
    $('version').textContent = `v${chrome.runtime.getManifest().version}`;
    $('footerVersion').textContent = `v${chrome.runtime.getManifest().version}`;
  })();
})();
