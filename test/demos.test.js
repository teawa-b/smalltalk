import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../backend/server.js';

// Replays must work with no keys at all: a judge on a fresh deploy sees every example.
async function serve(t) {
  const server = http.createServer(createApp({ env: {}, fetcher: async url => { throw new Error(`no live calls in a replay: ${url}`); } }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (base, path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const events = async res => (await res.text()).split('\n\n').map(c => c.split('\n').find(l => l.startsWith('data: '))).filter(Boolean).map(l => JSON.parse(l.slice(6)));

test('recorded examples replay without any API keys, and the pages load', async t => {
  const base = await serve(t);
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<title>SmallTalk/);
  assert.ok(home.headers.get('content-security-policy'));
  const talk = await post(base, '/api/talk/demo', { demo: 'sample' }).then(r => r.json());
  assert.ok(talk.turns.length >= 5 && talk.turns.at(-1).view.nudges.length);
  assert.equal((await post(base, '/api/talk/demo', { demo: '../../etc' })).status, 404, 'demo names are validated');
});
