# WA Auto Reply

A Chrome (MV3) extension that answers WhatsApp Web messages through WhatsApp's own
internal API (`wa-js`) with **human-like pacing**, **per-chat controls**, and a
**keyword bot engine**. A fixed-text engine and the full AI provider engine are also in
the code — the AI configuration screen is marked **coming soon**.

No API keys. No DOM scraping of WhatsApp. No bulk sending.

```text
WhatsApp tab                          background service worker
─────────────                         ────────────────────────
chat.new_message
      │  (bridge, JSON events)              policy (enabled? kind? override? cooldown?)
      ├──────────────────────────────────►  rate limit ──► reply mode
      │                                                   ├─ Bot  : keyword match → reply
      │                                                   ├─ Fixed: one canned reply
      │                                                   └─ AI   : provider tabs (retained)
      ◄────────────── wa2:reply {text, delay, typing} ────┘
 send queue in page
   wait 2.5–7s ─► mark read ─► “typing…” ─► sendTextMessage ─► ack
```

---

## Quick start

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → select this folder.
2. Open <https://web.whatsapp.com> and scan the QR code.
3. Click the toolbar icon → **Open dashboard**.
4. Open **Common**, turn on **Auto-reply**, choose **Bot** as the reply engine, then open
   the **Bot** tab and create your first bot (name + reply + keywords).
5. Tune delays, who may be answered, and per-chat overrides on the same screen.

After updating the extension, **reload the WhatsApp tab** so the new content scripts are
injected. If you use the retained AI engine, reload provider tabs too.

---

## Bot replies

A bot is a **named predefined reply** plus one or more **keywords**. Each keyword is one
of two match types:

| Type | Meaning | Example |
|---|---|---|
| `exact` | the whole incoming message equals the keyword | keyword `hi` matches `HI` but not `hi there` |
| `contains` | the keyword appears anywhere in the message | keyword `price` matches `send the price list` |

Rules enforced by the dashboard and the matcher ([lib/bots.js](lib/bots.js)):

- **One bot answers a message.** Exact matches beat `contains` matches; within the same
  match type, the bot higher in the list wins.
- A bot can have **many keywords**. A keyword may exist in **only one bot** — adding a
  duplicate shows which bot already owns it, and saving is blocked.
- Keywords are compared case-insensitively with whitespace collapsed. `Hi` and `  hi `
  are the same keyword.
- Disabled bots and bots without a reply are ignored.
- If no bot matches, the message is silently skipped. Bot mode never falls back to the
  fixed reply — switch the engine to Fixed if you want a canned answer for everything.
- The **Test matching** box in the Bot tab shows which bot/keyword would win without
  sending anything.

Bots are stored in `chrome.storage.local.bots` as an ordered array:
`{ id, name, enabled, reply, keywords: [{ text, type }], createdAt, updatedAt }`.
Order is priority. The dashboard writes them, so keyword uniqueness is always checked
there; a hand-edited storage value is matched leniently.

The regular safety rails still apply in bot mode: master switch, direct/group/community/
channel toggles, per-chat overrides, cooldown, hourly cap, human delay, typing and queue.

---

## What changed in v2 (and how each limitation is addressed)

Rows 2, 4 and 6 describe the retained AI engine; its dashboard is currently read-only
while the AI menu says **coming soon**. Bot replies are the active engine in v2.1.

