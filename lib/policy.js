/* WA Auto Reply — reply policy.
 *
 * Pure functions: given the current settings, the chat, per-chat overrides and
 * a little runtime state, decide whether an incoming message should be answered.
 * Kept pure so it can be unit-tested without Chrome or WhatsApp.
 */
(function (root, factory) {
  const lib = factory(root.WA2 || (typeof require === 'function' ? require('./defaults.js') : {}));
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.WA2 = Object.assign(root.WA2 || {}, lib);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (WA2) {
  'use strict';

  const KIND_SETTING = {
    contact: 'replyToContacts',
    group: 'replyToGroups',
    community: 'replyToCommunities',
    newsletter: 'replyToNewsletters',
  };

  const KIND_LABEL = {
    contact: 'direct chats',
    group: 'groups',
    community: 'communities',
    newsletter: 'channels',
    broadcast: 'broadcast lists',
    status: 'status updates',
    unknown: 'unknown chats',
  };

  function kindEnabled(settings, kind) {
    const key = KIND_SETTING[kind];
    if (!key) return false; // status / broadcast lists / unknown
    return settings[key] === true;
  }

  /**
   * @param {object} p
   * @param {object} p.settings normalized settings
   * @param {object} p.chat { id, kind }
   * @param {object} [p.override] { reply: 'inherit'|'on'|'off' }
   * @param {number} p.now epoch ms
   * @param {number} [p.ageMs] message age in ms
   * @param {number} [p.lastReplyAt] timestamp of the last reply in this chat
   * @param {number[]} [p.recentSends] timestamps of recent sends (all chats)
   * @param {boolean} [p.seen] this message was already processed
   * @param {boolean} [p.pending] a reply for this chat is already scheduled
   * @returns {{action:'reply'|'skip', code:string, reason:string}}
   */
  function evaluateIncoming(p) {
    const settings = p.settings || {};
    const chat = p.chat || {};
    const kind = chat.kind || 'unknown';
    const override = p.override || {};
    const now = Number.isFinite(p.now) ? p.now : Date.now();

    const skip = (code, reason) => ({ action: 'skip', code, reason });
    const reply = (code, reason) => ({ action: 'reply', code, reason });

    if (!settings.enabled) return skip('disabled', 'Auto-reply is off');
    if (chat.fromMe) return skip('self', 'Own outgoing message');
    if (p.ageMs != null && settings.maxMessageAgeMs > 0 && p.ageMs > settings.maxMessageAgeMs) {
      return skip('stale', `Message is ${Math.round(p.ageMs / 1000)}s old — likely history sync`);
    }
    if (!chat.body || !String(chat.body).trim()) return skip('empty', 'No text to answer (media-only)');
    if (kind === 'status') return skip('status', 'Status update');
    if (kind === 'broadcast') return skip('broadcast', 'Broadcast lists cannot be replied to');
    if (kind === 'unknown') return skip('unknown-chat', 'Unrecognised chat id');

    if (override.reply === 'off') return skip('chat-off', 'Replies disabled for this conversation');

    const explicitlyOn = override.reply === 'on';
    if (!explicitlyOn && !kindEnabled(settings, kind)) {
      return skip(`type-${kind}`, `${KIND_LABEL[kind] || kind} are disabled in settings`);
    }

    if (p.seen) return skip('duplicate', 'Already handled this message');
    if (p.pending) return skip('pending', 'A reply for this chat is already queued or generating');

    const last = Number(p.lastReplyAt) || 0;
    if (settings.minRetryMs > 0 && last > 0 && now - last < settings.minRetryMs) {
      const wait = Math.ceil((settings.minRetryMs - (now - last)) / 1000);
      return skip('cooldown', `Per-chat cooldown — ${wait}s left`);
    }

    const windowStart = now - 60 * 60 * 1000;
    const sendsLastHour = (p.recentSends || []).filter((t) => t > windowStart).length;
    if (sendsLastHour >= settings.maxSendsPerHour) {
      return skip('rate-limit', `Hourly send cap reached (${settings.maxSendsPerHour})`);
    }

    return reply('ok', 'Policy allows a reply');
  }

  /** Delay window for this chat, honouring per-chat overrides. */
  function delayRangeFor(settings, override) {
    const o = override || {};
    let min = Number.isFinite(o.delayMinMs) ? o.delayMinMs : settings.replyDelayMinMs;
    let max = Number.isFinite(o.delayMaxMs) ? o.delayMaxMs : settings.replyDelayMaxMs;
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = min;
    if (max < min) max = min;
    return { min: Math.max(0, Math.round(min)), max: Math.max(0, Math.round(max)) };
  }

  /** How long to show the "typing…" presence before sending, in ms. */
  function typingDurationFor(text, settings) {
    const cps = Math.max(1, Number(settings.typingCps) || 14);
    const raw = (String(text || '').length / cps) * 1000;
    return Math.round(Math.min(12_000, Math.max(1_200, raw)));
  }

  return { evaluateIncoming, delayRangeFor, typingDurationFor, kindEnabled, KIND_LABEL };
});
