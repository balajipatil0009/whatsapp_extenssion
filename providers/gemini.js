/* WA Auto Reply — Gemini provider config (gemini.google.com) */
(() => {
  'use strict';
  if (!self.WA2Provider) return;
  self.WA2Provider.install({
    id: 'gemini',
    label: 'Gemini',
    composer: [
      'rich-textarea .ql-editor[contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="prompt" i]',
      'div[contenteditable="true"][role="textbox"]',
    ],
    send: ['button.send-button', 'button[aria-label*="send" i]', 'button[mattooltip*="send" i]'],
    stop: ['button[aria-label*="stop" i]', 'button[mattooltip*="stop" i]'],
    responses: [
      'model-response',
      '[data-test-id="model-response-text"]',
      '.conversation-container .markdown',
      '.response-container .markdown',
    ],
    textSelector: '.markdown, message-content',
    newChat: ['button[aria-label*="new chat" i]', '[data-test-id="new-chat-button"]', 'a[href="/app"]'],
    maxWaitMs: 90_000,
  });
})();
