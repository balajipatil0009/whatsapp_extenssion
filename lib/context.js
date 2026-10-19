/* WA Auto Reply — conversation context & summary builder.
 *
 * Two jobs:
 *  1. Build the smallest prompt that still gets a good reply. In `hybrid` mode
 *     the provider chat itself holds earlier turns, so we only send the new
 *     message plus a short instruction — unless the provider tab switched
 *     conversation or the periodic anchor is due, in which case we send the
 *     full context packet.
 *  2. Keep a cheap, deterministic (extractive) summary per conversation so the
 *     full packet stays small and the dashboard can show what the AI "knows".
 *
 * No chrome.* calls here; everything is pure and unit-tested.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.WA2 = Object.assign(root.WA2 || {}, lib);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STOPWORDS = new Set(
    ('a an and are as at be been but by can could did do does for from had has have he her him his how i if in into is it its ' +
      'just like me my no not now of on or our out she so some than that the their them then there these they this to too ' +
      'up us was we were what when where which who why will with would you your ok okay yes yeah hey hi hello please thanks ' +
      'thank also very really much many more most been being got get one two').split(' ')
  );

  const KIND_LABEL = { contact: 'direct chat', group: 'group', community: 'community', newsletter: 'channel' };

  function hhmm(ts) {
    try {
      const d = new Date(ts);
      return d.toISOString().slice(0, 10);
    } catch {
      return '';
    }
  }

  function words(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^\p{L}\p{N}\s']/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && w.length <= 24 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  }

  /**
   * Deterministic summary: participants, message volume, top topics, open
   * questions and the last exchange. Cheap enough to rebuild on every message.
   */
  function makeExtractiveSummary(conv) {
    if (!conv || !Array.isArray(conv.turns) || !conv.turns.length) return '';
    const turns = conv.turns.slice(-24);
    const them = turns.filter((t) => t.role === 'them');
    const me = turns.filter((t) => t.role === 'me');
    if (!them.length) return '';

    const freq = new Map();
    for (const t of them) {
      for (const w of words(t.text)) freq.set(w, (freq.get(w) || 0) + 1);
    }
    const topics = [...freq.entries()]
      .filter(([, n]) => n >= 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([w]) => w);

    const openQuestions = them
      .filter((t) => /\?\s*$/.test(String(t.text || '').trim()))
      .slice(-2)
      .map((t) => String(t.text).trim().slice(0, 90));

    const lastThem = them[them.length - 1];
    const lastMe = me[me.length - 1];
    const first = turns[0];
    const since = first && first.ts ? hhmm(first.ts) : '';

    const parts = [];
    const who = conv.name || conv.id || 'this conversation';
    const kind = KIND_LABEL[conv.kind] || conv.kind || 'chat';
    parts.push(`Conversation with ${who} (${kind})${since ? ` since ${since}` : ''}: ${them.length} incoming, ${me.length} replies.`);
    if (topics.length) parts.push(`Topics: ${topics.join(', ')}.`);
    if (openQuestions.length) parts.push(`Open questions from them: ${openQuestions.map((q) => `"${q}"`).join(' ')}`);
    if (lastThem) parts.push(`Latest from them: "${String(lastThem.text).trim().slice(0, 110)}"`);
    if (lastMe) parts.push(`Your last reply: "${String(lastMe.text).trim().slice(0, 110)}"`);
    return parts.join(' ').slice(0, 700);
  }

  function formatTurns(turns) {
    return (turns || [])
      .map((t) => `${t.role === 'me' ? 'Me' : 'Them'}: ${String(t.text || '').replace(/\s+/g, ' ').trim().slice(0, 400)}`)
      .join('\n');
  }

  function estimateTokens(text) {
    // Rough but useful: ~4 characters per token for English, more for CJK.
    return Math.ceil(String(text || '').length / 4);
  }

  /**
   * Build the prompt for one turn.
   * @param {object} p
   * @param {object} p.settings normalized settings
   * @param {object} p.conv conversation record
   * @param {object} p.chat { id, name, kind }
   * @param {string} p.message incoming text
   * @param {'delta'|'full'} p.mode
   * @param {string} [p.summary] summary to inject ('' to omit)
   * @param {string} [p.ownerName]
   * @param {string} [p.turnId]
   */
  function buildPrompt(p) {
    const settings = p.settings || {};
    const conv = p.conv || {};
    const chat = p.chat || conv;
    const message = String(p.message || '').trim();
    const summary = String(p.summary || '').trim();
    const owner = (p.ownerName || 'the account owner').trim();
    const marker = `[WA2-TURN:${p.turnId || 'n/a'}]`;
    const recent = formatTurns((conv.turns || []).slice(-(settings.recentTurns || 6)));

    // Power users can keep their own template (legacy compatibility).
    const custom = String(settings.aiPrompt || '').trim();
    if (custom) {
      const text = custom
        .replaceAll('{{message}}', message)
        .replaceAll('{{summary}}', summary)
        .replaceAll('{{recent}}', recent)
        .replaceAll('{{name}}', chat.name || chat.id || '')
        .replaceAll('{{kind}}', KIND_LABEL[chat.kind] || chat.kind || 'chat')
        .replaceAll('{{owner}}', owner);
      return { text: `${marker}\n${text}`, mode: 'custom', tokens: estimateTokens(text) };
    }

    if (p.mode === 'delta') {
      const lines = [
        marker,
        `You are replying as ${owner} to a WhatsApp message. Write only the reply text, match their language and tone, keep it short and natural, never mention being an AI.`,
      ];
      if (summary) lines.push(`[CONTEXT] ${summary}`);
      lines.push(`Them: ${message}`);
      const text = lines.join('\n');
      return { text, mode: 'delta', tokens: estimateTokens(text) };
    }

    const lines = [
      marker,
      `You are replying to a WhatsApp conversation as ${owner}.`,
      `Rules: output ONLY the message text. Match the language and tone of the latest message. Keep it natural and concise (1-3 short sentences). No quotes, no labels, no markdown, no explanations. Never mention that you are an AI or an assistant.`,
      `Use the conversation below as the context for this reply; ignore unrelated earlier chats in this tab.`,
      `Style: ${settings.aiPersona || 'Warm, casual and concise.'}`,
    ];
    if (summary) lines.push('', `[CONTEXT] ${summary}`);
    if (recent) lines.push('', 'Conversation so far:', recent);
    lines.push('', `Them (latest): ${message}`, '', 'Reply now with only the message text.');
    const text = lines.join('\n');
    return { text, mode: 'full', tokens: estimateTokens(text) };
  }

  /**
   * Some provider UIs (Gemini especially) nest the same reply in two elements
   * that both match the scraper's selector, so the text arrives as "A\nA". If
   * the whole string is exactly two copies of the same block, keep one copy.
   * Only long, byte-identical halves are collapsed, so genuine short repeats
   * ("ha\nha") survive.
   */
  function collapseExactDuplicate(raw) {
    const t = String(raw == null ? '' : raw).trim();
    if (t.length < 80) return t;
    const half = Math.floor(t.length / 2);
    const from = Math.max(20, half - 80);
    const to = Math.min(t.length - 20, half + 80);
    for (let i = from; i <= to; i += 1) {
      const a = t.slice(0, i).trim();
      if (a.length < 20) continue;
      const b = t.slice(i).trim();
      if (a !== b) continue;
      return a;
    }
    return t;
  }

  /** Clean up whatever the provider tab scraped before sending it to WhatsApp. */
  function sanitizeReply(raw) {
    let text = String(raw == null ? '' : raw);
    text = text.replace(/\[WA2-TURN:[^\]]*\]/gi, '').trim();
    text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '');
    text = text.replace(/^(?:reply|response|answer|you|me|assistant|chatgpt|gemini|deepseek|kimi)\s*[:：-]\s*/i, '');
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    const closing = { '"': '"', "'": "'", '“': '”', '‘': '’' };
    if (text.length > 2 && closing[text[0]] && closing[text[0]] === text[text.length - 1]) {
      text = text.slice(1, -1).trim();
    }
    text = collapseExactDuplicate(text);
    if (text.length > 2000) text = text.slice(0, 2000).trim();
    return text;
  }

  return {
    makeExtractiveSummary,
    buildPrompt,
    sanitizeReply,
    collapseExactDuplicate,
    estimateTokens,
    formatTurns,
    KIND_LABEL,
  };
});