| # | Before | Now | Can we fully solve it? |
|---|--------|-----|------------------------|
| 1 | One conversation at a time; one global AI job | Per-chat conversation records (name, kind, turns, summary, provider, cooldowns). AI jobs are keyed by request and run **concurrently across providers**; each provider tab still handles one job at a time because the UI is single-threaded. | **Mostly.** Concurrency is bounded by the number of open provider tabs. Truly parallel jobs in one tab would need separate browser windows or the providers' paid APIs. |
| 2 | No conversation summary | A free deterministic **extractive summary** (topic words, open questions, last exchange) is rebuilt every N turns and used in full prompts + shown in the detail sheet. `AI summary` asks the active provider for a 70-word summary. | **Yes, with trade-offs.** Extractive summaries are free and private but shallow. AI summaries are better, but only work when that conversation is the provider tab's active chat, and they add one turn to the provider chat. |
| 3 | Fixed 400–1200 ms jitter | A real **outbound queue** in the page: per-chat random delay (global + per-chat override), “typing…” presence sized by reply length, read receipt, minimum gap between sends, hourly cap, one retry, cancellation. | **Yes.** Delay is applied per reply and visible in the dashboard. The queue is deliberately not resumed after a page reload (see limitations) to avoid double sends. |
| 4 | Gemini only | Provider registry with **Gemini, ChatGPT, DeepSeek, Kimi** adapters, round-robin across enabled/idle tabs, per-conversation pinning, busy detection, an AI wait queue, and a **Test** button that reports which selectors matched. | **Yes, but fragile by nature.** It drives consumer web UIs, so an upstream redesign can break selectors. Test + logs make that diagnosable; adding a provider is a ~20-line config. |
| 5 | No conversation list | Dashboard lists every chat with kind badge, search, filters, **tri-state per-chat reply** (default / always / never), per-chat provider, chat-type override, and separate global toggles for **direct, groups, communities, channels**. | **Yes.** Communities are detected from `groupMetadata` (`COMMUNITY` or `parentGroup`). If WhatsApp changes that shape, the manual chat-type override still works. |
| 6 | Full prompt injected every message | Three context modes: **delta** (new message + one line), **hybrid** (delta + full re-anchor every N turns or when a provider switches conversation), **full** (summary + recent turns). The provider's own chat history is the cache. | **Yes, ~75–85% fewer prompt tokens** in delta mode, with no accuracy loss while the same chat stays on the same provider tab. On a switch, hybrid automatically pays for a full prompt instead of guessing. |
| 7 | One minimal popup | One **single-screen dashboard** (status, engine, context, providers, queue) with a **detail sheet** per conversation and the existing separate **Logs** window for deep debugging. | **Yes.** Everything lives on one page; the detail sheet is the “bug window” for a single chat, Logs remains the global one. |

### Why deltas do not lose accuracy

The provider tab keeps its own conversation. Re-sending the whole history every turn is
wasteful; the model already has it. So the AI router tracks which conversation each
provider tab currently holds and whether that conversation's last turn went to the same
provider:

- same chat + same provider → **delta**: `~45–60 tokens` (instruction + new message);
- provider switched chat, new provider, every Nth turn, or `full` mode → **full**:
  `~250–400 tokens` (persona + summary + last 6 turns + message).

The dashboard's detail sheet shows both estimates for the selected conversation, so the
trade-off is visible rather than hidden.

### Duplicate replies are dropped at three layers

1. The page keeps a set of handled message ids (normalised to the stable trailing id, so
   `_serialized` variance cannot create a second key).
2. The worker claims a message id **before any `await`**, so two events arriving in the
   same tick cannot both schedule a reply.
3. If two AI tasks still produce identical text for the same chat within 15 seconds, the
   second delivery is suppressed. Fixed and bot replies are not affected, because their
   text is deterministic.

The provider scraper also keeps only the deepest matching DOM node and de-duplicates
identical text, because Gemini nests `message-content > .markdown` and both used to match
the selector — that produced exactly the “same reply twice in one bubble” symptom.

---

## Dashboard

The dashboard has a horizontal top nav — **Conversations**, then a grouped **Common /
Bot / AI**. The left rail changes with the selected tab:

- **Conversations** — searchable/filterable chat list. Every row has a reply switch in
  front; click the row to open that chat's rules in the big content area.
- **Common** — rail sections for Reply engine, Recipients, Pacing & limits, and Send
  queue; selecting one shows that card in the big area.
- **Bot** — bot list, each row with an enable switch in front. Clicking a bot opens its
  editor in the big area; **+ New bot** starts a new one; the tester lives under the
  editor.
- **AI** — `Soon`; the AI engine is retained but its configuration is read-only.

The wide content area is reserved for editing or the detailed view — the rail is only for
picking a chat/bot/section. Every conversation row and bot row starts with a switch:
conversation switches toggle replies for that chat, bot switches enable/disable the bot.

