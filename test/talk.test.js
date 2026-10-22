import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../backend/server.js';

const QKEY = 'qloo-secret-key', OKEY = 'openrouter-secret-key', FKEY = 'fal-secret-key';

async function serve(t, env, fetcher) {
  const server = http.createServer(createApp({ env, fetcher }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}
const events = async res => (await res.text()).split('\n\n').map(c => c.split('\n').find(l => l.startsWith('data: '))).filter(Boolean).map(l => JSON.parse(l.slice(6)));
const post = (base, path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const reply = content => Response.json({ choices: [{ message: { content } }] });

// A fake Qloo with a few brands, a podcast and a book; every search hits by exact name.
const catalog = { 'Superhero Movie': 'm-superhero-movie', Calm: 'b-calm', Strava: 'b-strava', Uber: 'b-uber', Robinhood: 'b-robin', 'This Week in Startups': 'p-twist', 'Sally Rooney': 'pe-rooney', 'Phoebe Bridgers': 'a-pb', 'Past Lives': 'm-pl', Marvel: 'br-marvel' };
function qloo(url, log) {
  const p = url.searchParams;
  log.push(Object.fromEntries(p));
  if (url.pathname === '/v2/tags') return Response.json({ results: { tags: /superhero/i.test(p.get('filter.query')) ? [{ tag_id: 't-super', name: 'Superhero' }] : [] } });
  if (url.pathname === '/search') {
    const name = Object.keys(catalog).find(k => k.toLowerCase() === p.get('query').toLowerCase());
    return Response.json({ results: name ? [{ name, entity_id: catalog[name], popularity: 0.9, types: [p.get('types') || 'urn:entity:brand'] }] : [] });
  }
  const type = p.get('filter.type');
  if (type === 'urn:demographics') return Response.json({ results: { demographics: (p.get('signal.interests.entities') || '').split(',').map(id => ({ entity_id: id, query: { age: { '25_to_29': 0.4, '45_to_54': -0.3 }, gender: {} } })) } });
  if (p.get('filter.results.entities')) return Response.json({ results: { entities: p.get('filter.results.entities').split(',').map((id, i) => ({ name: Object.keys(catalog).find(k => catalog[k] === id), entity_id: id, query: { affinity: 0.8 - i * 0.05 } })) } });
  const explain = p.get('feature.explainability') === 'true';
  const ids = (p.get('signal.interests.entities') || '').split(',');
  return Response.json({ results: { entities: [
    { name: 'Lucy Dacus', entity_id: 'a-dacus', query: { affinity: 0.92, ...(explain ? { explainability: { 'signal.interests.entities': ids.map(id => ({ entity_id: id, score: 1 / ids.length })) } } : {}) } },
    { name: 'The Power Law', entity_id: 'bk-power', query: { affinity: 0.88 } }
  ] } });
}

test('talk: consent first, typed or transcribed lines become a Qloo taste profile, nudges cite Qloo names', async t => {
  const log = [];
  const fetcher = async (url, options = {}) => {
    url = new URL(url);
    if (url.host === 'hackathon.api.qloo.com') return qloo(url, log);
    if (url.host === 'fal.run') {
      assert.equal(url.pathname, '/fal-ai/elevenlabs/speech-to-text');
      assert.equal(options.headers.authorization, `Key ${FKEY}`);
      return Response.json({ text: 'I love Past Lives but I really cannot stand Marvel.' });
    }
    if (url.host === 'openrouter.ai') {
      const body = JSON.parse(options.body), prompt = body.messages.at(-1).content;
      if (/extract cultural references/.test(body.messages[0].content)) {
        const mentions = [];
        if (/Sally Rooney/.test(prompt)) mentions.push({ name: 'Sally Rooney', kind: 'person', who: 'them', feeling: 'likes' });
        if (/Past Lives/.test(prompt)) mentions.push({ name: 'Past Lives', kind: 'movie', who: 'them', feeling: 'likes' });
        if (/Marvel/.test(prompt)) mentions.push({ name: 'Marvel', kind: 'brand', who: 'them', feeling: 'dislikes' });
        if (/stand superhero/.test(prompt)) mentions.push({ name: 'superhero films', kind: 'genre', who: 'them', feeling: 'dislikes' });
        return reply(JSON.stringify({ mentions }));
      }
      if (/Suggest exactly 6/.test(prompt)) return reply(JSON.stringify({ picks: [{ name: 'Lucy Dacus', kind: 'artist' }, { name: 'Uber', kind: 'brand' }, { name: 'Imaginary Band', kind: 'artist' }] }));
      return reply(JSON.stringify({ nudges: [{ say: 'Have you heard Lucy Dacus?', about: 'Lucy Dacus', why: 'fans of their taste love her' }, { say: 'Seen Dune?', about: 'Dune', why: 'guess' }] }));
    }
    throw new Error(`Unexpected request to ${url}`);
  };
  const base = await serve(t, { QLOO_API_KEY: QKEY, OPENROUTER_API_KEY: OKEY, FAL_KEY: FKEY }, fetcher);
  assert.equal((await post(base, '/api/talk/start', {})).status, 400, 'no consent, no session');
  const { id } = await post(base, '/api/talk/start', { consent: true, mine: 'Phoebe Bridgers' }).then(r => r.json());
  const first = await post(base, '/api/talk/hear', { id, text: 'I am reading the new Sally Rooney', who: 'them' }).then(r => r.json());
  assert.deepEqual(first.view.them.map(e => e.name), ['Sally Rooney']);
  assert.deepEqual(first.view.mine.map(e => e.name), ['Phoebe Bridgers']);
  assert.deepEqual(first.view.nudges.map(n => [n.about, n.grounded]), [['Lucy Dacus', true], ['Dune', false]], 'nudges are checked against Qloo results');
  assert.ok(first.view.shared.some(s => s.name === 'Lucy Dacus'), 'common ground comes from a combined signal with explainability');
  const audio = await post(base, '/api/talk/hear', { id, audio: 'data:audio/webm;base64,GkXfo0', who: 'them' }).then(r => r.json());
  assert.equal(audio.heard, 'I love Past Lives but I really cannot stand Marvel.');
  // A real 6-second chunk is a few hundred kilobytes once base64-encoded; it must get through.
  assert.equal((await post(base, '/api/talk/hear', { id, audio: 'data:audio/webm;base64,' + 'A'.repeat(300_000), who: 'them' })).status, 200, 'real-size audio chunks are accepted');
  assert.deepEqual(audio.view.them.map(e => e.name), ['Sally Rooney', 'Past Lives']);
  assert.deepEqual(audio.view.avoid.map(e => e.name), ['Marvel'], 'dislikes are kept apart');
  // A disliked genre becomes a Qloo tag, never a film that happens to share a word with it.
  const genre = await post(base, '/api/talk/hear', { id, text: 'I cannot stand superhero films', who: 'them' }).then(r => r.json());
  assert.deepEqual(genre.view.avoid.map(e => e.name), ['Marvel', 'Superhero']);
  // Without Qloo: an LLM alone suggests what to bring up; each pick is checked against Qloo's results for their taste.
  const cmp = await post(base, '/api/talk/compare', { id }).then(r => r.json());
  assert.deepEqual(cmp.picks.map(p => [p.name, p.verdict]), [['Lucy Dacus', 'ranked'], ['Uber', 'known'], ['Imaginary Band', 'unknown']]);
  assert.equal((await post(base, '/api/talk/hear', { id, audio: 'data:text/html;base64,PGI+' })).status, 400);
  assert.equal((await post(base, '/api/talk/hear', { id: 'nope', text: 'hi' })).status, 404);
  // On a serverless host the next turn may reach a fresh instance: the page sends the snapshot back and the
  // conversation carries on there.
  const fresh = await serve(t, { QLOO_API_KEY: QKEY, OPENROUTER_API_KEY: OKEY, FAL_KEY: FKEY }, fetcher);
  const resumed = await post(fresh, '/api/talk/hear', { id, state: genre.state, text: 'Anyway, how was your week?', who: 'them' }).then(r => r.json());
  assert.deepEqual(resumed.view.them.map(e => e.name), ['Sally Rooney', 'Past Lives']);
  assert.deepEqual(resumed.view.avoid.map(e => e.name), ['Marvel', 'Superhero']);
  assert.ok(resumed.view.lines.some(l => /Sally Rooney/.test(l.text)), 'the transcript comes along too');
});
