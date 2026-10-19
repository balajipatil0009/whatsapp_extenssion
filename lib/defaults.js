/* WA Auto Reply — shared defaults, provider registry and small helpers.
 *
 * Loaded by the service worker via importScripts(), by extension pages via
 * <script>, and by Node tests via require(). Keep it dependency-free and free
 * of chrome.* calls.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.WA2 = Object.assign(root.WA2 || {}, lib);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // --------------------------------------------------------------- providers
  // Tab-driven providers: we drive the user's own logged-in web chat, so no
  // API keys and no per-token billing. `matches` feed chrome.tabs.query().
  const PROVIDERS = [
    {
      id: 'gemini',
      label: 'Gemini',
      host: 'gemini.google.com',
      matches: ['https://gemini.google.com/*'],
      url: 'https://gemini.google.com/app',
      accent: '#4285f4',
      note: 'Fast, long context, good multilingual replies.',
    },
    {
      id: 'chatgpt',
      label: 'ChatGPT',
      host: 'chatgpt.com',
      matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
      url: 'https://chatgpt.com/',
      accent: '#10a37f',
      note: 'Strong instruction following and tone matching.',
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      host: 'chat.deepseek.com',
      matches: ['https://chat.deepseek.com/*'],
      url: 'https://chat.deepseek.com/',
      accent: '#4d6bfe',
      note: 'Cheap/fast, good for high message volume.',
    },
    {
      id: 'kimi',
      label: 'Kimi',
      host: 'www.kimi.com',
      matches: ['https://www.kimi.com/*', 'https://kimi.moonshot.cn/*'],
      url: 'https://www.kimi.com/',
      accent: '#ff6a00',
      note: 'Strong on Chinese and mixed-language chats.',
    },
  ];

  const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

  function providerById(id) {
    return PROVIDERS.find((p) => p.id === id) || null;
  }

  // ----------------------------------------------------------------- defaults
  const DEFAULT_SETTINGS = {
    // master
    enabled: false,
    replyMode: 'fixed', // 'fixed' | 'bot' | 'ai'
    replyText: 'Thanks for your message! I will get back to you soon.',

    // who to reply to
    replyToContacts: true,
    replyToGroups: false,
    replyToCommunities: false,
    replyToNewsletters: false,

    // anti-spam / anti-loop
    minRetryMs: 60_000, // per-chat cooldown
    maxMessageAgeMs: 120_000, // ignore messages replayed from history sync
    maxSendsPerHour: 40,
    minGapBetweenSendsMs: 2_000,

    // human-like pacing (what the queue uses)
    replyDelayMinMs: 2_500,
    replyDelayMaxMs: 7_000,
    typingSimulation: true,
    typingCps: 14, // characters per second while "typing…" is shown
    markSeen: true,

    // AI
    aiProvider: 'auto', // 'auto' | provider id
    enabledProviders: { gemini: true, chatgpt: false, deepseek: false, kimi: false },
    aiTimeoutMs: 90_000,
    aiFallbackToFixed: true,
    aiManual: false,
    ownerName: '', // how the AI refers to you in prompts (optional)
    aiPersona: 'Warm, casual and concise. Mirror the other person\'s language and tone. Never mention being an AI.',
    aiPrompt: '', // '' = built-in prompt; otherwise a {{message}} template

    // context / summary
    contextMode: 'hybrid', // 'delta' | 'hybrid' | 'full'
    recentTurns: 6,
    anchorEveryTurns: 20,
    summaryMode: 'extractive', // 'off' | 'extractive' | 'ai'
    summaryEveryTurns: 8,
  };

  const LEGACY_KEYS = ['replyToGroups', 'aiPrompt', 'aiManual', 'minRetryMs'];

  function asBool(v, fallback) {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 1) return true;
    if (v === 'false' || v === 0) return false;
    return fallback;
  }

  function normalizeSettings(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const s = { ...DEFAULT_SETTINGS };

    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (input[key] !== undefined) s[key] = input[key];
    }

    // --- legacy migration: v1 used aiMode 'fixed'|'gemini', v2 used 'fixed'|'ai'.
    const legacyGemini = input.aiMode === 'gemini';
    const legacyAi = input.aiMode === 'ai' || legacyGemini;
    if (input.replyMode === undefined) s.replyMode = legacyAi ? 'ai' : 'fixed';
    if (!['fixed', 'bot', 'ai'].includes(s.replyMode)) s.replyMode = 'fixed';

    // Keep old custom prompt templates working; empty means "use built-in".
    s.aiPrompt = typeof s.aiPrompt === 'string' ? s.aiPrompt : '';
    s.aiPersona = typeof s.aiPersona === 'string' && s.aiPersona.trim() ? s.aiPersona.trim() : DEFAULT_SETTINGS.aiPersona;
    s.replyText = typeof s.replyText === 'string' && s.replyText.trim() ? s.replyText.trim() : DEFAULT_SETTINGS.replyText;

    s.enabledProviders = { ...DEFAULT_SETTINGS.enabledProviders, ...(input.enabledProviders || {}) };
    for (const id of PROVIDER_IDS) s.enabledProviders[id] = asBool(s.enabledProviders[id], false);
    if (legacyGemini) s.enabledProviders.gemini = true;

    // If a specific provider is selected, it must be enabled.
    if (s.aiProvider !== 'auto') {
      if (!PROVIDER_IDS.includes(s.aiProvider)) s.aiProvider = 'auto';
      else s.enabledProviders[s.aiProvider] = true;
    }
    // At least one provider should be usable when AI mode is on. Prefer Gemini
    // (the historical default) but never silently disable all of them.
    if (s.replyMode === 'ai' && !PROVIDER_IDS.some((id) => s.enabledProviders[id])) {
      s.enabledProviders.gemini = true;
    }

    s.replyToContacts = asBool(s.replyToContacts, true);
    s.replyToGroups = asBool(s.replyToGroups, false);
    s.replyToCommunities = asBool(s.replyToCommunities, false);
    s.replyToNewsletters = asBool(s.replyToNewsletters, false);
    s.typingSimulation = asBool(s.typingSimulation, true);
    s.markSeen = asBool(s.markSeen, true);
    s.aiFallbackToFixed = asBool(s.aiFallbackToFixed, true);
    s.aiManual = asBool(s.aiManual, false);

    const num = (key, min, max) => {
      const n = Number(s[key]);
      s[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : DEFAULT_SETTINGS[key];
    };
    num('minRetryMs', 0, 86_400_000);
    num('maxMessageAgeMs', 0, 86_400_000);
    num('maxSendsPerHour', 1, 500);
    num('minGapBetweenSendsMs', 0, 60_000);
    num('replyDelayMinMs', 0, 600_000);
    num('replyDelayMaxMs', 0, 600_000);
    num('typingCps', 1, 100);
    num('aiTimeoutMs', 10_000, 300_000);
    num('recentTurns', 0, 20);
    num('anchorEveryTurns', 1, 200);
    num('summaryEveryTurns', 2, 100);

    if (s.replyDelayMaxMs < s.replyDelayMinMs) s.replyDelayMaxMs = s.replyDelayMinMs;
    if (!['delta', 'hybrid', 'full'].includes(s.contextMode)) s.contextMode = 'hybrid';
    if (!['off', 'extractive', 'ai'].includes(s.summaryMode)) s.summaryMode = 'extractive';

    return s;
  }

  // ---------------------------------------------------------------- chat kind
  /**
   * WhatsApp uses JID suffixes to tell chat types apart. Communities are groups
   * at transport level, so they need extra metadata (see chatKindFromChat).
   */
  function chatKindFromId(chatId) {
    const id = String(chatId || '');
    if (id === 'status@broadcast' || id.endsWith('@broadcast') && id.includes('status')) return 'status';
    if (id.endsWith('@g.us')) return 'group';
    if (id.endsWith('@newsletter')) return 'newsletter';
    if (id.endsWith('@broadcast')) return 'broadcast';
    if (!id) return 'unknown';
    return 'contact';
  }

  /**
   * Refine a chat kind using a wa-js Chat model. Communities are the parent
   * group (groupMetadata.groupType === 'COMMUNITY') or one of its subgroups
   * (groupMetadata.parentGroup set).
   */
  function chatKindFromChat(model, chatId) {
    const base = chatKindFromId(chatId);
    if (base !== 'group' || !model) return base;
    try {
      const gm = model.groupMetadata || null;
      const isCommunity = model.isParentGroup === true || (gm && (gm.groupType === 'COMMUNITY' || gm.parentGroup));
      return isCommunity ? 'community' : 'group';
    } catch {
      return base;
    }
  }

  // ------------------------------------------------------------------ helpers
  let uidCounter = 0;
  function uid(prefix) {
    uidCounter = (uidCounter + 1) % 1_000_000;
    return `${prefix || 'id'}_${Date.now().toString(36)}_${uidCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function truncate(text, max) {
    const t = String(text == null ? '' : text);
    return t.length > max ? t.slice(0, Math.max(0, max - 1)) + '…' : t;
  }

  function randomBetween(min, max) {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return lo + Math.random() * (hi - lo);
  }

  function formatDuration(ms) {
    const s = Math.round(Math.max(0, ms) / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  function providerSummary(settings) {
    return PROVIDER_IDS.filter((id) => settings.enabledProviders[id]).map((id) => providerById(id)?.label || id);
  }

  return {
    PROVIDERS,
    PROVIDER_IDS,
    DEFAULT_SETTINGS,
    LEGACY_KEYS,
    providerById,
    normalizeSettings,
    chatKindFromId,
    chatKindFromChat,
    uid,
    clamp,
    truncate,
    randomBetween,
    formatDuration,
    providerSummary,
  };
});