---

## Settings

Stored in `chrome.storage.sync` (conversations, overrides, bots, queue and logs are in
`chrome.storage.local`).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | master switch |
| `replyMode` | `fixed` | `fixed`, `bot` or `ai` |
| `replyText` | friendly default | fixed reply / AI fallback |
| `replyToContacts` | `true` | answer direct chats |
| `replyToGroups` | `false` | answer groups |
| `replyToCommunities` | `false` | answer community chats |
| `replyToNewsletters` | `false` | answer channels |
| `minRetryMs` | `60000` | per-chat cooldown |
| `maxMessageAgeMs` | `120000` | ignore history-sync replays |
| `maxSendsPerHour` | `40` | global cap |
| `minGapBetweenSendsMs` | `2000` | gap between any two sends |
| `replyDelayMinMs` / `replyDelayMaxMs` | `2500` / `7000` | human delay range |
| `typingSimulation` | `true` | show “typing…” before sending |
| `typingCps` | `14` | typing speed used to size the presence |
| `markSeen` | `true` | mark the chat read before replying |
| `aiProvider` | `auto` | `auto` or a provider id |
| `enabledProviders` | gemini only | per-provider on/off |
| `aiTimeoutMs` | `90000` | per-request timeout |
| `aiFallbackToFixed` | `true` | send `replyText` if AI fails |
| `aiManual` | `false` | build the prompt but do not send |
| `ownerName` | empty | name the AI writes as |
| `aiPersona` | casual/concise | style instruction |
| `aiPrompt` | empty | custom template, empty = built-in |
| `contextMode` | `hybrid` | `delta`, `hybrid`, `full` |
| `recentTurns` | `6` | turns included in full prompts |
| `anchorEveryTurns` | `20` | full re-anchor interval |
| `summaryMode` | `extractive` | `off`, `extractive`, `ai` |
| `summaryEveryTurns` | `8` | summary refresh interval |

Per-chat overrides live in `chrome.storage.local.overrides`:
`{ reply: on|off, kind: contact|group|community|newsletter, provider: auto|id, delayMinMs, delayMaxMs }`.

The AI settings below are retained and still used when `replyMode` is `ai`; their
dashboard controls are read-only while the AI menu is marked coming soon.

**Privacy:** conversations, summaries, bots, queue state and logs stay in this Chrome
profile's `chrome.storage.local`. Message text only leaves the machine when an AI reply is
generated — and then only to the provider tab you chose. **Dashboard → Clear conversation
data** wipes conversations/overrides but keeps your bots.

---

## Providers (AI engine retained — configuration coming soon)

The provider adapters and background routing are still in the build. The AI menu in the
dashboard is read-only until its configuration returns.

| Provider | Host | Notes |
|---|---|---|
| Gemini | `gemini.google.com` | Quill editor; most reliable adapter |
| ChatGPT | `chatgpt.com` | ProseMirror editor; Cloudflare may slow first load |
| DeepSeek | `chat.deepseek.com` | textarea composer; response blocks vary |
| Kimi | `www.kimi.com`, `kimi.moonshot.cn` | contenteditable composer |

The driver (`providers/driver.js`) polls for the composer, inserts text (native setter
for textareas, `execCommand` for rich editors), clicks Send (Enter fallback), waits until
the stop button disappears and the response text is stable for 3 polls, then scrapes it.
If a site redesigns its UI, **Dashboard → provider → Test** shows which selector failed
and the Logs page shows the exact error. Update the selector list in that provider's
config file; no other code changes.

Before the first AI reply, press **New chat** once in that provider tab so WhatsApp does
not inherit an unrelated conversation. Hybrid mode re-anchors with a full prompt whenever
a provider switches chats, so this is a quality tweak, not a correctness requirement.

To add another provider: copy `providers/gemini.js`, change `id`, host/matches, selectors,
add it to `PROVIDERS` in `lib/defaults.js` and to `manifest.json` (host permission +
content script).

---

## Manual feed (AI — coming soon)

When the AI configuration returns, enabling **Feed prompts manually** builds a prompt
without sending it. For now the control is disabled along with the rest of the AI panel.

---

