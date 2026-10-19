/* WA Auto Reply — Kimi provider config (kimi.com / kimi.moonshot.cn) */
(() => {
  'use strict';
  if (!self.WA2Provider) return;
  self.WA2Provider.install({
    id: 'kimi',
    label: 'Kimi',
    composer: [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea',
    ],
    send: [
      'div[class*="send"][role="button"]',
      'button[class*="send"]',
      'button[aria-label*="send" i]',
      'button[type="submit"]',
    ],
    stop: ['div[class*="stop"]', 'button[aria-label*="stop" i]'],
    responses: ['[class*="markdown"]', '.segment-content'],
    textSelector: '',
    newChat: ['div[class*="new-chat"]', 'button[class*="new"]', 'a[href="/"]'],
    maxWaitMs: 90_000,
  });
})();
