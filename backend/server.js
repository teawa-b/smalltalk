import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createQloo, qlooHosts } from './lib/qloo.js';
import { chooseLlm } from './lib/llm.js';
import { createLimiter } from './lib/limits.js';
import { loadDemo } from './lib/demos.js';
import { createTalk, transcribe, compareWithout } from './lib/talk.js';

// SmallTalk's backend: serves the page in ../frontend and the conversation API: start, hear a line, compare.
const files = {
  '/': ['talk.html', 'text/html'], '/talk.js': ['talk.js', 'text/javascript'], '/talk-xr.js': ['talk-xr.js', 'text/javascript'], '/talk.css': ['talk.css', 'text/css'],
  '/sound.js': ['sound.js', 'text/javascript'], '/fresh.js': ['fresh.js', 'text/javascript']
};
const cdn = 'https://cdn.jsdelivr.net';

const csp = {
  // Talk loads three.js from jsDelivr only when entering AR/VR; the microphone stays on this origin.
  home: `default-src 'self'; img-src 'self' https: data: blob:; media-src 'self' blob:; style-src 'self' ${cdn} https://fonts.googleapis.com; font-src https://fonts.gstatic.com ${cdn}; script-src 'self' ${cdn}; connect-src 'self' ${cdn}; base-uri 'none'; frame-ancestors 'none'`
};

// Bounded in-memory stores. A single instance is enough for a demo; restarts clear them.
function boundedMap(limit) {
  const map = new Map();
  return { get: k => map.get(k), set(k, v) { map.set(k, v); while (map.size > limit) map.delete(map.keys().next().value); return v; }, has: k => map.has(k), values: () => [...map.values()] };
}

