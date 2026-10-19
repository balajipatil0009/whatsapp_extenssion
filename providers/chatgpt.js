/* WA Auto Reply — ChatGPT provider config (chatgpt.com) */
(() => {
  'use strict';
  if (!self.WA2Provider) return;
  self.WA2Provider.install({
    id: 'chatgpt',
    label: 'ChatGPT',
    composer: [
      '#prompt-textarea',
      'div[contenteditable="true"][data-testid="prompt-textarea"]',
      'textarea[data-testid="prompt-textarea"]',
      'form textarea',
    ],
    send: ['button[data-testid="send-button"]', 'button[aria-label*="send" i]'],
    stop: ['button[data-testid="stop-button"]', 'button[aria-label*="stop" i]'],
    responses: [
      '[data-message-author-role="assistant"]',
      'article[data-testid^="conversation-turn-"] .markdown',
    ],
    textSelector: '.markdown',
    newChat: [
      'a[data-testid="create-new-chat-button"]',
      'button[data-testid="create-new-chat-button"]',
      'nav a[href="/"]',
    ],
    maxWaitMs: 90_000,
  });
})();
