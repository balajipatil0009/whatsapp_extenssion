/* WA Auto Reply — generic provider-tab driver (ISOLATED world)
 *
 * The extension has no API keys: it types into the provider's own web chat,
 * waits for the answer to finish streaming, and scrapes it. Everything that is
 * provider-specific lives in a small config object (see providers/*.js).
 *
 * Protocol (chrome.runtime messages):
 *   in : wa2:ai-request  {reqId, prompt, contextMode}
 *   in : wa2:ai-capture  {reqId}            → scrape latest response
 *   in : wa2:ai-new-chat                    → click the provider's New chat
 *   in : wa2:ai-probe                       → which selectors match right now
 *   in : wa2:ai-ping                        → install/health check
 *   out: wa2:ai-response {reqId, providerId, ok, text, error, ms}
 *
 * Content scripts cannot be ES modules, so this exposes a global factory.
 */

(() => {
  'use strict';

  if (self.WA2Provider) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

  let contextDead = false;
  function extAlive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }
  function sendRuntime(payload) {
    if (!extAlive()) {
      contextDead = true;
      return;
    }
    try {
      chrome.runtime.sendMessage(payload).catch((e) => {
        if (String(e?.message || e).includes('invalidated')) contextDead = true;
      });
    } catch {
      contextDead = true;
    }
  }

  function install(config) {
    if (!config || !config.id) return;
    if (window.__WA2_ADAPTER__ === config.id) return;
    window.__WA2_ADAPTER__ = config.id;

    const log = (level, message) =>
      sendRuntime({ type: 'wa2:log', level, tag: `provider:${config.id}`, message: String(message) });

    const MAX_WAIT_MS = config.maxWaitMs || 90_000;
    const POLL_MS = 1_200;
    const STABLE_POLLS = 3;

    let busy = false;
    let lastDedupeLog = 0;

    // ------------------------------------------------------------ DOM helpers
    function visible(el) {
      if (!el || !el.isConnected) return false;
      try {
        return el.getClientRects().length > 0 || el.offsetParent !== null;
      } catch {
        return false;
      }
    }

    function findOne(selectors) {
      for (const sel of selectors || []) {
        let nodes;
        try {
          nodes = document.querySelectorAll(sel);
        } catch {
          continue; // invalid selector in an older Chrome
        }
        for (const el of nodes) {
          if (visible(el)) return el;
        }
      }
      return null;
    }

    function findAll(selectors) {
      for (const sel of selectors || []) {
        let nodes;
        try {
          nodes = document.querySelectorAll(sel);
        } catch {
          continue;
        }
        if (nodes.length) return [...nodes];
      }
      return [];
    }

    function findStop() {
      for (const sel of config.stop || []) {
        try {
          for (const el of document.querySelectorAll(sel)) {
            if (visible(el)) return el;
          }
        } catch {
          /* ignore */
        }
      }
      return null;
    }

    async function waitFor(fn, timeoutMs, everyMs = 300) {
      const t0 = Date.now();
      for (;;) {
        const value = fn();
        if (value) return value;
        if (Date.now() - t0 > timeoutMs) return null;
        await sleep(everyMs);
      }
    }

    function elementText(el) {
      if (!el) return '';
      let nodes = [el];
      if (config.textSelector) {
        try {
          const found = [...el.querySelectorAll(config.textSelector)];
          if (found.length) nodes = found;
        } catch {
          /* keep the response element itself */
        }
      }

      // Gemini nests message-content > .markdown, and both match the selector
      // list — joining both duplicated every reply. Keep only the deepest
      // matched nodes, then de-duplicate identical text.
      const deepest = nodes.filter((n) => !nodes.some((other) => other !== n && n.contains(other)));
      if (deepest.length !== nodes.length && Date.now() - lastDedupeLog > 10_000) {
        lastDedupeLog = Date.now();
        log(
          'warn',
          `response text matched ${nodes.length} nested DOM nodes; kept ${deepest.length} deepest (duplicate scrape suppressed)`
        );
      }
      const seen = new Set();
      const parts = [];
      for (const n of deepest) {
        const text = String(n.innerText || n.textContent || '').trim();
        if (!text) continue;
        const key = text.replace(/\s+/g, ' ');
        if (seen.has(key)) continue;
        seen.add(key);
        parts.push(text);
      }
      return parts.join('\n').trim() || String(el.innerText || el.textContent || '').trim();
    }

    function getComposerText(el) {
      if (!el) return '';
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return String(el.value || '');
      return String(el.innerText || el.textContent || '');
    }

    async function insertText(el, text) {
      el.focus();
      await sleep(80);
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, text);
        else el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        try {
          // Select the editor's contents explicitly. execCommand('selectAll')
          // can select the whole page if focus did not land in the editor, which
          // used to append the prompt to whatever was already there.
          const range = document.createRange();
          range.selectNodeContents(el);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('insertText', false, text);
        } catch {
          try {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
          } catch {
            /* fall through to the textContent fallback */
          }
        }
        if (getComposerText(el).trim().length < Math.min(4, text.length)) {
          // Last-resort fallback for editors that ignore execCommand.
          el.textContent = text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        }
      }
      await sleep(150);
      return getComposerText(el).trim().length > 0;
    }

    function clickSend(composer) {
      const btn = findOne(config.send);
      if (btn) {
        const disabled =
          btn.disabled === true ||
          btn.getAttribute('aria-disabled') === 'true' ||
          btn.getAttribute('data-disabled') === 'true';
        if (!disabled) {
          btn.click();
          return 'button';
        }
      }
      // Fallback: Enter submits in most chat composers.
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      composer.dispatchEvent(new KeyboardEvent('keydown', opts));
      composer.dispatchEvent(new KeyboardEvent('keypress', opts));
      composer.dispatchEvent(new KeyboardEvent('keyup', opts));
      return 'enter';
    }

    function responseNodes() {
      return findAll(config.responses);
    }

    // ------------------------------------------------------------ main flow
    async function runPrompt(reqId, prompt) {
      const t0 = Date.now();
      busy = true;
      try {
        const composer = await waitFor(() => findOne(config.composer), 12_000);
        if (!composer) {
          throw new Error(
            `composer not found (${(config.composer || []).join(' | ')}) — is the ${config.label} tab logged in?`
          );
        }
        const before = responseNodes().length;
        log('info', `${reqId}: prompt inserted (${prompt.length} chars), before=${before}`);

        const inserted = await insertText(composer, prompt);
        if (!inserted) throw new Error('composer rejected the prompt text');
        await sleep(250);

        const how = clickSend(composer);
        log('info', `${reqId}: sent via ${how} — waiting (max ${MAX_WAIT_MS / 1000}s)…`);

        // Make sure the send actually took: the composer clears, a stop button
        // appears, or a new response node shows up. Any one is enough.
        const accepted = await waitFor(
          () =>
            getComposerText(composer).trim().length === 0 ||
            !!findStop() ||
            responseNodes().length > before,
          4_000,
          300
        );
        if (!accepted) {
          log('warn', `${reqId}: no sign of submission — retrying with Enter`);
          composer.focus();
          const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
          composer.dispatchEvent(new KeyboardEvent('keydown', opts));
          await sleep(1200);
          if (!findStop() && responseNodes().length <= before && getComposerText(composer).trim().length > 0) {
            throw new Error('send was not accepted by the page');
          }
        }

        let lastText = '';
        let stable = 0;
        let nodeSeen = 0;
        while (Date.now() - t0 < MAX_WAIT_MS) {
          await sleep(POLL_MS);
          const streaming = !!findStop();
          const nodes = responseNodes();
          nodeSeen = nodes.length;
          let node = null;
          if (nodes.length > before) node = nodes[nodes.length - 1];
          else if (nodes.length && nodes.length === before && lastText) node = nodes[nodes.length - 1];

          const text = node ? elementText(node) : '';
          if (text && text !== lastText) {
            lastText = text;
            stable = 0;
          } else if (text) {
            stable += 1;
          }

          if (
            text.length > 0 &&
            stable >= STABLE_POLLS &&
            !streaming &&
            Date.now() - t0 > 2_500
          ) {
            log('info', `${reqId}: response complete (${text.length} chars, ${Date.now() - t0}ms)`);
            return text;
          }
        }
        throw new Error(
          `timed out after ${MAX_WAIT_MS / 1000}s (streaming=${!!findStop()}, responses=${nodeSeen}, chars=${lastText.length})`
        );
      } finally {
        busy = false;
      }
    }

    async function handleRequest(reqId, prompt) {
      const started = Date.now();
      try {
        const text = await runPrompt(reqId, prompt);
        sendRuntime({
          type: 'wa2:ai-response',
          reqId,
          providerId: config.id,
          ok: true,
          text,
          ms: Date.now() - started,
        });
      } catch (e) {
        const message = e?.message || String(e);
        log('error', `${reqId}: FAILED — ${message}`);
        sendRuntime({
          type: 'wa2:ai-response',
          reqId,
          providerId: config.id,
          ok: false,
          error: message,
          ms: Date.now() - started,
        });
      }
    }

    async function handleCapture(reqId) {
      const started = Date.now();
      try {
        const nodes = responseNodes();
        const text = nodes.length ? elementText(nodes[nodes.length - 1]) : '';
        if (!text) throw new Error('no response visible in the open chat');
        log('info', `${reqId}: captured ${text.length} chars`);
        sendRuntime({
          type: 'wa2:ai-response',
          reqId,
          providerId: config.id,
          ok: true,
          text,
          ms: Date.now() - started,
        });
      } catch (e) {
        sendRuntime({
          type: 'wa2:ai-response',
          reqId,
          providerId: config.id,
          ok: false,
          error: e?.message || String(e),
        });
      }
    }

    function probe() {
      const composer = findOne(config.composer);
      const sendBtn = findOne(config.send);
      return {
        ok: !!composer,
        provider: config.id,
        host: location.host,
        composer: composer ? composer.tagName.toLowerCase() : null,
        sendButton: !!sendBtn,
        responses: responseNodes().length,
        streaming: !!findStop(),
        url: location.href,
      };
    }

    // ------------------------------------------------------------ messages
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'wa2:ai-request') {
        if (busy) {
          sendResponse({ accepted: false, error: 'busy' });
          return false;
        }
        sendResponse({ accepted: true });
        handleRequest(msg.reqId, String(msg.prompt || ''));
        return false;
      }
      if (msg?.type === 'wa2:ai-capture') {
        sendResponse({ accepted: true });
        handleCapture(msg.reqId);
        return false;
      }
      if (msg?.type === 'wa2:ai-new-chat') {
        const btn = findOne(config.newChat || []);
        if (!btn) {
          sendResponse({ ok: false, error: 'new-chat button not found' });
          return false;
        }
        btn.click();
        log('info', 'New chat requested');
        sendResponse({ ok: true });
        return false;
      }
      if (msg?.type === 'wa2:ai-probe') {
        sendResponse(probe());
        return false;
      }
      if (msg?.type === 'wa2:ai-ping') {
        sendResponse({ ok: !!findOne(config.composer), engine: `${config.id}-adapter`, host: location.host });
        return false;
      }
      return false;
    });

    log('info', `Adapter installed on ${location.host} (${config.label})`);
  }

  self.WA2Provider = { install };
})();
