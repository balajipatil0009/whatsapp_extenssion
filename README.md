# WA Auto Reply (Chrome Extension, MV3 + wa-js)

Auto-replies to incoming WhatsApp Web messages using **WhatsApp's own internal API** (via [WPPConnect wa-js](https://github.com/wppconnect-team/wa-js)) — no DOM scraping, no simulated typing. Comes with a full **diagnostic Logs page** so you can see exactly what's happening or breaking.

## Install (developer mode)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this folder
4. Open <https://web.whatsapp.com> and scan the QR if needed
5. Click the extension icon → set your reply message → switch auto-reply **ON**

Badge states: `ON` (listening & connected), `WAIT` (tab open but WhatsApp still connecting), `IDLE` (enabled but no WhatsApp tab).

## Diagnostics — the Logs page

Click **📋 Open diagnostic logs** in the popup (or open `logs/logs.html`). It shows every event with timestamps:

- `main` — script boot, wa-js loading, `conn.main_ready` connection state
- `incoming` — every `chat.new_message` event with sender/chat/self flags
- `reply` — every decision (replying, skipped: own msg / group / cooldown / already replied)
- `send` — the actual `sendTextMessage` result or error
- `bridge`, `bg`, `page` — extension plumbing and page crashes

Filters by level/tag/text, search, copy-all, clear. That's where you look first when something "isn't working".

## How it works

- `vendor/wppconnect-wa.js` — wa-js v4.6.1 injected into the WhatsApp Web page (MAIN world); it exposes `window.WPP`.
- `content/wa-main.js` — waits for `WPP.on('conn.main_ready')`, subscribes to `WPP.chat.on('chat.new_message')` and sends replies with `WPP.chat.sendTextMessage()`.
- `content/wa-bridge.js` — isolated-world bridge (the MAIN world can't call `chrome.*`): forwards settings/logs/status/pings via CustomEvents.
- `background.js` — ring-buffer log store (2000 rows in `chrome.storage.local`), status tracking, badge.
- `logs/` — the diagnostic log viewer.
- `popup/` — on/off, groups toggle, reply text, logs link.

## Settings (`chrome.storage.sync`)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | master switch |
| `replyText` | "Thanks for your message! …" | auto-reply body |
| `replyToGroups` | `false` | also reply to group chats |
| `minRetryMs` | `3000` | per-chat cooldown between replies |

## Known limitations

- Requires the WhatsApp Web tab open (linked-device session stays connected but the extension only runs in that tab).
- wa-js tracks WhatsApp Web's internals; large WhatsApp Web updates occasionally need an updated wa-js build (replace `vendor/wppconnect-wa.js` with the latest from unpkg).
- Reply dedup uses `chatId:msgId`; if a send fails we allow retry on the next message from that chat.
- Personal auto-replies only — no bulk sending (ToS), and messages sent while a chat is open are marked read as normal.

## Rebuilding/updating wa-js

```bash
curl -sSL -o vendor/wppconnect-wa.js "https://unpkg.com/@wppconnect/wa-js/dist/wppconnect-wa.js"
```
"# whatsapp_extenssion" 