## Logs

Open **Logs** from the dashboard or the popup. Entries are tagged `policy`, `incoming`,
`queue`, `send`, `presence`, `ai`, `provider:*`, `summary`, `conv`, `status`, `boot`.
Filter by level/tag/text, copy, clear. 1500 rows are kept in a ring buffer.

---

## Known limitations (honest list)

- **Bot keywords are literal, not regex.** `contains` is a plain substring test, so a
  keyword like `hi` also matches `this`; use `exact` or phrase keywords to avoid that.
- **One reply per bot.** No random variants or per-bot cooldown yet; the global pacing,
  cooldown and hourly cap still apply.
- **Keyword uniqueness is enforced by the dashboard.** The background matcher tolerates a
  hand-edited storage file, but it will not warn you about duplicates there.
- **Bots are local to this Chrome profile** (`chrome.storage.local`), not synced across
  devices.
- **WhatsApp Web must stay open.** Sending and receiving only exist in that page. There is
  no server-side queue; closing the tab pauses everything.
- **The send queue is not resumed after a reload.** It is mirrored to storage for
  visibility only. Resuming could double-send a message whose ack was lost. A durable
  outbox would need idempotency keys on top of wa-js, which WhatsApp does not expose.
- **One tab per provider.** Multiple provider tabs of the same site are not used. Adding
  that is possible (the driver is already per-tab) but needs a tab pool and per-tab chat
  tracking.
- **Provider memory is per tab, not per conversation.** When a provider tab switches to
  another WhatsApp chat, hybrid mode sends a full prompt to re-anchor. Automatic
  “new chat per conversation” is not implemented because it costs seconds per switch and
  is the most fragile DOM action; the **New chat** button is there for manual resets.
- **AI summaries are not free.** Auto summaries are extractive. AI summaries consume a
  provider turn and only run when that conversation is already active in a provider tab.
- **DOM automation is brittle by design.** No official API, no keys: selectors are
  best-effort and can break on provider redesigns (Test/Logs make it visible).
- **Hidden provider tabs can be throttled.** Chrome slows timers in background tabs
  (severely after a few minutes), which can stretch an AI reply from seconds to much
  longer. Keep provider tabs in a normal window (or a second monitor) for best latency.
- **Manual feed captures from the first free enabled provider tab.** If you have several
  provider tabs open, make sure only the one you pasted into is enabled.
- **Multi-account WhatsApp** needs separate Chrome profiles (one session per profile).
- **Automation risk.** Human pacing, caps, cooldowns and group/community defaults reduce
  the chance of looking like a bot, but do not make it zero. This is for personal-scale
  replies, not bulk messaging.
- **Service worker restarts.** In-flight AI jobs are persisted and late responses are
  still delivered, but a watchdog timer can be lost when Chrome stops the worker; the
  page's own timeout and the cleanup alarm cover the common cases.

---

## Tests

No browser needed for the pure logic and the orchestrator smoke test:

```bash
npm test          # 69 assertions across defaults, bots, policy, context, background
npm run check     # syntax-check every JS file
```

`tests/background.smoke.test.js` stubs `chrome.storage`, `chrome.tabs` and
`chrome.runtime`, loads `background.js`, and drives the real message protocol:
fixed reply → ack → conversation memory, duplicate suppression, group/community gates,
per-chat overrides, stale/media skips, AI fallback with no provider tab, and bot matching
(one bot per message, disabled bots and no-match silence).

---

## Migrating from v1 / v2

Settings migrate automatically: `aiMode: "gemini"` becomes `replyMode: "ai"` with Gemini
enabled; `aiMode: "fixed"` becomes `replyMode: "fixed"`. A custom `aiPrompt` template keeps
working. Old logs are compatible. Conversations are unchanged, and bots start empty —
create your first one in the **Bot** tab.

## Rebuilding wa-js

```bash
curl -sSL -o vendor/wppconnect-wa.js "https://unpkg.com/@wppconnect/wa-js/dist/wppconnect-wa.js"
```

Then reload the WhatsApp tab. `wa-js` tracks WhatsApp internals; if WhatsApp ships a big
change, update this file first.
