// NEXUS backend — the only place that ever sees API keys.
// The browser talks to /api/*; this file talks to Gemini + the
// specialized data APIs and keeps every secret in .env.

require('dotenv').config();
const express = require('express');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const GNEWS_API_KEY = process.env.GNEWS_API_KEY || '';
const RAWG_API_KEY = process.env.RAWG_API_KEY || '';
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const NEXUS_SYSTEM_PROMPT = [
  'NEXUS is a futuristic personal AI assistant. It is intelligent, concise,',
  'helpful and technically capable. It explains difficult concepts clearly,',
  'and assists with programming, planning, research, productivity and',
  'general questions. It should never pretend to know something it does',
  'not know. When information may be outdated, it should clearly state',
  'that current information may require a web search or a specialized API.',
  'Use Markdown where it helps (headings, lists, code blocks, tables), but',
  'do not pad answers unnecessarily.'
].join(' ');

/* ------------------------------------------------------------
   ERROR CLASSIFICATION — turn raw SDK/HTTP errors into the
   small set of statuses the frontend knows how to display.
------------------------------------------------------------ */
function classifyGeminiError(err) {
  if (!GEMINI_API_KEY) return 'api_key_missing';
  const status = err && (err.status || err.code || (err.response && err.response.status));
  const msg = ((err && err.message) || String(err) || '').toLowerCase();
  if (status === 401 || status === 403 || /api key not valid|invalid.*key|permission denied/.test(msg)) return 'invalid_api_key';
  if (status === 429 || /quota|rate limit|resource_exhausted/.test(msg)) return 'rate_limit_exceeded';
  if (status === 404 || /not found|unsupported model|model.*not.*found/.test(msg)) return 'model_unavailable';
  if (/network|enotfound|econnreset|econnrefused|fetch failed|timeout/.test(msg)) return 'network_error';
  return 'api_request_failed';
}
const ERROR_MESSAGES = {
  api_key_missing: 'API key missing. Add GEMINI_API_KEY to server/.env and restart the server.',
  invalid_api_key: 'Invalid API key. Check GEMINI_API_KEY in server/.env.',
  model_unavailable: 'Model unavailable. Check GEMINI_MODEL in server/.env.',
  rate_limit_exceeded: 'Rate limit exceeded. Please wait and try again.',
  network_error: 'Network error while reaching Gemini.',
  api_request_failed: 'The Gemini API request failed.',
};

/* ------------------------------------------------------------
   HEALTH / DIAGNOSTICS
   GET /api/health          -> config check only (fast, free)
   GET /api/health?live=1   -> makes a tiny real Gemini call
------------------------------------------------------------ */
app.get('/api/health', async (req, res) => {
  const base = { geminiConfigured: !!GEMINI_API_KEY, model: GEMINI_MODEL, backend: 'online', spotifyConfigured: !!(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET) };
  if (!GEMINI_API_KEY) return res.json({ ...base, status: 'not_configured', error: 'api_key_missing' });
  if (req.query.live !== '1') return res.json({ ...base, status: 'configured' });
  try {
    await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: 'Reply with the single word: ready',
      config: { maxOutputTokens: 5 },
    });
    res.json({ ...base, status: 'ready' });
  } catch (err) {
    const code = classifyGeminiError(err);
    console.error('NEXUS /api/health live check failed:', err);
    res.json({ ...base, status: 'error', error: code, message: ERROR_MESSAGES[code] });
  }
});

