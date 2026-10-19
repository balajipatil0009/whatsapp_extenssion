/* WA Auto Reply — bot keyword matching.
 *
 * A "bot" is a named predefined reply plus keywords. Each keyword is either:
 *   exact    — the whole incoming message equals the keyword
 *   contains — the incoming message contains the keyword
 *
 * Only one bot may answer a message. Exact matches win over `contains`
 * matches; within the same match type, the bot listed first on the dashboard
 * wins. Keyword text is compared case-insensitively with whitespace collapsed,
 * and a keyword may only exist in one bot.
 *
 * Pure and dependency-free so it runs in the worker, the dashboard and tests.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.WA2Bots = lib;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MATCH_TYPES = ['exact', 'contains'];
  const MAX_NAME = 60;
  const MAX_REPLY = 2000;
  const MAX_KEYWORD = 100;

  function normalizeText(value) {
    return String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function isMatchType(type) {
    return MATCH_TYPES.includes(type);
  }

  function cleanKeyword(raw) {
    const text = String(raw && typeof raw === 'object' ? raw.text : raw)
      .replace(/\s+/g, ' ')
      .trim();
    const type = raw && typeof raw === 'object' && isMatchType(raw.type) ? raw.type : 'contains';
    return { text, type };
  }

  /** Which other bot (if any) already owns this keyword? */
  function findKeywordOwner(bots, keyword, excludeBotId) {
    const key = normalizeText(keyword);
    if (!key) return null;
    for (const bot of Array.isArray(bots) ? bots : []) {
      if (!bot || bot.id === excludeBotId) continue;
      for (const kw of bot.keywords || []) {
        if (normalizeText(kw && kw.text) === key) return bot;
      }
    }
    return null;
  }

  function keywordMatches(keyword, normalizedMessage) {
    const key = normalizeText(keyword && keyword.text);
    if (!key) return false;
    if (keyword.type === 'exact') return normalizedMessage === key;
    return normalizedMessage.includes(key);
  }

  /**
   * @returns {{bot:object, keyword:{text:string,type:string}, matchType:'exact'|'contains'}|null}
   */
  function findMatchingBot(bots, message) {
    const normalized = normalizeText(message);
    if (!normalized) return null;

    const candidates = (Array.isArray(bots) ? bots : []).filter(
      (bot) =>
        bot &&
        bot.enabled !== false &&
        String(bot.reply || '').trim() &&
        Array.isArray(bot.keywords) &&
        bot.keywords.length
    );

    // Exact matches beat contains matches, even if the contains bot is first.
    for (const bot of candidates) {
      for (const keyword of bot.keywords) {
        if (keyword && keyword.type === 'exact' && normalizeText(keyword.text) === normalized) {
          return { bot, keyword: cleanKeyword(keyword), matchType: 'exact' };
        }
      }
    }
    for (const bot of candidates) {
      for (const keyword of bot.keywords) {
        if (keyword && keyword.type !== 'exact' && keywordMatches(keyword, normalized)) {
          return { bot, keyword: cleanKeyword(keyword), matchType: 'contains' };
        }
      }
    }
    return null;
  }

  /**
   * Validate a draft bot against every saved bot.
   * @returns {{ok:boolean, errors:string[], bot:{name:string,reply:string,keywords:Array}}}
   */
  function validateBot(draft, bots, editingId) {
    const errors = [];
    const name = String(draft?.name || '').replace(/\s+/g, ' ').trim();
    const reply = String(draft?.reply || '').trim();

    if (!name) errors.push('Give the bot a name.');
    if (name.length > MAX_NAME) errors.push(`Name must be ${MAX_NAME} characters or fewer.`);
    if (!reply) errors.push('Add a reply message for the bot.');
    if (reply.length > MAX_REPLY) errors.push(`Reply must be ${MAX_REPLY} characters or fewer.`);

    if (name && (Array.isArray(bots) ? bots : []).some((b) => b.id !== editingId && normalizeText(b.name) === normalizeText(name))) {
      errors.push(`A bot named "${name}" already exists.`);
    }

    const keywords = [];
    const seen = new Set();
    for (const raw of Array.isArray(draft?.keywords) ? draft.keywords : []) {
      const keyword = cleanKeyword(raw);
      if (!keyword.text) continue;
      if (keyword.text.length > MAX_KEYWORD) {
        errors.push(`Keyword "${keyword.text.slice(0, 24)}…" is longer than ${MAX_KEYWORD} characters.`);
        continue;
      }
      const key = normalizeText(keyword.text);
      if (seen.has(key)) {
        errors.push(`Keyword "${keyword.text}" is repeated in this bot.`);
        continue;
      }
      seen.add(key);
      const owner = findKeywordOwner(bots, keyword.text, editingId);
      if (owner) {
        errors.push(`Keyword "${keyword.text}" is already used by the bot "${owner.name}".`);
        continue;
      }
      keywords.push(keyword);
    }
    if (!keywords.length) errors.push('Add at least one keyword.');

    return { ok: errors.length === 0, errors, bot: { name, reply, keywords } };
  }

  return {
    MATCH_TYPES,
    MAX_NAME,
    MAX_REPLY,
    MAX_KEYWORD,
    normalizeText,
    cleanKeyword,
    findKeywordOwner,
    findMatchingBot,
    validateBot,
  };
});