export function createApp({ env = process.env, fetcher = fetch } = {}) {
  const talks = boundedMap(100);
  const llm = chooseLlm(env, fetcher);
  const qlooHost = qlooHosts.includes(env.QLOO_API_HOST) ? env.QLOO_API_HOST : qlooHosts[0];
  const limit = createLimiter({
    baseline: [Number(env.BASELINES_PER_HOUR || 12), 3600e3],
    talk: [Number(env.TALK_SESSIONS_PER_HOUR || 6), 3600e3],
    talkTurn: [Number(env.TALK_TURNS_PER_HOUR || 400), 3600e3],
    talkDaily: [Number(env.TALK_SESSIONS_PER_DAY || 100), 86400e3, true]
  });

  return async function handle(req, res) {
    const send = (status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(value)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Who is asking, for the limits. Behind a proxy (Railway) the real address is the one the proxy adds: X-Real-IP,
    // or the last X-Forwarded-For entry. The first entry is whatever the visitor sent, so it can't be trusted.
    const ip = String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',').pop() || req.socket.remoteAddress || '').trim();
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      // Static images and 3D rooms shipped with the app (logos, the examples). Names are restricted, so no path tricks.
      const image = path.match(/^\/img\/([a-z0-9-]+)\.(jpg|png|webp|glb)$/);
      if (req.method === 'GET' && image) {
        const bytes = await readFile(new URL(`../frontend/img/${image[1]}.${image[2]}`, import.meta.url)).catch(() => null);
        if (!bytes) return send(404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': image[2] === 'glb' ? 'model/gltf-binary' : `image/${image[2] === 'jpg' ? 'jpeg' : image[2]}`, 'Cache-Control': 'public, max-age=86400' });
        return res.end(bytes);
      }
      const entry = files[path];
      if (req.method === 'GET' && entry) {
        const [name, type] = entry;
        res.setHeader('Content-Security-Policy', csp['home'] || csp.home);
        res.setHeader('Permissions-Policy', 'microphone=(self), xr-spatial-tracking=(self)');
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        return res.end(await readFile(new URL(`../frontend/${name}`, import.meta.url)));
      }
      if (req.method === 'GET' && path === '/api/health') return send(200, { ok: true, version: env.VERCEL_DEPLOYMENT_ID || env.VERCEL_URL || 'local' });
      if (req.method === 'GET' && path === '/api/config') {
        return send(200, { site: 'talk', siteName: 'SmallTalk', qloo: Boolean(env.QLOO_API_KEY), qlooHost, llm: llm?.label || null });
      }

      if (req.method !== 'POST') return send(404, { error: 'Not found' });
      const origin = req.headers.origin;
      if (origin) { let host; try { host = new URL(origin).host; } catch {} if (host !== req.headers.host) return send(403, { error: 'Requests must come from this app.' }); }

      // Audio chunks (6 s of speech, base64) need more room than the JSON endpoints.
      const body = await readBody(req, path === '/api/talk/hear' ? 4_800_000 : 32_000);

      if (path === '/api/talk/demo') {
        const demo = await loadDemo('talk', body.demo);
        return demo ? send(200, demo) : send(404, { error: 'That example is not available.' });
      }

      // Talk: a live conversation coach. One session per conversation; each turn is audio or typed text.
      if (path === '/api/talk/start') {
        if (!llm) return send(503, { error: 'Talk needs an LLM key on the server.' });
        if (!env.QLOO_API_KEY) return send(503, { error: 'This server has no Qloo API key configured.' });
        if (body.consent !== true) return send(400, { error: 'Confirm the other person knows you are using a conversation assistant.' });
        if (!limit.take('talk', ip) || !limit.take('talkDaily', 'all')) return send(429, { error: 'Too many conversations this hour. Try again later.' });
        const id = randomUUID();
        const talk = createTalk({ qloo: createQloo({ key: env.QLOO_API_KEY, host: qlooHost, fetcher }), llm: llm.fast || llm });
        const mine = (Array.isArray(body.mine) ? body.mine : String(body.mine || '').split(',')).map(s => String(s).trim().slice(0, 60)).filter(Boolean);
        if (mine.length) await talk.setMine(mine);
        talks.set(id, { talk, busy: Promise.resolve(), qloo: createQloo({ key: env.QLOO_API_KEY, host: qlooHost, fetcher }) });
        return send(200, { id, view: talk.view(), state: talk.snapshot(), stt: Boolean(env.FAL_KEY) });
      }

      // The page sends the conversation's snapshot back with each turn, so an instance that has not seen this
      // conversation yet can pick it up.
      const findTalk = () => {
        const id = String(body.id || '');
        if (talks.get(id)) return talks.get(id);
        if (!/^[\w-]{8,64}$/.test(id) || !body.state || typeof body.state !== 'object' || !llm || !env.QLOO_API_KEY) return null;
        const qloo = createQloo({ key: env.QLOO_API_KEY, host: qlooHost, fetcher });
        return talks.set(id, { talk: createTalk({ qloo, llm: llm.fast || llm, saved: body.state }), busy: Promise.resolve(), qloo });
      };

      if (path === '/api/talk/hear') {
        const entry = findTalk();
        if (!entry) return send(404, { error: 'That conversation has ended. Start a new one.' });
        if (!limit.take('talkTurn', ip)) return send(429, { error: 'Slow down a little.' });
        const who = body.who === 'me' ? 'me' : 'them';
        let text = String(body.text || '').trim().slice(0, 600);
        if (!text && body.audio) {
          if (!env.FAL_KEY) return send(503, { error: 'Listening needs FAL_KEY on the server. Type what they said instead.' });
          if (String(body.audio).length > 4_000_000) return send(413, { error: 'Audio chunk too large.' });
          text = await transcribe({ key: env.FAL_KEY, audio: body.audio, fetcher });
        }
        if (!text) return send(200, { heard: '', view: entry.talk.view(), state: entry.talk.snapshot() });
        // One turn at a time per conversation, so mentions and suggestions stay in order.
        const turn = entry.busy.then(() => entry.talk.hear(text, who));
        entry.busy = turn.catch(() => {});
        await turn;
        return send(200, { heard: text, who, view: entry.talk.view(), state: entry.talk.snapshot() });
      }

      // With and without Qloo for a conversation so far: the main model alone, checked against Qloo's results.
      if (path === '/api/talk/compare') {
        const entry = findTalk();
        if (!entry) return send(404, { error: 'That conversation has ended. Start a new one.' });
        if (!entry.talk.state.them.size) return send(400, { error: 'Wait until they have mentioned something they love.' });
        if (!limit.take('baseline', ip)) return send(429, { error: 'Comparison limit reached. Try again later.' });
        await entry.busy;
        return send(200, await compareWithout({ state: entry.talk.state, llm, qloo: entry.qloo }));
      }

      return send(404, { error: 'Not found' });
    } catch (error) {
      if (res.headersSent) { try { res.end(); } catch {} return; }
      send(error.status && error.status < 600 ? error.status : 400, { error: error.message, ...(error.details ? { details: error.details } : {}) });
    }
  };
}

async function readBody(req, max) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > max) throw Object.assign(new Error('Request too large.'), { status: 413 }); }
  try { const body = JSON.parse(raw); if (body && typeof body === 'object') return body; } catch {}
  throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3303);
  const host = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  http.createServer(createApp()).listen(port, host, () => console.log(`SmallTalk running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
}
