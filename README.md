# NEXUS — Your Digital Command Center

NEXUS is a futuristic AI dashboard. This version runs on a small Node/Express
backend so **no API key ever lives in the browser** — the old single-file
`index.html` used to embed live keys directly in client-side JavaScript,
which is fixed here.

```
NEXUS
│
├── frontend/
│   └── index.html        — the NEXUS app (HTML + CSS + JS, unchanged UI/design)
├── server/
│   └── server.js          — Express backend: Gemini chat, health check, API proxies
├── .env                    — your secrets (already filled in from the old file — see note below)
├── .env.example             — template for sharing/committing
├── .gitignore
├── package.json
├── start-server.command     — one-click launcher (macOS/Linux)
├── start-server.bat         — one-click launcher (Windows)
└── README.md
```

## How to run

**macOS / Linux:** double-click `start-server.command` (first time: if macOS
blocks it, right-click → Open → Open again).

**Windows:** double-click `start-server.bat`.

Either way, the script installs dependencies on first run, copies
`.env.example` to `.env` if you don't have one yet, starts the server, and
opens `http://localhost:8080` in your browser.

Prefer the command line?

```bash
npm install
npm start
```

Requires **Node.js 18+** (get it from https://nodejs.org).

## Setting up your API key

Open `.env` and check `GEMINI_API_KEY`. It was carried over from your old
`index.html`, but that value (`AQ.Ab8RN6...`) doesn't look like a normal
Gemini key — real Gemini API keys usually start with `AIza...`. If NEXUS AI
shows an error, get a fresh key at **https://aistudio.google.com/apikey**,
paste it into `.env`, and restart the server.

```
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.5-flash
```

`TMDB_API_KEY`, `GNEWS_API_KEY`, and `RAWG_API_KEY` were also carried over
from the old file (Movies, News, and Games modules). They're optional — if
left blank, those modules fall back to their existing local demo data, same
as before.

## Music (Spotify)

The Music module now does two real things:

1. **Search** — type a song/artist/album and it searches the real Spotify
   catalog. This uses Spotify's Client Credentials flow, so it needs a
   `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env`:
   - Go to https://developer.spotify.com/dashboard, log in, click **Create
     app** (any name/description; you can put `http://localhost:8080` as the
     redirect URI even though this flow doesn't use it).
   - Copy the **Client ID** and **Client Secret** into `.env`.
   - This flow only reads Spotify's public catalog — it never touches a
     personal Spotify account, playlists, or requires the user to log in.
2. **Embedded playback** — clicking a search result (or pasting any
   `open.spotify.com/...` link or `spotify:track:...` URI into the "Have a
   Spotify link?" box) loads Spotify's official embedded player `<iframe>`
   right in the panel and on the Dashboard widget. Playback itself happens
   inside that Spotify iframe, so it follows normal Spotify rules (ads on a
   free account, full playback if the listener is logged into Premium in
   that browser).

Search is optional — even with no key configured, pasting a Spotify link
still plays instantly, so Music is never fully blocked on setup.

## What changed from the old version

- **NEXUS AI now actually answers anything.** It's no longer limited to a
  fixed set of commands — ask it to explain a concept, write code, compare
  things, or anything else, and it goes straight to Gemini.
- **Gemini is the primary (and only) AI engine**, called from the backend
  via the current official `@google/genai` SDK, with response streaming so
  replies appear progressively instead of all at once.
- **No more silent demo fallback.** If Gemini fails, NEXUS shows a real
  error ("could not connect to Gemini" + reason) with a **Retry** button.
  Demo Mode now only turns on if you explicitly choose it (in that error
  prompt, or in Settings → AI) — never automatically.
- **All API keys moved server-side.** `GEMINI_API_KEY`, `TMDB_API_KEY`,
  `GNEWS_API_KEY`, and `RAWG_API_KEY` live only in `.env`. The browser calls
  same-origin `/api/chat`, `/api/tmdb/...`, `/api/gnews/...`, `/api/rawg/...`
  instead.
- **Conversation memory.** NEXUS remembers the last several turns of the
  chat and sends them to Gemini, so follow-up questions work.
- **Basic tool routing.** Weather, trending-movies, top-news, and
  GitHub-profile questions are detected and answered using their existing
  specialized APIs (with Gemini summarizing the weather/news results);
  everything else goes straight to Gemini.
- **Status indicator that doesn't lie.** The AI Core badge only shows
  ONLINE after a real health check succeeds, not on page load.
- **Settings → AI**: a Real AI / Demo toggle, plus AI Diagnostics showing
  Gemini configuration, backend status, active model, and live connection
  state.
- **Chat UI fixes**: real Markdown rendering (headings, lists, tables, code
  blocks with a copy button and syntax highlighting), Enter to send /
  Shift+Enter for a new line, Send disabled while a reply is streaming, and
  the message list auto-scrolls correctly.
- Movies, News, and Games modules work exactly as before — they just fetch
  through the backend proxy now instead of calling TMDB/GNews/RAWG directly
  with an exposed key. Weather (Open-Meteo) and GitHub's public profile
  endpoint never needed a key, so they're untouched.

## API reference (backend)

- `POST /api/chat` — `{ message, history, githubUsername?, city? }` → a
  `text/event-stream` of `data: {...}\n\n` events (`{chunk}` for streamed
  text, `{module}`/`{sources}` for metadata, `{error, message, done:true}`
  on failure, `{done:true}` on success).
- `GET /api/health` — config check. Add `?live=1` to run an actual tiny
  Gemini request and confirm the connection works.
- `GET /api/tmdb/*`, `/api/gnews/*`, `/api/rawg/*` — thin proxies that
  forward your request to the matching provider with the key attached
  server-side.
- `GET /api/spotify/search?q=...&type=track&limit=10` — searches Spotify's
  catalog (Client Credentials flow) and returns simplified track objects
  (name, artists, album art, duration, Spotify URI).
- `GET /api/spotify/health` — `{ configured: boolean }`, used by the
  frontend to know whether to show the search box or just the paste-a-link
  fallback.

## Notes

- This is still meant for local/personal use — there's no auth on the
  backend. Don't deploy it publicly without adding rate limiting and
  authentication in front of `/api/chat`.
- If you ever want Demo Mode as the default instead of Real AI, change
  `aiMode:'real'` to `aiMode:'demo'` in the `settings` default in
  `frontend/index.html`, or just toggle it once in Settings — it's saved.
