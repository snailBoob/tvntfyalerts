import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { Delivery } from './notifications.mjs';
import { Relay } from './relay.mjs';
import { createApp } from './app.mjs';
import { normalizeNotificationUrl } from './settings.mjs';

test('notification URLs reject credentials and unsupported schemes', () => {
  assert.equal(normalizeNotificationUrl('https://ntfy.example/'), 'https://ntfy.example');
  assert.throws(() => normalizeNotificationUrl('https://u:secret@example.com'));
  assert.throws(() => normalizeNotificationUrl('file:///tmp/file'));
});

test('only rejected sessions request a settings action; authenticated ntfy sends use PUBLIC_URL', async t => {
  const received = [];
  const ntfy = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    res.end(JSON.stringify({ id: 'receipt', event: 'message' }));
  });
  ntfy.listen(0, '127.0.0.1'); await once(ntfy, 'listening');
  t.after(() => { ntfy.closeAllConnections(); ntfy.close(); });
  const delivery = new Delivery({ url: `http://127.0.0.1:${ntfy.address().port}`, topic: 'tradingview-alerts', token: 'tk_fixture', publicUrl: 'https://settings.example' });
  const relay = new Relay(delivery, { getChannel: async () => { throw Object.assign(new Error(), { code: 'AUTH' }); } });
  t.after(() => relay.stop());
  relay.cookies = {}; await relay.reconnect(relay.generation); await delivery.chain;
  assert.equal(received[0].auth, 'Bearer tk_fixture');
  assert.match(received[0].body.message, /session is invalid/);
  assert.deepEqual(received[0].body.actions, [{ action: 'view', label: 'Open settings', url: 'https://settings.example' }]);
  assert.equal(received[0].body.click, undefined);
  await delivery.notice('TradingView connected.');
  assert.equal(received[1].body.actions, undefined);
  delivery.publicUrl = ''; await delivery.notice('Session invalid.', true);
  assert.equal(received[2].body.actions, undefined);
});

test('ntfy configuration cannot be changed through HTTP and secrets are absent from status and SSE', async t => {
  const relay = new EventEmitter(); relay.state = { connection: 'waiting' };
  const config = { url: 'https://ntfy.example', topic: 'tradingview-alerts', token: 'tk_private' };
  const app = createApp({ relay, delivery: new Delivery(config), config });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => { app.closeStreams(); app.closeAllConnections(); app.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(`${base}/api/notifications`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  const status = await (await fetch(`${base}/api/status`)).text();
  assert.equal(status.includes('tk_private'), false);
  const response = await fetch(`${base}/api/events`);
  const reader = response.body.getReader();
  const event = new TextDecoder().decode((await reader.read()).value);
  assert.equal(event.includes('tk_private'), false);
  await reader.cancel();
});