/* ------------------------------------------------------------
   SPECIALIZED TOOLS — used for intent routing inside /api/chat
------------------------------------------------------------ */
async function toolWeather(city) {
  const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`).then(r => r.json());
  if (!geo.results || !geo.results.length) throw new Error('Location not found: ' + city);
  const loc = geo.results[0];
  const params = 'current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code&timezone=auto';
  const data = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&${params}`).then(r => r.json());
  return {
    city: [loc.name, loc.admin1, loc.country].filter(Boolean).join(', '),
    temp: Math.round(data.current.temperature_2m),
    feels: Math.round(data.current.apparent_temperature),
    humidity: data.current.relative_humidity_2m,
    wind: Math.round(data.current.wind_speed_10m),
  };
}
async function toolNews(topic) {
  if (!GNEWS_API_KEY) throw new Error('GNews not configured');
  const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(topic || 'technology')}&lang=en&sortby=publishedAt&max=5&apikey=${GNEWS_API_KEY}`;
  const data = await fetch(url).then(r => r.json());
  return (data.articles || []).map(a => ({ title: a.title, source: a.source && a.source.name, url: a.url }));
}
async function toolMovies() {
  if (!TMDB_API_KEY) throw new Error('TMDB not configured');
  const url = `https://api.themoviedb.org/3/trending/movie/week?api_key=${TMDB_API_KEY}&language=en-US`;
  const data = await fetch(url).then(r => r.json());
  return (data.results || []).slice(0, 5).map(m => ({ title: m.title, year: (m.release_date || '').slice(0, 4), rating: (m.vote_average || 0).toFixed(1) }));
}
async function toolGithub(username) {
  const data = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, {
    headers: { 'User-Agent': 'nexus-dashboard' },
  }).then(r => r.json());
  if (!data || data.message === 'Not Found') throw new Error('GitHub user not found: ' + username);
  return { username: data.login, repos: data.public_repos, followers: data.followers, bio: data.bio };
}
function detectIntent(message) {
  const m = message.toLowerCase();
  if (/\bweather\b/.test(m)) {
    const cityMatch = m.match(/weather.*?(?:in|for|at)\s+([a-z\s]+?)[\?\.!]?$/i);
    return { type: 'weather', city: cityMatch ? cityMatch[1].trim() : null };
  }
  if (/trending movies?|movies? (tonight|to watch|recommend)|show me movies/.test(m)) {
    return { type: 'movies' };
  }
  if (/(latest|top|recent).{0,15}news|news.*(today|latest)/.test(m)) {
    const topicMatch = m.match(/news (?:about|on)\s+([a-z\s]+)/i);
    return { type: 'news', topic: topicMatch ? topicMatch[1].trim() : 'technology' };
  }
  if (/(show|my) .{0,10}github|github (repo|repositories|profile)/.test(m)) {
    return { type: 'github' };
  }
  return { type: 'general' };
}

/* ------------------------------------------------------------
   GEMINI STREAMING HELPER — writes SSE-style `data: {...}\n\n`
   chunks onto an already-open response.
------------------------------------------------------------ */
async function streamGemini(message, history, send) {
  const contents = [
    ...history.map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(h.content || '') }] })),
    { role: 'user', parts: [{ text: message }] },
  ];
  const stream = await ai.models.generateContentStream({
    model: GEMINI_MODEL,
    contents,
    config: { systemInstruction: NEXUS_SYSTEM_PROMPT, maxOutputTokens: 1536, temperature: 0.7 },
  });
  let full = '';
  for await (const chunk of stream) {
    const t = chunk.text;
    if (t) { full += t; send({ chunk: t }); }
  }
  if (!full) throw new Error('Empty response from Gemini');
  return full;
}

/* ------------------------------------------------------------
   POST /api/chat  — the only endpoint the AI chat UI calls.
   Body: { message: string, history: [{role, content}], githubUsername?, city? }
   Streams `data: {...}\n\n` events; always ends with a `done` event
   (either `{done:true[, module]}` on success or `{error, message,
   done:true}` on failure — never a silent canned fallback).
------------------------------------------------------------ */
app.post('/api/chat', async (req, res) => {
  const { message, history, githubUsername, city } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ success: false, error: 'empty_message', message: 'Message is required.' });
  }
  if (!GEMINI_API_KEY) {
    return res.status(503).json({ success: false, error: 'api_key_missing', message: ERROR_MESSAGES.api_key_missing });
  }
  const safeHistory = Array.isArray(history) ? history.slice(-16) : [];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const intent = detectIntent(message);

    if (intent.type === 'weather') {
      const w = await toolWeather(intent.city || city || 'Bhopal');
      const prompt = `The user asked: "${message}". Live weather data (JSON): ${JSON.stringify(w)}. Answer naturally and concisely using only this data — mention city, temperature, feels-like, humidity, and wind.`;
      await streamGemini(prompt, [], send);
      send({ done: true, module: 'weather' });

    } else if (intent.type === 'movies') {
      const movies = await toolMovies();
      const text = movies.length
        ? 'Trending this week:\n' + movies.map(m => `- **${m.title}** (${m.year}) — ${m.rating}/10`).join('\n')
        : "I couldn't find trending movies right now.";
      send({ chunk: text });
      send({ done: true, module: 'movies' });

    } else if (intent.type === 'news') {
      const articles = await toolNews(intent.topic);
      const prompt = `The user asked: "${message}". Recent headlines (JSON): ${JSON.stringify(articles)}. Summarize the key stories in 3-5 concise bullet points, in your own words — do not just repeat the titles verbatim.`;
      await streamGemini(prompt, [], send);
      if (articles.length) send({ sources: articles.map(a => ({ title: a.title, url: a.url })) });
      send({ done: true, module: 'news' });

    } else if (intent.type === 'github') {
      const gh = await toolGithub(githubUsername || 'octocat');
      const text = `**${gh.username}** has ${gh.repos} public repositories and ${gh.followers} followers.${gh.bio ? '\n' + gh.bio : ''}`;
      send({ chunk: text });
      send({ done: true, module: 'github' });

    } else {
      await streamGemini(message, safeHistory, send);
      send({ done: true });
    }
  } catch (err) {
    console.error('NEXUS chat error:', err);
    const code = classifyGeminiError(err);
    send({ error: code, message: ERROR_MESSAGES[code] || (err && err.message) || 'Request failed', done: true });
  }
  res.end();
});

