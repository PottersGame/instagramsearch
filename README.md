# DM Finder

A **private, offline, local-only** web app for searching your Instagram DM
history. Instagram's own DM search is broken — this one isn't.

- **Zero network.** Everything runs in your browser. Your chats never leave your device.
- **Fast full-text search.** Inverted-index over every message in every conversation.
- **Filters** by person, sender, and date range.
- **Phrase search** with `"quotes"`, sender shorthand `from:alex`, conversation shorthand `in:alex`.
- **Context view.** Click any result to see the surrounding messages.
- **No build step, no dependencies, no tracking.** Just static files.

## Running it

There is no backend. Serve the folder with any static file server:

```bash
# Python 3
python3 -m http.server 8000

# Node
npx --yes http-server -p 8000 .
```

Then open `http://localhost:8000` in your browser.

You can also just `file://`-open `index.html` in Chrome / Edge / Firefox, but
some browsers restrict folder uploads from `file://` — a local server is more
reliable.

## Exporting your Instagram data

Open the app and click the **How to export** tab. In short:

1. Instagram → Settings → Accounts Center → Your information and permissions → **Download your information**.
2. Pick **Some of your information** → tick **Messages**.
3. Set format to **JSON**. *(HTML won't work.)*
4. Wait for Instagram's email with the ZIP.
5. Extract the ZIP and drop the folder on the app.

## Privacy model

The app enforces privacy in code, not just in policy:

- A strict `Content-Security-Policy` with `connect-src 'none'` prevents the
  page from making any network request — fetch, XHR, WebSocket, or otherwise.
- No third-party scripts, fonts, analytics, or CDN dependencies.
- No `localStorage` / `IndexedDB` writes. Data lives in RAM and disappears on
  refresh.
- Every line is unminified and sits in `js/` — read it yourself.

Verify it by opening DevTools → Network. After the initial HTML/CSS/JS load,
no further requests are made, no matter what you do inside the app.

## File layout

```
index.html       — entry point, UI markup, CSP
css/styles.css   — styles
js/parser.js     — Instagram export JSON parser + mojibake fix
js/search.js     — inverted index + query parser
js/app.js        — UI orchestration
```

## Query syntax

| Query                           | Meaning                                       |
| ------------------------------- | --------------------------------------------- |
| `pizza`                         | messages containing "pizza" (any case)        |
| `pizza party`                   | both words must appear (order irrelevant)     |
| `"happy birthday"`              | exact phrase                                  |
| `from:alex pizza`               | messages sent by someone matching "alex"      |
| `in:taylor "see you"`           | exact phrase inside the Taylor conversation   |

Combine with the **Match case** and **Whole word** toggles to narrow further.
