/* WA Auto Reply — DeepSeek provider config (chat.deepseek.com) */
(() => {
  'use strict';
  if (!self.WA2Provider) return;
  self.WA2Provider.install({
    id: 'deepseek',
    label: 'DeepSeek',
    composer: [
      'textarea#chat-input',
      'textarea[placeholder*="message" i]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
    ],
    send: [
      'div[role="button"][aria-label*="send" i]',
      'button[aria-label*="send" i]',
      'button[type="submit"]',
    ],
    stop: ['div[role="button"][aria-label*="stop" i]', 'button[aria-label*="stop" i]'],
    responses: ['.ds-markdown', '[class*="ds-markdown"]'],
    textSelector: '',
    newChat: ['[class*="new-chat"]', 'a[href="/"]'],
    maxWaitMs: 90_000,
  });
})();