/* ------------------------------------------------------------
   SPECIALIZED-API PROXIES — the frontend calls these same-origin
   paths; keys are attached here and never reach the browser.
------------------------------------------------------------ */
function proxyRoute(prefix, upstreamBase, keyParam, apiKey) {
  app.get(`${prefix}/*`, async (req, res) => {
    if (!apiKey) return res.status(503).json({ success: false, error: `${prefix.slice(5).toUpperCase()} not configured` });
    const subpath = req.params[0];
    const url = new URL(`${upstreamBase}/${subpath}`);
    for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v);
    url.searchParams.set(keyParam, apiKey);
    try {
      const upstream = await fetch(url.toString());
      const data = await upstream.json();
      res.status(upstream.status).json(data);
    } catch (err) {
      console.error(`NEXUS ${prefix} proxy error:`, err);
      res.status(502).json({ success: false, error: 'upstream_request_failed' });
    }
  });
}
proxyRoute('/api/tmdb', 'https://api.themoviedb.org/3', 'api_key', TMDB_API_KEY);
proxyRoute('/api/gnews', 'https://gnews.io/api/v4', 'apikey', GNEWS_API_KEY);
proxyRoute('/api/rawg', 'https://api.rawg.io/api', 'key', RAWG_API_KEY);

/* ------------------------------------------------------------
   SPOTIFY — Client Credentials flow (server-side only; this
   flow never sees a user's account, it just authenticates the
   app itself so we can search the public catalog). Token is
   cached in memory and refreshed shortly before it expires.
   Get a client id/secret at https://developer.spotify.com/dashboard
------------------------------------------------------------ */
let spotifyToken = null;
let spotifyTokenExpiresAt = 0;
async function getSpotifyToken() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) throw new Error('Spotify not configured');
  if (spotifyToken && Date.now() < spotifyTokenExpiresAt) return spotifyToken;
  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) throw new Error(data.error_description || 'Spotify auth failed');
  spotifyToken = data.access_token;
  spotifyTokenExpiresAt = Date.now() + (Math.max(60, (data.expires_in || 3600) - 60) * 1000);
  return spotifyToken;
}
// GET /api/spotify/search?q=...&type=track,album,playlist,artist&limit=10
app.get('/api/spotify/search', async (req, res) => {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return res.status(503).json({ success: false, error: 'spotify_not_configured', message: 'Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to server/.env.' });
  }
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ success: false, error: 'missing_query' });
  const type = req.query.type || 'track';
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 20);
  try {
    const token = await getSpotifyToken();
    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}&limit=${limit}`;
    const upstream = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ success: false, error: 'spotify_request_failed', message: data.error && data.error.message });
    const tracks = (data.tracks && data.tracks.items || []).map(t => ({
      id: t.id,
      name: t.name,
      artists: (t.artists || []).map(a => a.name).join(', '),
      album: t.album && t.album.name,
      image: t.album && t.album.images && t.album.images[0] && t.album.images[0].url,
      durationMs: t.duration_ms,
      previewUrl: t.preview_url,
      externalUrl: t.external_urls && t.external_urls.spotify,
      uri: t.uri,
    }));
    res.json({ success: true, tracks });
  } catch (err) {
    console.error('NEXUS spotify search error:', err);
    res.status(502).json({ success: false, error: 'spotify_request_failed', message: err.message });
  }
});
// GET /api/spotify/health — lets the frontend know if search is available
app.get('/api/spotify/health', (req, res) => {
  res.json({ configured: !!(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET) });
});

/* ------------------------------------------------------------
   STATIC FRONTEND
------------------------------------------------------------ */
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR));
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`NEXUS running at http://localhost:${PORT}`);
  console.log(`Gemini configured: ${!!GEMINI_API_KEY} (model: ${GEMINI_MODEL})`);
  if (!GEMINI_API_KEY) {
    console.warn('⚠ GEMINI_API_KEY is not set. Add it to server/.env — NEXUS AI will show an error until it is.');
  }
});
